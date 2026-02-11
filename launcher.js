#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const minimist = require("minimist");
const Fastify = require("fastify");
const rawBody = require("fastify-raw-body");
const { request: urequest } = require("undici");
const setCookie = require("set-cookie-parser");

const GAME_ID = 95426;
const GAME_NAME = "Sweet Bonanza 1000";
const BASE_URL = "https://melbet-tn.com";
const LANG = "en";

function buildApiUrl(baseUrl, p, params) {
  const clean = baseUrl.replace(/\/$/, "");
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    usp.append(k, String(v));
  }
  const q = usp.toString();
  return q ? `${clean}${p}?${q}` : `${clean}${p}`;
}

class Wallet {
  constructor(initialBalance = 1000.0) {
    this.balance = Math.max(0, Number(initialBalance) || 0);
  }

  update(amount) {
    const v = Number(amount);
    if (!Number.isFinite(v)) return this.balance;
    this.balance = Math.max(0, v);
    return this.balance;
  }
}

class SimpleCookieJar {
  constructor() {
    this.store = new Map(); // origin => Map(name => value)
  }

  _origin(urlStr) {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}`;
  }

  getCookieHeader(urlStr) {
    const origin = this._origin(urlStr);
    const jar = this.store.get(origin);
    if (!jar || jar.size === 0) return "";
    return Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  storeFromResponse(urlStr, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const origin = this._origin(urlStr);
    let jar = this.store.get(origin);
    if (!jar) {
      jar = new Map();
      this.store.set(origin, jar);
    }
    const parsed = setCookie.parse(setCookieHeaders, { map: false });
    for (const c of parsed) {
      if (!c || !c.name) continue;
      if (typeof c.value !== "string") continue;
      jar.set(c.name, c.value);
    }
  }
}

function b64urlEncode(s) {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s) {
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s + "=".repeat(padLen);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function makeProxyPath(upstreamUrl) {
  const u = new URL(upstreamUrl);
  const origin = `${u.protocol}//${u.host}`;
  const token = b64urlEncode(origin);
  const p =
    u.pathname && u.pathname.startsWith("/")
      ? u.pathname
      : `/${u.pathname || ""}`;
  const q = u.search || "";
  return `/p/${token}${p}${q}`;
}

function rewriteProxyLocation(locationHeader, fallbackBaseUrl) {
  if (!locationHeader) return locationHeader;
  try {
    const abs = new URL(locationHeader, fallbackBaseUrl);
    const origin = `${abs.protocol}//${abs.host}`;
    const token = b64urlEncode(origin);
    const pathname =
      abs.pathname && abs.pathname.startsWith("/")
        ? abs.pathname
        : `/${abs.pathname || ""}`;
    return `/p/${token}${pathname}${abs.search || ""}`;
  } catch (_) {
    return locationHeader;
  }
}

function rewriteCss(cssText, token, upstreamOrigin) {
  const prefix = `/p/${token}`;
  let out = cssText;
  out = out.replace(
    /url\(\s*['"]?\/(?!p\/)([^)'"\s]+)['"]?\s*\)/gi,
    `url(${prefix}/$1)`,
  );
  out = out.replace(
    /@import\s+['"]\/(?!p\/)([^'"]+)['"]/gi,
    `@import "${prefix}/$1"`,
  );
  out = out.split(`${upstreamOrigin.replace(/\/$/, "")}/`).join(`${prefix}/`);
  return out;
}

