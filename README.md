# Aavin POS

React 18 + Vite, with Firebase Authentication and Cloud Firestore. Staff use counter billing, customer accounts, order history and their own cash expenses. Owners manage products, customers, reports, staff and settings. Owners cannot settle bills. Table/channel components are retained legacy code and are not exposed by the current navigation.

**Production status: NOT SAFE TO DEPLOY.** Read [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) for the remaining settlement, ledger privacy, refund and history blockers. The hardening branch has not been deployed.

## Local setup

Use Node 24 LTS (`.nvmrc`) and Java 21+ for the Firestore emulator tests.

```sh
npm ci
cp .env.example .env
# Set your Firebase web registration in .env.
npm run dev
npm run verify
```

The required build-time values are `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_APP_ID`. The other registration fields are optional. Firebase Hosting does not inject these values at runtime; configure them in the build environment. All `VITE_*` values are public browser configuration. Keep service-account, payment and AI credentials in a trusted backend. Builds reject unreviewed public variable names, missing values, demo projects and emulator-enabled production configuration.

`.env` and environment variants are ignored; `.env.example` is tracked. Use separate Firebase projects and credentials for development/staging and production.

## Verification

```sh
npm run lint
npm run test:unit
npm run test:rules
npm run build
npm audit
npm run check:secrets
# Or run all the checks together:
npm run verify
```

Rules tests start an isolated, loopback-only Firestore emulator on an available port with project `demo-pos-rules`. The first run downloads the official 130 MB emulator and verifies its pinned SHA-256; later runs use the Firebase emulator cache. The Firebase deployment CLI is not an application dependency.

Three tests named **KNOWN BLOCKER** deliberately reproduce unresolved vulnerabilities. Their passing assertions are evidence that the risks remain; a green test run does not make this release safe. Other tests cover actual Firestore permission checks, financial transactions, concurrent credit limits, invoice retries and input handling.

## Interactive local emulators

Install the official Firebase CLI separately in your development/deployment environment, using a reviewed, pinned version. The audit used CLI 15.37.0.

```sh
firebase emulators:start --project demo-billingapp --only auth,firestore
VITE_USE_FIREBASE_EMULATORS=true npm run dev
```

The interactive demo always uses `demo-billingapp` on `127.0.0.1`. Optional `VITE_FIREBASE_AUTH_EMULATOR_PORT` and `VITE_FIREBASE_FIRESTORE_EMULATOR_PORT` overrides support isolated local instances; configure matching ports in the Firebase emulator configuration. Production builds reject emulator mode.

## Production setup, after the audit blockers are resolved

1. Create a dedicated production Firebase project/database and enable Email/Password Authentication. Configure the production build variables from `.env.example`.
2. Create the owner Auth user in the Firebase console. Using a trusted administrator session, create `operators/{ownerUid}` with `role: "owner"`, `active: true`, `name` and `email`. Client code cannot provision owners. Inspect existing owner profiles for unauthorized grants before relying on an older deployment.
3. Review the complete Firestore rules, especially if this Firebase project is shared with other apps. Deploy the hardened rules with the application. Default deploy scripts include both Hosting and Firestore rules; use an explicit project ID.
4. Sign in as owner to initialize the workspace, then use **Staff & Roles** to provision staff. Disable staff access through their operator profile when required. Configure provider password policy, authorized domains, email-enumeration protection and abuse quotas in Firebase.
5. Restrict the public web API key to the required Firebase APIs and approved web origins. Confirm backup/restore procedures, billing alerts, logging, access to the Firebase console, custom domain and HTTPS.
6. Run `npm run verify`, then deploy through your authorized Firebase CLI session:

```sh
npm run deploy -- --project YOUR_PRODUCTION_PROJECT_ID
```

The app uses hash navigation. Unknown URL paths return the hosting 404 page. `/health` returns static-hosting availability only; it does not check Auth or Firestore. Hosting and local preview share CSP, HSTS, framing and MIME protections, with separate development allowances for local emulators.

## Operating behavior

- Checkout requires a connection and commits invoice sequencing and linked customer changes transactionally. Current credit limits are checked inside the transaction. Browser counter drafts survive refresh within the signed-in session and are cleared on sign-out. Shared-terminal authentication uses session storage.
- UPI QR codes request payment; staff confirm actual receipt in the payment app or on the card terminal. There is no payment-provider webhook. Manual payments are operator assertions.
- Full manual refunds default to disabled. **Account/credit refunds currently do not reverse customer debt.** Keep this feature disabled until the audited refund/ledger design is implemented.
- Customer statement history currently retains only the latest 50 embedded entries. This is not a durable payment ledger. Full-collection subscriptions also require a pagination/aggregation plan before larger deployments.
- Reports use India business dates, weeks begin Monday, and new bills apply discounts without adding GST. Older receipts preserve recorded tax. Receipt rendering was smoke-tested; physical printer hardware was not tested.
