# Sweet Bonanza 1000 - Standalone Launcher

A standalone launcher for Sweet Bonanza 1000 (Game ID: 95426) with virtual wallet balance integration.

## Features

- 🎰 Launches Sweet Bonanza 1000 demo game
- 💰 Custom virtual wallet balance displayed directly in-game
- 🔄 Real-time balance sync - wins/losses update the virtual wallet
- 🎯 Dual-mode interception: Supports both currency (e.g., $500.00) and credits (e.g., 5,000) display modes
- ⚡ Advanced interception: Covers `toLocaleString`, `toString()`, `toFixed()`, and `String()` to catch ALL balance display paths

## Installation

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

## Usage

This launcher runs with **no Playwright** and **no browser extension**. It serves the game through a local reverse proxy and injects the interceptor JS server-side.

```bash
python3 launcher.py --balance 1000
```

(`--proxy` is optional; proxy mode is the default.)

Change host/port:
```bash
python3 launcher.py --proxy --host 127.0.0.1 --port 8000 --balance 1000
```

Inject a different script (repeat `--inject` to inject multiple files, in order):
```bash
python3 launcher.py --proxy --inject injectors/canvas_interceptor.js --balance 1000
```

### Debug: Direct (No Proxy / No Injection)

Opens the game directly (the game will not be intercepted).

```bash
python3 launcher.py --direct --balance 1000
```

## How It Works

1. The launcher starts a local HTTP server with a virtual wallet
2. Fetches the demo game URL from MelBet API
3. Serves the game through a local `/p/<token>/...` reverse proxy and injects the interceptor JS server-side
4. The injected script intercepts multiple JavaScript primitives (`toLocaleString`, `toString`, `toFixed`) to replace the game's internal demo balance with your custom wallet balance
5. Win/loss deltas are tracked and synced to your virtual wallet in real-time
6. The in-game CREDIT display updates automatically as you play, even when toggling between USD and Credit modes

You can edit the wallet balance live using the input in the top bar while the game is running.

## Files

- `launcher.py` - Main launcher script
- `injectors/` - JS interceptors injected into proxied HTML
  - `pragmatic_specific.js` - Advanced interception for Pragmatic Play (supports currency/credit toggling)
  - `canvas_interceptor.js` - Alternative canvas interception

## Technical Details

In proxy mode, the launcher injects scripts into proxied HTML responses. This allows intercepting core JavaScript methods before the game initializes, enabling robust balance replacement.

Only large "balance-like" values (>= 30,000 in internal game units) are replaced to preserve game UI elements like bet amounts, buy prices, and small wins. When the game toggles to "Credit" mode, the interceptor automatically applies the appropriate multiplier (typically 10x) to match the game's credit display logic.

## Troubleshooting

- If you see `ERR_SSL_PROTOCOL_ERROR` requests to `https://127.0.0.1:<port>/...`, upgrade to the latest version of this launcher (it rewrites those back through the proxy).
- If the game shows a “connection lost” screen, open DevTools Console inside the game iframe and look for failing network calls under `/p/<token>/...` (some upstream endpoints may block proxied access).
