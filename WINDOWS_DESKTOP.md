# Windows offline cash counter

The desktop version adds an Electron cash counter with an encrypted SQLite outbox. The original web POS opens in a separate **Full online POS** window. Walk-in cash sales for Counter/Takeaway work offline after an online staff sign-in. Credit, collections, refunds, UPI/card, discounts, tables, expenses, owner reports and catalog changes require the online POS. Refunds remain disabled by their existing server gate.

## Backup and rollback

The unchanged web version is commit `901574f459f6828a759ebd74d88d689121050ed7` on `prod-hardening`. Tag `backup/pre-windows-offline-20261128-162957` is pushed to GitHub. The private backup is `/Users/spidey/Developer/Aavin POS Backups/before-windows-offline-20261128-162957/`: verified source/build archives, a Git bundle, checksums and restricted private environment copies. **This is not a live Firestore backup.** Never upload `private-config/` or include it in an installer.

Recover into another directory without overwriting current work:

```sh
git worktree add ../aavin-web-checkpoint backup/pre-windows-offline-20261128-162957
# Alternatively, clone the saved repository.bundle into a new directory.
```

## Build

Use Node 24+ and the existing public Firebase registration in root `.env`, with emulators disabled.

```sh
npm ci
npm ci --prefix functions
npm run verify
npm run desktop       # build and run on this computer
npm run package:win   # create Windows x64 installer; never publish
npm run check:desktop-package
```

Output: `releases/Aavin-POS-1.0.0-Windows-x64-Setup.exe` and its `.sha256` checksum. `releases/win-unpacked/` contains the unpacked app. The installer is **unsigned**; no certificate or paid service was purchased. Installation is per Windows user, without elevation; uninstall preserves counter data. Node/SQLite are bundled. The Windows PC needs no Node, Java, Firebase CLI or administrator/service-account key.

Packaging checks inspect the ASAR file allowlist, compare all runtime source/assets with staging, check the public-only config and validate hardened Electron fuses. Server/Admin code, runtime npm dependencies, environment files and private reports are excluded. Cross-building does not verify Windows execution or printer drivers.

## Manual setup before using it

1. Publish the updated backend from `codex/windows-offline`, or review/merge it into your selected deployment branch. Follow `FREE_HOSTING.md` for the chosen Spark + free hosted backend. **No Blaze upgrade is required.** This conversion does not deploy an app/backend, create a provider account or change cloud permissions. The old backend will safely reject the new `offlineReceipt` field until updated.
2. Configure a dedicated server identity, matching Firebase project, HTTPS address and public web registration. Keep `ENABLE_RECONCILED_REFUNDS=false`. Existing approved Firestore rules stay unchanged. Do not permit direct client financial writes or introduce wildcard CORS. Native transport uses the existing authenticated callable API and sends no browser Origin header.
3. Verify Firebase API key restrictions. An HTTP-referrer restricted browser key may reject native REST requests. If needed, create a separate **public client key** restricted to the required Firebase Auth/token and Firestore APIs and build with `DESKTOP_FIREBASE_API_KEY` set. Keep the web key's restrictions. Never use an Admin/service-account key here. API registration keys do not replace Firebase authentication or rules.
4. Install on a Windows 10/11 x64 test PC after comparing the checksum. Enter your trusted backend **origin**, without `/api`. Setup checks `/build-info.json` for the packaged project and rejects emulator builds and redirects. HTTP is allowed only on loopback for local development; a Mac's `localhost` address will not reach it from Windows.
5. Staff sign in online with their Firebase email/password and choose a **separate offline passphrase of at least 8 characters**. This downloads the catalog and permits local cash billing for 24 hours. Owners cannot unlock offline. The full online POS signs in independently and retains its existing authorization.
6. Perform the Windows staging checklist below. Set up the receipt printer and test restoration of both the counter database and Windows account/profile keys. No production migration, data reset, functions deployment, rules publication or billing activation is performed by this conversion.

## Queue, receipts and conflicts

The main process validates product IDs/options, integer quantities and tender against the cached catalog. It rejects renderer prices/totals, customer IDs, discounts and credit. A unique UUID and device-specific local reference are durably committed with SQLite WAL/FULL before a receipt appears. A saved receipt must be opened/closed before starting another bill; an interrupted acknowledgement is recovered on the next unlock.

