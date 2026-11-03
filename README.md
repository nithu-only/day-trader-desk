# Day Trader Desk

A personal, single-user web app for day-trading research and planning. Runs locally on `127.0.0.1:8000`.

Wraps the MIT-licensed [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill) repo as the trading engine — no logic is rewritten, all existing Python CLI scripts are called via subprocess.

## What it does

- **Scanner** — daily setups and opening-range breakouts from free Yahoo Finance data
- **News** — headlines and SEC 8-K filings for your watchlist
- **Trade planner** — entry status, stop/target plan on a price chart
- **Time Machine** — 10,000 simulated replay paths, odds bar, plain-language verdict
- **Size & risk** — position sizing to your budget and max loss, PASS/BLOCK verdict
- **Alerts** — price/target/stop/time rules, clock, quotes
- **Earnings** — SEC XBRL quarterly fundamentals (revenue, margins, EPS)
- **Congress trades** — House Clerk PTR disclosures by member
- **Settings** — budget, risk limits, demo/live mode, SEC user agent

Two modes:
- **Demo** — offline fixtures, no internet, pinned clock `2026-10-19 10:15 ET`
- **Live** — real Yahoo/SEC/House Clerk data, 60-second cache

Mode is chosen at startup in this order: `DESK_MODE` in `.env` (wins and locks the Settings selector), then the mode saved in Settings, then demo. `.env.example` ships with `DESK_MODE=demo`; remove or change that line to switch from the Settings page.

## Stack

- Backend: FastAPI (Python 3.11), SQLite, bound to `127.0.0.1`
- Frontend: vanilla HTML/CSS/JS, served by FastAPI (no build step)
- Trading engine: `vendor/day-trader-skill` (copied from upstream, `.git` removed)

## Quick start

```bash
# 1. Copy env example
cp .env.example .env
# Edit .env if you want live mode or a custom SEC user agent

# 2. Start
./run.sh
# On Windows PowerShell:
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
#   ./run.sh

# 3. Open http://127.0.0.1:8000
```

`run.sh` installs `fastapi` and `uvicorn` if missing, then launches the server.

## Project layout

```
vendor/day-trader-skill/   upstream MIT-licensed trading engine (no .git)
backend/                   FastAPI app, SQLite, subprocess wrappers
frontend/                  HTML/CSS/JS single-page app
data/                      SQLite DB + trader/ working dir for CLI tools
.env.example               environment variable template
run.sh                     one-command start script
```

## License

The trading engine in `vendor/day-trader-skill/` is [MIT licensed](vendor/day-trader-skill/LICENSE) by Jake Schincariol. This wrapper app is provided as-is for personal research.

## Disclaimer

Not financial advice. Data is free, unofficial and may lag. Most day traders lose money. No order placement or broker integration — this is a research and planning tool only.
