# Contributing

Thanks for looking. AllIn is a personal project, so changes are accepted slowly and only when they keep the rules below.

## Run the checks

You need Node 22.18 or later.

```sh
npm ci
npm run build
npm test
npm run test:build
npm run test:browser
npx prettier --check .
npm audit --omit=dev
```

`npm run test:browser` needs a browser for Playwright the first time: `npx playwright install chromium`. The tests use temporary folders and an in-memory key store. They never open a real vault or a real key store.

## Rules a change must keep

1. **No new network host.** The app makes no outbound request until the user turns on a market feed, and then only to `api.coinbase.com` and `data.alpaca.markets`. No telemetry, no update check, no download.
2. **No weaker security boundary** without saying so. The boundaries are listed in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): the Host and Origin checks, a session that needs both the cookie and the per-tab token, the idle lock, encrypted backups, and logs that never hold private data. A change that loosens one needs a matching change to that page, in the same pull request.
3. **No investment advice and no orders.** Market screens show rule output for information only.
4. **Docs don't overstate.** If something hasn't been run, the docs say so. A feature that only passed text checks is "written, not run".
5. **Tests first.** A change in behaviour comes with a test that fails without it.
6. **No private data in the repo.** No real vault, export, key, certificate, address or email. Fixtures are synthetic.

## Pull requests

Keep each one to a single purpose, and say what you ran and what you could not run. A change for a platform you could not test on is fine if it says so.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, as in [LICENSE](LICENSE).
