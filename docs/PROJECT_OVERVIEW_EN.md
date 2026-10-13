# Vendure Secondary-Development Migration and End-to-End Validation Project

**整理版本 / Prepared version:** v1.1  
**整理日期 / Preparation date:** 2026-09-04  
**Source requirements document:** `/home/zyy/antigravity(old)/vendure商城/二开功能/流水线外包/测试任务.docx` on the minipc

## 1. Project Positioning

The purpose of this project is to migrate the secondary-development features built on the old Vendure base to the current new Vendure base, and to verify through reproducible end-to-end operations that the migrated system supports the real custom press-on-nail business.

This is not merely a code-copying or unit-testing project. Acceptance must cover the complete business chain: storefront browsing, product publishing, country and currency selection, cart operations, payment, wallet operations, order handling, image archiving, production preparation, inventory deduction, and shipment-status updates. The verification result must show whether the system produces the correct user-visible behavior, order data, financial data, inventory data, and local production materials in realistic use.

The migration is organized into two sequential batches. Each batch has its own functional scope and end-to-end validation requirements:

1. **Batch 1: foundational capabilities.** Country/channel behavior, customer country, product country, payment-flow channel locking, and their dependent pages, database extensions, and configuration are migrated first because the remaining business functions depend on them.
2. **Batch 2: remaining business capabilities.** All remaining secondary-development features are migrated except accounting-related functionality and WorldFirst-related functionality, and are verified using the business flows and E2E requirements in this document.

The implementation and handover must keep the two batches separately traceable. Each batch must have its own code changes, environment preparation, verification actions, observed results, and delivery evidence. A generic statement such as “the feature has been migrated” is not a substitute for the individual validations.

### 1.1 GitHub test inputs and local-output boundary

The real public entry point for the test images is now fixed:

