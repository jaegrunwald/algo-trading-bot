"""Flask application skeleton for the Rating Engine."""

from __future__ import annotations

import os
from urllib.parse import quote, urlencode

from dotenv import load_dotenv
from flask import Flask, jsonify, request, Response
from markupsafe import escape

from rating_engine.config import get_watchlist_tickers
from rating_engine.market_data import dataframe_to_records, fetch_daily_history

load_dotenv()

_HTML_MAX_ROWS = 120


def _history_table_html(
    *,
    title: str,
    ticker: str,
    period: str,
    rows: list[dict],
    total_rows: int,
    json_query: str,
) -> str:
    shown = len(rows)
    cap_note = ""
    if total_rows > shown:
        cap_note = f"<p><em>Showing last {shown} of {total_rows} trading days.</em></p>"
    head = "".join(f"<th>{escape(str(k))}</th>" for k in (rows[0].keys() if rows else []))
    body_lines: list[str] = []
    for r in rows:
        cells = "".join(f"<td>{escape(str(v))}</td>" for v in r.values())
        body_lines.append(f"<tr>{cells}</tr>")
    body = "\n".join(body_lines)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{escape(title)}</title>
  <style>
    body {{ font-family: system-ui, sans-serif; margin: 1.25rem; line-height: 1.4; }}
    table {{ border-collapse: collapse; font-size: 0.85rem; }}
    th, td {{ border: 1px solid #ccc; padding: 0.35rem 0.5rem; text-align: right; }}
    th {{ background: #f4f4f4; }}
    td:first-child, th:first-child {{ text-align: left; }}
    code {{ background: #eee; padding: 0.1rem 0.35rem; }}
  </style>
</head>
<body>
  <h1>{escape(title)}</h1>
  <p>Ticker <code>{escape(ticker)}</code> · period <code>{escape(period)}</code> ·
     <a href="?{escape(json_query)}">JSON</a> (same page, machine-readable)</p>
  {cap_note}
  <table>
    <thead><tr>{head}</tr></thead>
    <tbody>{body}</tbody>
  </table>
</body>
</html>"""


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["JSON_SORT_KEYS"] = False

    @app.get("/")
    def index():
        return jsonify(
            {
                "service": "rating-engine",
                "phase": 1,
                "endpoints": {
                    "health": "/health",
                    "history_json": "/api/history/<ticker>?period=1y&format=json",
                    "history_html": "/api/history/<ticker>?period=3mo&format=html",
                    "watchlist_json": "/api/history?period=1y&format=json",
                    "watchlist_html": "/api/history?format=html",
                },
            }
        )

    @app.get("/health")
    def health():
        return jsonify({"status": "ok", "service": "rating-engine"})

    @app.get("/api/history/<ticker>")
    def history_one(ticker: str):
        period = request.args.get("period", "1y")
        fmt = (request.args.get("format") or "json").lower()
        sym = ticker.strip().upper()
        try:
            frame = fetch_daily_history(sym, period=period)
        except ValueError as e:
            if fmt == "html":
                msg = escape(str(e))
                return Response(
                    f"<!DOCTYPE html><html><head><meta charset=utf-8><title>Error</title></head>"
                    f"<body><p>{msg}</p><p><a href='/'>Home</a></p></body></html>",
                    status=404,
                    mimetype="text/html; charset=utf-8",
                )
            return jsonify({"error": str(e)}), 404
        rows = dataframe_to_records(frame)
        total = len(rows)
        if fmt == "html":
            tail = rows[-_HTML_MAX_ROWS:] if total > _HTML_MAX_ROWS else rows
            json_query = urlencode({"period": period, "format": "json"})
            html = _history_table_html(
                title=f"Daily history · {sym}",
                ticker=sym,
                period=period,
                rows=tail,
                total_rows=total,
                json_query=json_query,
            )
            return Response(html, mimetype="text/html; charset=utf-8")
        return jsonify(
            {
                "ticker": sym,
                "period": period,
                "interval": "1d",
                "row_count": total,
                "rows": rows,
            }
        )

    @app.get("/api/history")
    def history_watchlist():
        """Daily history for each symbol in WATCHLIST_TICKERS (comma-separated env)."""
        period = request.args.get("period", "1y")
        fmt = (request.args.get("format") or "json").lower()
        tickers = get_watchlist_tickers()
        results: list[dict] = []
        errors: list[dict] = []
        for symbol in tickers:
            try:
                frame = fetch_daily_history(symbol, period=period)
                recs = dataframe_to_records(frame)
                results.append(
                    {
                        "ticker": symbol,
                        "period": period,
                        "interval": "1d",
                        "row_count": len(recs),
                        "rows": recs,
                    }
                )
            except ValueError as e:
                errors.append({"ticker": symbol, "error": str(e)})
        if fmt == "html":
            q_html = urlencode({"period": period, "format": "html"})
            q_json = urlencode({"period": period, "format": "json"})
            links = "".join(
                f'<li><a href="/api/history/{quote(s, safe="")}?{q_html}">{escape(s)}</a> — '
                f'<code>/api/history/{escape(s)}?period={escape(period)}&format=json</code></li>'
                for s in tickers
            )
            err_html = ""
            if errors:
                items = "".join(
                    f"<li>{escape(e['ticker'])}: {escape(e['error'])}</li>" for e in errors
                )
                err_html = f"<h2>Fetch errors</h2><ul>{items}</ul>"
            ok = len(results)
            page = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Watchlist history</title>
  <style>
    body {{ font-family: system-ui, sans-serif; margin: 1.25rem; line-height: 1.5; }}
    code {{ background: #eee; padding: 0.1rem 0.35rem; }}
  </style>
</head>
<body>
  <h1>Watchlist</h1>
  <p>Period <code>{escape(period)}</code> · {ok} ok / {len(tickers)} symbols ·
     <a href="?{escape(q_json)}">Raw JSON</a> (large)</p>
  <p>Open one symbol as a <strong>table</strong>:</p>
  <ul>{links}</ul>
  {err_html}
  <p><a href="/">Home</a></p>
</body>
</html>"""
            return Response(page, mimetype="text/html; charset=utf-8")
        return jsonify(
            {
                "watchlist": tickers,
                "summary": {"ok": len(results), "errors": len(errors)},
                "data": results,
                "errors": errors,
            }
        )

    return app


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    # macOS often binds port 5000 to AirPlay Receiver; default to 5001 locally.
    port = int(os.environ.get("PORT", "5001"))
    create_app().run(host="0.0.0.0", port=port, debug=debug)