function rewriteHtml(htmlText, token, upstreamOrigin, injectSources) {
  const prefix = `/p/${token}`;
  const upstream = upstreamOrigin.replace(/\/$/, "");
  const upstreamNetloc = new URL(upstream).host;

  let out = htmlText.replace(
    /<meta[^>]+http-equiv=['"]Content-Security-Policy['"][^>]*>/gi,
    "",
  );

  function rewriteUrl(url) {
    const u = (url || "").trim();
    if (!u) return u;
    if (/^(data:|blob:|mailto:|javascript:|#)/i.test(u)) return u;
    if (u.startsWith(`${upstream}/`))
      return `${prefix}${u.slice(upstream.length)}`;
    if (u.startsWith(`//${upstreamNetloc}/`))
      return `${prefix}${u.slice(`//${upstreamNetloc}`.length)}`;
    if (u.startsWith("/") && !u.startsWith("/p/") && !u.startsWith("/api/"))
      return `${prefix}${u}`;
    return u;
  }

  out = out.replace(
    /\b(src|href|action|poster|data)=(["'])(.*?)(\2)/gi,
    (_m, key, quote, val) => {
      return `${key}=${quote}${rewriteUrl(val)}${quote}`;
    },
  );

  const inject = [];
  if (!/<base\b/i.test(out)) {
    inject.push(`<base href="${prefix}/">`);
  }

  inject.push(
    "<script>(function(){" +
      `window.__MELBET_PROXY_PREFIX=${JSON.stringify(prefix)};` +
      `window.__MELBET_UPSTREAM_ORIGIN=${JSON.stringify(upstream)};` +
      "const p=window.__MELBET_PROXY_PREFIX;" +
      "const upstream=window.__MELBET_UPSTREAM_ORIGIN;" +
      "function rewrite(u){" +
      "try{" +
      "if(typeof u!=='string') return u;" +
      "if(u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('mailto:')||u.startsWith('javascript:')||u.startsWith('#')) return u;" +
      "const url=new URL(u, window.location.href);" +
      "const isLocalHost=(url.host===window.location.host);" +
      "const isUpstream=(upstream && url.origin===upstream);" +
      "if((isLocalHost||isUpstream)&&url.pathname.startsWith('/')&&!url.pathname.startsWith('/p/')&&!url.pathname.startsWith('/api/')){" +
      "return p+url.pathname+(url.search||'');" +
      "}" +
      "if(u.startsWith('/')&&!u.startsWith('/p/')&&!u.startsWith('/api/')) return p+u;" +
      "return u;" +
      "}catch(e){return u;}" +
      "}" +
      "const ofetch=window.fetch;" +
      "window.fetch=function(input,init){" +
      "try{" +
      "const url=(typeof input==='string')?input:input&&input.url;" +
      "const nu=rewrite(url);" +
      "if(typeof nu==='string' && nu!==url){" +
      "if(typeof input==='string') input=nu; else input=new Request(nu,input);" +
      "}" +
      "}catch(e){}" +
      "return ofetch.call(this,input,init);" +
      "};" +
      "const oopen=XMLHttpRequest.prototype.open;" +
      "XMLHttpRequest.prototype.open=function(m,u){" +
      "try{if(typeof u==='string'){const nu=rewrite(u); if(typeof nu==='string') u=nu;}}catch(e){}" +
      "return oopen.apply(this,arguments);" +
      "};" +
      "})();</script>",
  );

  for (const src of injectSources) {
    inject.push(`<script>\n${src}\n</script>`);
  }

  const injectHtml = `${inject.join("\n")}\n`;
  const headMatch = out.match(/<head\b[^>]*>/i);
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length;
    return `${out.slice(0, idx)}\n${injectHtml}${out.slice(idx)}`;
  }
  return injectHtml + out;
}

async function requestWithCookies(cookieJar, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookie = cookieJar.getCookieHeader(url);
  if (cookie) headers.cookie = cookie;

  const res = await urequest(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  const setCookieHeaders = res.headers["set-cookie"];
  if (setCookieHeaders) cookieJar.storeFromResponse(url, setCookieHeaders);

  return res;
}

async function warmupCookies(cookieJar) {
  const warm = `${BASE_URL.replace(/\/$/, "")}/${LANG}/slots`;
  try {
    const res = await requestWithCookies(cookieJar, warm, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": `${LANG},${LANG};q=0.9,en;q=0.8`,
      },
    });
    await res.body.dump();
  } catch (_) {}
}

async function getDemoLink(gameId, retries = 5, backoffMs = 750) {
  const cookieJar = new SimpleCookieJar();
  await warmupCookies(cookieJar);

  const apiUrl = buildApiUrl(BASE_URL, "/web-api/tpgamesopening/getgameurl", {
    demo: "true",
    id: gameId,
    withGameInfo: "true",
    sectionId: 1,
    launchDomain: "melbet-tn.com/",
  });

  let lastErr = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await requestWithCookies(cookieJar, apiUrl, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          accept: "application/json, text/plain, */*",
          "accept-language": `${LANG},${LANG};q=0.9,en;q=0.8`,
          referer: `${BASE_URL.replace(/\/$/, "")}/${LANG}/slots`,
          "x-requested-with": "XMLHttpRequest",
        },
      });
      const txt = await res.body.text();
      const j = JSON.parse(txt);
      if (j && typeof j.link === "string" && j.link) {
        return j.link;
      }
      lastErr = "Demo link not found in response";
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }

  throw new Error(`Failed to get demo link: ${lastErr}`);
}