- **Public repository:** [vendure-project-briefing](https://github.com/vendure-ai-factory/vendure-project-briefing);
- **Current review branch:** `codex/github-refactor-20260904`;
- **Test image input:** [`evaluation-demo/assets/nail-patterns/`](https://github.com/vendure-ai-factory/vendure-project-briefing/tree/codex/github-refactor-20260904/evaluation-demo/assets/nail-patterns), on the latest commit of the public evaluation branch, containing 199 sanitized JPG/PNG files;
- **Directory constraint:** the original subdirectory structure is preserved. The Contractor must copy the complete tree and must not mix, flatten, or rename the images. Editable PSD source files are not public.

The public hands-on entry point also contains a [sanitized migration-input package](https://github.com/vendure-ai-factory/vendure-project-briefing/tree/codex/github-refactor-20260904/evaluation-demo/migration-input), including a clean-tree source snapshot and the two migration task documents. It is provided so a Contractor can inspect more of the task and try path-aware experiments before quoting. The formal source revision, private Git history, private fixtures, and owner-controlled acceptance inputs remain in the Client-controlled `vendure-evaluation-input` repository; their exact relative path and pinned commit/tag will be provided in a controlled manner after signature and before the formal Acceptance Manifest is frozen. The public package is not a history mirror or the final formal acceptance revision. The Pipeline shall obtain input from fixed GitHub revisions and execute code analysis, migration, and testing in its own temporary checkout/workspace; the GitHub URL is a source address, not a local filesystem path from which scripts can be executed directly.

Historical paths such as `/mnt/e/archive` and `E:\new\1\0.jpg` may remain only as directory-structure examples. They must not be the current acceptance input location. If a test requires a post-run local production archive, the Client SSD is an output target, not the Contractor’s input source.

### 1.2 Contractor path from public review to formal acceptance

After seeing the advertisement and becoming interested, the Contractor first opens the public repository, reads the project overview, acceptance target, sanitized demo code, and image tree, and then runs the public demo in the Contractor’s own computer, clone, fork, or Codespace. The Contractor may modify and test the demo in that private copy. A pull request or fork is only a submission and result-demonstration mechanism; it does not require the Client to merge the code and does not grant permission to modify the Client’s `main`, private repositories, minipc, or production environment.

After the hands-on run, the Contractor submits a quote, delivery period, scope, assumptions, and risks based on the actual result. The Client chooses one Contractor from the received quotes and signs the Agreement. After signature, the Contractor must select at least 3 representative long-chain tasks from the E2E validation tasks in Sections 3.6 and 12, run them automatically with the Contractor’s Pipeline, and submit complete evidence; in principle, the set should cover at least one task from Batch 1 and one from Batch 2, with the Contractor proposing the third task for Client confirmation. Only after all 3 tasks pass may the Contractor deliver the formal Pipeline. The Client then uses the Pipeline to attempt the complete migration within the agreed scope of this document; when problems appear, the Client provides failure evidence and the Contractor continues tuning and rerunning it. Only after the agreed migration scope is complete, the Pipeline runs the agreed scenarios reliably and automatically, and the Client-controlled Final Acceptance Run passes will key, source, documentation handover, and payment proceed.

The three-task gate is a Pipeline capability/delivery gate, not final project acceptance and not, by itself, a payment event. The complete migration remains the Client’s validation operation after delivery. Defects in the Pipeline, its adapters, evidence, rollback, or automation that are inside the frozen scope remain in the tuning loop until the agreed conditions pass; the process does not impose an arbitrary small number of tuning rounds. A new feature, new Vendure version, new execution environment, or new acceptance scenario is a scope change and must be agreed in writing.

### 1.3 Execution environment and access boundary

The public repository is the control and evidence surface, not the runtime for the complete Vendure migration. The public demo runs in the Contractor’s own clone, fork, computer, Codespace, or isolated runner. For the three-task capability gate, the Contractor may use an isolated environment controlled by the Contractor or another agreed isolated runner. For final acceptance, the Client or an agreed independent verifier creates a clean, temporary Linux environment and controls the credentials, network boundary, lifecycle, and cleanup. The preferred trigger is an authenticated GitHub Actions `workflow_dispatch` or equivalent API; SSH is not the normal task interface and may be used only as a separately approved, limited diagnostic channel.

The delivered Pipeline should include a `Dockerfile` and `compose.yaml` or an equivalent reproducible runner definition, dependency lockfiles or version pins, start/stop/check/cleanup scripts, a no-secret `.env.example`, declared tool/MCP permissions, and an image digest or package hash. If a required tool can run only on the Client’s minipc, the Client must expose it through a narrow allowlisted adapter. The Contractor must not receive unrestricted minipc, production, SSH, Docker, or persistent self-hosted-runner access.

## 2. Business Model and Terminology

### 2.1 Business model

The platform sells two categories of products:

- **Standard products:** For example, jelly glue and other nail-related tools. They follow ordinary e-commerce pricing, inventory, checkout, and order behavior.
- **Custom press-on-nail products:** The platform or a customer publishes a nail design (a virtual product). After another customer purchases it, the platform prints the design onto blank nail tips (the physical product), produces the finished press-on nails, and mails them to the buyer.

Therefore, a custom press-on-nail product is a bundled sale of a virtual product together with its corresponding physical product. The design fee corresponds to the virtual design product; the craft fee corresponds to the physical product and the production labor. This bundling rule is the central area of secondary development.

### 2.2 Project terminology

- **Press-on nails:** Finished artificial nail tips made by printing a design onto blank nail tips. They are nail products that can be attached to a customer’s natural nails.
- **Jelly glue:** Disposable double-sided adhesive used to attach press-on nails to natural nails. It has size differences corresponding to different nail-tip and fingernail sizes.
- **Product attributes:** The “options + option values” managed under “Manage Variants” in the Vendure Dashboard. This document uses “product attributes” for that data.
- **Product catalog / product collection:** The “Attributes” area in the Vendure Dashboard. This document uses “product catalog” or “product collection” for that area.
- **Customer country:** The customer’s country of registration or the country selected in the customer profile.
- **Product country:** The country channel to which a product variant belongs. “Channel” and “product variant” retain their Vendure Dashboard meanings.
- **Composite effect image:** A single image showing an entire nail-design set together. It corresponds to the archive image named `0`.
- **Effect image:** A photograph of the finished press-on nail after the design has been printed onto a nail tip. Every concrete effect image must correspond one-to-one with a design image.
- **Design image:** The original design file. It is used for local production and is not shown directly to customers.

### 2.3 Country, channel, and currency boundaries

The Vendure framework strictly isolates channels. For the same product, different country channels may have different prices, currencies, inventory, shipping methods, tax rates, and warehouses.

Customer country is not the same as product channel. A customer may browse and shop across countries, but when the browsing context differs from the customer’s current country or the product country, the storefront must use the lower-right “switch country” prompt to complete the correct channel switch. The customer’s “default country” in the profile also determines the wallet base currency, default payment-related currency, and withdrawal currency. The product’s country channel determines the product price and product-side business context. These dimensions must remain distinguishable and traceable: Germany and Austria may both use EUR, but they must not be merged into one country track.

## 3. Batch 1: Foundational Migration

The principle of Batch 1 is to migrate the foundation before migrating business functions that depend on it. The following four capabilities must be implemented, together with the dependent secondary-development frontend pages, database extensions, and surrounding configuration.

### 3.1 Country-channel and customer-country matching

The system must correctly handle the relationship between Vendure country channels and the customer’s country. A customer may browse and shop across countries, but when the browsing context differs from the customer or product country, the storefront must use the “switch country” prompt to establish the correct channel context.

### 3.2 Payment-flow channel locking

Because customers may browse across channels, the system must strictly lock the country channel from the moment a product is added to the cart until payment is completed. If cross-channel behavior occurs at any point in the payment flow, returning to the payment flow must restore the channel belonging to the current cart products. Page navigation, cookies, headers, callbacks, or cart restoration must not move the order to the wrong country channel.

### 3.3 Customer country

- A customer without an in-platform account must see a welcome page on first entry and choose a country.
- A customer with an account must be able to choose the country in the profile.
- The selectable countries are limited to country channels already created in the backend. If the customer’s country has not been opened as a channel, `other country` must also be available.
- The customer country determines the currency of the in-platform wallet.

### 3.4 Product country

Products consist of a parent product and product variants (child products) with an inheritance relationship. The parent product is above the country-channel boundary, while child variants are strictly constrained by country channel. This parent/child visibility and inheritance relationship must remain intact after migration.

### 3.5 Version, plugin, and re-development boundary

The migration must account for the following facts:

- The source secondary-development code was built on an older Vendure base, while the target base uses a different Vendure version. The old code therefore cannot be assumed to be safely overlaid onto the target.
- The new Vendure base has more plugins installed. If a function was previously implemented entirely with custom code and moving it would overwrite or damage functionality supplied by a target-base plugin, the function should be re-developed using the target plugin capability instead of mechanically copying the old code.
- Batch 1 also includes the secondary-development frontend pages, database extensions, and surrounding configuration needed to make these capabilities runnable.

### 3.6 Batch 1 end-to-end validation order

After Batch 1 migration, simulate the human flow in the following order. The homepage must be opened first; the test must not jump directly to a deep link:

1. Open the homepage and confirm that it renders normally. Click **Shop Now** and confirm that the browser actually enters `/en/search`; it must not jump directly to a deep link.
2. Use the DE account to complete the main flow and confirm that the customer country is Germany and the currency is EUR.
3. In the DE account, open the profile and confirm that the customer country is displayed correctly. Switch the country once and return to the profile; confirm that browsing country and customer country have not been conflated.
4. With the DE account, inspect the product list and product detail page. Confirm that the parent product is cross-country reusable, the child variant is visible only in its corresponding country, and product images are completely inherited.
5. With the DE account, add a domestic product to the cart and then try to add a product from another country. Confirm that the cart and checkout prevent a mixed-country order according to the rule.
6. Enter checkout, first confirm that Stripe is visible, then complete a test payment. Confirm order completion, consistent payment callback, and consistent backend order status.
7. Verify in-platform wallet payment and perform a separate `store-credit` payment. Confirm that the deduction is converted according to the product currency and that the persisted order data is consistent.
8. Repeat the same flow with the AT account. The important point is that AT and DE both use EUR, but their country tracks must remain different and must not be merged.
9. Repeat the same flow with the HU account. The important points are that the currency is HUF and that tax and shipping follow the Hungary country context.
10. Repeat the same flow with the GB account. The important points are that the currency is GBP and that the order and product country never drift.
11. Open the order aggregation page in the customer center. Confirm that orders from different countries can be aggregated in the list. Open one order and confirm that its detail page returns to the country context belonging to that order.
12. Open `[domain]/dashboard/` and confirm that the backend page opens normally as the administrator verification entry point.
13. Finally run a `clean-db / rollback` verification. Confirm that a clean database can be initialized, migrated, rolled back, and used to start another sample environment.

## 4. Batch 2: Business Function Scope

Batch 2 includes all remaining secondary-development functions except accounting-related functionality and WorldFirst-related functionality. Coupons and the marketing module remain marked as to-be-developed in the current requirements and must not be described as completed capabilities.

### 4.1 Platform-owned custom press-on-nail product flow

The platform publishes design products with `run_publish_product_v11.sh`. For example, a design product A containing ten nail patterns must behave as follows:

1. On the homepage “All Products Overview” page, use one composite effect image showing the ten nail patterns together as the product’s overall presentation.
2. When the customer clicks the composite effect image and enters product A’s detail page, the composite image must not appear there. The detail page must show ten independent effect images, one for each concrete design, in a slideshow.
3. The customer can slide left and right through all ten effect images. Clicking one concrete effect image means that the customer has selected that design. The customer then chooses the nail-tip shape and nail-tip size and adds the item to the cart.
4. At this point the virtual product and physical product are already being bundled. The design image is not shown to the customer; it remains on the platform’s local hard drive. The customer sees the photograph of the finished press-on nail made from that design.
5. After payment, the platform downloads the previous day’s orders for unified local processing with the order-export script `run_export.sh`.
6. For each order, the platform uses the selected effect image to find the corresponding design image locally, prints it onto blank nail tips, produces the custom press-on nails, and mails them according to the customer address.
7. After all processed orders are complete, the platform uses the batch-shipping script `process_shipping_csv.ts` to update the database in bulk and change the order status to shipped.

The three scripts mentioned in this flow originally ran with the old Vendure framework. They must be debugged for the current new Vendure base after migration.

### 4.2 Local archive rules for design and effect images

Local production depends on being able to find a design image from the effect-image name. The directory design must be obtained from and tested against the `evaluation-demo/assets/nail-patterns/` folder in the public GitHub test repository, using the latest commit of the public evaluation branch [branch `codex/github-refactor-20260904`](https://github.com/vendure-ai-factory/vendure-project-briefing/tree/codex/github-refactor-20260904/evaluation-demo/assets/nail-patterns). It contains eleven test sets of effect images and design images. This is the project’s online test-fixture path, not a customer local-drive path:

- The root directory contains all design sets; each set has its own folder.
- The design images are kept in the set folder, and the effect images are kept in its `1` subfolder.
- An effect image and its corresponding design image have the same name but are stored in different folders.
- The `0` image in the `1` folder is the composite effect image for the entire set and has no corresponding design image with the same name.
- Every other effect image must have exactly one corresponding design image with the same name.
- Once an order supplies the name of the selected effect image, the same name can be used to locate the design image in the other directory.

The implementation and verification must understand this structure together with the publishing logic in `run_publish_product_v11.sh`. In particular, the `0` composite effect image must appear only in the overall product-list presentation and must not appear in the concrete-design slideshow on the product detail page.

The real production archive of design and effect images remains on the customer’s local storage rather than on the online production server; the test copies used for this acceptance project are obtained from the GitHub fixture path defined above. The customer first sees the composite image on the product list, enters the detail page, browses the concrete effect-image slideshow, clicks a concrete effect image, chooses the nail shape and wearing finger, and completes the purchase. When the platform exports the order, the order record and the customer-side archive rules must allow the correct design image to be found for production.

### 4.3 Separate standard-product and custom-press-on-nail paths

The system uses the internal flag `isCustomerDesign` to separate two parallel paths that must not interfere with each other.

#### Standard Flow

- **Financial logic:** A standard product, such as jelly glue, has one selling price and does not split design fee and craft fee.
- **Settlement:** At checkout, 100% of the sales amount is recognized as the platform’s External Revenue and the corresponding invoice is generated automatically.
- **Commission interception:** The commission logic in `AffiliateSubscriber` automatically skips standard products because they have no designer ID. No accidental commission expense may be generated.
- **Selling permissions:** A designer may publish designs in the Dashboard but may not publish or modify these platform standard products.

#### Custom Logic

- **Bundled sale:** Every design order must be correctly connected to the backend production list.
- **Design commission:** After checkout, tiered calculation is triggered automatically and the design-fee portion is accurately credited to the designer’s AUA wallet.

### 4.4 Craft fee, design fee, and pricing

The storefront price of a custom press-on-nail product consists of two parts:

1. **Craft fee:** The labor fee for making the press-on nails. It is set by the platform and differs by country.
2. **Design fee:** The fee for the nail-pattern design. For most platform-owned designs it is zero; for customer-published designs it is set by the customer.

The storefront displays the two parts as one combined price; the buyer must not see the internal split. After sale, the backend accounting allocation must clearly show the two parts and their respective destinations.

The source requirements contain an earlier sentence saying that a customer-published design product “can set the craft fee,” but the later and more complete rule says that the craft fee is platform-fixed and cannot be changed by the customer; the customer-facing form contains the design fee. This project follows the latter business rule: the platform configures the craft fee by country, and the customer may set only the design fee. If the implementer believes this rule should change, the proposal must be stated and approved before implementation.

The craft fee can be viewed or configured with the following script. The source requirements describe this as a Windows-side WSL internal path; during migration, the actual path and execution method in the target environment must be confirmed:

```bash
cd /home/zyy/projects/vendure-store && npx ts-node scripts/set_craft_fee.ts
cd /home/zyy/projects/vendure-store && npx ts-node scripts/set_craft_fee.ts --country=DE --fee=2.5
```

Examples are Germany at EUR 2.5, Austria at EUR 4, and Hungary at HUF 3000. When the platform publishes its own design with `run_publish_product.sh`, it can enter `0` as the design fee; for example, a Germany product can be displayed as “EUR 0 design fee + EUR 2 craft fee = EUR 2.” The configured value, rather than a hard-coded example, is the value to be verified.

The customer design-publishing panel follows the same general principle as `run_publish_product.sh`: design image, effect image, product name, and price. The additional function is that customer-uploaded design images must also be synchronized to the platform’s local storage.

### 4.5 Customer-published design products

Customers can publish their own nail-design products (virtual products) and publish them to different country channels already opened by the platform.

Relevant pages:

- “My Designs” list: `http://domain/vendor/products`
- “Publish New Design”: `http://domain/vendor/products/new`

The form contains five areas:

1. **Basic information:** Enter the design name.
2. **Large composite image:** Upload one photograph showing the entire nail set together for the product-list page.
3. **Design/effect image pairs:** Click “Add a pair.” Each pair contains two uploads: the design image (the original pattern file) on the left and the effect image (the finished nail photograph) on the right.
4. **Pricing:** Enter the design fee. The page automatically calculates the platform-fixed craft fee, which cannot be changed by the customer; the final retail price (`design fee + craft fee`); and the commission preview showing what the customer receives per sale.
5. **Submission:** Click “Publish Design.”

Customer-published design sets must satisfy all of the following:

- There must be one large composite image for the product-list page, corresponding to an actual file under `evaluation-demo/assets/nail-patterns/design-set/1/0` in the GitHub test fixture. Here `design-set` is one of the public directories `1`, `2`, `3`, `4`, `5`, `6`, `11`, `设计者7`, `设计者8`, `设计者9`, or `设计者10`; the extension is read from the actual file. The original `E:\new\1\0.jpg` is only a historical local-path example and is not the current acceptance-input path.
- Every concrete effect image must have exactly one corresponding design image. Otherwise, when a buyer selects an effect image, the platform may find the wrong design image and production will be incorrect.
- The SKU uses the product publication timestamp, precise to seconds, as the product identification ID, subject to the uniqueness rules in the SKU section.
- Uploaded design and effect images must be synchronized to the local removable SSD `/media/zyy/SU70022`, using the same directory and naming rules as the platform’s own design/effect images.
- Regardless of the names used by the customer or the Vendure backend, the synchronized local archive must name the composite image `0`; give each design image and its corresponding effect image the same name (extensions may differ); make the design-image name in the batch-export CSV match the design-image file name; and store everything inside a directory named with `SKU + timestamp`.
- Each archive must also generate `product_info.json` and `publish_log.json` with the same content structure as the files generated by `run_publish_product_v10.sh`.
- The “Target Sales Countries” selector may show only country channels already opened in the backend. When Hungary is selected, the displayed price unit must automatically change from EUR (€) to HUF (Ft), and the starting guidance amount must also adapt.
- A customer may delist their own product. After delisting, the previously uploaded design and effect images must be automatically deleted from the database.
- A locally runnable script must be provided so that entering one SKU automatically delists the customer product, with support for comma-separated batch delisting.

Example administrator-delisting commands are:

```bash
cd /home/zyy/projects/vendure-store && npx ts-node scripts/admin_delist_products.ts --sku=SKU-20260226-163712-0042
cd /home/zyy/projects/vendure-store && npx ts-node scripts/admin_delist_products.ts --sku=SKU-001,SKU-002,SKU-003
```

### 4.6 Manual synchronization and recovery of customer images

`sync_vendor_uploads.sh` is used for recovery or forced manual synchronization. Although the `publishDesign` backend code already implements synchronization at publication time, the script must remain available when the local drive has omissions or when all published designs need a comprehensive archive check:

```bash
sync_vendor_uploads.sh
```

It may also be configured in `crontab` to run once per day and automatically synchronize missing files to the local drive.

The original script behavior is:

1. Scan the database for products marked as customer/vendor designs and having a SKU.
2. The original version checks whether a corresponding SKU archive folder exists under `/mnt/e/archive`; this is only the old local-archive location and is not the current project’s GitHub test-input location.
3. If the product exists in the database but the archive folder is missing, extract the images from Vendure’s internal resource store `static/assets/source`.
4. Rebuild the archive according to the naming rules: put `0.jpg` in the `1/` folder and name the remaining effect images in sequence.
5. Generate the missing `product_info.json` and `publish_log.json`.

The current minipc has no E drive. If this project’s test scenario requires the uploaded files to be materialized in the customer-side archive, the customer’s SSD `/media/zyy/SU70022` is the post-run output target; it is not the contractor’s input path for test images or legacy source code. The migrated pipeline must obtain its inputs from the GitHub test fixture and GitHub legacy-code revision, and must not treat either `/mnt/e/archive` or `/media/zyy/SU70022` as the online test-input location.

### 4.7 Design-fee commission tiers

Use `ts-node scripts/set_commission_tiers.ts` to view or modify the design-fee commission tiers. The percentage is the share taken by the platform from the design fee set by the customer. Once the design fee exceeds a configured amount, the platform takes the corresponding tiered share. This is intended to limit excessive design fees and prevent money laundering through the website.

The examples in the source requirements are:

- **Germany (EUR):** From EUR 0 to 3, the customer receives 100%; EUR 3 to 7, the platform takes 20%; EUR 7 to 20, the platform takes 60%; EUR 20 to 50, the platform takes 80%; above EUR 50, the platform takes 90%.
- **Hungary (HUF):** From HUF 0 to 1000, the customer receives 100%; HUF 1000 to 7000, the platform takes 30%; HUF 7000 to 20000, the platform takes 60%; HUF 20000 to 50000, the platform takes 80%; above HUF 50000, the platform takes 90%.

The source contains the wording “in Hungary: in Germany” before the second tier list. This formal document assigns the HUF tier list to Hungary based on the currency and context. Implementation and acceptance must use the explicit `Hungary/HUF` interpretation and must not accidentally apply that list to Germany.

It must also be evaluated whether this commission script can be implemented together with the existing product-collection and marketing functions. This is an implementation-design question and must not be treated as solved without code evidence or an actual test.

Although a customer-published product is a virtual design product, it can still have an inventory value so that the design can be sold as a limited edition.

### 4.8 Script for checking designer commission

The source requirements also call for a debugging script to check the designer’s commission. Its intended simple usage is:

```bash
cd /home/zyy/projects && bash ./check_order.sh <order-number>
```

For example:

```bash
cd /home/zyy/projects && bash ./check_order.sh G7N4X2
```

The migrated script must be runnable in the target environment and its result must agree with the order, tax, exchange-rate, and commission records.

## 5. Country, City, Delivery, and Tax Foundations

### 5.1 Country and city database

The project needs to mount a Europe country-and-city database. Vendure has a native country database; it must be connected to Vendure’s Countries and Zones and linked with delivery, shipping fees, and tax calculation.

The Dashboard channel is the product country. When a new country channel is created in the backend, that country must be added consistently in all four places below:

1. Product country, namely the Vendure channel;
2. The customer-country selector in the customer profile;
3. Country selection in the shipping address;
4. The “Target Sales Countries” selector on the customer publishing page `http://domain/vendor/products/new`.

The “Top 50 cities quick selection” is a pure frontend convenience feature (UX). Choosing a city only fills the text field for the user; the thousands of city records should not be inserted into the core billing system and should not slow down core billing performance.

### 5.2 Currency and exchange-rate handling

The exchange-rate channel handles currency alignment for transfers between in-platform accounts. All wallet-related money flows must pass through listener logic that:

1. Checks whether the currencies in the transaction match; if not, it invokes the exchange-rate channel.
2. Checks that the wallet currency matches the customer’s default country and enforces alignment.
3. Monitors currency handling related to accounting.

The exchange-rate table must be updated once per day by scheduled jobs that pull current rates from several free exchange-rate sources.

The system uses an “Identity-First Currency” rule:

- A Hungary-based designer (HU) must use HUF; a Germany- or Austria-based designer (DE/AT) must use EUR.
- Every balance-changing function, including rewards, transfers, and charges, reads the customer’s `countryCode` and aligns the amount to the customer’s base currency.
- `VendorService.getVendorOverview` must not simply add order amounts. It must group by original order currency and use the exchange-rate service to convert the groups into the designer’s base currency before returning the result.
- For example, if a German customer buys a Hungary-based designer’s work in the German channel (EUR), the designer’s backend sales total must be shown in the corresponding HUF and must agree with the amount actually credited to the designer’s wallet.

Audit and interception requirements:

- The `AffiliateTransactionEvent` listener must record `originalAmount` and `originalCurrency` for every transaction, leaving an auditable path for every exchange-rate conversion.
- `AffiliateSubscriber` (a TypeORM subscriber) acts as a database-level guard over `Customer` changes. If any code, manual operation, or plugin logic attempts to write a wallet amount that does not match the customer’s default-country base currency, the attempt must be recorded and intercepted before save.
- For platform-owned products, the default price currency follows the country to which the product is published.
- `TaxIntegrationService` must be currency-aware: whether it handles a Hungary distributor’s reward/spending records in HUF or order revenue from the Hungary site, it must convert the data to EUR before sending it onward.

### 5.3 Scheduled jobs

The following scheduled jobs must be retained and verified:

- Exchange-rate updates;
- Tax-rate monitoring.

### 5.4 Simulated shipping providers

There is currently no third-party shipping-company API. During testing, use a Vendure plugin to generate simulated shipping providers: create two different shipping companies for each country, with price ranges based on weight. This is used for E2E testing, especially for verifying increased weight and shipping-fee differences after order merging.

## 6. Wallet and Internal Accounts

The wallet has three logical backend accounts, while the current frontend displays only two:

| Frontend display | Frontend field | Backend field | Logical account | Financial nature and logic |
|---|---|---|---|---|
| Withdrawable balance | `balanceWithdrawable` | `balanceWithdrawable` | MCA (Must-only-withdraw) | Withdrawable assets such as design income and affiliate commissions; deducted by `transferBalance`. |
| In-platform spending balance | `balanceBonus` | `balanceBonus` | AUA (Accounting-unassigned) | Referral rewards, received transfers, refunds, and similar funds; first deduction source in `spendBalance`. |
| Not displayed on the frontend | — | `balanceNonWithdrawable` | SNA (Strictly-non-withdrawable) | Gifts and strictly non-convertible assets; second deduction source in `spendBalance`. |

Based on the `AffiliateService` logic:

### 6.1 Spending deduction priority

When a customer places an in-platform order, `spendBalance` deducts in this order:

1. First deduct AUA (`balanceBonus`) because it is usually accounting-unassigned or time-limited money.
2. Then deduct SNA (`balanceNonWithdrawable`), which can only be spent.
3. Finally deduct MCA (`balanceWithdrawable`) in order to protect withdrawable assets as far as possible.

### 6.2 Transfer logic

- The sender’s MCA is deducted. Only withdrawable funds may be transferred, reducing the risk of money laundering.
- The receiver’s AUA is increased. Received funds become in-platform spending balance and may not be withdrawn a second time.

### 6.3 Frontend visibility risk

The current `wallet/page.tsx` connects only to MCA and AUA and completely ignores SNA. If a customer has SNA funds, they may not see them on “My Wallet,” while checkout may still consume them. This must be explicitly recorded and tested during migration. If the project requires customers to see SNA, the frontend component must be updated.

### 6.4 Plugin boundary

- **Open-source foundation:** `@avendure/vendure-plugin-store-credit`, which provides basic persistence and lookup for stored credit.
- **Custom upper layer:** `AffiliateWalletPlugin`, which implements the business-specific split between bonus and withdrawable funds, HUF/EUR conversion, and designer commissions.

The currency used for withdrawal must follow the default country in the customer profile. Whenever the business expands to a country, the backend opens a new country channel; the default-country selector then contains all opened channels plus `other country`. For example, after France is added it should contain Germany, Austria, Hungary, France, and `other country`. Customers in `other country` use EUR as their default withdrawal currency. Wallet currency, withdrawal currency, and Vendure `Channel.defaultCurrencyCode` must all be monitored by `AffiliateSubscriber`.

An order may use both in-platform wallet funds and a third-party payment tool. For example, when a Hungary customer uses an HUF wallet balance to buy a Germany EUR product, the HUF balance must be converted through the exchange-rate channel into EUR before being applied to payment.

## 7. Order Merging

The platform has a batch order-export script. Once an order is exported, the database records that it has been batch-exported. Before export, the customer may still add products to the order.

The rules are:

- Even if an order is already paid, it may be returned to an editable state for additional products and additional price, shipping-fee, or confirmation handling, provided that it has not been exported and has not been shipped.
- Orders belonging to different product countries must never be merged.
- When the customer is about to clear the cart, the system automatically checks for an order that has not yet been exported and guides the customer to add the new products to the mergeable order.
- After a new product is added, the order state rolls back; shipping, shipping method, and total payment are recalculated, and the difference is paid at the final payment step.
- Once `run_export.sh` has exported an order, no additional product may be merged into that order.

## 8. Customer Nail Sizes and Nail-Tip Models

Customer measurement page: `http://domain/account/nail-sizes`.

The source test file is `/home/zyy/antigravity(old)/vendure商城/二开功能/测试用指甲尺寸与型号对照表.xlsx` on the minipc. It contains the nail-tip size table and must be installed into the website database.

The business flow is:

1. The customer measures their fingernails and saves the measurements in the profile. One account may save multiple sets of nail sizes.
2. The customer enters a design-product detail page, clicks a concrete design effect image in the slideshow, chooses the nail-tip shape, chooses the finger on which it will be worn, and adds the product to the cart.
3. During the finger-selection step, the backend matches two tables: the nail-tip size table and the customer nail-size table. Through `size` matching, it automatically selects the corresponding nail shape and nail-tip model, and writes the result into the later order list.
4. During order processing, the platform uses the exported order’s design pattern, nail shape, and size/nail-tip model to find the selected design image and the corresponding blank nail tip for printing and delivery.

The core of the “finger-to-model” mapping chain is `order-line-subscriber.ts` plus `nail-size-data.ts`. Migration and validation must cover this complete chain.

## 9. Inventory and Replenishment

### 9.1 Inventory categories

- **Standard-product inventory:** Uses Vendure’s native inventory behavior.
- **Custom press-on-nail inventory:** Split into physical-product inventory and virtual-product inventory.
- **Physical-product inventory:** The quantity of blank nail tips and other production materials.
- **Virtual-product inventory:** The number of times one design can be sold. Although virtual inventory could theoretically be unlimited, setting a quantity makes the design a limited edition.

Customer-published designs and platform-published designs share the physical nail-tip inventory. The system uses the special product “Raw Material Inventory - Nail Tips” to implement this: every custom press-on-nail purchase must bind the design product to one nail tip in the raw-material inventory.

### 9.2 Warehouse isolation

Create one global warehouse and one local warehouse for each country. Each warehouse must have inventory records categorized by nail shape plus model, with a quantity in pieces for every shape/model combination.

- Inventory in the global warehouse can flow into a local warehouse for replenishment.
- When a Hungary customer orders, only the Hungary local warehouse may be used; global-warehouse or other-country inventory must not be visible or usable.
- The `stock_location_channel` junction table locks warehouse permissions. A Hungary backend API request must automatically filter out German warehouse data.

### 9.3 Alerts, replenishment, and shipping deductions

- Set a low-inventory threshold for physical goods. When physical inventory drops below it, show “replenishment required.” This warning applies to physical goods, not virtual goods.
- Create a replenishment script that deducts a selected physical item from the global warehouse and adds it to a local warehouse in one operation.
- Download orders locally in batches, produce and mail the press-on nails, then set `1` in the CSV “shipped” column for completed orders and submit the file through `mark_shipped_from_csv.sh`.
- The batch-shipping script deducts physical inventory from the corresponding country warehouse according to the CSV country code, nail shape, and nail-tip model. It also deducts the custom design’s virtual inventory.
- If the physical “Raw Material Inventory - Nail Tips” reaches 0, or if the custom design’s virtual inventory reaches 0, the storefront must display the product as out of stock and must no longer allow purchase.

## 10. Orders and the Cross-Channel Unified Index

### 10.1 Two order categories

Customer orders are divided into:

1. Orders generated when other people buy “My Designs”;
2. Orders generated when the customer shops on the website.

They appear in different places in the customer center, but both use the same cross-channel indexing concept.

### 10.2 OrderMetadata and admission rules

When a product is purchased and an order is formed, the system must create the concrete Vendure order in the product’s channel and also copy an order summary into the customer-ID-owned `OrderMetadata` table. This table is above channel boundaries: the customer-center list can read it without a channel verification ID. Only when the customer opens a specific order does the system read full details from the order’s channel, with the lower-right prompt available to switch country channel if required.

The timing of designer-order creation is strict. Before a designer-published product is actually paid for, no “purchased design product” order information may be created under the designer ID. Vendure may create a native `Order` when the product is in the cart but not yet paid; that unpaid record must not appear in the designer’s order list.

A guest order with no email, no payment, and later cancellation is an “abandoned draft” and must not enter the global index. `active = false` only means that the order session has ended; the system must distinguish whether the session ended because payment succeeded or because the session timed out and was removed.

Vendure natively creates an order before identity confirmation: adding an item to a cart creates an `Order` row; if the visitor closes the browser without entering an email, Vendure may later mark it `Cancelled`. Those records may remain in native Vendure tables for audit, but they are meaningless garbage for the customer center and designer panel.

Synchronization and realtime listeners therefore need an admission threshold: only an order with a non-empty `customerId`, or an order that has reached a designated business stage such as `ArrangingPayment`, may enter the index. With Stripe integrated, an email is required before payment, and a successful payment automatically creates a `Customer` entity through the email. Consequently, in this business definition a guest order exists only before the “Pay” action; an order without `customerId` has never entered payment and must be invisible to both buyer and designer and ignored by index synchronization.

### 10.3 OrderMetadata field responsibilities

- `customerId` is the buyer ID. It belongs to the buyer/customer-center side, identifies who paid, and determines whose “My Orders” list displays the order.
- `orderLine` records the concrete products purchased. It belongs to the product/designer side and connects each order line to its designer. One order may contain a manicure product from designer A and a tool kit from designer B; `OrderMetadata` is the order summary, while `orderLine` is the designer relationship.
- `OrderMetadata` retains both customer and designer dimensions and serves as a global cross-channel tracking table containing the order number, total, status, buyer ownership, and design ownership.
- Buyers can use it to view orders across channels, while designers can use it to view sales performance.

### 10.4 updateOrderIndex

`updateOrderIndex` is the execution function that updates `OrderMetadata`:

1. Listen for a transaction in a Germany or Hungary branch, triggered by EventBus.
2. Read the order from the concrete channel ledger.
3. Copy the key summary data into the global `OrderMetadata` table.
4. Never index an order without `customerId` or an order that has not reached `PaymentSettled`.
5. In addition to copying the buyer ID, analyze the order lines and copy the designer ID.

This is the “Unified Index Pattern”: a global directory above all channels removes the channel-authorization obstacle from list reading. The list can be displayed without a country credential; when the customer opens a detail page, the frontend reads the order’s channel marker, automatically updates the Cookie and Header, and switches to the relevant country context. Whenever a channel order changes state, it must notify the global directory so that the index is synchronized; for example, a cancellation in the Hungary channel must update the aggregate status.

Product backfill reads the `designTemplate` field directly. List display should prefer `designTemplate` rather than querying every channel. Delisting must clean both the database record and the corresponding local symbolic-link archive directory.

### 10.5 Two determinants in cross-channel customer management

The following two fields must remain explicitly distinct:

1. `Channel.defaultCurrencyCode` in the Vendure `Channel` table is the default currency for the channel and determines the product price currency.
2. The “default country” in the customer profile determines the wallet currency and the default currency used for withdrawal.

When an account is created, it must belong to `Default Channel`. The customer then chooses a default country in the profile. That field determines the tax jurisdiction, wallet currency, and default payment currency. The country channel used by the product list remains the channel ID that the native Vendure framework actually evaluates.

When a customer belonging to `Default Channel` visits an unfamiliar country channel, the frontend displays a “confirm country switch” prompt. After the customer clicks the switch button, the request context (`ctx`) must contain that country’s valid channel credential (Channel Token), allowing the channel-scoped request to be established correctly.

The key Unified Index behavior is that the list layer reads from a cross-channel order index above all channels without a live channel credential. The detail layer reads the order’s channel marker, such as HU, automatically updates the Cookie and Header, and switches to the Hungary channel. Every order-state change must notify the aggregate index so that a cancellation or other change in a concrete channel cannot leave the unified directory stale.

## 11. Tax Rates, Unique IDs, and Deferred Scope

### 11.1 Tax rates

The authoritative tax source is EU VAT Rates Data, maintained by Iurii Rogulia and connected directly to the EU official interface with daily updates. The project uses `TaxConsistencyGuard` and `EUVatSyncService` to provide:

- Automatic correction: lock the Germany, Austria, and Hungary tax zones on every startup to prevent manual or script mistakes.
- Authoritative synchronization: synchronize the latest EU VAT rates from GitHub (`vatnode`) daily so that values such as Hungary’s 27% remain current.
- Physical isolation: separate Germany, Austria, and Hungary from the generic Europe region to eliminate tax-calculation conflicts.

The script is `scripts/setup_tax_rates.ts`. The source requirements record that it has created dedicated zones and tax rates for seven countries, including Germany (19% VAT), Hungary (27% VAT), and Austria (20% VAT), and associated each country Channel with its correct zone instead of the previous global 20% placeholder. After migration, these behaviors must be confirmed by actual testing; the presence of the script alone is not evidence.

Platform/designer commission must be calculated after VAT has been deducted. For example, if the product price excluding shipping is EUR 10, VAT is 20%, and the platform and designer each receive 50% of the post-tax amount, the designer receives `10 × (1 - 20%) × 50% = EUR 4`. VAT has already been collected, so the designer does not pay that VAT again.

### 11.2 SKU and designId

When the platform publishes a press-on-nail design product, the SKU is generated from the publication timestamp to the second. The publishing input may use the following JSON:

```json
{
  "name": "Product name",
  "designId": "SKU",
  "countries": {
    "DE": { "price": 30.00 },
    "HU": { "price": 3900 },
    "AT": { "price": 35.00 }
  }
}
```

After publication, the script writes the generated SKU back and uses the same generated SKU as both the sales identifier (SKU) and the unique design identifier (`designId`). This guarantees uniqueness for the current one-design/one-product case.

For customer-uploaded designs, the backend can allocate a unique ID through an auto-increment sequence or UUID, for example `CUST-9527`; a combination of user ID and millisecond timestamp can further reduce collision risk. When synchronized locally, the allocated `designId` is normally used as the folder name so that the file path is unique.

SKU and `designId` may look identical in the current business, but they represent different concepts:

- `designId` is the identity and lineage of the design image itself—the original archive in the physical world.
- SKU is the stock-keeping and sales unit—the way that design is sold.

In the future, one design may be sold as both a ten-piece set and a twenty-piece set. There would then be two SKUs but one `designId`. To change the original design, the system needs to find all related SKUs through `designId` rather than search for every SKU individually. Keeping an independent `designId` therefore reserves an architectural extension point for future sizes, materials, and other sales specifications.

### 11.3 Deferred or not-yet-developed functions

- **Tax accounting and financial accounting:** Deferred in the current phase and to be added in a later phase.
- **WorldFirst:** Deferred in the current phase and to be added in a later phase.
- **Coupons:** To be developed.
- **Marketing module:** To be developed.

## 12. Batch 2 End-to-End Validation Requirements

The following requirements are the acceptance targets for this project. Each item must be verified through real operations and observed results. Code presence, a successful API response, a page that merely opens, or a script that merely prints help text is not a substitute for the relevant E2E result.

### 12.1 Base test data

First create four country channels for testing:

| Country | Currency | Region |
|---|---|---|
| Germany | EUR | European Union |
| Austria | EUR | European Union |
| Hungary | HUF | European Union |
| United Kingdom | GBP | Outside the European Union |

These countries deliberately vary by country, currency, and regional classification so that their test results are distinguishable. Then register one customer account for each country, record the accounts and test data, and make them reusable for subsequent tests.

### 12.2 Global E2E checklist

1. Configure the appropriate tax rate and shipping weight-price table for each country.
2. Create a new country channel in the backend and confirm that the new country is added to all four locations:
   - Product country, namely the Vendure channel;
   - Customer-country selector in the customer profile;
   - Country selector in the shipping address;
   - Target Sales Countries selector on `http://domain/vendor/products/new`.
3. Perform E2E verification of in-platform account transfers, deposits, and withdrawals. The full chain must use different currencies and must verify that the exchange-rate channel works.
4. Verify the hard binding between customer country and wallet currency.
5. Verify that a platform-owned product uses the currency of the country to which it is published.
6. Verify that the customer center correctly displays bills, orders, and in-platform fund-transfer records. “Bills” include the platform shopping receipt and withdrawal credentials. In the source requirements, “order” in this particular description refers to the record of unpaid products currently in the cart; paid-order behavior is additionally covered by the order aggregation and index scenarios.
7. Verify order merging and confirm that orders from different product countries cannot be merged.
8. Use `run_publish_product_v11.sh` to complete the platform-owned product publication flow, then complete the full customer purchase flow and confirm that the customer receives the correct receipt.
9. Have one customer publish a design product and another customer buy it. The two customers must use different currencies. Verify all of the following:
   - Design fee and craft fee are recorded separately and correctly in the backend database;
   - Every design-fee commission tier is tested and the platform/designer split is correct;
   - Commission is calculated after VAT deduction;
   - Exchange-rate conversion is correct;
   - The design publisher can see correct income details and product-sales information;
   - The customer-uploaded design and effect images are automatically downloaded to the local SSD with correct names;
   - When one design is published to multiple countries, the product in every country is purchased once and taken through the full test flow;
   - `run_export.sh` exports the order list, and the list records lead to the correct customer design and effect images;
   - The nail shape and size recorded in the order list match the choices made by the purchasing customer.
10. Verify that, after the customer records nail sizes, selecting a finger on the press-on-nail shopping page automatically matches the correct nail shape and size/nail-tip model in the backend.
11. Verify inventory and scripts:
   - If either virtual-product inventory or physical-product inventory is 0, the storefront displays the product as out of stock;
   - If physical inventory drops below the alert threshold, the system displays “replenishment required”;
   - Test the replenishment script;
   - Test `mark_shipped_from_csv.sh` and confirm that it deducts the physical inventory of the corresponding warehouse according to the CSV country code, nail shape, and nail-tip model;
   - Physical inventory is deducted by the batch-shipping script, while design-product virtual inventory is deducted at purchase time. Both deduction paths must be tested independently.
12. Verify the currency-and-price alignment listener: price and currency on the product index page must match the concrete product detail page.
13. Verify data synchronization for the cross-channel order list in the customer center.
14. Verify the tax rate for each country, dynamic tax-table updates, and alignment of the full tax-related frontend/backend chain, including values at payment and on the shopping receipt.
15. Test an in-platform transfer between two customers and the associated exchange-rate conversion. Focus on security: the transaction is wrapped in `TransactionalConnection`, and self-referral point farming must be disabled.
16. Verify that MCA, AUA, and SNA account inflows and outflows are correct.

### 12.3 E2E scenario for customer-published design products

#### A. Publication and local synchronization

For a customer-published design product, test all of the following:

1. The product can be published to multiple countries with different prices and currencies.
2. During upload, every effect image is paired with the correct design image. If their original names differ, the system must normalize the names so that the synchronized local design image and effect image share the same name while remaining in different folders and complying with the backend archive rules.
3. After upload, one large composite image plus multiple concrete effect images display correctly on the product index page and product detail page, and the product can be published to multiple countries.
4. The effect and design images are automatically downloaded and saved using the `[美甲图案]` directory format so that the design image can later be found from the effect-image name.

#### B. Purchase, payment, and order merging in every country

When the published product is purchased in each country, test all of the following:

1. The applicable VAT rate for each country is correct.
2. If the shopping account’s wallet currency differs from the currency used for payment, the wallet currency is converted through the exchange-rate channel into the payment currency before it participates in the final payment. Customer country and product country must be aligned correctly in the business logic.
3. The hard validation before clicking Pay requires the shipping-address country to equal the product country. If they differ, payment is not allowed.
4. Order merging follows these strict rules:
   - A paid but not-yet-exported order may be merged with a new product and the difference paid when the new product belongs to the same product country as the existing order;
   - Orders from different product countries may not be merged even if neither order has been exported.
5. Test shipping selection, especially the case in which merging makes the shipment heavier and causes a shipping-fee difference that must be paid.

#### C. Post-purchase order processing

After purchase, test all of the following:

1. **Commission:**
   - Deduct VAT first, then calculate the craft-fee and design-fee allocations. Set the craft fee with `ts-node scripts/set_craft_fee.ts` and compare it with the later allocated craft fee to confirm that the amounts match;
   - Test the platform/designer design-fee split with `ts-node scripts/set_commission_tiers.ts`;
   - Store the design fee in the correct internal AUA wallet and display it correctly on the frontend;
   - Convert the design fee through the exchange-rate channel when its currency differs from the wallet currency.
2. **Order export:** Use `run_export.sh` and confirm that the exported content matches the customer’s purchase inputs and choices.
3. **Production-material lookup:** Confirm specifically that the customer’s selection of “effect image + nail shape + finger” maps to the correct “design image + nail shape + nail-tip model,” and that the corresponding design image can actually be found on the local hard drive.
4. **Shipment:** Use the batch-shipping script (`process_shipping_csv.ts`; the batch marker script is also recorded as `mark_shipped_from_csv.sh`) to update the database in bulk and change the order status to shipped. Confirm that the relevant country’s physical nail-tip inventory decreases by one and the design product’s virtual inventory also decreases by one.

#### D. Customer center

The customer center must verify:

1. The designer account that sells a design product can display sales details.
2. A customer can delist a design product they published.
3. An administrator can delist a customer-published product with `admin_delist_products.ts`.
4. The purchasing customer receives a shopping receipt, and the price and VAT shown on it are correct.

## 13. Questions the Handover Must Answer

At delivery, the project result must provide an individual, reproducible answer to at least these questions:

- Are the four Batch 1 foundational capabilities genuinely usable on the new Vendure base?
- Do the Batch 2 business functions maintain the correct country, channel, currency, tax, order, and wallet boundaries?
- Can the selected effect image always identify one and only one correct local design image?
- Are virtual-product and physical-nail-tip inventory deducted at their specified, different points in time?
- Are unpaid, paid, exported, shipped, and abandoned guest-draft orders distinguished correctly?
- Do design fee, craft fee, VAT, exchange-rate, and MCA/AUA/SNA changes agree across the backend, frontend, orders, and credentials?
- Can the cross-channel order list be displayed in one unified view while the order detail returns to the correct country channel?
- Can clean database initialization, migration, rollback, and restart be reproduced?

The project has achieved its “migration plus business validation” objective only when these questions are answered by actual end-to-end operations and results. Compilation success or a successful individual API response is not full acceptance.
