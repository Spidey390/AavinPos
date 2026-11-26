# Production security audit — 26 November 2026

**Final verdict: NOT SAFE TO DEPLOY.** Code-level hardening is implemented on `prod-hardening`, but H04, H05 and H07 require architecture/schema/access-policy decisions before production customer-account use. H06 must be resolved before enabling manual refunds. The source changes have not been deployed.

Stack: React 18 / Vite / Firebase Authentication / Cloud Firestore / Firebase Hosting. There is no Express, Python, custom API server, AI endpoint, SQL server or server upload handler in this repository.

The workspace had no `.git` directory. Git was initialized directly on `prod-hardening` before source changes, and `58594fe` captures the original source. Before locations below refer to that snapshot; current locations refer to the hardened branch. Earlier history and current cloud configuration/deployed rules were unavailable. `.env` was inspected without printing values and remains ignored and unchanged. No source files were deleted.

## Before / after findings

| Severity | ID | Before finding | Before location | After / remaining action | Current location |
|---|---|---|---|---|---|
| CRITICAL | C01 | Any signed-in user could create an owner profile; login also auto-created Auth accounts. | `firestore.rules:41; src/components/auth/OperatorGate.jsx:94` | Fixed: only trusted administrators create owners; public login only signs in. | `firestore.rules:106` |
| HIGH | H01 | An email substring granted owner UI access, including error/cache fallbacks. | `src/components/auth/OperatorWorkspace.jsx:9` | Fixed: authorization requires a server-confirmed active operator profile. | `src/components/auth/OperatorWorkspace.jsx:22` |
| HIGH | H02 | Staff could rewrite balances, ledger contents and customer statistics without a real sale/payment. | `firestore.rules:96` | Fixed: exact monetary reconciliation, append-only rolling history, new-invoice coupling and identity checks. | `firestore.rules:53` |
| HIGH | H03 | Checkout never checked the customer credit limit against current transaction data. | `src/db/db.js:367; src/domain/customers.js:11` | Fixed: concurrent checkout reads and checks the canonical customer; rules require an atomic debit within the limit. | `src/db/db.js:389` |
| HIGH | H04 | Client-defined invoice lines/subtotals and nested drafts were not comprehensively validated by the server. | `firestore.rules:107; src/db/db.js:378` | PARTIAL / BLOCKER: scalar/tender/sequence checks added; forged lines still pass direct writes. Trusted settlement or a line-document schema needs your decision. | `firestore.rules:35` |
| HIGH | H05 | Staff can read embedded ledger fields that the UI presents as owner-only. | `firestore.rules:73` | OPEN / BLOCKER: split private ledger data from staff-readable customer summaries, or explicitly revise the access policy. | `firestore.rules:140` |
| HIGH | H06 | Refunding an Account/Credit invoice does not reduce the customer debt. | `src/db/db.js:478` | OPEN / BLOCKER when refunds are enabled: requires an agreed atomic refund/reconciliation design. Refunds remain disabled by default. | `src/db/db.js:498` |
| HIGH | H07 | Embedded account transactions discard entries older than the newest 50, losing payment history. | `src/db/db.js:393; src/db/db.js:455` | OPEN / BLOCKER for production customer accounts: approve a durable, immutable payment/refund ledger and migration. | `src/db/db.js:414` |
| HIGH | H08 | Untrusted category/staff/item names could address inherited object properties in reports. | `src/components/reports/BusinessReports.jsx:97; src/components/dashboard/OperationsDashboard.jsx:83` | Fixed: aggregation dictionaries have no prototype; browser-tested with __proto__ names. | `src/components/reports/BusinessReports.jsx:98` |
| HIGH | H09 | The default deployment published Hosting without the Firestore rules. | `package.json:11` | Fixed: deployment scripts include hosting and firestore:rules. Production publication was not performed. | `package.json:11` |
| MEDIUM | M01 | Production CSP allowed inline scripts, broad network/image hosts and loopback connections; no HSTS header. | `index.html:9; firebase.json:22` | Fixed: HTTP CSP with exact Firebase endpoints, no inline scripts/loopback in production, HSTS and framing/MIME protections. | `config/security.js:1` |
| MEDIUM | M02 | Missing Firebase configuration only logged an error; production builds could succeed. | `src/services/firebaseApp.js:31` | Fixed: missing, placeholder, demo, unexpected public variables and production emulator mode fail closed. | `src/domain/firebaseConfig.js:8` |
| MEDIUM | M03 | Default persistent Auth state outlived shared-terminal sessions; counter drafts survived sign-out. | `src/components/auth/OperatorGate.jsx:6; src/context/AppContext.jsx:31` | Fixed: session persistence and per-operator draft cleanup on sign-out. | `src/services/auth.js:5` |
| MEDIUM | M04 | The browser-only cooldown can be bypassed through direct Firebase Auth calls. | `src/components/auth/OperatorGate.jsx:102` | OPEN configuration review: Firebase enforces provider limits, but project-specific quotas, password policy, enumeration protection and App Check enforcement were not available to inspect. | `src/components/auth/OperatorGate.jsx:92` |
| MEDIUM | M05 | Malformed saved drafts or render/import failures could blank the app. | `src/context/AppContext.jsx:31; src/main.jsx:8` | Fixed: persisted draft validation, top-level error boundary and safe recovery/loading UI. | `src/domain/drafts.js:6` |
| MEDIUM | M06 | CSV report text could execute spreadsheet formulas. | `src/components/reports/BusinessReports.jsx:126` | Fixed: formula-prefix neutralization and correct CSV quoting; export uses a revocable Blob URL. | `src/domain/csv.js:7` |
| MEDIUM | M07 | CSV import split on commas, accepted partial numeric strings and had no size limit. | `src/domain/csv.js:6; src/components/menu/MenuCatalog.jsx:636` | Fixed: quoted fields, exact currency parsing, 2 MB / 5,000-product limits and file-read errors. | `src/domain/csv.js:5` |
| MEDIUM | M08 | Collections are subscribed in full; reports and customer history grow with all stored orders. | `src/db/db.js:42` | OPEN scale decision: choose retention, pagination and server aggregates. Silently limiting reads would understate financial totals. | `src/db/db.js:44` |
| MEDIUM | M09 | Customer purchase history used an older order field shape and UTC grouping. | `src/components/crm/CustomerCRM.jsx:95` | Fixed: current customerPhone invoices are included; grouping uses India business dates and skips invalid dates. Stable customer IDs on invoices remain a future schema decision. | `src/components/crm/CustomerCRM.jsx:97` |
| MEDIUM | M10 | Staff account forms offered profile/credit administration that server rules reject; failed imports closed and lost retry context. | `src/components/crm/CustomerCRM.jsx:551; src/components/menu/MenuCatalog.jsx:93` | Fixed: owner-only administration fields/controls; import dialog stays open on failure. | `src/components/crm/CustomerCRM.jsx:221` |
| MEDIUM | M11 | Raw provider messages reached toasts/logs, while production stripped all application logging. | `src/context/AppContext.jsx:207; vite.config.js:29` | Fixed: safe provider messages and structured event/code logs; production retains sanitized application error logging. Centralized monitoring remains an operational choice. | `src/services/errors.js:1` |
| MEDIUM | M12 | Currency entry/restore validation allowed negative restored prices or prices that checkout cannot settle; staff passwords could exceed the login input limit. | `src/db/backup.js:11; src/components/menu/MenuCatalog.jsx:226; src/components/staff/StaffPermissions.jsx:26` | Fixed: negative prices rejected on restore, exact currency validated at entry, staff passwords bounded to the sign-in limit. Historical positive price precision is preserved on backup import. | `src/db/backup.js:10` |
| MEDIUM | M13 | Bulk CSV imports write multiple independent batches and can partially apply after interruption. | `src/db/db.js:306` | OPEN workflow decision: define whole-import atomicity/idempotency and recovery before changing schema or import semantics. Owners should inspect partial imports before retrying. | `src/db/db.js:318` |
| LOW | L01 | No static health endpoint, real path 404 or descriptive metadata. | `firebase.json:12; index.html:10` | Fixed: /health, hosting 404, description/robots/theme metadata; favicon retained. | `public/health.json:1` |
| LOW | L02 | No lint script or database authorization regression tests. | `package.json:6; tests/domain.test.js:230` | Fixed: ESLint, isolated rules/real-transaction tests, secret scan and combined verify command. | `package.json:17` |
| LOW | L03 | Several dependency major versions trail current releases. | `package.json:18` | Compatible updates applied; React 19, Vite 8, plugin-react 6 and Tailwind 4 migrations require a separate compatibility plan. npm audit reports zero vulnerabilities. | `package.json:19` |
| LOW | L04 | Unreferenced components and stale marketing/operating claims remain in retained source. | `src/components/landing/LandingFeaturesModal.jsx:9; src/components/tables/TableManagement.jsx:45` | README corrected; no source files deleted. Decide whether to keep or remove the listed legacy components. | `src/components/landing/LandingFeaturesModal.jsx:5` |
| LOW | L05 | Firebase/Firestore still produces a large shared browser chunk. | `src/services/branding.js:1` | Initial entry improved from ~319 kB to ~147 kB; Firestore chunk remains ~558 kB (~148 kB gzip). No bundle warning is raised at the existing 600 kB limit. | `src/services/branding.js:1` |


