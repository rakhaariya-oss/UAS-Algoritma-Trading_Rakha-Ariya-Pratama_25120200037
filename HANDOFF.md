# Project Handoff

Updated: 2026-11-14
Project root: `D:\Bot Dry Run Indodax`

## Open on another PC

1. Connect the SSD and open `D:\Bot Dry Run Indodax` in VS Code.
2. Install Node.js LTS if it is not already installed.
3. Run `npm ci` from this folder, then `npm run dev -- --port 3001`.
4. Open `http://localhost:3001`.
5. For the static offline viewer, serve this project root over HTTP and open `/public/dashboard.html`.

The project now has a local `.git` repository. Its history starts with the current project state; no earlier commit history or original freeze commit is included. The Desktop copy may still exist on the original PC; the SSD path is the working copy used for the recent changes.

## Latest changes

- Header branding uses the original `public/logo-cakrawala-doang-v2.webp`; logo and `Rakha Ariya Pratama - 25120200037` are on the left, while `Indodax Dry Run` is on the right. The React and offline HTML dashboards use the same arrangement.
- `app/api/tick/route.ts` requests enough hourly candles for the strategy, records decisions/book data and runtime errors, and updates simulated cash, positions, equity, and daily PnL.
- `lib/risk.ts` preserves open positions when the WIB day resets. `lib/execution.ts` distinguishes partial fills.
- The dashboards warn when the saved report freeze differs from the assignment and distinguish historical reports from live execution evidence.
- The React dashboard fetches saved reports with `cache: 'no-store'` so stale browser cache cannot keep showing an old freeze date.
- The forward replay notice explains that live execution logs were not recorded for this period and the displayed result uses historical candles instead.
- The backtest and offline dataset generators use the assignment window: freeze `2026-11-04T05:00:00.000Z` and forward end `2026-11-14T05:00:00.000Z`. Reports were regenerated from Indodax hourly candles; the forward replay archive is `public/data/forward-replay.json`.
- Reflection report: `Laporan_Refleksi_Algorithmic_Trading.pdf`; editable source: `laporan-refleksi.html`.

## Validation performed

- `npm run backtest` completed with full coverage through the requested forward end.
- `npm run build` passed after report regeneration.
- `npx tsx scripts/backtest.freeze.spec.ts` passed for the date/cutoff checks.
- `npx tsx scripts/risk.spec.ts` passed for daily position retention and partial fills.
- The production alias serves the corrected freeze and forward end timestamps; the deployed dashboard bundle contains the no-store report fetch.
- The replay notice states that live execution logs were not recorded for this period and the result uses historical candle data; the production bundle and offline viewer were verified to contain the message.
- The original logo copied into `public` was verified byte-for-byte against the root asset.
- Latest Vercel production alias: `https://indodax-dryrun-bot-theta.vercel.app/`.
- Production deployment `dpl_A2dELV1rZ4RWm7Eb1NRL9v48Tn2C` is READY; the production alias serves the regenerated backtest and forward-test report windows.

## Data and evidence status

- Saved backtest report: 2023-11-04 05:00 UTC to 2026-11-04 05:00 UTC, 963 trades, +31.45% total return, +9.54% CAGR, 15.76% maximum drawdown, profit factor 1.62, 33.54% win rate.
- Saved forward replay: 2026-11-04 05:00 UTC to 2026-11-14 05:00 UTC, full requested coverage, 1 ETH/IDR trade, about -Rp191,893 net / -0.19%. This is a retrospective candle replay, not evidence that the production bot ran live.
- The latest Indodax history fetch succeeded and the raw forward candles are archived in `public/data/forward-replay.json`. Historical order-book snapshots are unavailable; reports use zero historical spread cost and a fixed slippage assumption.
- Production `/api/dashboard` reported persistent storage, but `hasRun=false`, no runtime logs, and no forward metrics from live logs at the last check.

## Next steps

1. Do not describe the saved historical replay as live forward-test logs.
2. Hard-refresh the production dashboard if a browser still shows cached report dates.
3. Configure and verify a production scheduler for `/api/tick`, then confirm persistent storage records each run before beginning any new prospective forward period.
4. Keep secrets such as `CRON_SECRET` and KV tokens in local/Vercel environment settings; do not put them in this handoff or commit them. `.env.example` contains placeholders only.
5. Keep the local Git history as evidence for changes made from this point forward. Do not claim an earlier freeze commit exists; this repository has not been uploaded to GitHub.