Sync runs on startup/sign-in and every 15 seconds while the app is open, with bounded batches and retry backoff. It can finish queued uploads after the staff lock the counter. Closing the app or shutting down Windows pauses sync; reopening resumes it. This is not a Windows service. **Sync now**, pending/review counts and the most recent 100 local receipts are visible. Counts include older records.

The server authenticates the originating Firebase user and rechecks current active staff, workspace and migration state. It reads current DB products and recomputes prices/totals before assigning the official invoice number and writing immutable financial proofs. `expectedTotal` is only a stale-price guard. Lost-response retries reuse the exact immutable payload and ID and return the same invoice.

Changed totals, removed products, disabled/revoked staff, workspace changes or incompatible setup retain the original bill in **Needs review**. No receipt is deleted, silently repriced or automatically refunded. Restore legitimate access/setup and retry the unchanged request where appropriate. Permanent conflicts require owner reconciliation of already-collected cash using a reviewed administrator workflow. Automatic conflict reconciliation is not implemented. **Do not re-enter a pending sale as a new bill.**

Offline receipts are explicitly **provisional** until server acceptance. The final invoice retains the local reference and unverified device capture time. **Accounting/report dates use the server's acceptance time**, including when sync crosses India midnight. Device time never establishes trusted financial dates or payroll attendance. Final invoice numbering at offline checkout, guaranteed historical catalog prices and device-time-based reports need a separate reviewed design.

## Attendance, security and recovery limits

Online desktop contact uses the existing staff heartbeat/logout endpoints. Deferred checkout sync does not create a false staff login. Local unlock/lock events are encrypted as `device-only` observations. They are **not uploaded as verified attendance or included in owner working-hour totals**. Owner attendance remains server-confirmed time; offline hours need manual review. Offline payroll/shift reconciliation is future work.

The local renderer is sandboxed and isolated, with no Node or network access. IPC is narrow, bounded and restricted to the main frame and exact local origin. Remote windows have no preload/bridge. Arbitrary navigation/popups and permissions are denied. Packaged binaries disable RunAsNode, Node environment options and CLI inspection and require integrity-checked ASAR app code.

Refresh tokens, cached grants/catalog and bills use Windows DPAPI encryption (macOS Keychain in development). Firebase passwords are not persisted. Offline passphrases use salted scrypt hashes, persistent attempt lockout, a 24-hour lease and detected clock-rollback denial. Revocation cannot be learned while disconnected. Someone controlling the same Windows account, app or administrator privileges can access DPAPI secrets or tamper with clocks/app code; use protected Windows accounts, disk encryption and locked terminals.

Owner **Back up counter** uses SQLite's consistent online backup, including WAL data. The backup is decryptable only under the **same Windows account/profile**. A copied DB alone cannot recover data on another PC/user. Maintain a full encrypted system/profile backup and test restoration. To restore, close POS, preserve the entire current user-data folder, restore `counter.sqlite` under the same Windows profile, and reopen. Old WAL/SHM files belong with the preserved old DB, never the restored DB. Do not reset a counter with unsettled receipts. Portable independently encrypted recovery is not implemented.

## Windows staging acceptance

- Online staff/owner sign-in, offline staff unlock, incorrect-passphrase lockout, lease expiry and clock rollback. Staff still cannot read owner ledger/reports.
- Save/print a cash bill, disconnect, close/reopen, unlock and verify the same pending reference, total, received amount and change. Insufficient cash, forged options and credit attempts fail.
- Reconnect: exactly one official invoice and settlement, unchanged total and local reference. Repeat sync and interrupt after server success: no duplicate revenue.
- Separately change catalog prices, revoke staff and switch workspaces in staging. Affected receipts remain visible for review; no silent changes or drops.
- Print/reprint at 80mm on the actual printer; test cancellation, multi-operator switching, midnight report dates, verified-attendance gaps and Windows/profile+DB restoration.

The installer is a **staging candidate**, not a production approval. Live HTTPS hosting, dedicated identity, availability/monitoring, backups/recovery and Windows/printer acceptance remain required. Free hosting sleep/availability limits still affect online operations.
