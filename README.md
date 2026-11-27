# Aavin POS

React/Vite POS with Firebase Authentication, Firestore and callable Cloud Functions. Financial writes run only on the server. Read [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) before the first production cutover.

## Setup and verification

Use Node 24+ for root tooling and Java 21+ for the Firestore emulator. Functions deploy on Node 22.

```sh
npm ci
npm ci --prefix functions
cp .env.example .env
# Set public Firebase registration values for the intended project.
npm run verify
npm run dev
```

`npm run verify` runs ESLint, unit tests, Functions tests, real Firestore/emulated-callable tests, both builds, both dependency audits and the private-credential scan. Tests use isolated demo data. No deployment happens during verification. The former three vulnerability diagnostics now assert secure behavior.

## Financial boundaries

- Checkout sends catalog selections and tender details to the callable. The server reads prices, options, settings, current credit limits and sequencing from Firestore, recalculates all amounts and commits atomically. A displayed-total assertion only detects stale prices. Custom-priced items must first be created in the owner-managed menu.
- Active staff settle invoices; owner/staff record account payments. Financial documents and customer balances cannot be written directly by browser clients, including owner clients. Private credit policy/ledger data is owner-readable only.
- New account payments and ledger events are immutable documents under `customerAccounts/{customer}/payments` and `/ledger`, without a fifty-entry cap. Owner history is paginated. The browser keeps opaque retry IDs across uncertain responses; editing an unconfirmed payment is blocked until the original outcome is resolved.
- Refunds remain disabled by default (`ENABLE_RECONCILED_REFUNDS=false`). The opt-in implementation reconciles Account/Credit debt, records immutable evidence and rejects duplicates. Cash/card/UPI transfers remain external operator actions. Old invoices without trusted proofs need administrator review.
- Counter drafts survive reload within a session. Sign-out clears drafts and reloads to discard in-memory records. Operational views wait for server-confirmed data. New customer history uses stable customer IDs.
- Managed Firestore backups are authoritative. Client-side financial restore/reset is closed; preserve ledger, proof and idempotency records in any administrator restore.

## Local interactive emulators

Install the official reviewed Firebase CLI separately (the audit used 15.37.0).

```sh
firebase emulators:start --project demo-billingapp --only auth,firestore,functions
VITE_USE_FIREBASE_EMULATORS=true npm run dev
```

Emulator ports default to Auth 9099, Firestore 8080 and Functions 5001 on loopback. Matching optional `VITE_FIREBASE_*_EMULATOR_PORT` overrides support isolated local instances. The dedicated test runner chooses its own Firestore port. Production builds reject emulator mode.

## Deployment and migration

Functions require Blaze. The first rollout needs a maintenance window, backups, deny-direct-write rules, Functions, a reviewed dry-run/apply migration and then Hosting. Use the exact ordered commands in [the audit](PRODUCTION_AUDIT.md#manual-cutover-steps). Migration defaults to dry-run and applying requires `--plan`, `--ack-backup` and matching `--confirm-project`. No migration was run against production by this task.

Set `functions/.env.PROJECT_ID` from `functions/.env.example`: approved HTTPS `POS_ALLOWED_ORIGINS`, and `ENABLE_RECONCILED_REFUNDS=false`. Keep the public UI flag `VITE_ENABLE_RECONCILED_REFUNDS=false` in the browser build until the separately reviewed refund rollout. Required public web build variables are `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. Other registration values are optional; all VITE values are browser-visible. Private Admin/payment/AI credentials never belong in VITE variables.

For later releases after cutover, `npm run deploy -- --project PROJECT_ID` deploys the financial Functions codebase, Hosting and rules. It does not apply migrations or enable refunds. Production deployment was not performed here.

Create the first owner Auth user and `operators/{uid}` through a trusted Firebase administrator. Client code cannot provision owners. Restrict API keys/domains, review Auth policy and owner grants, configure managed backups, billing/error alerts and HTTPS, and run signed-in staging tests before opening terminals.

The old embedded ledger already discarded entries beyond fifty. Migration preserves all available evidence and the current balance, marks history incomplete, and cannot recover absent records. Reconcile older backups and legacy refunds before treating historical statements as complete.

The app uses hash navigation, a real path 404 and security headers. `/health` checks static Hosting availability only. Tables/channel legacy components are retained but not re-enabled. Physical printer and bank-transfer behavior requires operator validation.
