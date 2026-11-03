"""Day Trader Desk - FastAPI backend."""

import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from config import DEFAULT_CONFIG, DEMO_NOW, TRADER_DIR, env_mode, mode
from db import (
    add_history, add_watchlist, coerce_setting, delete_alert, get_alerts,
    get_all_settings, get_plans, get_scans, get_simulations, get_watchlist,
    init_db, latest_plan, remove_watchlist, save_alert, save_plan, save_scan,
    save_simulation, set_setting,
)
import wrappers
from wrappers import ToolError

# Ensure data/trader exists for the CLI tools
TRADER_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    wrappers.write_vendor_config()
    yield


app = FastAPI(title="Day Trader Desk", lifespan=lifespan)

app.mount(
    "/static",
    StaticFiles(directory=str(Path(__file__).parent.parent / "frontend" / "static")),
    name="static",
)


# ---------------------------------------------------------------- errors

@app.exception_handler(ToolError)
async def tool_error_handler(request: Request, exc: ToolError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    messages = []
    for err in exc.errors():
        loc = ".".join(str(part) for part in err.get("loc", ()) if part != "body")
        msg = err.get("msg", "invalid value")
        messages.append(f"{loc}: {msg}" if loc else msg)
    detail = "; ".join(messages) or "The request was not valid."
    return JSONResponse(status_code=400, content={"detail": detail})


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    default_reasons = {
        400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
        404: "Not Found", 405: "Method Not Allowed",
    }
    if str(request.url.path).startswith("/api/") and detail == default_reasons.get(exc.status_code):
        detail = f"No such endpoint: {request.method} {request.url.path}"
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    import traceback

    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong inside the desk. The terminal has the details."},
    )


# ---------------------------------------------------------------- models

class ScanRequest(BaseModel):
    symbols: list[str] | None = None
    limit: int | None = None


class NewsRequest(BaseModel):
    tickers: list[str] | None = None
    hours: int = 48


class EntryRequest(BaseModel):
    symbol: str


class ExitPlanRequest(BaseModel):
    symbol: str
    entry: float
    stop_rule: str = "or-mid"
    target: str = "2R"
    or_high: float | None = None
    or_low: float | None = None


class TMRequest(BaseModel):
    symbol: str | None = None
    entry: float | None = None
    stop: float | None = None
    target: float | None = None
    entry_time: str | None = None


class AlertAddRequest(BaseModel):
    rule_id: str
    symbol: str | None = None
    stop: float | None = None
    target: float | None = None
    above: float | None = None
    below: float | None = None
    pct: float | None = None
    at: str | None = None
    label: str | None = None


class FactsRequest(BaseModel):
    tickers: list[str]


class PelosiRequest(BaseModel):
    member: str | None = None
    year: int | None = None
    since: str | None = None


class SettingRequest(BaseModel):
    key: str
    value: Any


class WatchlistAdd(BaseModel):
    symbol: str
    name: str | None = None


# ---------------------------------------------------------------- helpers

def bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)


def not_found(message: str) -> HTTPException:
    return HTTPException(status_code=404, detail=message)


def clean_symbols(values, field: str = "tickers") -> list[str]:
    out = []
    for value in values or []:
        symbol = wrappers.check_symbol(value)
        if symbol not in out:
            out.append(symbol)
    return out


def effective_mode() -> dict:
    return {"mode": mode(), "mode_locked": env_mode() is not None,
            "demo_clock": DEMO_NOW + " ET"}


