# Public Test Image Assets

This directory contains the sanitized JPG and PNG image materials for the public hands-on demo.

## Where to find them

```text
evaluation-demo/assets/nail-patterns/
```

The source directory structure is intentionally preserved because some Vendure second-development scripts resolve image inputs by relative path. Do not flatten, rename, or move all images into one directory. Examples include `1/`, `1/1/`, `5/1/`, and `设计者10/1/`. The public package contains 199 JPG/PNG files distributed across those original subdirectories. Native PSD source files are intentionally excluded from the public repository because editable layers and metadata are not required for the first hands-on test.

When copying these materials into a test workspace, copy the complete `assets/nail-patterns/` tree and keep the relative paths unchanged. When uploading through the GitHub web interface, upload each source subdirectory to the matching directory under this path; GitHub limits a web upload batch to fewer than 100 files.

These assets are supplementary public test materials. The minimal automated acceptance case still uses `evaluation-demo/app/fixtures/legacy-catalog.json`; a pipeline that uses the image assets should record the selected asset paths and the resulting evidence in its own run output.

## Safety boundary

The assets are for local inspection and testing only. Do not upload credentials, private customer data, production files, or access keys. The public demo does not grant access to the private evaluation-input repository, minipc, production services, or shared evidence storage.
