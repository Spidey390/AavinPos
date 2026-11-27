# Aavin POS

React/Vite POS with Firebase Authentication, Firestore and a trusted Node financial backend. The selected free route uses **Render Free + Firebase Spark**, serving the browser and authenticated callable API from one web service. Read [FREE_HOSTING.md](FREE_HOSTING.md) for setup and [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) for security findings. The optional Cloud Functions target is retained.

## Setup and verification

Use Node 24+ for root tooling and Java 21+ for the Firestore emulator. The standalone Render host uses Node 24; the optional Functions target uses Node 22.

```sh
npm ci
npm ci --prefix functions
cp .env.example .env
# Set public Firebase registration values for the intended project.
npm run verify
npm run dev
```

`npm run verify` runs ESLint, unit tests, Functions tests, real Firestore/emulated-callable tests, both builds, both dependency audits and the private-credential scan. Tests use isolated demo data. No deployment happens during verification. The former three vulnerability diagnostics now assert secure behavior.

With emulator mode off, `npm run dev` serves the frontend and the authenticated `/api/*` handlers together on loopback. The API uses local administrator Application Default Credentials (`gcloud auth application-default login`) and the Firebase project from the public web configuration. An optional ignored `server.env` is loaded by dev, preview and standalone startup; `POS_PROJECT_ID`, if set, must match that project. Keep credentials outside browser variables and the repository. Vite's actual port, including fallback port 3001, determines the exact allowed local origins. Restart `npm run dev` after changing backend JavaScript or credentials. No deployment or billing upgrade is needed for this local API.

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

## Owner staff activity

Open **Staff & Roles**, or choose **Staff activity** on the owner dashboard. Select an inclusive date range of up to 31 days (India time) and Apply / Refresh. Each staff UID has completed gross sales, bill count, latest recorded login, total expenses, cash received, cash refunds, cash expenses and cash remaining. Staff with the same display name remain separate, disabled staff remain visible, and available historical actor names are preserved.

Cash remaining is cash invoice receipts after change plus cash account-payment collections, minus cash refunds and cash expenses recorded by that staff member. Split payments contribute only their cash portion; UPI/card and unpaid Account/Credit sales do not count as cash. Refund cash is attributed to the operator who recorded the refund. Opening float, owner-handled cash and cash handovers are outside this per-staff figure. Missing legacy actor/tender details show Needs review; pre-cutover periods carry an incomplete-history warning.

The owner-only API uses a read-only transaction, bounded date queries and projections rather than trusting client totals. Recorded sales, expenses and login times remain visible before financial migration; cash amounts are withheld as **Setup required**, never guessed as zero. Missing payment-history indexes also withhold cash totals until the index is ready. Checkout and payment recording still require the reviewed migration. Last login comes from the verified Firebase token's sign-in time, recorded idempotently by the backend on sign-in and authenticated financial calls. It is not an online-status or working-duration tracker. Staff cannot read the report/login collection or write login timestamps directly. Publish the updated rules **and indexes** with `npm run deploy:firestore -- --project PROJECT_ID`; the payments date collection-group index must finish building for complete cash reports. No rules/indexes were published here.

## Free hosting and migration

Follow [FREE_HOSTING.md](FREE_HOSTING.md). The `render.yaml` Blueprint selects the Free plan, Node 24, Singapore, `/health`, and manual future deployments. Both browser and API use the Render origin; there is no need to change Firebase to Blaze or deploy Cloud Functions. A dedicated administrator-approved service-account Secret File is required. Its key never belongs in browser variables or the repository.

Run `npm run build` then `npm run preview` for the Vite production preview, including the protected local API. `npm start` runs the standalone host used by Render. Both bind loopback locally and can use administrator ADC credentials. Copy `server.env.example` to ignored `server.env` and set the intended project. Both production preview modes reject browser builds for the wrong project or with emulators enabled. Hosted startup requires the Render secret file and rejects wrong projects, emulator settings and mismatched builds.

`npm run deploy` and `deploy:all` stop with free-hosting guidance; `npm run deploy:rules -- --project PROJECT_ID` publishes rules only. Rules publication and the reviewed payment migration remain maintenance-window operations. No deployment, credential upload or production migration was performed by this change.

A read-only, type-preserving local backup/verification CLI is available at `functions/scripts/backup-firestore.js` for Spark. Follow its maintenance, privacy and restoration-review instructions in the hosting guide. It is not a managed Firestore export and excludes Auth/rules/indexes/IAM. The existing embedded history may already be incomplete; reconcile older records before accepting statements.

Render explicitly advises against production use of its free instances: they sleep after inactivity and have suspension/usage limits. This route is prepared for free preview/staging; uninterrupted production billing still needs a suitable availability/recovery arrangement. Keep refunds disabled in both browser and backend.

Create the first owner Auth user and `operators/{uid}` through a trusted Firebase administrator. Restrict API keys/domains, review owner grants, backups and monitoring, and test signed-in flows on staging. Physical printer and bank-transfer behavior requires operator validation.

The original Firebase deployment configuration remains for an optional future Blaze rollout. It is not the selected free route. The app uses hash navigation, a real 404 page and HTTP security headers.
