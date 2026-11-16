# Project AllIn

**Build brief for an implementation LLM · v0.2**

Build a private personal dashboard for three things I want to improve: tracking stocks and crypto, understanding my fitness progress, and making better use of my time. I should be able to open one app and see what changed, what needs attention, and what I can do today. Each area should work independently, and I decide what the AI can see and which actions it can take.

## 1. Starting assumptions

- Start with one user on a personal computer. Build a responsive local web UI that can later be used from a paired phone. Use the computer as the initial data and model host. Remote access and device sync are separate milestones.
- Default to offline operation. Tasks, imported health summaries, cached charts, market replay, and an installed local model should work without internet. Live prices require an enabled data feed and a running host.
- Start with a small watchlist of US equities and spot crypto pairs. Make instruments, intervals, timezone, and currency configurable. Leave other markets, derivatives, and real-money execution outside this brief.
- Start with a TypeScript UI and local service, encrypted SQLite through a supported native binding, and a local model adapter such as Ollama. These are starting choices. Verify host compatibility, storage and keychain support, and local model behavior before committing to dependencies.
- OpenFit remains the source of truth for fitness records. AllIn owns tasks, watchlists, strategy settings, and approved derived summaries. There is no required cloud account or hosted model.

## 2. What to build

### Today

Show three cards that answer what changed in the markets, how my fitness goals are going, and what I should do next. Markets shows feed status and recent rule triggers. Health shows a chosen trend and data coverage. Tasks shows the next three priorities, a one-tap inbox entry, and a button to propose a plan. Show the source and timestamp for each card. Each card should support first-run, stale, unavailable, and locked states as applicable. A failed integration should affect only its own card.

Keep Markets, Health, and Tasks independently usable. The Today screen assembles their summaries through separate read interfaces. The market worker handles quotes and signal evaluation outside the UI, and the planner receives only the fields allowed for the current workflow. Each module owns its records and authorizes its own changes.

### Markets

