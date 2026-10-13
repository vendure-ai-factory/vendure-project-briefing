#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
node sync_vendor_uploads.mjs "$@"
