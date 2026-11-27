# Production security audit follow-up — 27 November 2026

All four approved code blockers are resolved on `prod-hardening`. No Functions deployment, rules publication, Hosting deployment, paid-plan activation or production migration was performed. The branch is prepared for staged deployment; production cutover still requires the reviewed data migration and cloud configuration below.

**Production verdict: NOT SAFE TO DEPLOY directly without the manual cutover.** There are no known remaining code blockers within H04–H07. A local emulator cannot certify historical production balances, missing legacy payments, deployed IAM/rules or domain configuration.

## Selected free hosting update

The user selected **a separate free hosted backend**, keeping Firebase Spark. `functions/src/server.js` now serves the built UI plus the same SDK-authenticated `/api/*` handlers on a Node web service. `render.yaml` selects Render Free with automatic future deployments off. The financial transaction service, all four blocker fixes and Firestore client-write denials are preserved. No credential upload or new IAM grant was made. See [FREE_HOSTING.md](FREE_HOSTING.md) for the selected cutover; the Blaze instructions later in this report are now an optional alternative.

The standalone host adds bounded JSON parsing, a bounded pre-auth IP limiter, exact origin checks, shared security headers, static file isolation, curated errors, `/health`, project/build/credential checks and graceful shutdown. Actual callable HTTP emulator tests now use this production HTTP adapter. All persistent financial state remains in Firestore across free-host restarts.

A Spark-compatible administrator snapshot CLI reads typed Firestore REST documents at one recent fixed read time, traverses private nested collections, writes a private digest-verified local file, and never writes to Firestore. It is not a managed backup; restoration to staging and separate Auth/rules/index/IAM recovery remain manual release gates. No production backup or migration was run.

