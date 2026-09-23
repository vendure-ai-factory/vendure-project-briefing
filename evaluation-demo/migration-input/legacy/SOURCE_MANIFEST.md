# Legacy Vendure secondary-development source export

This directory is a sanitized source export from the original Vendure project archive.

- Original archive SHA-256: 47314c8d797965ff2df99ad636d0af6a28a3afca1de32efe7df4fbb822af1c18
- Included roots: vendure-store and storefront.
- Included: source code, package manifests and relevant tests/scripts.
- Excluded: .env files, Git history, dependencies, build caches, runtime databases, logs, screenshots and static asset folders.
- The test/design assets are provided separately under the evaluation repository fixtures directory.
- The vendure-store source in this export uses Vendure 3.5.3 and is migration input, not the target runtime base.
- Local paths were converted to repository-relative defaults or environment-variable overrides.
- Test and administrator passwords are not committed; scripts require environment variables or use explicit replacement placeholders.
