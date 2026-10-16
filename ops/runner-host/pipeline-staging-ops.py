#!/usr/bin/python3
"""Allowlisted staging deploy and redacted log reader for the GitHub Runner."""
from __future__ import annotations
import fcntl
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/opt/nail-patterns-staging")
APP_COMPOSE = ROOT / "app-compose.yaml"
APP_ENV = ROOT / "deploy.env"
APP_PROJECT = "nail-patterns-staging-app"
APP_SERVICES = ("vendure", "vendure-worker")
PG_COMPOSE = ROOT / "compose.yaml"
PG_PROJECT = "nail-staging"
EXPECTED_REPO = "ghcr.io/vendure-ai-factory/nail-patterns-vendure"
EXPECTED_SOURCE = "https://github.com/vendure-ai-factory/vendure-staging-baseline"
STAGING_ORIGIN = "https://staging.tibella.eu"
LOG_TARGETS = {
    "vendure": (APP_PROJECT, APP_COMPOSE, "vendure"),
    "worker": (APP_PROJECT, APP_COMPOSE, "vendure-worker"),
    "postgres": (PG_PROJECT, PG_COMPOSE, "postgres"),
}
DOCKER = "/usr/bin/docker"
DIGEST_RE = re.compile(r"^" + re.escape(EXPECTED_REPO) + r"@sha256:[0-9a-f]{64}$")

REDACTIONS = [
    (re.compile(r"(?i)\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+\b"), "[REDACTED_STRIPE_KEY]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\bor-v1-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_OPENROUTER_KEY]"),
    (re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(\b(?:password|passwd|secret(?:[_-]?key)?|token|api[_-]?key|authorization|cookie|set-cookie|database_url|postgres_url)\b\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;]+)"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(://[^:/@\s]+:)[^@/\s]+@"), r"\1[REDACTED]@"),
    (re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"), "[REDACTED_EMAIL]"),
]

class OpsError(Exception):
    pass

def redact(value: str) -> str:
    for pattern, replacement in REDACTIONS:
        value = pattern.sub(replacement, value)
    return value[:2000] + (" [TRUNCATED]" if len(value) > 2000 else "")

def audit(op: str, target: str, result: str) -> None:
    uid = os.environ.get("SUDO_UID", "unknown")
    try:
        actor = pwd.getpwuid(int(uid)).pw_name
    except (ValueError, KeyError):
        actor = "unknown"
    message = f"actor={actor} op={op} target={target} result={result}"
    try:
        subprocess.run(["/usr/bin/logger", "-t", "pipeline-staging-ops", "--", message],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    except Exception:
        pass

def run(args: list[str], timeout: int = 90, check: bool = True) -> str:
    env = os.environ.copy()
    env["HOME"] = "/root"
    env["DOCKER_CONFIG"] = "/root/.docker"
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=timeout, check=False)
    if check and result.returncode != 0:
        detail = redact(result.stderr or result.stdout or "command failed")
        raise OpsError(f"command failed ({result.returncode}): {detail}")
    return result.stdout.strip()

def require_runner_sudo() -> None:
    if os.geteuid() != 0:
        raise OpsError("must be invoked through sudo")
    expected = pwd.getpwnam("gha-runner").pw_uid
    if os.environ.get("SUDO_UID") != str(expected):
        raise OpsError("caller must be gha-runner via sudo")

def image_from_env() -> str:
    if APP_ENV.is_symlink() or not APP_ENV.is_file():
        raise OpsError("staging deploy.env missing or symlinked")
    st = APP_ENV.stat()
    if st.st_uid != 0 or (st.st_mode & 0o077) != 0:
        raise OpsError("staging deploy.env must be root-owned and mode 0600")
    values = [line.partition("=")[2].strip() for line in APP_ENV.read_text().splitlines()
              if line.startswith("APP_IMAGE=")]
    if len(values) != 1 or not DIGEST_RE.fullmatch(values[0]):
        raise OpsError("deploy.env must contain one approved immutable APP_IMAGE")
    return values[0]

def write_image_env(image: str) -> None:
    lines = APP_ENV.read_text().splitlines(keepends=True)
    hits = [i for i, line in enumerate(lines) if line.startswith("APP_IMAGE=")]
    if len(hits) > 1:
        raise OpsError("deploy.env contains duplicate APP_IMAGE entries")
    replacement = f"APP_IMAGE={image}\n"
    if hits:
        lines[hits[0]] = replacement
    else:
        lines.append(replacement)
    fd, temp_name = tempfile.mkstemp(prefix=".deploy.env.", dir=str(ROOT))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.writelines(lines)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temp_name, 0, 0)
        os.replace(temp_name, APP_ENV)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)

def image_metadata(image: str) -> tuple[str, str]:
    raw = run([DOCKER, "image", "inspect", image, "--format", "{{json .Config.Labels}} {{json .RepoDigests}}"])
    labels_raw, digests_raw = raw.split(" ", 1)
    labels = json.loads(labels_raw or "{}")
    digests = json.loads(digests_raw or "[]")
    if image not in digests:
        raise OpsError("requested digest is not present in the pulled image RepoDigests")
    source = labels.get("org.opencontainers.image.source", "")
    revision = labels.get("org.opencontainers.image.revision", "")
    if source.rstrip("/") != EXPECTED_SOURCE or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise OpsError("image provenance labels do not identify the approved Vendure staging source and commit")
    return source, revision

