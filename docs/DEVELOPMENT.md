# AllIn in detail

This page is the full description of what AllIn does, how to run it for development, and what has and has not been verified. For a short introduction, see the [front page](../README.md).

A private, local dashboard for a more intentional day. Markets, health, and tasks share a calm interface while keeping their data boundaries explicit.

**This is the runnable M0 foundation described in [PROJECT_SPEC.md](../PROJECT_SPEC.md), plus the M1 OpenFit import and the M4 optional live market feeds, with a richer synthetic preview.** Real task management, encrypted recovery, and Health import from an OpenFit export file work. Markets are synthetic replay until you turn on a feed, and the preview before you create a vault is always synthetic. Coinbase prices (BTC-USD, ETH-USD) have been read from the real service. **Alpaca stocks (AAPL, NVDA, MSFT) have not been tried on real data**: they are proven only against Alpaca's documented format, so check them yourself with your own paper keys. AllIn places no orders and gives no advice. This is not the M2 release or a production security certification.

## Run on this Mac

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4310**. Use that exact address, not `localhost`: the service validates its Host and Origin. Leave the terminal running. Stop with Ctrl+C; the vault closes when the process exits. The startup banner reads "Offline until you turn on a market feed · models disabled".

The preview opens without an account. Select **Make it yours** to create an empty vault with your own passphrase. The preview's synthetic tasks are not copied into it. No personal vault has been created for you by the implementation process.

Development: `npm run dev` uses the same port and vault location. Stop the production server first. Development serves source through Vite and relaxes script CSP for its runtime; use the built production UI for normal use.

`npm run build` compiles the server into `build/` and the page into `dist/`, and `npm start` runs `node build/server/index.js`, so it works from any folder. `npm run test:build` runs the checks on that compiled build.

