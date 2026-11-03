# Day Trader Desk — audit report

Run on 2026-11-03 against `http://127.0.0.1:8000` (server started with `./run.sh`, demo mode pinned to 2026-10-19 10:15 ET).

## Result summary

| Check | Result | What was verified / fixed |
|---|---|---|
| Start with documented `./run.sh` | **PASS** | Script starts uvicorn on `127.0.0.1:8000`; printed URL `http://127.0.0.1:8000`. Uses `python3` with `python` fallback. |
| Backend endpoint audit (`python backend_audit.py`) | **PASS — 19/19** | Health, settings read/update, daily scan (8 hits), ORB scan (42 hits), watchlist add/list/remove, news (16 items), entry check (TSLA triggered 364.18), exit plan, time machine, size, risk, alerts add/list/check, earnings AAPL, Congress Pelosi. |
| Vendor test suite (`python -m unittest discover -s vendor/day-trader-skill/tests`) | **PASS — 315/315** | 315 tests, 0 failures, 0 errors (14.5 s). |
| Demo fixture values | **PASS** | ORB 10:15 TSLA range **354.47–362.18**, price **364.18**; plan stop **358.32**, target **370.04** (1R); Time Machine seed 19 → **29.4% target / 25.5% stop / 45.1% neither**; $5,000 budget + $50 max loss → **8 shares**, risk **PASS**. |
| Full UI flow (`node flow.js`) | **PASS — 41/41** | Scan → watchlist → news → planner → Time Machine → size/risk → alerts; stepper back-jump; Ctrl/Cmd+K palette; browser Back; reload persistence; active nav; earnings; Congress; light theme; keyboard focus; zero console/network errors. |
| Responsive / accessibility audit (`node audit.js`) | **PASS — 27/27 page-widths** | 9 pages × 1440/768/390: no document overflow, no off-screen elements, no clipped text, no contrast failures, no tap targets under 44 px, no console/network errors. |
| Failure paths (`python fails.py`) | **PASS** | Unknown/lowercase/garbage/empty tickers, bad entry price, empty earnings/news lists, bad JSON body, unknown Congress member, missing alert id → clear human-readable messages, **no stack traces**. |
| Live mode without internet | **PASS** | With a dead proxy: SEC user-agent missing → explicit setup instructions; Yahoo entry/news, House Clerk and ORB pre-open → plain-language "could not reach / wait and try again" messages. |
| Screenshots | **PASS** | 38 images in `audit/screenshots/` (all 9 pages at 1440/768/390, light theme, and populated size/risk, Time Machine and alerts). |

No required check remains failing.

## Root causes fixed

- Vendor CLIs were being fed whole fixture directories, mixing unrelated symbols into scans/news. Each demo tool now gets its own dataset file.
- `news.py` interprets a naive `--now` as UTC while every other tool uses New York; the desk now passes `2026-10-19T14:15:00Z` for news.
- The desk watchlist was leaking into the vendor scanner's `trader/watchlist.json`; it is now passed explicitly with `--tickers`.
- Vendor config (budget/risk limits) was missing for CLIs; it is materialized from DB settings before each call.
- Alert deletion had no vendor verb; deletion now rewrites `alerts.json` and the DB together.
- Runtime used hardcoded `python3`; wrappers now use `sys.executable`.
- Frontend was rebuilt around hash routing (`#page`, `#planner/TSLA`), real buttons, mobile tab bar, theme toggle, inline SVG charts, proper loading/empty/error states.
- Simulation percentages were stored as fractions, producing blank history columns; values are stored 0–100 and corrupt rows were removed.
- Explicit empty `news.tickers` silently fell back to the last scan; it now returns "Enter at least one ticker, for example TSLA."
- Planner reload left the Target selector on 2R while showing a saved 1R plan; the form now syncs stop rule and target from the saved plan.
- Mobile fixes: 44 px tap targets, checkbox label/box overlap, chart label collisions, "Planner" tab label.
- `backend_audit.py` was not idempotent (fixed alert id collision, wrong alerts-list count, and it now keeps the demo plan at 1R).

## Notes / not counted as failures

- Adding an alert rule for a well-formed but unknown symbol (e.g. `ZZZZ`) is accepted: a rule is stored and only rings if quote data exists. All market-data endpoints reject unknown tickers.
- Live news with no internet returns HTTP 200 with an explanatory note ("could not reach …") instead of an error, because it is a partial-results browse view; the UI displays the note.
- An unrelated external client polls `GET /health` (not an app route) and gets 404; this does not affect the desk.
- `run.sh` mode precedence: `DESK_MODE` from `.env` wins and locks the selector, otherwise the saved Settings value, otherwise demo.

## Screenshot index

- Page coverage: `scanner-*`, `news-*`, `planner-*`, `timemachine-*`, `size-risk-*`, `alerts-*`, `earnings-*`, `congress-*`, `settings-*` at `1440`, `768`, `390`.
- Populated evidence: `size-risk-filled-*` (8 shares, PASS), `timemachine-filled-*` (odds + fan chart), `alerts-filled-*` (stop/target rules).
- Theme: `light-scanner-*`, `light-settings-*`.
- Flow: `flow-scanner-1440.png`.