def compose(project: str, file: Path, *args: str, timeout: int = 120, check: bool = True) -> str:
    return run([DOCKER, "compose", "--project-name", project, "--file", str(file), *args], timeout=timeout, check=check)

def verify_compose_image(image: str) -> None:
    services = compose(APP_PROJECT, APP_COMPOSE, "config", "--services").splitlines()
    images = compose(APP_PROJECT, APP_COMPOSE, "--env-file", str(APP_ENV), "config", "--images").splitlines()
    if set(services) != set(APP_SERVICES) or len(images) != 2 or any(item != image for item in images):
        raise OpsError("staging Compose target no longer matches the two approved Vendure services")

def wait_health() -> None:
    deadline = time.monotonic() + 180
    last_error = "not ready"
    while time.monotonic() < deadline:
        try:
            ids = compose(APP_PROJECT, APP_COMPOSE, "ps", "-q", "vendure", "vendure-worker").splitlines()
            if len(ids) != 2:
                raise OpsError("Vendure API/worker container set is incomplete")
            state = run([DOCKER, "inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", *ids]).splitlines()
            if len(state) != 2 or any(not line.startswith("running ") for line in state):
                raise OpsError("Vendure API/worker containers are not both running")
            with urllib.request.urlopen(STAGING_ORIGIN + "/health", timeout=8) as response:
                health = json.loads(response.read(65536))
                if response.status != 200 or health.get("status") != "ok":
                    raise OpsError("staging health endpoint did not return status=ok")
            payload = json.dumps({"query": "{ __typename }"}).encode()
            request = urllib.request.Request(STAGING_ORIGIN + "/shop-api", data=payload,
                                             headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                data = json.loads(response.read(65536))
                if response.status != 200 or data.get("data", {}).get("__typename") != "Query":
                    raise OpsError("staging Shop API smoke check failed")
            return
        except Exception as exc:
            last_error = redact(str(exc))
            time.sleep(6)
    raise OpsError(f"staging API/worker health check timed out: {last_error}")

def deploy(image: str) -> None:
    if not DIGEST_RE.fullmatch(image):
        raise OpsError("image must be the approved GHCR repository followed by @sha256:<64 lowercase hex>")
    if APP_COMPOSE.is_symlink() or not APP_COMPOSE.is_file() or APP_COMPOSE.stat().st_uid != 0:
        raise OpsError("staging Compose file missing, symlinked, or not root-owned")
    before = image_from_env()
    lock_fd = os.open("/run/lock/pipeline-staging-ops.lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock_fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OpsError("another staging deploy operation is already running")
        run([DOCKER, "pull", image], timeout=600)
        source, revision = image_metadata(image)
        verify_compose_image(image)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_dir = ROOT / "backups" / "runner-deploy"
        backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(backup_dir, 0o700)
        backup_env = backup_dir / f"deploy.env-before-{stamp}"
        shutil.copy2(APP_ENV, backup_env)
        os.chmod(backup_env, 0o600)
        write_image_env(image)
        try:
            compose(APP_PROJECT, APP_COMPOSE, "--env-file", str(APP_ENV), "up", "-d", "--no-build", "--no-deps", *APP_SERVICES, timeout=300)
            wait_health()
            result = "healthy"
        except Exception:
            result = "deployed-health-block"
            raise
        finally:
            evidence_dir = ROOT / "evidence" / "runner-ops"
            evidence_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(evidence_dir, 0o700)
            record = {"time_utc": datetime.now(timezone.utc).isoformat(), "operation": "deploy",
                      "result": result, "previous_image": before, "requested_image": image,
                      "source": source, "source_revision": revision,
                      "deploy_env_backup": str(backup_env),
                      "automatic_database_rollback": False}
            (evidence_dir / f"deploy-{stamp}.json").write_text(json.dumps(record, indent=2) + "\n")
            os.chmod(evidence_dir / f"deploy-{stamp}.json", 0o600)
            audit("deploy", image.rsplit("@", 1)[1][:19], result)
        print(json.dumps({"result": result, "previous_image": before, "active_image": image,
                          "source_revision": revision, "host_evidence": str(evidence_dir / f"deploy-{stamp}.json"),
                          "note": "Database state is not automatically restored; retain the pre-deploy image and database backup policy."}, indent=2))

def logs(target: str) -> None:
    if target not in LOG_TARGETS:
        raise OpsError("logs target must be one of: vendure, worker, postgres")
    project, file, service = LOG_TARGETS[target]
    output = compose(project, file, "logs", "--no-color", "--timestamps", "--tail", "100", "--since", "2h", service, timeout=120, check=False)
    # Docker Compose combines container log text; redact before anything reaches the Runner log/artifact.
    for line in output.splitlines()[-100:]:
        print(redact(line))
    audit("logs", target, "read")

def main() -> int:
    try:
        require_runner_sudo()
        if len(sys.argv) == 3 and sys.argv[1] == "logs":
            logs(sys.argv[2])
            return 0
        if len(sys.argv) == 3 and sys.argv[1] == "deploy":
            deploy(sys.argv[2])
            return 0
        raise OpsError("usage: pipeline-staging-ops logs {vendure|worker|postgres} | deploy <approved-ghcr-image@sha256:digest>")
    except Exception as exc:
        audit(sys.argv[1] if len(sys.argv) > 1 else "unknown", "-", "blocked")
        print(f"BLOCK: {redact(str(exc))}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
