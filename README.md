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

Open **Staff & Roles**, or choose **Staff activity** on the owner dashboard. Choose a **Selected day**, use **Today**, or switch to **Date range** for up to 31 inclusive India dates. Each staff card shows today's working hours separately from the selected day's/period's hours, each recorded login/logout interval, daily totals, sales, expenses and cash remaining. Reports refresh every minute while visible. Staff with the same display name remain separate, disabled staff remain visible, and available historical actor names are preserved.

Attendance starts when the authenticated staff app first contacts the server; existing Firebase sessions and historical last-login metadata are not backfilled as working time. The app sends a heartbeat every minute and records **Sign out** before clearing authentication. Server timestamps and verified identity determine each interval. Overlapping sessions count once, sessions split at India midnight, and a gap longer than 125 seconds ends the interval at the last verified contact. Reconnecting starts a new interval. Closing a tab or losing the network is shown as an interrupted session with no invented logout time. Offline sign-out still clears local authentication. These are recorded app-session hours; work performed away from the app is not inferred.

Cash remaining is cash invoice receipts after change plus cash account-payment collections, minus cash refunds and cash expenses recorded by that staff member. Split payments contribute only their cash portion; UPI/card and unpaid Account/Credit sales do not count as cash. Refund cash is attributed to the operator who recorded the refund. Opening float, owner-handled cash and cash handovers are outside this per-staff figure. Missing legacy actor/tender details show Needs review; pre-cutover periods carry an incomplete-history warning.

The owner-only API uses a read-only transaction, bounded date queries and projections rather than trusting client totals. Attendance rows are retained under `staffAttendanceDays/{day}/sessions/{session}` with private session state under `operatorActivity/{uid}/sessions/{session}`. Staff cannot read these collections, choose another UID, submit timestamps/hours, or directly write attendance records. The rules allow owner reads and deny all client writes. Attendance queries need no new collection-group/composite index. On 27 November 2026 the owner explicitly approved publishing the reviewed rules to `aavin-81398`; only those rules were published, and the released source was checked against the tested file. For another project, publish reviewed rules with `npm run deploy:rules -- --project PROJECT_ID`. No Functions or application deployment was performed for this feature.

Recorded sales, expenses and attendance remain visible before financial migration; cash amounts are withheld as **Setup required**, never guessed as zero. Missing payment-history indexes also withhold cash totals until the index is ready. Checkout and payment recording require a ready financial schema, initialized automatically for a new workspace or supplied by the reviewed migration for retained legacy data. For `aavin-81398`, the owner separately approved publishing the cash-report payment index after discarding test business data; the fresh workspace is ready without legacy migration.

## Free hosting and migration

Follow [FREE_HOSTING.md](FREE_HOSTING.md). The `render.yaml` Blueprint selects the Free plan, Node 24, Singapore, `/health`, and manual future deployments. Both browser and API use the Render origin; there is no need to change Firebase to Blaze or deploy Cloud Functions. A dedicated administrator-approved service-account Secret File is required. Its key never belongs in browser variables or the repository.

Run `npm run build` then `npm run preview` for the Vite production preview, including the protected local API. `npm start` runs the standalone host used by Render. Both bind loopback locally and can use administrator ADC credentials. Copy `server.env.example` to ignored `server.env` and set the intended project. Both production preview modes reject browser builds for the wrong project or with emulators enabled. Hosted startup requires the Render secret file and rejects wrong projects, emulator settings and mismatched builds.

`npm run deploy` and `deploy:all` stop with free-hosting guidance; `npm run deploy:rules -- --project PROJECT_ID` publishes rules only. Future rules changes and any migration of retained legacy data remain maintenance-window operations. The owner-approved test reset initialized a fresh, empty workspace while retaining operator sign-in access. No legacy migration is needed for that workspace. The payment-history index and, after separate approval, the reviewed security rules were published; no application deployment, credential upload or legacy-data migration was performed.

A read-only, type-preserving local backup/verification CLI is available at `functions/scripts/backup-firestore.js` for Spark. Follow its maintenance, privacy and restoration-review instructions in the hosting guide. It is not a managed Firestore export and excludes Auth/rules/indexes/IAM. The existing embedded history may already be incomplete; reconcile older records before accepting statements.

Render explicitly advises against production use of its free instances: they sleep after inactivity and have suspension/usage limits. This route is prepared for free preview/staging; uninterrupted production billing still needs a suitable availability/recovery arrangement. Keep refunds disabled in both browser and backend.

Create the first owner Auth user and `operators/{uid}` through a trusted Firebase administrator. Restrict API keys/domains, review owner grants, backups and monitoring, and test signed-in flows on staging. Physical printer and bank-transfer behavior requires operator validation.

The original Firebase deployment configuration remains for an optional future Blaze rollout. It is not the selected free route. The app uses hash navigation, a real 404 page and HTTP security headers.