Supported hosts: **macOS (verified) and Linux (not yet run on a real box)**. The verified host is macOS on Apple Silicon, Node **26.13.0**, npm **11.20.0**. The package requires Node ≥22.18. Other Node/OS combinations have not been certified. The launcher accepts macOS and Linux and rejects any other host. On Linux the device secret is a file, not the Keychain: see [Linux server](#linux-server). Installation and browser-test setup download dependencies. The running application makes no outbound requests until you turn on a market feed.

## What works

- Responsive Today, Markets, Health, Tasks, Weekly review, and Connections & privacy views, with keyboard capture using ⌘K / Ctrl+K.
- Title-only task capture; projects; priorities; due dates; estimates; optional actual effort; daily/weekly recurrence; completion; editing; deletion; search; and a manual daily schedule.
- Optimistic record versions reject stale writes. Stable capture IDs deduplicate retries. Reopening and completing a recurring occurrence reuses its successor instead of duplicating it.
- Completing a recurring task schedules the next occurrence after both its due day and today, in your display timezone, so finishing an overdue task doesn't create another overdue one.
- The Today view includes overdue tasks, and the Today screen's next three tasks put what's due now ahead of undated work.
- Weekly review counts planned/completed tasks, compares planned effort with effort on those same tasks, reports unplanned effort separately, and distinguishes missing effort from zero. One adjustment can be saved for next week and appears on the Today screen until that week ends.
- A passphrase plus a device secret (the macOS Keychain, or a key file on Linux) protects a random vault master key. The passphrase is stretched with scrypt at N=131072. Three independently derived keys encrypt separate SQLite domain files.
- Authenticated, encrypted backup download and clean-profile restore with a separate recovery phrase. Invalid, tampered, unsupported, or wrong-key backups fail before state creation.
- Five market instruments (synthetic replay by default; see Live market feeds), price/volume charts, transparent 20/50 EMA replay, and inspectable decision evidence. Fixture prices are integer cents. The evaluator knows the NYSE regular-session calendar for 2026–2028, but the fixtures remain a continuous synthetic session. Replay contains no actual exchange prices, orders, or alerts. Live rows come only from a feed you turned on.
- A rule overview for each asset, the later price move after each setup, and a disclaimer on market screens. Setups are rule output for information only, not financial advice or a recommendation to buy or sell.
- Health import from an OpenFit 0.1.11 export file you choose. You choose workouts, weight, or both, and all dates or a date range, and see what will be kept before anything is saved. Only the number of counted workouts on each day and the weight in kg on each day are kept, in the encrypted vault. Re-importing replaces the chosen range without duplicates, and **Purge Health data** removes everything imported, including the weekly goal. A file whose export time is more than a day ahead of the clock is refused. Steps and active calories are not in the export, so AllIn does not show them. A saved vault holds at most 20,000 days per category and 1,000 date ranges; a save past either limit is refused with a message pointing to All dates. Before you create a vault, the Health tab shows synthetic examples. Missing health coverage is visibly different from zero.
- Same-origin request checks, a session that needs both a cookie and a per-tab token, automatic idle locking, and a minimal encrypted local activity history.

Manual tasks work without a model. No model is installed or downloaded. The **Plan my day** action opens manual scheduling; it does not pretend to produce an AI proposal.

## Live market feeds

Both feeds are **off by default**, and with both off AllIn starts no extra process and makes no outbound request. Turn one on from **Connections & privacy**. Its dialog states the destination and what is sent, links the provider's terms, and sends nothing until you confirm.

| Feed     | Symbols                          | Connects to           | Sends                                                     |
| -------- | -------------------------------- | --------------------- | --------------------------------------------------------- |
| Coinbase | BTC-USD, ETH-USD                 | `api.coinbase.com`    | The symbols and your IP address                           |
| Alpaca   | AAPL, NVDA, MSFT (IEX feed only) | `data.alpaca.markets` | The symbols, your IP address, and your Alpaca account key |

- **Coinbase:** select **Turn on** on its row and confirm. It needs no account.
- **Alpaca:** you need a free Alpaca account and a paper trading API key (a key ID and a secret), which can't touch real money. Generate one in your Alpaca dashboard under the paper trading account. Alpaca's screens may change, so follow their own instructions. Enter both fields in the dialog. AllIn tests the key with one request through the sandboxed worker and saves it to Keychain only if that works. Alpaca's free plan carries IEX trades only, about 2.5% of US stock volume. **Stocks are unproven on real data until you check them**: AllIn's Alpaca code has run only against Alpaca's documented format.
- **How it behaves:** prices about once a minute, and each closed 15-minute bar 30 seconds after its close. Each row says whether it is live or replay, the provider and venue, and how old it is. A stale, catching-up, or gapped row pauses new setups. Alerts appear in AllIn only, on Today and Markets, until you dismiss them. A feed you turned on keeps running while the vault is locked, and then the watched symbols and the Alpaca key stay in memory. Quitting AllIn ends it.
- **What's kept:** up to 4,000 bars per symbol (about 41 days of crypto or 7 months of stocks) and 1,000 alerts, in `markets.sqlite`. Backups hold no market data and no keys, and feeds stay off after a restore.
- **Isolation on Linux (not yet run on a real box):** the worker runs inside bubblewrap (`bwrap`), which contains its **file system only**. It sees read-only system folders and the app, and not the vault folder, the key folder or (in the packaged install) the home folders. It can't write outside a private `/tmp`. Unlike the Mac profile, it shares the host's network: it can reach any address and any port, including `127.0.0.1`, the box's own WireGuard address and other machines on your home network, over plain HTTP as well as HTTPS. Only the worker's own list of two hosts keeps it to Coinbase and Alpaca. It can therefore reach AllIn's own address; AllIn still demands a session cookie and its token for every private request, and the worker has neither. It can also start other programs found under `/usr`, which the Mac profile denies. The Mac sandbox is the stricter of the two, and narrowing the Linux worker's network needs its own design. The Linux tests (`tests/feedSandboxLinux.test.ts`) have never run. If `bwrap` is missing or the worker can't prove it can't see the vault, the feed refuses to run.
- **Isolation on a Mac:** the worker that talks to the providers runs inside a macOS `sandbox-exec` profile (Apple has deprecated `sandbox-exec`). If the worker can't prove it is shut out of the vault's data folder, the feed refuses to run. The sandbox still lets it read files outside your home folder, including any backup copies of the vault on external drives under `/Volumes`. It can also read the AllIn project folder, including `.git`, and Node's install folder, even when they sit inside your home folder. It can reach any address on port 443, and look up any name over DNS. Its limits are in [docs/THREAT_MODEL.md](THREAT_MODEL.md).
- **Not verified:** Coinbase's terms of service (their page refused an automated request) and Alpaca's terms are unread, so read them yourself before relying on either feed. That Keychain access is blocked inside the sandbox is unproven. Alpaca has not run on real data.

Setups are rule output for information only, not financial advice, and they also fire on random prices.

## Storage and locking

Default data directory:

```text
~/Library/Application Support/AllIn/
  vault.json       # Salt, vault UUID, authenticated encrypted master key
  tasks.sqlite     # Encrypted tasks, settings, and action/time/outcome events
  health.sqlite    # Encrypted Health summaries: workout days, weights, coverage, goal
  markets.sqlite   # Encrypted market bars, alerts, and which feeds are on
```

On Linux the device secret is a file in a folder you name with `ALLIN_KEYSTORE_DIR`, which must be mode `0700`, owned by the running user, and outside the data folder. On a Mac, the device secret is in macOS Keychain under service `com.allin.local.v1`, account equal to the vault UUID. If you turn on Alpaca, your key is kept in the same Keychain under `alpaca:<vault id>`. Neither is placed in arguments, environment variables, browser responses, prompts, or application logs. The adapter's round trip was verified with a disposable synthetic entry, which was removed. Explicit device-only/synchronization/accessibility policy is **not yet verified** with this native binding. On Linux the Alpaca key is a file in the key folder too, and is not encrypted beyond the folder's permissions.

The vault directory is mode `0700`; database/metadata files are `0600`. SQLCipher-compatible page encryption is selected before database use. Temporary SQLite storage is in memory, DELETE journaling is used, and secure deletion is requested. Keys are best-effort cleared and database handles closed on lock. JavaScript strings, browser memory, OS swap, and OS crash reports cannot be claimed to be securely erased.

An authenticated session expires after **15 minutes without a private API operation**, or eight hours in total. Status polling does not extend it. The browser checks every 15 seconds and when it becomes visible; this bounds normal on-screen cleanup lag, not access to an already-compromised host. Closing the tab alone does not instantly lock the server. Use **Lock vault** when stepping away.

Each private request needs the HTTP-only session cookie and a session token that the unlocking tab keeps in `sessionStorage`. Browsers send cookies to every port on `127.0.0.1`, so another local server could receive the cookie, but the cookie alone reveals nothing and allows nothing. A reload keeps the session. In the default loopback mode, a new tab or another browser asks for your passphrase and takes over the session, and the earlier tab locks the next time it checks in. In network mode up to three devices can be signed in at once, and a fourth sign-in replaces the one idle longest. **Connections & privacy → Signed-in devices** lists them with a **Sign out** button for each. The vault locks when the last session ends, and **Lock vault** ends every session.

**Wrong passphrases are rate limited.** After 5 wrong guesses you wait 1 minute, and each further wrong guess doubles the wait, up to 1 hour. A right guess resets it. The count and the wait are saved in `lockout.json` in the data folder, so restarting doesn't reset them. The wait covers the whole server, not one device or address. A damaged or missing file counts as no failures. This is in both modes.

**Compatibility with older copies.** New vaults and backups use scrypt N=131072 (`vault.json` and backups version 2), up from N=32768. An existing vault is upgraded the next time it unlocks, and the old file is replaced only after the new one is checked. **Once this version unlocks an existing vault, or creates a vault or a backup, an older copy of AllIn can no longer open that vault or restore that backup.** An older copy reports an upgraded vault as damaged ("The vault file is damaged or unreadable"), although it isn't. The only way back is a backup made with the older copy before the first unlock on this version, restored into a clean profile in the older copy. Unlocking takes noticeably longer.

Server faults return a 5xx error and write one line to the terminal with the route and error type only, never messages, tokens, or request data.

`ALLIN_PORT` changes the port. `ALLIN_DATA_DIR` selects another profile. These are trusted operator configuration, not inputs from the UI. A relative data path resolves from the launch directory. Keep `dist/`, the source, and the profile under your control; do not expose the service through a tunnel or reverse proxy. **The one exception is network mode** on your own WireGuard address, with AllIn serving HTTPS itself (see [Linux server](#linux-server)). Never put AllIn on a public address, behind a proxy, or on the open internet.

## Linux server

AllIn can run on an always-on Linux box that you open from your Mac and phone over your own WireGuard network. A feed you turned on then keeps collecting while your Mac sleeps. `npm run package:linux` builds a release folder, and `scripts/install-linux.sh` installs it as a systemd service. [docs/INSTALL_LINUX.md](INSTALL_LINUX.md) has every step, including the certificate.

Network mode is chosen by setting `ALLIN_LISTEN` to a private address. The variables are `ALLIN_PORT`, `ALLIN_LISTEN`, `ALLIN_ORIGIN`, `ALLIN_TLS_CERT`, `ALLIN_TLS_KEY`, `ALLIN_DATA_DIR` and `ALLIN_KEYSTORE_DIR`. On Linux the last two are required. AllIn refuses to start on a wildcard or public address, without the origin and certificate files, or with a key file other users can read. It serves HTTPS (TLS 1.3 only) and checks the Host and Origin against `ALLIN_ORIGIN` exactly. WireGuard membership alone grants nothing: you still need your passphrase.

**Not verified.** Nothing of the systemd install has run on a real Linux machine: not the bubblewrap sandbox, not the installer or the service unit, and not a sign-in over WireGuard. The database module (`better-sqlite3-multiple-ciphers`) has never opened a vault on Linux. The Docker install below has run in part on one box. `@napi-rs/keyring` is still loaded on Linux, even though a key file holds the device secret there. The guide lists the checks to run on the box. It also lists two assumptions to confirm: that the box's disk is encrypted, and that your distribution provides systemd, Node 22.18 or later and a working `bwrap`. If the disk isn't encrypted, the key file protects only against a copied vault folder, not a taken disk. Installing downloads dependencies from the npm registry.

**Docker.** The release folder also holds a `Dockerfile`, `compose.yaml` and `docker.env.example`, for a home lab that runs Docker. The container uses the box's network so AllIn can listen on the WireGuard address, or, with the second compose file `compose.wireguard.yaml`, shares the network of a WireGuard container when WireGuard runs in one (AllIn must then be restarted whenever that container restarts). It keeps the vault and the device secret in two named volumes, and runs as a fixed non-root user with a read-only file system. **Live feeds don't work in it**: the feed needs bubblewrap to prove it can't see the vault, the image has none, and Docker's defaults would block it, so the feed refuses to run and Markets shows replay data. Tasks and Health are expected to work, but nobody has used them in a container. Anyone who can use Docker on the box can read both volumes. Building the image downloads the Node base image from Docker Hub and the dependencies from the npm registry. One box has built the image and started the container; nothing beyond that has run, and Docker isn't on the machine this was written on. See [docs/INSTALL_DOCKER.md](INSTALL_DOCKER.md).

## Backup and clean-profile recovery

1. Unlock the vault and open **Connections & privacy → Export encrypted backup**.
2. Choose and confirm a separate recovery phrase of at least 16 characters. Keep it separately from the downloaded `.allin-backup` file. AllIn does not retain it.
3. On another supported Mac or a separate test profile, launch an empty profile:

   ```sh
   ALLIN_DATA_DIR="$HOME/Library/Application Support/AllIn Recovery" ALLIN_PORT=4312 npm start
   ```

4. Open `http://127.0.0.1:4312`, choose **Make it yours → I have an encrypted backup**, select the file, enter its recovery phrase, and choose a new vault passphrase.
5. Confirm the recovered tasks, Health summaries, and preferences before retiring the old profile.

Recovery creates fresh master/domain/device keys and never replaces an existing profile. The old device's Keychain is unnecessary. Authentication and schema validation run before a new profile is created. Files are limited to 24 MB; the supported maximum 10,000-task snapshot is tested to fit that limit, including long multibyte titles.

No cloud reset exists. Losing the device key or passphrase requires a valid backup and its recovery phrase. Losing both usable vault access and a usable backup is unrecoverable. Deleting a task does not delete it from older backups, OpenFit, OS backups, or SSD snapshots. **Delete saved market data** removes saved bars and alerts after a confirmation; **Remove key** deletes the Alpaca key from Keychain and turns Alpaca off. Backups never held either. Purging Health data removes it from the vault, but older backups of the vault and OpenFit keep their own copies, and AllIn changes neither. Unlocking checks every database file and refuses with a damage message if one is missing, emptied, or corrupted. Creating a vault never overwrites or deletes existing database files: if `vault.json` is lost, setup refuses until you put it back or move those files elsewhere. In-app key rotation, passphrase change, full-vault deletion, and recovery from a power loss during initial setup remain release work. Manual recovery to a new profile is the supported rekey path.

## Verification

```sh
npm run check
npx playwright install chromium   # Once; downloads a test browser
npm run test:browser
```

The core suite covers locked access, wrong passwords, the persistent sign-in lockout, the scrypt upgrade, configuration refusals, HTTPS mode, several signed-in devices, the Linux key file, the `bwrap` command line (as text), the release folder, restart persistence, plaintext sentinel inspection of disk artifacts, unkeyed SQLite rejection, independent clean-profile restore, corruption/wrong-secret/schema rejection, damaged-vault and credential-store reporting, optimistic edits, recurrence, backup-size compatibility, timezone boundaries, Host/Origin/CSRF enforcement, cookie-only rejection, session takeover, lockout, expiry, market-session calendars, replay determinism/gaps/deduplication, and the feed adapters, supervisor, sandbox, and routes (scripted transports and recorded Coinbase responses; Alpaca responses built from its documentation). Browser tests cover real UI workflows in a disposable test profile, desktop/phone layout, accessibility checks, module failure isolation, and observed browser requests staying on the local origin. Test keys are memory-only through a dedicated test entry point; production has no insecure key-store fallback.

`tests/live/coinbase.live.test.ts` is separate and goes online, to `api.coinbase.com` only. It runs only when you ask, outside any sandbox (the worker starts `sandbox-exec`, which can't nest): `ALLIN_LIVE_TESTS=1 node --import tsx --test tests/live/coinbase.live.test.ts`. There is no Alpaca live test, because it needs your key.

These checks are meaningful evidence for the foundation, not a complete security audit. OS-level packet capture, live rollback-journal/crash analysis, native dependency review, signed distribution, and clean-device credential policy verification remain release gates.

## Architecture and next milestones

`src/` contains the React UI; `server/app.ts` owns the local HTTP boundary; `server/vault.ts` owns private persistence and task authorization; `server/crypto.ts` handles authenticated envelopes and recovery; `server/replay.ts` evaluates bars outside the UI; `server/feedWorker.ts` (in the sandbox from `server/feedSandbox.ts`) fetches market data and `server/feedSupervisor.ts` schedules it; `shared/` contains schemas and explicitly synthetic fixtures. No generic shell, browser, arbitrary-URL, or model-tool endpoint exists.

See [docs/IMPLEMENTATION.md](IMPLEMENTATION.md) for decisions, data flows, integration prerequisites, and milestone status. The threat model is in [docs/THREAT_MODEL.md](THREAT_MODEL.md). It is not a full vulnerability scan.

M1 (verified OpenFit import) and M4 (optional live market feeds) are implemented; see [docs/IMPLEMENTATION.md](IMPLEMENTATION.md) for their evidence. M4 ran ahead of the rest of M2 and M3. The next milestone is **M2**, which requires durable replay/watchlist configuration and first-run states. M3 adds local-model proposals and the permission-scoped workout planning flow.