def _pct(value):
    """Store a 0-1 probability as a 0-100 percentage."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number * 100, 2) if number <= 1 else round(number, 2)


# ---------------------------------------------------------------- health

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        **effective_mode(),
        "vendor": str(TRADER_DIR.parent.parent / "vendor" / "day-trader-skill"),
    }


@app.get("/api/status")
async def status():
    clock = wrappers.alerts_clock()
    return {**effective_mode(), "clock": clock}


# ---------------------------------------------------------------- settings

@app.get("/api/settings")
async def get_settings():
    saved = get_all_settings()
    out = {}
    for key in DEFAULT_CONFIG:
        out[key] = saved.get(key, DEFAULT_CONFIG[key])
    out["mode"] = mode()
    return out


@app.post("/api/settings")
async def set_settings(req: SettingRequest):
    key = (req.key or "").strip()
    if key not in DEFAULT_CONFIG:
        raise bad_request(f'"{key}" is not a setting this desk knows about.')
    try:
        value = coerce_setting(key, req.value)
    except (KeyError, ValueError) as exc:
        raise bad_request(str(exc) or f"Invalid value for {key}") from None
    if key == "mode":
        if value not in ("demo", "live"):
            raise bad_request('Mode must be "demo" or "live".')
        if env_mode():
            raise bad_request(
                f"Mode is fixed by the DESK_MODE environment variable ({env_mode()}). "
                "Change it in .env and restart the desk."
            )
    set_setting(key, value)
    wrappers.write_vendor_config()
    add_history("setting_changed", details={"key": key, "value": value})
    return {"ok": True, "key": key, "value": value}


# ---------------------------------------------------------------- scanner

@app.post("/api/scan/daily")
async def scan_daily(req: ScanRequest | None = None):
    req = req or ScanRequest()
    symbols = clean_symbols(req.symbols, "symbols") if req.symbols else None
    result = wrappers.scanner_daily(symbols=symbols, limit=req.limit)
    save_scan("daily", result.get("as_of"), result.get("hits", []), result.get("counts", {}))
    add_history("scan_daily", details={"hits": len(result.get("hits", []))})
    return result


@app.post("/api/scan/orb")
async def scan_orb(req: ScanRequest | None = None):
    req = req or ScanRequest()
    symbols = clean_symbols(req.symbols, "symbols") if req.symbols else None
    result = wrappers.scanner_orb(symbols=symbols)
    save_scan("orb", result.get("as_of"), result.get("hits", []), result.get("counts", {}))
    add_history("scan_orb", details={"hits": len(result.get("hits", []))})
    return result


# ---------------------------------------------------------------- news

@app.post("/api/news")
async def news(req: NewsRequest | None = None):
    req = req or NewsRequest()
    if req.hours <= 0 or req.hours > 24 * 30:
        raise bad_request("Hours must be between 1 and 720.")

    requested = clean_symbols(req.tickers, "tickers") if req.tickers else None
    explicit = req.tickers is not None
    if explicit and not req.tickers:
        raise bad_request("Enter at least one ticker, for example TSLA.")

    # The desk's own watchlist wins; the last scan is the fallback because it is
    # what the News page follows on from.
    tickers = requested
    if tickers is None:
        tickers = [row["symbol"] for row in get_watchlist()]
    if not tickers:
        for scan in get_scans(5):
            if scan.get("hits"):
                tickers = [hit.get("symbol") for hit in scan["hits"] if hit.get("symbol")]
                break

    skipped = []
    if wrappers.is_demo():
        available = wrappers.demo_tickers("news")
        usable = [t for t in tickers if t in available]
        skipped = [t for t in tickers if t not in available]
        tickers = usable
        if not tickers and not explicit:
            tickers = sorted(available)
        if not tickers:
            sample = ", ".join(sorted(available))
            raise not_found(
                "No demo headlines for " + ", ".join(skipped or ["that"]) +
                f". Demo mode has headlines for {sample}."
            )
    if not tickers:
        return {"checked": None, "moves": [], "items": [], "notes": [
            "Add a ticker to your watchlist, or run a scan, to see headlines."
        ]}

    result = wrappers.news_check(tickers=tickers, hours=req.hours)
    notes = [wrappers.clean_message(note) for note in result.get("notes", []) if note]
    notes = [note for note in notes if "no file" not in note.lower()][:5]
    if skipped:
        notes.append("Skipped " + ", ".join(skipped) + ": no demo headlines for those tickers.")
    result["notes"] = notes
    result["tickers"] = tickers
    add_history("news", details={"items": len(result.get("items", []))})
    return result


# ---------------------------------------------------------------- entry

@app.post("/api/entry/check")
async def entry_check(req: EntryRequest):
    symbol = wrappers.check_symbol(req.symbol)
    wrappers.require_demo_data("entry", symbol)
    result = wrappers.entry_check(symbol=symbol)
    add_history("entry_check", symbol=symbol, details={"status": result.get("status")})
    return result


# ---------------------------------------------------------------- exit

@app.post("/api/exit/plan")
async def exit_plan(req: ExitPlanRequest):
    symbol = wrappers.check_symbol(req.symbol)
    wrappers.require_demo_data("entry", symbol)
    if req.entry is None or req.entry <= 0:
        raise bad_request("Entry price must be above $0.")
    if req.stop_rule in ("or-mid", "or-low", "or-high"):
        if req.or_high is None or req.or_low is None:
            raise bad_request(
                "An opening-range stop needs the OR high and OR low. "
                "Run the entry check first so they can be filled in."
            )
        if req.or_high <= req.or_low:
            raise bad_request("The opening-range high must be above the low.")
    if req.target not in ("1R", "1.5R", "2R", "3R"):
        raise bad_request('Target must be one of "1R", "1.5R", "2R" or "3R".')

    result = wrappers.exit_plan(
        symbol=symbol, entry=req.entry, stop_rule=req.stop_rule,
        target=req.target, or_high=req.or_high, or_low=req.or_low,
    )

    plan = result.get("plan", result)
    save_plan(
        symbol=symbol,
        setup=plan.get("setup", "orb"),
        entry=plan.get("entry", req.entry),
        stop=plan.get("stop"),
        target=plan.get("target"),
        risk=plan.get("risk_per_share"),
        rr=plan.get("reward_risk"),
        date=plan.get("date"),
        plan_json=json.dumps(plan),
    )
    add_history("exit_plan", symbol=symbol, details={"stop": plan.get("stop"), "target": plan.get("target")})
    return result


@app.get("/api/exit/show")
async def exit_show():
    return wrappers.exit_show()


# ---------------------------------------------------------------- time machine

@app.post("/api/timemachine/run")
async def tm_run(req: TMRequest | None = None):
    req = req or TMRequest()
    symbol = wrappers.check_symbol(req.symbol) if req.symbol else None
    if symbol:
        wrappers.require_demo_data("timemachine", symbol)
    for name, value in (("Entry", req.entry), ("Stop", req.stop), ("Target", req.target)):
        if value is not None and value <= 0:
            raise bad_request(f"{name} price must be above $0.")

    result = wrappers.timemachine_run(
        symbol=symbol, entry=req.entry, stop=req.stop,
        target=req.target, entry_time=req.entry_time,
    )

    sim = result.get("simulation", result)
    mc = sim.get("mc") or {}
    save_simulation(
        plan_id=None, symbol=symbol or sim.get("symbol", ""),
        target_first=_pct(sim.get("target_first_pct", mc.get("p_target"))),
        stop_first=_pct(sim.get("stop_first_pct", mc.get("p_stop"))),
        neither=_pct(sim.get("neither_pct", mc.get("p_neither"))),
        verdict=sim.get("verdict", ""),
        sim_json=json.dumps(sim),
    )
    add_history("timemachine", symbol=symbol, details={"verdict": sim.get("verdict")})
    return result


@app.get("/api/timemachine/chart")
async def tm_chart():
    return wrappers.timemachine_chart()


@app.get("/api/simulations")
async def simulations():
    return get_simulations()


# ---------------------------------------------------------------- size / budget

@app.post("/api/size")
async def size_position():
    return wrappers.size_position()


# ---------------------------------------------------------------- risk

@app.post("/api/risk/check")
async def risk_check():
    return wrappers.risk_check()


# ---------------------------------------------------------------- alerts

@app.get("/api/alerts/clock")
async def alerts_clock():
    return wrappers.alerts_clock()


@app.post("/api/alerts/quote")
async def alerts_quote(tickers: list[str]):
    return wrappers.alerts_quote(tickers=clean_symbols(tickers, "tickers"))


def _alert_kind(req: AlertAddRequest) -> tuple[str, dict]:
    """Map the request onto one vendor rule type plus its stored fields."""
    if req.at:
        if not re.match(r"^\d{1,2}:\d{2}$", req.at.strip()):
            raise bad_request('A time alert needs a clock time like "15:45".')
        return "time", {"at_time": req.at.strip()}
    for name, value in (("above", req.above), ("below", req.below),
                        ("stop", req.stop), ("target", req.target)):
        if value is not None:
            if value <= 0:
                raise bad_request(f'The "{name}" level must be above $0.')
            return name, {"price": float(value)}
    if req.pct is not None:
        if req.pct == 0:
            raise bad_request("A percent alert needs a non-zero percentage.")
        return "pct_move", {"pct": float(req.pct)}
    raise bad_request("Give the alert a price level, a percentage, or a time.")


@app.post("/api/alerts/add")
async def alerts_add(req: AlertAddRequest):
    rule_id = (req.rule_id or "").strip()
    if not rule_id:
        raise bad_request('Give the alert an id, for example "tsla-stop".')
    if not re.match(r"^[A-Za-z0-9._-]{1,60}$", rule_id):
        raise bad_request("Alert ids may only use letters, numbers, dots, dashes and underscores.")

    kind, fields = _alert_kind(req)
    symbol = wrappers.check_symbol(req.symbol) if (req.symbol or kind != "time") else None

    try:
        existing = wrappers.alerts_list().get("rules", [])
    except ToolError:
        existing = []
    if any(str(rule.get("id")) == rule_id for rule in existing):
        raise HTTPException(status_code=409, detail=f'An alert called "{rule_id}" already exists.')

    result = wrappers.alerts_add(
        rule_id=rule_id, symbol=symbol, stop=req.stop, target=req.target,
        pct=req.pct, at=req.at, label=req.label, above=req.above, below=req.below,
    )

    save_alert(
        rule_id=rule_id, symbol=symbol, rule_type=kind,
        price=fields.get("price"), pct=fields.get("pct"),
        at_time=fields.get("at_time"),
        direction="up" if kind in ("above", "target") else None,
    )
    add_history("alert_add", symbol=symbol, details={"rule_id": rule_id, "type": kind})
    return {"ok": True, "rule": {"id": rule_id, "symbol": symbol, "type": kind, **fields}}


@app.post("/api/alerts/check")
async def alerts_check():
    result = wrappers.alerts_check()
    rings = result.get("rings") or []
    add_history("alert_check", details={"rings": len(rings)})
    return result


@app.get("/api/alerts/list")
async def alerts_list():
    return wrappers.alerts_list()


@app.get("/api/alerts/stored")
async def alerts_stored():
    return get_alerts()


@app.delete("/api/alerts/{rule_id}")
async def alerts_delete(rule_id: str):
    removed_tool = wrappers.alerts_remove(rule_id)
    removed_db = delete_alert(rule_id)
    if not removed_tool and not removed_db:
        raise not_found(f'No alert called "{rule_id}".')
    add_history("alert_remove", details={"rule_id": rule_id})
    return {"ok": True, "removed": rule_id}


# ---------------------------------------------------------------- earnings

@app.post("/api/earnings")
async def earnings(req: FactsRequest):
    tickers = clean_symbols(req.tickers, "tickers")
    if not tickers:
        raise bad_request("Enter at least one ticker, for example AAPL.")
    for ticker in tickers:
        wrappers.require_demo_data("facts", ticker)
    result = wrappers.facts(tickers=tickers)
    if not result:
        raise not_found(
            "No SEC filing data for " + ", ".join(tickers) +
            ". In demo mode only AAPL and KO are loaded."
        )
    add_history("earnings", details={"tickers": tickers})
    return result


# ---------------------------------------------------------------- congress

@app.post("/api/congress/index")
async def congress_index(req: PelosiRequest | None = None):
    req = req or PelosiRequest()
    member = (req.member or "").strip()
    result = wrappers.pelosi_index(member=member or None, year=req.year, since=req.since)
    if not result:
        who = member or "that member"
        raise not_found(f"No periodic transaction reports found for {who}.")
    add_history("congress", details={"member": member, "filings": len(result)})
    return result


# ---------------------------------------------------------------- watchlist

@app.get("/api/watchlist")
async def watchlist():
    return get_watchlist()


@app.post("/api/watchlist")
async def watchlist_add(req: WatchlistAdd):
    symbol = wrappers.check_symbol(req.symbol)
    add_watchlist(symbol, (req.name or "").strip())
    add_history("watchlist_add", symbol=symbol)
    return {"ok": True, "symbol": symbol}


@app.delete("/api/watchlist/{symbol}")
async def watchlist_remove(symbol: str):
    remove_watchlist(symbol)
    add_history("watchlist_remove", symbol=wrappers.normalise_symbol(symbol))
    return {"ok": True}


# ---------------------------------------------------------------- plans

@app.get("/api/plans")
async def plans():
    return get_plans()


@app.get("/api/plans/latest")
async def plan_latest(symbol: str | None = None):
    row = latest_plan(symbol)
    if not row:
        raise not_found("No saved plan yet. Run the entry check and save a plan first.")
    return row


@app.get("/api/scans")
async def scans():
    return get_scans(10)


# ---------------------------------------------------------------- serve frontend

@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = Path(__file__).parent.parent / "frontend" / "templates" / "index.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
