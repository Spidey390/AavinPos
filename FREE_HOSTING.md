# Free hosted setup: Render + Firebase Spark

The selected free route runs one Node web service on Render. It serves the production React build and the authenticated `/api/*` financial endpoints together. Firebase stays on Spark for Authentication and Firestore; no Firebase Functions deployment or Blaze upgrade is required. The financial transaction engine and deny-direct-write rules are unchanged. Refunds remain disabled.

This is a **free preview/staging setup**, not an always-available production commitment. Render explicitly advises against using free instances for production: they sleep after 15 idle minutes, take about a minute to wake, and may be suspended when free allowances are exhausted. Firestore and Auth also have free-plan quotas. Keep the Render service on **Free**, use no paid database/disk/add-ons, and avoid adding a payment method if you require suspension rather than overage billing. See [Render free limits](https://render.com/docs/free) and [Firebase pricing](https://firebase.google.com/pricing).

No Render account, service-account grant/key, credential upload, deployment, rules publication, live backup or production migration was performed by this change.

## 1. Verify the reviewed code locally

```sh
npm ci --ignore-scripts
npm ci --prefix functions --ignore-scripts
npm run verify
```

Root/standalone tooling runs on Node 24. The optional Firebase Functions target retains its Node 22 runtime. `npm start` runs the standalone host on loopback; it needs a production build and the matching project in `server.env` (copy `server.env.example`). Hosting health is `/health`. Do not start the migration until the backup/reconciliation review below.

## 2. Prepare a separate backend identity

A trusted project administrator must create a dedicated service account for the hosted backend, with **Cloud Datastore User** (`roles/datastore.user`) on the intended project. Do not use an Owner/Editor account or the developer's personal ADC credential file on Render. Firebase ID tokens are verified by the shared callable SDK, and the service rechecks the active operator in Firestore for every mutation.

These are manual administrator commands; review the new access before running them:

```sh
gcloud iam service-accounts create aavin-pos-render --project aavin-81398

gcloud projects add-iam-policy-binding aavin-81398 \
  --member=serviceAccount:aavin-pos-render@aavin-81398.iam.gserviceaccount.com \
  --role=roles/datastore.user
```

Create a JSON key for that service account through Google Cloud IAM, save it privately **outside the repository**, and restrict its local permissions to `0600`. The key grants database access. Uploading it to Render authorizes Render's service to use that identity; the owner must approve this transfer. Never paste it into chat, source code, the Blueprint, or a `VITE_*` variable. If the organization forbids service-account keys, stop and choose an approved identity arrangement instead of weakening that policy.

## 3. Configure the Render Free web service

Create/sign in to your Render account and connect `Spidey390/AavinPos`, branch `prod-hardening`. Creating an account/accepting terms and granting repository access remain owner actions.

`render.yaml` supplies the reviewed free service configuration. You can also create a **Web Service** manually:

| Setting | Value |
|---|---|
| Runtime | Node |
| Branch | `prod-hardening` |
| Region | Singapore |
| Instance plan | **Free** |
| Build command | `npm ci --include=dev --ignore-scripts && npm ci --prefix functions --ignore-scripts && npm run build` |
| Start command | `npm start` |
| Health check | `/health` |
| Auto-deploy | Off |

The Blueprint starts an initial deployment when created even though later automatic deploys are off. Review the account/credential setup before creating it. A missing secret or wrong project fails startup; the app never falls back to client financial writes.

Set these Render environment variables:

```dotenv
NODE_VERSION=24.22.3
NODE_ENV=production
POS_PROJECT_ID=aavin-81398
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-service-account.json
ENABLE_RECONCILED_REFUNDS=false
VITE_FIREBASE_PROJECT_ID=aavin-81398
VITE_FIREBASE_AUTH_DOMAIN=aavin-81398.firebaseapp.com
VITE_FIREBASE_API_KEY=YOUR_EXISTING_PUBLIC_WEB_API_KEY
VITE_FIREBASE_APP_ID=YOUR_EXISTING_PUBLIC_WEB_APP_ID
VITE_USE_FIREBASE_EMULATORS=false
VITE_ENABLE_RECONCILED_REFUNDS=false
```

Use web registration values from the same Firebase app. In Render **Environment → Secret Files**, add `firebase-service-account.json` with the dedicated key contents. The process validates the secret's project and the browser build's project before listening. Render's HTTPS URL is automatically approved for API CORS; add exact custom HTTPS origins through `POS_ALLOWED_ORIGINS` only if needed. Keep all emulator variables absent.

Add the service's actual hostname to Firebase Authentication's authorized domains and to any configured web API-key referrer restrictions. Serve both frontend and API from the Render URL. The old Firebase Hosting frontend cannot reach this server via its existing Cloud Functions rewrites. `npm run deploy`/`deploy:all` now stop with guidance rather than attempting a paid deployment.

## 4. Make a local Firestore backup without managed export

Use a separate staging Firebase project with test accounts first. For the real cutover, stop **all** writers/terminals and wait at least 30 seconds for outstanding writes. Preserve an Auth/operator recovery record separately. With your local administrator ADC credentials, run:

```sh
node functions/scripts/backup-firestore.js --project aavin-81398 \
  --out .migration-reports/before-cutover.json --ack-maintenance

node functions/scripts/backup-firestore.js --project aavin-81398 \
  --verify .migration-reports/before-cutover.json
```

This read-only REST snapshot uses one fixed recent Firestore read time for collection discovery and document reads, including nested collections beneath missing parent documents. It preserves Firestore value types and includes document names/update times plus a verification digest. It refuses to overwrite an existing file, stores output with `0600` permissions, prints counts only, and stops above 64 MiB/100,000 discovered paths or 45 minutes. Reads consume Spark quotas. It is not Firebase's managed export format, and does not include Auth users, rules, indexes or IAM. Keep a second private copy outside Render's ephemeral filesystem, and validate a restoration to staging before relying on it as your sole recovery method. Restoration requires a reviewed administrator workflow using the captured document `fields` and paths; browser financial import remains closed.

Review the existing customer balances, legacy refunds and missing older payment evidence before migration. The old fifty-entry cap may already have discarded evidence that cannot be reconstructed.

## 5. Publish rules and migrate only during the reviewed cutover

Once backup/recovery and staging checks pass, publish the same deny-direct-write rules:

```sh
npm run deploy:rules -- --project aavin-81398
```

Generate the read-only migration plan for the active workspace (confirmed at the last readiness check as `204d5dcc4202630c4f0bdbb6604771d7`; recheck `posConfig/current.workspace` before running):

```sh
node functions/scripts/migrate-payments.js --project aavin-81398 \
  --workspace 204d5dcc4202630c4f0bdbb6604771d7 \
  --dry-run --out .migration-reports/review.json
```

Review all errors, counts, current balances and completeness warnings. Only after accepting that evidence and the backup:

```sh
node functions/scripts/migrate-payments.js --project aavin-81398 \
  --workspace 204d5dcc4202630c4f0bdbb6604771d7 \
  --apply --plan .migration-reports/review.json \
  --ack-backup --confirm-project aavin-81398
```

Confirm `posWorkspaces/<workspace>/config/financialMigration.status == ready`, then manually deploy the reviewed Render service. No Firebase Functions or Firebase Hosting deploy is needed for this route.

## 6. Acceptance and remaining production gates

On staging, test real signed-in owner/staff access, forged/direct write denial, catalog checkout, current credit limits, payment retry after an uncertain response, private history, page 404, `/health`, TLS/headers, and reopening the app after the free server sleeps. Run physical printer and operator payment checks. Transactions and idempotency receipts persist in Firestore across service restarts; local Render files do not.

Keep both refund flags false. Switch terminals to the new Render URL only after reconciliation and acceptance. The free provider's sleep/suspension limits and recovery/uptime requirements remain production risks. **Verdict: ready for a free staging rehearsal; not certified safe for unattended live billing on the free service.**