**Free hosting limitation:** [Render's free service documentation](https://render.com/docs/free) explicitly recommends these instances for previews rather than production. Sleep, wake-up delay, quotas and possible suspension are remaining live-billing availability risks. The code is ready for a free staging rehearsal; the production verdict remains NOT SAFE until migration/recovery, real staging acceptance and availability requirements are resolved. No paid plan was activated.

## Owner staff activity follow-up

The owner now has a staff activity section with a date range, completed gross sales, bill count, latest sign-in time, total expenses and cash remaining. Cash remaining follows the approved definition: cash invoice/account collections minus cash refunds and cash expenses. It excludes card/UPI/unpaid credit, opening float and unrecorded cash handovers; expenses and refund cash follow the recorded operator UID. Legacy uncertainty is surfaced rather than presented as an accurate zero.

`recordStaffLogin` derives its timestamp/UID from verified Firebase Auth claims, ignores duplicate/older sessions and stores owner-readable, client-write-denied `operatorActivity` documents. Authenticated financial calls also register the verified sign-in. `getStaffSummary` rechecks the active owner/workspace and migration readiness, limits date ranges to 31 days, projects only required fields and fails rather than truncating oversized data. A payments date collection-group index is provided in `firestore.indexes.json`; it must be published and ready. No index/rule publication or deployment was performed.

Tests cover India date boundaries, split tenders, cash change, account collections, cross-operator refunds, same-name staff, negative balances, ambiguous legacy cash, login spoofing/replay, private reads, active-workspace scoping and real callable HTTP owner/staff access. The initial staff activity change passed 72 tests under Node 24, lint, both builds, both dependency audits (zero reported vulnerabilities) and credential scanning. The report UI was checked with isolated fixture data for populated, loading, empty and error states, refresh behavior and mobile width. No real staff credentials or production finance records were used in browser testing.

## Local API and report readiness correction

`npm run dev` previously served only Vite, so `/api/checkout` and `/api/recordStaffLogin` returned 404. Dev and production preview now mount the existing authenticated Node handlers on loopback, using exact origins derived from the listening port rather than assuming port 3000. Native server imports keep administrator dependencies and credentials outside the browser bundle. Server environment files, migration reports and service-account key filenames are denied by Vite's file server. Anonymous callable requests stop before any database access; invalid local setup returns a curated 503. Live mode rejects emulator endpoints and mismatched browser/server projects.

The subsequent `/api/getStaffSummary` 400 was a migration precondition: a read-only production check found the financial gate uninitialized. The owner report now uses a read-only transaction and returns recorded sales, expenses and login times even before migration. All cash amounts remain null with **Setup required** until migration and the payment-history index are ready. No financial gate, balance, invoice or payment is changed by fetching this report; its refresh throttle is bounded in memory. Checkout/payment mutation guards and owner-only permissions are unchanged. Restart dev/preview after backend source changes.

Validation now covers 83 passing tests (32 root, 14 server unit, 37 rules/emulator), lint, builds, both dependency audits and credential scanning under Node 24. Tests exercise actual Vite dev/preview, fallback-port CORS, private-file denials, authenticated emulator checkout, continued migration denial and report rendering with unknown cash values. Local anonymous probes on ports 3000 and 3001 return 401 rather than 404. No production migration, financial mutation, rules publication or deployment was performed.

## Updated before / after table

| Blocker | Severity | Before | Current result | Source |
|---|---|---|---|---|
| H04 | HIGH | Client-controlled invoice lines and totals | Fixed: authenticated callable recomputes catalog variants/add-ons, totals, discounts, current credit limits, receipt metadata and sequencing in one Admin transaction. Client invoice/sequence writes are denied. | `functions/src/financial.js:55` |
| H05 | HIGH | Staff could read owner ledger data | Fixed: operational summaries use financialSchema 2. Credit policy/history live under owner-only customerAccounts. Legacy summaries stay unreadable to staff until reviewed migration is ready; all financial client writes are denied. | `firestore.rules:27` |
| H07 | HIGH | Payment history dropped after fifty entries | Fixed: one immutable document per payment and ledger event; unlimited retained history with paginated owner reads. Request-bound idempotency survives uncertain responses and rejects edited retries. | `functions/src/financial.js:198` |
| H06 | HIGH | Account refunds left customer debt unchanged | Fixed: full refund uses original trusted invoice proof and atomically records refund, invoice status and account credit. Duplicate/concurrent refunds are rejected. Production server flag remains false. | `functions/src/financial.js:234` |
| L01 | HIGH | Local dev/preview returned 404 for financial API requests | Fixed: loopback Vite bridge mounts the existing authenticated handlers, validates projects and uses the actual port for CORS. Private server files are denied. | `config/local-api.js:9`, `functions/src/local-api.js:9` |
| L02 | MEDIUM | Owner staff report failed entirely before migration or a missing payment index | Fixed: read-only partial report shows recorded sales/expenses/logins; cash amounts remain null with setup guidance. Checkout stays gated. | `functions/src/staff.js:108`, `src/components/staff/StaffActivityView.jsx:37` |

## Server financial contract

Callable exports: `checkout`, `recordPayment`, `refund`, `initializeWorkspace`, `saveCustomer`, `archiveCustomer`, `recordStaffLogin`, `getStaffSummary`. On the optional Cloud Functions target they run in `asia-south1`, Node.js 22, with 10 maximum instances and concurrency 1. The selected standalone Render host uses Node 24 and its free instance limits; both use bounded requests and the same authenticated transaction handlers. Protected mutations re-read the active operator and workspace migration gate in each Firestore transaction. Financial mutations are throttled per operator/action. Errors expose curated messages, not stacks. The standalone host serves `/api/<name>` directly; optional Firebase Hosting rewrites target Cloud Functions. Both retain same-origin browser API access. Production CORS is configured through `POS_ALLOWED_ORIGINS`.

Checkout accepts product IDs, variant/add-on selections, quantity, notes, channel, customer/table references, requested discount percentage and tender details. It rejects caller-supplied price/total/merchant/cashier fields. Catalog prices and settings come from Firestore. An optional expected total is only a stale-screen assertion; it never determines the amount. Unknown/custom-priced items require owner catalog creation. Limits are 100 lines, 25 add-ons per line and two-decimal currency. Cash/UPI/card receipts remain manual operator assertions; no payment-provider capture/webhook was added.

Invoice IDs bind retries to operator and request content. Original server proofs and invoice tender receipts are stored privately. Current customer credit limits are private database configuration; staff cannot provide a larger limit or rewrite balances. Customer administration goes through role-checked callables; profile edits preserve live balances and historical records. Archiving retains financial history and requires a zero balance.

## Paths and permissions

- `posWorkspaces/{workspace}/customers/{customer}`: operational summary/contact fields only; staff query `financialSchema == 2` after the workspace migration gate is ready. Client writes are denied.
- `.../customerAccounts/{customer}`: private credit policy, cutover metadata and completeness marker. Owner reads only.
- `.../customerAccounts/{customer}/payments/{payment}`: one immutable account-payment document per operation.
- `.../customerAccounts/{customer}/ledger/{event}`: immutable opening, charge, payment and refund events. Owner reads only; owner and staff client writes both denied.
- `.../orders/{invoice}`: shared operational invoice/receipt. Client writes are denied in active and archived workspaces.
- `.../financialInvoices/{invoice}` plus `payments/settlement` and `refunds/full`: owner-only server proofs and immutable invoice settlement/refund evidence.
- `.../financialOperations/{operation}`: private idempotency receipts; no client writes.

Managed Firestore backups are authoritative for restoration. The application JSON export now includes private account history, invoice proofs, payment/refund events and idempotency receipts, but client-side financial restore/reset is deliberately closed. Use an administrator restore workflow that preserves these records.

## Refund reconciliation and disabled default

`ENABLE_RECONCILED_REFUNDS=false` remains the server default. The browser UI also defaults off with `VITE_ENABLE_RECONCILED_REFUNDS=false`, hiding payout actions and disabling the owner toggle. This is a presentation gate; changing browser settings cannot bypass the server flag. Changing the owner UI preference alone cannot enable refunds. Both the trusted server flag and the owner's staff-refund policy are required. The enabled path is tested locally, but is not activated for production.

Account/Credit refunds subtract the original invoice total from current debt and append an account-credit event atomically. A fully paid account can become a negative balance (customer credit); no cash is sent. An archived customer is reactivated if the refund creates a usable balance. Cash/card/UPI refunds record an externally returned amount and do not alter customer account debt. Gross visit/spend totals retain their previous meaning; reports subtract recorded refunds separately.

Amounts come from the original immutable server proof, not current catalog prices or caller input. A deterministic full-refund record prevents duplicates even if an invoice field is inconsistent. Pre-cutover invoices without trusted proof are rejected for automatic refunds and need administrator reconciliation. Existing historical refund mistakes must be reviewed rather than silently guessed during migration.

## Migration: dry-run first, no production run performed

`functions/scripts/migrate-payments.js` defaults to a read-only dry run. It writes a local 0600 plan under ignored `.migration-reports/`; no customer names, phone numbers or payment details are printed. The plan contains source hashes and counts. Applying requires the reviewed plan, matching project/workspace and explicit backup acknowledgement.

The migration validates identities, currency, dates, balances and document size. It preserves the current balance and every retained legacy entry, including duplicate legacy IDs. Each payment and event receives a deterministic destination ID. Existing immutable destinations are verified, never overwritten. Bounded transactions support histories longer than fifty entries. A lease prevents simultaneous migrations; the workspace remains financially locked after a failed/incomplete apply until a reviewed resume completes.

Ledger/credit fields move off staff-readable documents before they become version 2. Staff cannot read summaries while cutover is in progress. Changed source hashes, malformed records, plan tampering and unresolved data errors fail closed. Rerunning a completed plan is idempotent. After an interrupted process, wait two minutes for its lease to expire before a controlled resume; inspect any source conflicts before generating a new plan.

**Data limitation:** the old application already discarded payments older than its embedded fifty-entry window. Code cannot recreate absent evidence. Migrated accounts are marked `historyComplete: false`, with a preserved cutover/opening balance and an owner-visible warning. Recover/reconcile older backups and legacy account refunds before accepting historical statements as complete. Do not replace missing payments with invented records.

## Verification

The four blocker commits each run lint, tests and both Functions syntax/build checks and the Vite production build, including checks after commit. Both root and Functions dependency trees are audited. The final suite contains no tests intentionally accepting a vulnerability.

Before the free-host follow-up, local results were 60 passing tests (26 domain/deployment, 1 server unit, 33 emulator/rules/callable cases), lint passed, both builds passed, and zero reported vulnerabilities in either dependency tree. The private-credential scan found no private keys/tokens in the working tree or available Git history. Root checks ran on Node 26.13.1; the Functions deployment target remains Node 22 and needs staging verification in that managed runtime.

Emulator coverage includes:

- Staff/anonymous/disabled access, owner escalation, cross-staff expenses, owner-only ledger/payment reads and active/inactive workspace writes.
- Forged invoice prices/totals, invalid variants/add-ons, stale displayed totals, current credit limits and concurrent checkout retries.
- Immutable client-denied invoices, payment/ledger documents, original proofs, refund records and sequencing.
- 55 new retained payments and 60 migrated legacy payments; repeated migration and duplicate legacy source IDs preserve each record without duplication.
- Read-only plans, invalid/stale sources, tampered plans, migration lock and balance preservation.
- Uncertain payment IDs surviving retries, edited retries failing closed and storage failures preventing submission.
- Disabled-by-default refunds, Account reconciliation, cash refunds, simultaneous payment/refund, duplicate refunds and rejection of untrusted legacy proofs.
- Actual callable HTTP envelopes, Auth-emulator token handling with a loopback user-lookup fixture, role failures and canonical checkout/payment responses. All Firestore operations target the isolated demo emulator, not production.

The standard suites are `npm run test:unit`, `npm run test:functions`, `npm run test:rules`; `npm run verify` adds lint, builds, audits and private-credential scanning. A real signed-in staging browser test of Hosting rewrites and real Google-signed tokens remains part of release validation. Physical printers and actual bank transfers were not tested.

## Manual cutover steps

**Optional Blaze route only.** For the selected free Spark/Render route, follow [FREE_HOSTING.md](FREE_HOSTING.md), including its local backup and manual credential requirements. Do not enable billing or deploy Functions for the free route.

1. Put terminals into maintenance and take a full managed Firestore backup plus an Auth/operator recovery record. Review owner grants, old account balances, discarded-history gaps and legacy refunds. Use a staging project first.
2. Enable the Firebase **Blaze** plan and required Functions/build services; confirm service-account IAM, budgets/alerts, Auth domains/policies and API restrictions. Functions deployment requires Blaze. See [Firebase deployment prerequisites](https://firebase.google.com/docs/functions/get-started).
3. Install the reviewed Firebase CLI and dependencies. Root tooling targets Node 24+; deployed Functions use Node 22. Run `npm ci`, `npm ci --prefix functions`, then `npm run verify`.
4. Create the ignored `functions/.env.PROJECT_ID` from `functions/.env.example`; set approved HTTPS `POS_ALLOWED_ORIGINS` and keep `ENABLE_RECONCILED_REFUNDS=false`. Set the public web build variables in root `.env`/CI for the same project, keeping `VITE_ENABLE_RECONCILED_REFUNDS=false`. Never set emulator endpoints in production.
5. Publish deny-direct-write rules and deploy the Functions codebase during maintenance, with an explicit project. Do not use the old client for financial operations afterward:

```sh
firebase deploy --only firestore:rules --project PROJECT_ID
firebase deploy --only functions:financial --project PROJECT_ID
```

6. With administrator ADC credentials, generate and review a dry-run plan. These are manual commands; they were not run against production:

```sh
node functions/scripts/migrate-payments.js --project PROJECT_ID --workspace WORKSPACE_ID --dry-run --out .migration-reports/review.json
# Inspect all errors, completeness warnings, balances and backup/reconciliation evidence.
node functions/scripts/migrate-payments.js --project PROJECT_ID --workspace WORKSPACE_ID --apply --plan .migration-reports/review.json --ack-backup --confirm-project PROJECT_ID
```

7. After every customer has migrated and `config/financialMigration.status` is `ready`, build and publish Hosting with the matching API rewrites:

```sh
npm run build
firebase deploy --only hosting --project PROJECT_ID
```

8. Reload/clear old terminal site data during rollout. Test real owner/staff sign-in, checkout, payment retry, staff ledger denial and direct-write denial. Check private payment counts and current balances against the reviewed plan and backup. Verify `/health`, HTTP security headers, domain/SSL and alerts before reopening terminals.
9. Keep refunds disabled. Only after dataset reconciliation and staging acceptance should a trusted administrator separately enable the trusted server refund flag, publish a browser build with `VITE_ENABLE_RECONCILED_REFUNDS=true`, and enable the owner staff-refund preference. Redeploy Functions and Hosting for that explicit rollout. Account refunds create customer credit; they do not issue bank payouts.

## Commits for the four blockers

```text
897444e fix(H04): move checkout into trusted catalog-priced callable transactions
1eb69d8 fix(H05): isolate owner financial data and add reviewed legacy migration
8647a69 fix(H07): record append-only payments with durable idempotent history
```

The final H06 commit contains refund reconciliation, disabled-default enforcement, regression coverage and these updated cutover instructions; its hash is reported in the chat / `git log`.

## Remaining blockers and follow-up

**No known remaining code blockers in H04–H07.** Production is still gated on the chosen host configuration, rules publication, backup/recovery validation, a reviewed and reconciled migration, and signed-in staging validation. The selected free Render service also has unresolved availability limitations. Missing historical payments and pre-cutover refund errors require real backup/accounting evidence; migration intentionally does not fabricate corrections.

Previously identified follow-up remains: query pagination/server aggregates at larger scale, catalog bulk-import recovery, major frontend upgrades, retained unused components and provider-side abuse/App Check/monitoring configuration. See the initial full audit at `git show 7d6b534:PRODUCTION_AUDIT.md`. None of these decisions was silently changed by this four-blocker follow-up.

**Final verdict: code is ready for staging; NOT SAFE for an unattended production deployment until the manual cutover is completed.** No deployment or production migration occurred in this task.