function renderGamePage({ demoUrl, useProxy, walletBalance }) {
  const iframeSrc = useProxy ? makeProxyPath(demoUrl) : demoUrl;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${GAME_NAME}</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    header { display: flex; gap: 12px; align-items: center; padding: 10px 12px; background: #111; color: #fff; flex-wrap: wrap; }
    header input { width: 120px; padding: 6px 8px; border-radius: 6px; border: 1px solid #333; background: #0b0b0b; color: #fff; }
    header button { padding: 6px 10px; border-radius: 6px; border: 1px solid #333; background: #1b1b1b; color: #fff; cursor: pointer; }
    header button:hover { background: #222; }
    iframe { width: 100vw; height: calc(100vh - 44px); border: 0; }
    #spinLock {
      position: fixed;
      right: 0;
      bottom: 0;
      width: 420px;
      height: 240px;
      z-index: 2147483646;
      pointer-events: none;
      background: transparent;
    }
    .spacer { flex: 1 1 auto; }
    .muted { opacity: .75; }
  </style>
</head>
<body>
  <header>
    <strong>${GAME_NAME}</strong>
    <span class="muted">Game ID: ${GAME_ID}</span>
    <span class="spacer"></span>
    <label class="muted" for="bal">Wallet</label>
    <input id="bal" inputmode="decimal" autocomplete="off" />
    <button id="setBal" type="button">Set</button>
    <span id="balMsg" class="muted"></span>
  </header>
  <iframe id="gameFrame" src="${iframeSrc}" allowfullscreen></iframe>
  <div id="spinLock" aria-hidden="true"></div>
  <script>
    let walletBalance = ${Number(walletBalance)};
    let lastGameBalance = null;

    const balInput = document.getElementById('bal');
    const balMsg = document.getElementById('balMsg');
    const gameFrame = document.getElementById('gameFrame');
    const spinLock = document.getElementById('spinLock');

    function updateSpinLock() {
      spinLock.style.pointerEvents = walletBalance <= 0 ? 'auto' : 'none';
    }

    function broadcastBalance(val) {
      try {
        gameFrame.contentWindow.postMessage({ type: 'MELBET_BALANCE_UPDATE', balance: val }, '*');
      } catch (e) {}
    }

    function setMsg(txt) {
      balMsg.textContent = txt || '';
      if (txt) setTimeout(() => { if (balMsg.textContent === txt) balMsg.textContent = ''; }, 2000);
    }

    async function refreshWalletBalance() {
      try {
        const r = await fetch('/api/wallet/balance');
        const j = await r.json();
        if (typeof j.balance === 'number') {
          walletBalance = j.balance;
          balInput.value = walletBalance.toFixed(2);
          broadcastBalance(walletBalance);
          updateSpinLock();
        }
      } catch (e) {}
    }

    async function syncWallet(newBalance) {
      try {
        const r = await fetch('/api/wallet/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ balance: newBalance })
        });
        const j = await r.json();
        if (j && typeof j.balance === 'number') {
          walletBalance = j.balance;
        } else {
          walletBalance = Math.max(0, Number(newBalance) || 0);
        }
        if (document.activeElement !== balInput) {
          balInput.value = walletBalance.toFixed(2);
        }
        broadcastBalance(walletBalance);
        updateSpinLock();
      } catch (e) { console.error('Failed to sync wallet', e); }
    }

    document.getElementById('setBal').addEventListener('click', async () => {
      const v = parseFloat((balInput.value || '').toString().replace(/,/g, ''));
      if (!Number.isFinite(v)) {
        setMsg('Invalid number');
        return;
      }
      if (v < 0) {
        setMsg('Balance cannot be negative');
        return;
      }
      walletBalance = v;
      await syncWallet(walletBalance);
      setMsg('Updated');
    });

    refreshWalletBalance();
    setInterval(() => broadcastBalance(walletBalance), 1000);

    window.addEventListener('message', (e) => {
      let data = e.data;
      try { if (typeof data === 'string') data = JSON.parse(data); } catch (err) {}
      if (!data) return;

      if (data.name === 'post_updateBalance' || (data.event === 'updateBalance' && data.params?.total)) {
        const rawAmount = data.params?.total?.amount;
        if (typeof rawAmount === 'number') {
          const gameVal = rawAmount / 100.0;
          if (lastGameBalance === null) {
            lastGameBalance = gameVal;
            console.log('Initialized baseline game balance:', gameVal);
          } else {
            const delta = gameVal - lastGameBalance;
            lastGameBalance = gameVal;
            if (delta !== 0) {
              walletBalance = Math.max(0, walletBalance + delta);
              syncWallet(walletBalance);
              if (document.activeElement !== balInput) {
                balInput.value = walletBalance.toFixed(2);
              }
              updateSpinLock();
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

function resolveInjectScripts(scriptPaths, baseDir) {
  const out = [];
  for (const p of scriptPaths || []) {
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
    if (!fs.existsSync(abs)) throw new Error(`Inject script not found: ${abs}`);
    out.push(abs);
  }
  return out;
}

async function createServer({
  host,
  port,
  initialBalance,
  injectScripts,
  useProxy,
}) {
  const wallet = new Wallet(initialBalance);
  const demoUrlCache = new Map();
  const injectSources = injectScripts.map((p) => fs.readFileSync(p, "utf8"));
  const proxyCookieJar = new SimpleCookieJar();

  const app = Fastify({ logger: false });
  // Accept arbitrary upstream payloads (binary, custom media types) on proxy routes.
  // Without this, Fastify can reject unknown content-types with 415 before our handler.
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    function (_req, body, done) {
      done(null, body);
    },
  );
  await app.register(rawBody, {
    field: "rawBody",
    global: true,
    encoding: false,
    runFirst: true,
  });

  app.get("/api/wallet/balance", async () => {
    return { balance: wallet.balance, currency: "FUN" };
  });

  app.post("/api/wallet/sync", async (req, reply) => {
    try {
      const data = req.body || {};
      const newBalance = Number(data.balance ?? wallet.balance);
      wallet.update(newBalance);
      return { success: true, balance: wallet.balance };
    } catch (e) {
      reply.code(400);
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  });

  async function renderRoot(req, reply) {
    let demoUrl = demoUrlCache.get(GAME_ID);
    if (!demoUrl) {
      try {
        demoUrl = await getDemoLink(GAME_ID);
        demoUrlCache.set(GAME_ID, demoUrl);
      } catch (e) {
        reply.code(500).type("text/html; charset=utf-8");
        return `<h1>Failed to get game URL</h1><pre>${String(e.message || e)}</pre>`;
      }
    }

    const useProxyFlag = String(
      (req.query && req.query.proxy) || "0",
    ).toLowerCase();
    const shouldProxy = ["1", "true", "yes"].includes(useProxyFlag)
      ? true
      : useProxy;
    reply.type("text/html; charset=utf-8");
    return renderGamePage({
      demoUrl,
      useProxy: shouldProxy,
      walletBalance: wallet.balance,
    });
  }

  app.get("/", renderRoot);
  app.get("/game", renderRoot);

  async function handleProxy(req, reply) {
    const token = req.params.token;
    const rest = req.params["*"] || "";

    let upstreamOrigin;
    try {
      upstreamOrigin = b64urlDecode(token);
      new URL(upstreamOrigin);
    } catch (e) {
      reply.code(400).type("text/html; charset=utf-8");
      return `<h1>Bad proxy token</h1><pre>${String(e.message || e)}</pre>`;
    }

    const upstreamPath = rest ? `/${rest}` : "/";
    const queryString = req.raw.url.includes("?")
      ? req.raw.url.slice(req.raw.url.indexOf("?"))
      : "";
    const upstreamUrl = `${upstreamOrigin.replace(/\/$/, "")}${upstreamPath}${queryString}`;

    const headers = {};
    for (const h of [
      "content-type",
      "accept",
      "accept-language",
      "user-agent",
    ]) {
      const v = req.headers[h];
      if (v) headers[h] = v;
    }
    headers["accept-encoding"] = "identity";
    headers.origin = upstreamOrigin;
    headers.referer = `${upstreamOrigin.replace(/\/$/, "")}/`;

    const body = ["GET", "HEAD"].includes(req.method) ? undefined : req.rawBody;

    try {
      const upstreamRes = await requestWithCookies(
        proxyCookieJar,
        upstreamUrl,
        {
          method: req.method,
          headers,
          body,
        },
      );

      const status = upstreamRes.statusCode || 200;
      const respHeaders = upstreamRes.headers || {};
      const rawBuf = Buffer.from(await upstreamRes.body.arrayBuffer());
      const rewrittenLocation = rewriteProxyLocation(
        respHeaders.location,
        upstreamUrl,
      );

      const ct = String(respHeaders["content-type"] || "");
      const lowerCt = ct.toLowerCase();
      const isHtml =
        lowerCt.includes("text/html") ||
        lowerCt.includes("application/xhtml+xml");
      const isCss = lowerCt.includes("text/css");

      let out = rawBuf;
      let outType = ct || "application/octet-stream";

      if (isHtml) {
        let text = rawBuf.toString("utf8");
        out = Buffer.from(
          rewriteHtml(text, token, upstreamOrigin, injectSources),
          "utf8",
        );
        outType = "text/html; charset=utf-8";
      } else if (isCss) {
        let text = rawBuf.toString("utf8");
        out = Buffer.from(rewriteCss(text, token, upstreamOrigin), "utf8");
        outType = "text/css; charset=utf-8";
      }

      reply.code(status);
      const strip = new Set([
        "content-security-policy",
        "content-security-policy-report-only",
        "x-frame-options",
        "strict-transport-security",
        "content-length",
        "connection",
        "transfer-encoding",
        "set-cookie",
      ]);

      for (const [k, v] of Object.entries(respHeaders)) {
        const lk = k.toLowerCase();
        if (strip.has(lk)) continue;
        if (lk === "location") continue;
        if (Array.isArray(v)) {
          reply.header(k, v.join(", "));
        } else if (v !== undefined) {
          reply.header(k, String(v));
        }
      }
      if (rewrittenLocation) {
        reply.header("location", rewrittenLocation);
      }
      reply.header("content-type", outType);
      reply.header("content-length", String(out.length));
      return reply.send(out);
    } catch (e) {
      reply.code(502).type("text/html; charset=utf-8");
      return `<h1>Upstream error</h1><pre>${String(e.message || e)}</pre>`;
    }
  }

  app.route({
    method: ["GET", "POST", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/p/:token/*",
    config: { rawBody: true },
    handler: handleProxy,
  });

  await app.listen({ host, port });
  const q = useProxy ? "?proxy=1" : "";
  console.log(`Server running on http://${host}:${port}/${q}`);
  console.log(`Open: http://${host}:${port}/${q}`);
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    boolean: ["direct", "proxy"],
    string: ["host", "inject"],
    default: {
      balance: 1000,
    },
    alias: {
      h: "host",
      p: "port",
    },
  });

  const baseDir = __dirname;
  const injectArg = args.inject;
  const injectList =
    injectArg === undefined
      ? ["injectors/pragmatic_specific.js"]
      : Array.isArray(injectArg)
        ? injectArg
        : [injectArg];

  let injectScripts;
  try {
    injectScripts = resolveInjectScripts(injectList, baseDir);
  } catch (e) {
    console.error(`Error: ${e.message || e}`);
    process.exit(1);
  }

  const useProxy = args.direct ? false : true;
  const scripts = useProxy ? injectScripts : [];
  const isRender = Boolean(process.env.RENDER);
  const host = String(args.host || (isRender ? "0.0.0.0" : "127.0.0.1"));
  const port = Number(args.port || process.env.PORT || 8000);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`Fatal: invalid port '${args.port || process.env.PORT}'`);
    process.exit(1);
  }

  try {
    await createServer({
      host,
      port,
      initialBalance: Number(args.balance),
      injectScripts: scripts,
      useProxy,
    });
  } catch (e) {
    console.error(`Fatal: ${e.message || e}`);
    process.exit(1);
  }
}

main();
