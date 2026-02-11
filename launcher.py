#!/usr/bin/env python3
"""
Sweet Bonanza 1000 - Standalone Game Launcher
Launches the game with virtual wallet balance integration.

Usage:
    python launcher.py --balance 500
    python launcher.py --balance 1000 --port 8080
"""

import argparse
import asyncio
import base64
import html
import http.cookiejar
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import webbrowser
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener

# Game configuration
GAME_ID = 95426
GAME_NAME = "Sweet Bonanza 1000"
BASE_URL = "https://melbet-tn.com"
LANG = "en"


def _build_api_url(base_url: str, path: str, params: dict) -> str:
    base_url = base_url.rstrip("/")
    qs = urlencode({k: v for k, v in params.items() if v is not None}, doseq=True)
    return f"{base_url}{path}?{qs}" if qs else f"{base_url}{path}"


def _make_http_opener(base_url: str, lang: str):
    jar = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(jar))
    opener.addheaders = [
        (
            "User-Agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        ),
        ("Accept", "application/json, text/plain, */*"),
        ("Accept-Language", f"{lang},{lang};q=0.9,en;q=0.8"),
        ("Referer", f"{base_url.rstrip('/')}/{lang}/slots"),
        ("X-Requested-With", "XMLHttpRequest"),
    ]
    # Warm up cookies
    try:
        with opener.open(f"{base_url.rstrip('/')}/{lang}/slots", timeout=30) as r:
            r.read(1)
    except Exception:
        pass
    return opener


def _get_demo_link(game_id: int, retries: int = 5, backoff_s: float = 0.75) -> str:
    """Fetch the demo game URL from MelBet API."""
    opener = _make_http_opener(BASE_URL, LANG)

    # Warm up with game page
    try:
        with opener.open(f"{BASE_URL}/{LANG}/slots?game={game_id}", timeout=30) as r:
            r.read(1)
    except Exception:
        pass

    api_url = _build_api_url(
        BASE_URL,
        "/web-api/tpgamesopening/getgameurl",
        {
            "demo": "true",
            "id": game_id,
            "withGameInfo": "true",
            "sectionId": 1,
            "launchDomain": "melbet-tn.com/",
        },
    )

    last_err = None
    for attempt in range(retries + 1):
        try:
            req = Request(api_url, method="GET")
            with opener.open(req, timeout=30) as r:
                data = r.read().decode("utf-8")
            j = json.loads(data)
            if isinstance(j, dict) and isinstance(j.get("link"), str) and j.get("link"):
                return str(j["link"])
            last_err = "Demo link not found in response"
        except Exception as e:
            last_err = str(e)

        if attempt < retries:
            time.sleep(backoff_s * (2**attempt))

    raise RuntimeError(f"Failed to get demo link: {last_err}")


class Wallet:
    def __init__(self, initial_balance: float = 1000.0):
        self.balance = initial_balance

    def update(self, amount: float):
        self.balance = amount


def _b64url_encode(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> str:
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii")).decode("utf-8")


def _make_proxy_path(upstream_url: str) -> str:
    u = urlparse(upstream_url)
    origin = f"{u.scheme}://{u.netloc}"
    token = _b64url_encode(origin)
    path = u.path if u.path else "/"
    if not path.startswith("/"):
        path = "/" + path
    proxied = f"/p/{token}{path}"
    if u.query:
        proxied += "?" + u.query
    return proxied


def create_server(host: str, port: int, initial_balance: float, inject_scripts):
    """Create the HTTP server that serves the game launcher."""
    wallet = Wallet(initial_balance)
    demo_url_cache = {}
    inject_sources = []
    for script_path in inject_scripts:
        with open(script_path, "r", encoding="utf-8") as f:
            inject_sources.append(f.read())

    # Cookie jar for proxied upstream requests.
    proxy_jar = http.cookiejar.CookieJar()
    proxy_opener = build_opener(HTTPCookieProcessor(proxy_jar))
    proxy_opener.addheaders = [
        (
            "User-Agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        ),
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
        ("Accept-Language", f"{LANG},{LANG};q=0.9,en;q=0.8"),
        ("Accept-Encoding", "identity"),
        ("Connection", "close"),
    ]

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass  # Suppress logging

        def _send_html(self, status: int, content: str):
            body = content.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, status: int, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path or "/"

            if path.startswith("/p/"):
                self._proxy("GET")
                return

            if path == "/api/wallet/balance":
                self._send_json(200, {"balance": wallet.balance, "currency": "FUN"})
                return

            if path == "/" or path.startswith("/game"):
                # Get demo URL
                if GAME_ID not in demo_url_cache:
                    try:
                        demo_url_cache[GAME_ID] = _get_demo_link(GAME_ID)
                    except Exception as e:
                        self._send_html(
                            500, f"<h1>Failed to get game URL</h1><pre>{e}</pre>"
                        )
                        return

                demo_url = demo_url_cache[GAME_ID]
                qs = parse_qs(parsed.query)
                use_proxy = qs.get("proxy", ["0"])[0] in ("1", "true", "yes")
                self._send_html(
                    200, self._render_game_page(demo_url, use_proxy=use_proxy)
                )
                return

            self._send_html(404, "<h1>Not Found</h1>")

        def do_POST(self):
            parsed = urlparse(self.path)
            path = parsed.path or "/"

            if path.startswith("/p/"):
                self._proxy("POST")
                return

            if path == "/api/wallet/sync":
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len)
                try:
                    data = json.loads(body)
                    new_balance = float(data.get("balance", wallet.balance))
                    wallet.update(new_balance)
                    self._send_json(200, {"success": True, "balance": wallet.balance})
                except Exception as e:
                    self._send_json(400, {"success": False, "error": str(e)})
                return

            self._send_json(404, {"error": "Not found"})

        def _render_game_page(self, demo_url: str, use_proxy: bool) -> str:
            iframe_src = _make_proxy_path(demo_url) if use_proxy else demo_url
            return f"""<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{GAME_NAME}</title>
    <style>
        body {{ margin: 0; font-family: system-ui, sans-serif; }}
        header {{ display: flex; gap: 12px; align-items: center; padding: 10px 12px; background: #111; color: #fff; flex-wrap: wrap; }}
        header input {{ width: 120px; padding: 6px 8px; border-radius: 6px; border: 1px solid #333; background: #0b0b0b; color: #fff; }}
        header button {{ padding: 6px 10px; border-radius: 6px; border: 1px solid #333; background: #1b1b1b; color: #fff; cursor: pointer; }}
        header button:hover {{ background: #222; }}
        iframe {{ width: 100vw; height: calc(100vh - 44px); border: 0; }}
        .spacer {{ flex: 1 1 auto; }}
        .muted {{ opacity: .75; }}
    </style>
</head>
<body>
    <header>
        <strong>{GAME_NAME}</strong>
        <span class="muted">Game ID: {GAME_ID}</span>
        <span class="spacer"></span>
        <label class="muted" for="bal">Wallet</label>
        <input id="bal" inputmode="decimal" autocomplete="off" />
        <button id="setBal" type="button">Set</button>
        <span id="balMsg" class="muted"></span>
    </header>
    <iframe id="gameFrame" src="{iframe_src}" allowfullscreen></iframe>
    <script>
        let walletBalance = {wallet.balance};
        let lastGameBalance = null;

        const balInput = document.getElementById('bal');
        const balMsg = document.getElementById('balMsg');
        const gameFrame = document.getElementById('gameFrame');

        function broadcastBalance(val) {{
            try {{
                gameFrame.contentWindow.postMessage({{ type: 'MELBET_BALANCE_UPDATE', balance: val }}, '*');
            }} catch (e) {{}}
        }}

        function setMsg(txt) {{
            balMsg.textContent = txt || '';
            if (txt) setTimeout(() => {{ if (balMsg.textContent === txt) balMsg.textContent = ''; }}, 2000);
        }}

        async function refreshWalletBalance() {{
            try {{
                const r = await fetch('/api/wallet/balance');
                const j = await r.json();
                if (typeof j.balance === 'number') {{
                    walletBalance = j.balance;
                    balInput.value = walletBalance.toFixed(2);
                    broadcastBalance(walletBalance);
                }}
            }} catch (e) {{}}
        }}

        async function syncWallet(newBalance) {{
            try {{
                await fetch('/api/wallet/sync', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{ balance: newBalance }})
                }});
                broadcastBalance(newBalance);
            }} catch (e) {{ console.error("Failed to sync wallet", e); }}
        }}

        document.getElementById('setBal').addEventListener('click', async () => {{
            const v = parseFloat((balInput.value || '').toString().replace(/,/g, ''));
            if (!Number.isFinite(v)) {{
                setMsg('Invalid number');
                return;
            }}
            walletBalance = v;
            await syncWallet(walletBalance);
            setMsg('Updated');
        }});

        refreshWalletBalance();
        setInterval(() => broadcastBalance(walletBalance), 1000);

        window.addEventListener('message', (e) => {{
            let data = e.data;
            try {{ if (typeof data === 'string') data = JSON.parse(data); }} catch(err){{}}
            if (!data) return;

            if (data.name === 'post_updateBalance' || (data.event === 'updateBalance' && data.params?.total)) {{
                const rawAmount = data.params?.total?.amount;
                if (typeof rawAmount === 'number') {{
                    const gameVal = rawAmount / 100.0;
                    if (lastGameBalance === null) {{
                        lastGameBalance = gameVal;
                        console.log("Initialized baseline game balance:", gameVal);
                    }} else {{
                        const delta = gameVal - lastGameBalance;
                        lastGameBalance = gameVal;
                        if (delta !== 0) {{
                            walletBalance += delta;
                            syncWallet(walletBalance);
                            if (document.activeElement !== balInput) {{
                                balInput.value = walletBalance.toFixed(2);
                            }}
                        }}
                    }}
                }}
            }}
        }});
    </script>
</body>
</html>"""

        def _proxy(self, method: str):
            parsed = urlparse(self.path)
            path = parsed.path or "/"
            parts = path.split("/", 3)
            if len(parts) < 3 or parts[1] != "p":
                self._send_html(400, "<h1>Bad proxy request</h1>")
                return
            token = parts[2]
            rest = ""
            if len(parts) == 4:
                rest = parts[3]
            try:
                upstream_origin = _b64url_decode(token)
            except Exception as e:
                self._send_html(
                    400, f"<h1>Bad proxy token</h1><pre>{html.escape(str(e))}</pre>"
                )
                return

            upstream_path = "/" + rest if rest else "/"
            upstream_url = upstream_origin.rstrip("/") + upstream_path
            if parsed.query:
                upstream_url += "?" + parsed.query

            body = None
            if method not in ("GET", "HEAD"):
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len) if content_len else b""

            headers = {}
            for h in ("Content-Type", "Accept", "Accept-Language", "User-Agent"):
                v = self.headers.get(h)
                if v:
                    headers[h] = v
            headers["Accept-Encoding"] = "identity"

            # Avoid leaking our local Origin/Referer upstream (some backends validate them).
            headers["Origin"] = upstream_origin
            headers["Referer"] = upstream_origin + "/"

            try:
                req = Request(upstream_url, data=body, method=method, headers=headers)
                with proxy_opener.open(req, timeout=60) as r:
                    status = getattr(r, "status", 200)
                    resp_headers = dict(r.headers.items())
                    raw = r.read()
            except Exception as e:
                self._send_html(
                    502, f"<h1>Upstream error</h1><pre>{html.escape(str(e))}</pre>"
                )
                return

            content_type = resp_headers.get("Content-Type", "")
            lower_ct = content_type.lower()
            is_html = "text/html" in lower_ct or "application/xhtml+xml" in lower_ct
            is_css = "text/css" in lower_ct

            out = raw
            if is_html:
                charset = "utf-8"
                m = re.search(r"charset=([A-Za-z0-9_\\-]+)", content_type, flags=re.I)
                if m:
                    charset = m.group(1)
                try:
                    text = raw.decode(charset, errors="replace")
                except Exception:
                    text = raw.decode("utf-8", errors="replace")
                text = self._rewrite_html(text, token, upstream_origin)
                out = text.encode("utf-8")
                content_type = "text/html; charset=utf-8"
            elif is_css:
                try:
                    text = raw.decode("utf-8", errors="replace")
                except Exception:
                    text = raw.decode("latin-1", errors="replace")
                text = self._rewrite_css(text, token, upstream_origin)
                out = text.encode("utf-8")
                content_type = "text/css; charset=utf-8"

            self.send_response(status)

            # Strip headers that commonly break injection/framing on our origin.
            strip = {
                "Content-Security-Policy",
                "Content-Security-Policy-Report-Only",
                "X-Frame-Options",
                "Strict-Transport-Security",
            }
            for k, v in resp_headers.items():
                if k in strip:
                    continue
                lk = k.lower()
                if lk in ("content-length", "connection", "transfer-encoding"):
                    continue
                # Cookies are handled server-side via cookiejar.
                if lk == "set-cookie":
                    continue
                self.send_header(k, v)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(out)

        def _rewrite_css(self, css_text: str, token: str, upstream_origin: str) -> str:
            # Rewrite url(/...) and @import "/..." to stay within the proxy prefix.
            prefix = f"/p/{token}"
            css_text = re.sub(
                r'url\\(\\s*[\'"]?/(?!p/)([^)\'"\\s]+)[\'"]?\\s*\\)',
                rf"url({prefix}/\\1)",
                css_text,
                flags=re.I,
            )
            css_text = re.sub(
                r'@import\\s+[\'"]/(?!p/)([^\'"]+)[\'"]',
                rf'@import "{prefix}/\\1"',
                css_text,
                flags=re.I,
            )
            # Rewrite direct references to the upstream origin.
            css_text = css_text.replace(upstream_origin.rstrip("/") + "/", prefix + "/")
            return css_text

        def _rewrite_html(
            self, html_text: str, token: str, upstream_origin: str
        ) -> str:
            prefix = f"/p/{token}"
            upstream_origin = upstream_origin.rstrip("/")
            upstream_netloc = urlparse(upstream_origin).netloc

            # Remove CSP meta tags that can block our injected script.
            html_text = re.sub(
                r'<meta[^>]+http-equiv=[\'"]Content-Security-Policy[\'"][^>]*>',
                "",
                html_text,
                flags=re.I,
            )

            def rewrite_url(url: str) -> str:
                u = (url or "").strip()
                if not u:
                    return u
                if (
                    u.startswith("data:")
                    or u.startswith("blob:")
                    or u.startswith("mailto:")
                    or u.startswith("javascript:")
                    or u.startswith("#")
                ):
                    return u
                if u.startswith(upstream_origin + "/"):
                    return prefix + u[len(upstream_origin) :]
                if u.startswith("//" + upstream_netloc + "/"):
                    return prefix + u[len("//" + upstream_netloc) :]
                if (
                    u.startswith("/")
                    and not u.startswith("/p/")
                    and not u.startswith("/api/")
                ):
                    return prefix + u
                return u

            # Rewrite common URL-bearing attributes.
            attr_pat = re.compile(
                r'\\b(src|href|action|poster|data)=([\'"])(.*?)(\\2)', flags=re.I
            )

            def attr_sub(m):
                key = m.group(1)
                quote = m.group(2)
                val = m.group(3)
                return f"{key}={quote}{rewrite_url(val)}{quote}"

            html_text = attr_pat.sub(attr_sub, html_text)

            # Inject <base> and our init scripts early in <head>.
            inject = []
            if re.search(r"<base\\b", html_text, flags=re.I) is None:
                inject.append(f'<base href="{prefix}/">')

            # Make /fetch and XHR root-absolute URLs go through the proxy prefix.
            inject.append(
                "<script>(function(){"
                f"window.__MELBET_PROXY_PREFIX={json.dumps(prefix)};"
                f"window.__MELBET_UPSTREAM_ORIGIN={json.dumps(upstream_origin)};"
                "const p=window.__MELBET_PROXY_PREFIX;"
                "const upstream=window.__MELBET_UPSTREAM_ORIGIN;"
                "function rewrite(u){"
                "try{"
                "if(typeof u!=='string') return u;"
                "if(u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('mailto:')||u.startsWith('javascript:')||u.startsWith('#')) return u;"
                "const url=new URL(u, window.location.href);"
                "const isLocalHost = (url.host === window.location.host);"
                "const isUpstream = (upstream && url.origin === upstream);"
                "if((isLocalHost || isUpstream) && url.pathname.startsWith('/') && !url.pathname.startsWith('/p/') && !url.pathname.startsWith('/api/')){"
                "return p + url.pathname + (url.search||'');"
                "}"
                "if(u.startsWith('/') && !u.startsWith('/p/') && !u.startsWith('/api/')) return p + u;"
                "return u;"
                "}catch(e){return u;}"
                "}"
                "const ofetch=window.fetch;"
                "window.fetch=function(input,init){"
                "try{"
                "const url=(typeof input==='string')?input:input&&input.url;"
                "const nu=rewrite(url);"
                "if(typeof nu==='string' && nu!==url){"
                "if(typeof input==='string') input=nu; else input=new Request(nu,input);"
                "}"
                "}catch(e){}"
                "return ofetch.call(this,input,init);"
                "};"
                "const oopen=XMLHttpRequest.prototype.open;"
                "XMLHttpRequest.prototype.open=function(m,u){"
                "try{if(typeof u==='string'){const nu=rewrite(u); if(typeof nu==='string') u=nu;}}catch(e){}"
                "return oopen.apply(this,arguments);"
                "};"
                "})();</script>"
            )

            for src in inject_sources:
                inject.append("<script>\n" + src + "\n</script>")

            inject_html = "\n".join(inject) + "\n"

            m = re.search(r"<head\\b[^>]*>", html_text, flags=re.I)
            if m:
                i = m.end()
                return html_text[:i] + "\n" + inject_html + html_text[i:]
            return inject_html + html_text

    class _ReuseThreadingTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    return _ReuseThreadingTCPServer((host, port), Handler)


def _resolve_inject_scripts(script_paths, base_dir: str):
    resolved = []
    for p in script_paths:
        if not p:
            continue
        candidate = p
        if not os.path.isabs(candidate):
            candidate = os.path.abspath(os.path.join(base_dir, candidate))
        if not os.path.exists(candidate):
            raise FileNotFoundError(f"Inject script not found: {candidate}")
        resolved.append(candidate)
    return resolved


def run_server_mode(
    host: str, port: int, initial_balance: float, inject_scripts, use_proxy: bool
):
    server = create_server(host, port, initial_balance, inject_scripts=inject_scripts)

    def run_server():
        q = "?proxy=1" if use_proxy else ""
        print(f"Server running on http://{host}:{port}/{q}")
        server.serve_forever()

    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(1)

    url = f"http://{host}:{port}/" + ("?proxy=1" if use_proxy else "")
    print(f"\nOpen: {url}")
    try:
        webbrowser.open(url)
    except Exception:
        pass

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        return 0


def main():
    parser = argparse.ArgumentParser(
        description=f"Launch {GAME_NAME} with virtual wallet"
    )
    parser.add_argument(
        "--balance", type=float, default=1000.0, help="Initial balance (default: 1000)"
    )
    parser.add_argument(
        "--host", default="127.0.0.1", help="Server host (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port", type=int, default=8000, help="Server port (default: 8000)"
    )
    parser.add_argument(
        "--inject",
        action="append",
        default=None,
        help="JS file to inject into proxied HTML (repeatable). Default: injectors/pragmatic_specific.js",
    )
    parser.add_argument(
        "--direct",
        action="store_true",
        help="Open the game directly (no proxy, no injection). Useful for debugging only.",
    )
    parser.add_argument(
        "--proxy",
        action="store_true",
        help="(Default) Use local proxy + injection. Kept for compatibility.",
    )
    args = parser.parse_args()

    base_dir = os.path.abspath(os.path.dirname(__file__))
    inject = (
        args.inject if args.inject is not None else ["injectors/pragmatic_specific.js"]
    )
    try:
        inject_scripts = _resolve_inject_scripts(inject, base_dir)
    except Exception as e:
        print(f"Error: {e}")
        return 1

    # Default mode is proxy injection (no Playwright, no extension).
    use_proxy = True
    if args.direct:
        use_proxy = False
    scripts = inject_scripts if use_proxy else []
    return run_server_mode(
        args.host, args.port, args.balance, scripts, use_proxy=use_proxy
    )


if __name__ == "__main__":
    sys.exit(main())