## 1. Secrets

No private service-account credentials, private keys, database credentials, JWT signing secrets, payment-provider keys or AI keys were detected in source, ignored environment files, build output or the available newly created Git history. This is a heuristic scan plus targeted review, not evidence about unavailable earlier history. `.env` variants and logs/build artifacts are ignored; `.env.example` is tracked. A public-variable allowlist rejects unexpected `VITE_*` names at build/startup.

The existing environment contains Firebase web registration only. Its API key is intentionally browser-visible and does not grant Firestore authorization. No private key was replaced and no private-secret rotation is required by this scan. Review API/referrer restrictions and rotate the web key if it has been abused or enabled for unrelated paid APIs. See [Firebase API-key guidance](https://firebase.google.com/docs/projects/api-keys).

## 2. Authentication and IDOR

Owner provisioning now requires a trusted Firebase administrator. Signing in cannot create an Auth account or grant an owner role. Missing, disabled, cached or failed operator reads do not grant access. Losing server verification after sign-in shows an access error instead of an indefinite loading screen. Owners may create staff only; staff cannot promote themselves or others. Disabling an operator is checked by Firestore rules on protected operations.

Actual emulator requests test anonymous/unprovisioned/disabled denial, operator escalation, configuration/catalog writes, inactive-workspace access, and staff A reading/writing staff B expenses. Own-expense queries require the caller UID; staff-wide expense enumeration fails. Orders and customer summaries are intentionally shared within this single business, rather than scoped to the cashier who created them. This is not a multi-tenant application.

Passwords and token issuance are handled by Firebase Authentication. There is no application password table or JWT signing key to replace with bcrypt/argon2. Firebase ID tokens expire after about an hour; refresh/session management is provider-owned. Browser auth now uses session persistence. Cookie flags are not applicable to the existing token-based SPA; an HTTP-only cookie design would require a trusted API. See [Firebase session management](https://firebase.google.com/docs/auth/admin/manage-sessions).

## 3. Input validation

Firestore rules now validate monetary scalars, tender types, sequence transitions, customer identity creation, credit limits and customer balance/statistic deltas. The real checkout transaction validates the current bill and current customer rather than relying on stale UI state. Payment-history updates preserve the retained prefix and must reconcile exactly. Staff cannot inject a refund while creating an invoice.

**H04 remains:** rules do not validate every nested item/draft and do not prove that line totals equal subtotal or catalog prices. Client checks are bypassable. One diagnostic intentionally writes a forged invoice successfully. A trusted settlement endpoint or a different line-item schema is required. Do not treat the client validator as a server security boundary.

New bill limits are 500 lines and monetary scalars up to 1,000,000,000, with two decimal places; discount percentages are 0–100. CSV imports are bounded and support quoting; exports neutralize spreadsheet formulas. QR uploads are browser-only, limited by file type/size, rendered down to 640 px, saved as PNG/JPEG data URLs and capped below Firestore's document limit. No executable HTML rendering, eval/Function construction, server filesystem path handling, SQL/NoSQL string queries or server upload/exec endpoint was found. React escapes rendered values. Backup validation rejects unsafe IDs, duplicate IDs, malformed data and negative restored sale prices while retaining legacy positive price precision.

## 4. API hardening

Firebase Hosting headers provide CSP, HSTS, MIME, framing, referrer and permission protections. Production CSP allows exact Firebase Auth/token/Firestore endpoints, excludes loopback and inline scripts, and retains inline styles required by the current UI. Development has explicit loopback/HMR allowances. Hosting configuration and preview headers are tested for equality. The dev/preview servers use `cors: false`; protected Firestore requests rely on Auth and rules.

There is no application server on which Helmet or an Express limiter would run. Firebase supplies server-side Auth abuse limits. The browser cooldown is only a UX control. Project quota adjustments, password policy, email-enumeration protection, authorized domains and App Check enforcement require cloud configuration review; none was silently enabled. See [Firebase Auth limits](https://firebase.google.com/docs/auth/limits).

Application logs contain structured event/code pairs and omit raw errors, customer records, credentials and stacks. Provider failures get safe UI messages. External log collection/alerting is not configured by this source patch.

## 5. Dependencies

`npm audit` reported **0 vulnerabilities before and after**, including dev dependencies in the final tree. Compatible updates include Firebase 13.4.0, lucide-react 1.81.0, autoprefixer 10.7.0 and React type patches. Direct dependencies resolve from npm; no hallucinated package was found. All runtime dependencies have source imports. React 18.3.1, Vite 6.4.6, plugin-react 4.7.0 and Tailwind 3.4.19 remain behind current majors; a compatibility migration was not forced into a security patch.

The deployment CLI is managed separately. Rules tests run a pinned, SHA-256-verified official emulator directly, avoiding an unrelated deployment CLI dependency tree in the app. ESLint checks correctness/security patterns; its core unused-variable rule is disabled because it does not track JSX component references. Retained unused-file candidates were checked separately.

## 6. AI code smells / unused source

The unsafe automatic owner bootstrap and email heuristic were removed. The default datasets are empty, not a demo catalog. No debug HTTP routes or AI endpoints were found. Empty catches in optional native date pickers/storage fallbacks are deliberate feature recovery rather than authorization bypasses.

Retained, apparently unreferenced components: `src/components/landing/LandingFeaturesModal.jsx`, `src/components/layout/SelectDropdown.jsx`, `src/components/tables/TableManagement.jsx`, and `src/components/pos/TableSelectModal.jsx`. The landing component contains stale walkthrough/compiler/offline-storage claims. Legacy supplier/purchase/raw-material data and backup/reset functions are also retained for compatibility. Confirm whether to keep or remove them; none was deleted or re-enabled.

## 7. Database

Only the brand name is publicly readable by design. Business documents require active operator authorization. Owner access is business-wide; staff are limited to the active workspace, shared operational records and their own cash expenses. Local emulators are loopback-only and always use demo projects; production build flags prevent accidental emulator deployment. Separate cloud projects remain an operator setup step.

**H05–H07 remain:** customer documents expose their embedded ledger to staff; account refunds leave debt unchanged; history drops entries older than 50. Firestore reads return the whole document, so private fields require separate storage/access policy. See [Firestore field access guidance](https://firebase.google.com/docs/firestore/security/rules-fields). Approve an immutable payments/refunds collection, stable customer references and atomic settlement/refund reconciliation with a migration/backfill plan.

Existing expense queries use automatic single-field indexes; no missing composite-index requirement was identified. Consider index exemptions for large QR/array fields as a reviewed database configuration change. Current subscriptions are unbounded, not paginated. Checkout uses a bounded set of transactional reads rather than per-line server queries. Exports deliberately read twice to detect concurrent changes; they are not a substitute for managed backups/PITR.

## 8. Functionality

Traced login → active operator → workspace/config → catalog/customer selection → bill/tender → invoice sequence + customer transaction → receipt → account payment → owner report. Automated tests use actual Firestore rules and production transaction functions, including concurrent credit-limit races and duplicate invoice retries. Counter drafts are validated before use and cleared on sign-out. Customer history recognizes current invoices and India dates. Role-incompatible customer controls are hidden, and failed imports retain retry context. A top-level error boundary handles lazy-load/render failures.

Interactive browser smoke test used separate local demo ports 9199/8180 and app port 3001: staff sign-in, customer selection, Account checkout AP-1001, due balance 100 → 125, recording payment 25 → due 100, owner sign-in/reports, hostile `__proto__` category/staff/item names, and sign-out. Existing local services were left running. No production records were changed. Physical printer hardware, actual money transfer, payment-provider confirmation and cloud deployment were not tested.

Table/channel components are not wired into current role navigation; existing access tests explicitly exclude table management. They were preserved instead of changing product scope. README now describes the exposed flows. Whole-import atomicity/recovery also needs an agreed workflow before changing batched import semantics.

## 9. Performance

The production build succeeds without warnings at its configured threshold. Initial entry is ~146.7 kB (~47.5 kB gzip), compared with ~319.3 kB (~83.2 kB gzip) before lazy startup/error containment. The shared Firestore chunk remains ~558.1 kB (~147.8 kB gzip). Views and payment/receipt UI remain lazy-loaded. No external product-photo catalog exists; uploaded QR images are resized/capped.

Financial reports require complete data today. Adding a silent query limit would create incorrect totals. Choose date-scoped pagination, server-side aggregates, retention and a production data-size/load target before larger deployment. Billing load tests were not run against the live project.

## 10. Deployment

`.env.example`, required build-variable validation, sanitized logging, `/health`, a real path 404, favicon and metadata are present. `/health` reports static hosting availability, not backend readiness. Default deploy scripts publish Hosting and Firestore rules together with an explicit CLI project selection. No deployment was performed.

HTTP checks against local production preview: `/` 200, `/health` 200 JSON with `no-store`, unknown path 404, missing asset 404; CSP/HSTS present. Negative builds rejected missing API configuration and emulator mode. Hosting policy JSON matches tested preview policy. Verify the actual published headers/rules after an authorized deployment.

## Verification results

- Every source fix batch ran dependency installation, lint, tests and a production build before committing. The final command is `npm run verify`.
- Final suites: **24 unit/deployment tests + 18 Firestore tests = 42 passing tests**. **Three are diagnostics that intentionally demonstrate unresolved vulnerabilities**, leaving 39 ordinary regression/behavior checks. Green status does not override the NOT SAFE verdict.
- `npm audit`: 0 reported vulnerabilities. No Python dependency tree exists, so pip-audit is not applicable.
- Missing-configuration and production-emulator negative builds failed as expected.
- Secret scan: no private credentials detected in the working tree (including ignored `.env` and `dist`) or all available commits. Earlier history did not exist in this workspace.
- Real browser smoke flows and local HTTP behavior are described above. The latest compatible dependency updates also passed the actual transaction suites and production build; the interactive browser run preceded those compatible updates.

## Manual auth / IDOR checks

Run `npm run test:rules`. The tests contain concrete cases for anonymous/unprovisioned/disabled access, self-owner creation, staff promotion, operator provisioning, cross-staff expenses, own-UID expense queries, archived workspace access, unauthorized catalog/config writes, direct balance tampering, invoice replay and credit-limit races.

For read-only production verification after publishing rules, set the variables locally from your authorized test accounts; never commit tokens:

```sh
# Expected 403 for staff A reading staff B's expense; 200 for staff A's own expense.
curl -sS -o /dev/null -w '%{http_code}\n'   -H "Authorization: Bearer ${STAFF_A_ID_TOKEN}"   "https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/posWorkspaces/${WORKSPACE_ID}/expenses/${STAFF_B_EXPENSE_ID}"

# Expected denial without authentication.
curl -sS -o /dev/null -w '%{http_code}\n'   "https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/posConfig/current"

curl -i "https://${POS_DOMAIN}/health"
curl -I "https://${POS_DOMAIN}/"
curl -I "https://${POS_DOMAIN}/does-not-exist"
```

Write-based attack diagnostics are confined to the isolated demo test runner.

## Needs your input

1. **Release blocker, H04:** choose/approve a trusted settlement API (for example Firebase Functions or an existing server) or a new line-document schema. Validate catalog/custom-item policy, discounts, every line and all derived amounts on the server; retain idempotency and atomic customer/table updates.
2. **Release blockers, H05–H07:** decide staff visibility, approve a durable immutable payments/refunds schema with stable customer IDs and migration/backfill, and define atomic Account/Credit refund behavior. Keep manual refunds disabled pending reconciliation.
3. Choose scale/retention/report aggregation targets and whole-import atomicity/recovery semantics before schema/workflow changes. Decide a major framework/tooling upgrade plan separately.
4. Review cloud-side Auth/API restrictions, abuse controls, production ownership, backup/PITR, monitoring and domain/HTTPS. Their current state was not available locally; new paid services were not configured.
5. Keep or remove the listed unused components/legacy features? Provide earlier repository history if historical secret verification is required.

## Manual deployment steps

1. Resolve H04–H07 and rerun the known-blocker diagnostics with expectations changed to secure behavior. Review existing operator owner grants and revoke unapproved access through a trusted Firebase administrator. Create the legitimate owner profile manually if needed.
2. Set the required public Firebase build variables in the production build host/CI; use a separate staging project. Restrict the public API key, required APIs and approved origins. Enable the intended Auth password/enumeration/abuse protections. No private secret was found to rotate; rotate any abused or previously leaked keys discovered in unavailable history.
3. Enable managed backups/PITR as appropriate, set retention and billing/security alerts, and perform a restore drill. Configure centralized error monitoring if desired.
4. Connect the production domain, verify Firebase-managed HTTPS/SSL, run `npm run verify`, and deploy both Hosting and Firestore rules using an explicit production project. Review shared-project rules before replacing them.
5. Repeat the read-only auth/IDOR and HTTP checks above against the deployed project. Monitor `/health` as static availability plus a separate authenticated backend probe when one is implemented.

## Commits made

```text
58594fe chore: snapshot codebase before production audit
ed1d253 fix(auth): prevent owner self-provisioning and fail closed on profile errors
f34e785 fix(database): validate financial writes and enforce checkout credit limits
91e49b9 fix(reports): isolate aggregation keys from object prototypes
cdead2b fix(input): bound CSV imports and neutralize spreadsheet formulas
e4555ec fix(runtime): recover from corrupt drafts and contain shared-terminal sessions
2d4e969 fix(deploy): enforce production config and secure static hosting
d2a3367 fix(customers): align account forms with enforced operator permissions
8684f9a chore(deps): update compatible packages and retain a clean audit
4ba5c89 test(security): verify auth boundaries and document unresolved financial risks
845c606 fix(validation): reject invalid currency and align credential entry limits
```

This report and the updated README are recorded in a separate documentation commit; its final hash is listed in the chat response / `git log`.

**Final verdict: NOT SAFE TO DEPLOY.** Remaining release blockers are trusted invoice validation, owner-only ledger isolation and durable financial history. Account/Credit refund reconciliation must also be resolved before enabling manual refunds. Local verification cannot certify the uninspected live Firebase configuration or unavailable earlier Git history.
