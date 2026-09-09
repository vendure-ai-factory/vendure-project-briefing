# Public Demo Task

## Goal

Complete the migration adapter in `app/src/catalog.mjs`.

The input is a legacy catalog export in `app/fixtures/legacy-catalog.json`. Convert it into the public catalog shape consumed by a newer application.

Supplementary visual materials are available under `assets/nail-patterns/`. They include sanitized effect and design images for optional pipeline experiments. The original subdirectory structure must be preserved because some Vendure second-development scripts resolve image inputs by relative path; do not flatten or rename the files. The required automated assertions remain based on the JSON fixture so the public acceptance run is reproducible.

## Required behavior

- keep active records and exclude inactive records;
- create a URL-safe lowercase `slug` from the legacy name;
- convert the decimal price to integer `price_cents`;
- expose the number of image files as `image_count`;
- preserve the legacy SKU as `sku`;
- do not expose `internalNote` or any other internal-only field;
- return records in stable SKU order;
- do not mutate the input object;
- do not add dependencies or make network calls.

## Required evidence

Your pipeline should leave:

- the changed-file summary and Git diff;
- the exact command and exit code used for verification;
- test output showing the required assertions;
- a short explanation of how to roll back the change;
- a clear `PASS` or `BLOCK` result.

## Boundary

This is a public demonstration only. Do not attempt to access private repositories, client systems, production services, or credentials. A successful public demo supports a feasibility discussion; it is not formal acceptance of the private Vendure pipeline.

Run the task only in your own clone, fork, computer, Codespace, or isolated no-secret runner. Do not use the Client's minipc, a shared self-hosted runner, unrestricted SSH, repository secrets, or production services. The public task demonstrates the shape of a bounded migration and its evidence; after contract signing, the separate capability gate and final acceptance use the private inputs and the controlled environments described in the public project documents.