- Build a watchlist, price and volume charts, and a timeline of **Buy setup**, **Sell setup**, and **No trigger** decisions. A separate **Signal unavailable** state covers gaps, stale data, and insufficient history. Show the rule, strategy version, thresholds, candle interval, trigger time, venue, feed coverage, and the data used for each decision.
- Normalize bars with instrument identity, asset class, provider and venue, quote currency, UTC bar time, receipt time, interval, and revision. Store prices as decimals or fixed-point values. Keep exchange sessions and holidays separate from the user's display timezone.
- Separate streaming quotes from evaluated signals. Reconcile historical and live bars, deduplicate replayed events, detect gaps using the provider's semantics, and backfill before signals resume. Track connection health, feed entitlement, and data freshness separately. Display the difference between a market closure and a feed failure. Preserve historical revisions and mark corrected signals so late data cannot silently rewrite an alert.
- Start with one transparent rule for testing, such as an upward or downward 20/50 EMA crossover on a closed 15-minute bar. Define the warm-up, initialization, and gap policy and publish them with the rule. The rule engine owns the result. The AI may explain an existing result using the stored evidence.
- Use the signal timeline as a journal. Save the original rule version, inputs, and price context so I can replay why the signal fired and inspect what happened afterward. Distinguish recorded decisions from later replay results and label any simulation.
- Start with deterministic replay and add one live stock feed and one live crypto feed after verifying access, limits, usage rights, and coverage. Alpaca is a candidate for US equities and offers different IEX and SIP coverage. Coinbase Advanced Trade public market data is a candidate for spot crypto. Label the actual feed and any delay in the UI. [Alpaca Market Data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) · [Coinbase WebSocket documentation](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
- Show the last successful update and when live monitoring is paused. On wake or restart, treat the feed as unavailable until it reconnects and reconciles missing data. Show signals found during backfill as historical and keep them out of the live alert stream.
- Keep orders, exchange account access, and wallet signing outside the MVP. If adding paper trading, use the next eligible simulated fill after a signal, model fees, spread and slippage, and test against time-ordered holdout data. Report trade count, drawdown and return against a benchmark. Account for stock splits and other applicable corporate actions, and flag any survivorship bias in the dataset.

### Health with OpenFit

- OpenFit documents a local JSON export, workouts, nutrition, weight, and Apple Health-derived weight, steps, and active calories. Its SQLite schema uses local calendar days and kilograms. Read the upstream export implementation and test a synthetic export from a pinned version before building the mapper. Do not assume a stable external API or schema across versions. [OpenFit repository](https://github.com/Vitzso/open-fit) · [OpenFit schema](https://github.com/Vitzso/open-fit/blob/main/prisma/schema.prisma)
- Start with a manual import. Let me choose categories and a date range, and preview the retained fields. Validate a bounded file against a supported schema, map selected data locally, and keep only the derived records and provenance AllIn uses. Discard the original payload from AllIn after processing. Explain that the export file remains wherever I saved it.
- Start with workout frequency and weight trends. Add steps or nutrition summaries where the export and user permissions support them. Preserve source day, unit, and coverage. Show missing data separately from zero. A retry of the same import must be idempotent. Define how a newer snapshot replaces corrected or deleted entries within the selected scope. Provide a purge for imported and derived health data.
- Later, add an explicit read-only bridge if recurring manual import is a problem. Verify OpenFit's available interfaces first. If needed, propose a versioned endpoint upstream that returns only approved categories and date ranges through revocable credentials and authenticated transport. Keep AllIn away from the live OpenFit database, login cookies, and full backup directory.
- Keep health insights descriptive. Ground them in imported observations, mention partial coverage, and avoid diagnoses, treatment recommendations, or medication changes. Leave health access disabled for the task agent unless I explicitly opt in to a specific summary.

### Everyday tasks and AI

- Start with one-tap capture into an inbox. I should be able to save a task title without filling in any other fields. Support projects, due dates, estimated effort, recurring tasks, and a daily plan. Manual editing and planning must work offline with the model unavailable.
- The local AI can suggest priorities, break down a goal, group errands, and propose time blocks from tasks and calendar availability I share. Keep MVP calendar input local, such as a manual availability schedule. Add external calendar connections only after their scopes and data flows are verified.
- Have the model return structured proposals. Each proposal contains an action type, target, expected record version, proposed change, reason, and expiry. Show the proposed changes in a preview. Validate types, authorization and current state in application code. Bind approval to the exact proposal and consume it once. On a conflict, show the updated state and ask for a new review. Batch local writes transactionally and deduplicate retries.
- Give the model no direct database, shell, browser, network, or credential access. Task notes, calendar text, imported files, and model output are untrusted data. The app chooses which fields it provides. Logs and prompts stay local, and conversation retention is off by default. External sends, bookings, purchases and calendar writes are outside the MVP. [OWASP prompt injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- Add a weekly review that compares planned tasks with completed tasks and planned effort with actual effort when I choose to log it. Show missing effort separately. Let me select one adjustment for next week. Show workout consistency only with an explicit grant for that summary.

### First workflow across modules

If I set a goal of three workouts this week and OpenFit shows two completed, let me ask AllIn to find time for the third. With my explicit permission, provide the planner only the completed count, the goal, and the date range and coverage needed to interpret the count. Combine that with the availability I shared and propose a slot as a local task. Show the reason and time in the preview. Write the task only after I approve it. If the summary is missing, stale, or incomplete, show that state and let me plan manually. Recheck the relevant inputs and permissions before applying an approved proposal.

## 3. Privacy and security requirements

| Boundary | Required design |
| --- | --- |
| Device and identity | Bind the service to loopback by default. Validate origin and host, protect mutating requests against CSRF, and require an authenticated, unlocked session for private operations. A local network or VPN never grants access by itself. For a future phone client, use explicitly paired, revocable devices with authenticated encrypted transport. |
| Data and keys | Encrypt sensitive data at rest with a maintained library. Verify coverage of database pages, journals, caches, exports, and backups. Keep wrapping keys in the OS credential store with device-only settings where available. Separate domain keys and access paths for health, tasks, and private financial data. Keep provider credentials in the credential store and outside prompts, UI payloads, and logs. |
| Integrations and outbound traffic | Default to no outbound app traffic. Enabling a feed must show its destination and the categories it receives, including symbols, IP and any required account identity. Isolate network-enabled adapters with OS-enforced restrictions from private stores and the model. Allow only expected destinations and protocols, validate certificates, and reject arbitrary URLs and redirects. Use market-data-only credentials where a credential is required. |
| Model and tools | Run inference locally with no outbound access. Keep model and connector processes away from private storage except for authorized, minimal data supplied by the app. A deterministic policy checks every proposal and tool request. Disable tools entirely for market explanations and health summaries. |
| Backup and recovery | Provide authenticated encrypted exports with a user-held recovery secret and a tested restore path on a clean device. A restore validates integrity and schema before replacing state. Define key rotation, revocation and deletion behavior. Explain that removing data from AllIn does not remove copies in older backups or from OpenFit. |
| Operational visibility | Provide a connection and privacy panel showing integration status, destinations, granted categories, last successful access, and revocation and purge controls. Keep a minimal local event history with action type and outcome. Exclude tokens, prompts and raw payloads from logs. Ship with analytics and cloud crash reporting disabled. |

Model these threats before importing real data: stolen or unlocked device, compromised host or dependency, hostile websites targeting localhost, malicious imports or model inputs, credential leakage, network interception, stale market data, and lost recovery secrets. Record how each control is tested and which platform limits remain. An unlocked host can access plaintext needed for local processing. If a relay is ever added, design and review endpoint-held keys, encrypted payloads, device revocation and conflict handling before calling that feature end-to-end encrypted. [NIST zero-trust architecture](https://csrc.nist.gov/pubs/sp/800/207/final) · [OWASP Mobile Application Security Verification Standard](https://mas.owasp.org/MASVS/)

## 4. Build order and acceptance checks

Ship the first usable release at M2 with the Today screen, manual inbox, one OpenFit trend, and a replay watchlist. Add the workout planning flow before enabling live feeds.

| Milestone | Deliverable | Done when |
| --- | --- | --- |
| M0 · Local foundation | Launchable dashboard, vault, manual task inbox, fixture data, and threat model | Tasks survive restart. Locked or unauthorized requests cannot read or change private data. The offline profile makes no app-initiated network calls. An encrypted backup restores on a clean test profile, and a wrong key or corrupted backup is rejected. |
| M1 · Health import | OpenFit preview, selected summaries, and purge | Supported synthetic export imports twice without duplicates. Corrected data replaces the relevant snapshot. Unsupported or malformed files leave prior data intact. Unselected fields are absent from the vault and logs. |
| M2 · Market replay and first usable release | Today screen with inbox, one OpenFit trend, a replay watchlist, and a signal journal | Identical fixtures and rule versions produce identical results. Duplicate events do not duplicate alerts. Each card stays usable when another module fails. |
| M3 · Local planning and review | Local model, plan preview, workout scheduling proposal, and weekly review | A malicious note cannot trigger a write or disclose health data. An expired, altered, replayed, or stale proposal cannot apply. The workout workflow passes only the approved summary and creates a task only after approval. The inbox still works with the model off. |
| M4 · Live market feeds | Opt-in stock and crypto streams and connection status | Live data shows venue, coverage, and freshness. Sleep, disconnects, stale data, and gaps suppress new live alerts until reconciliation. Backfill results appear as historical. Duplicate events produce a single alert at most. |
| M5 · Release readiness | Installation, recovery and integration documentation, signed release process, and security review | Inspect disk artifacts for plaintext, capture network traffic in offline and opt-in profiles, test revocation and connector failure, and publish a data-flow inventory, supported hosts, and known limits. |

## 5. Ideas to add after the MVP

1. **Capture suggestions.** After I save a task, offer a project, due date, or first step for review.
2. **Trading journal and paper trading.** Extend the signal journal with manual decisions and their rationale. Review outcomes against a benchmark and see what changes when simulated costs rise.
3. **Focus and recovery planning.** Let me reserve time for workouts and focused work, then suggest moving low-priority tasks out of an overloaded day.
4. **Calendar and recurring chores.** Add read-only calendar availability first. Propose recurring reminders, batching and time blocks with a preview.
5. **Paired mobile capture.** Capture a task or check the Today dashboard from a phone. Keep phone caches encrypted and design revocation and conflict handling before adding sync.
6. **Background market alerts.** Measure the host uptime and alert latency needed first. If I need alerts while my computer sleeps, evaluate moving the isolated market worker to an always-on device I control. Keep notification payloads generic by default.

## 6. Handoff prompt for the implementation LLM

> Read this spec and inspect the workspace. Identify what already exists, the supported host and unresolved integration facts. Keep the security boundaries and milestone acceptance checks as requirements. Record reversible assumptions and implement the smallest runnable M0 slice using synthetic data. Include a local launch command, a short threat model with data flows, and tests for access control, encryption and restore. Keep live feeds, personal imports, model downloads and external actions disabled by default. If a production prerequisite is unresolved, keep that integration behind a fixture and document what remains to verify. After running the checks, report what works, what you verified, and the next milestone.
