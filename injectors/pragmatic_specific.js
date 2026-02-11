// Pragmatic Play Specific Interceptor - Canvas Direct Approach
// Directly intercepts canvas rendering calls - MUST RUN BEFORE GAME LOADS

(function () {
  "use strict";

  let melBetBalance = 500.0; // Default, will be updated from API/messages

  // Avoid touching buy/bet/win UI numbers like 2,000 / 10,000.
  // Pragmatic demo credits are typically 100,000+ (often 1,000,000).
  const MIN_REPLACE_VALUE = 100000;

  function _formatBalanceForMatch(hasDecimals) {
    const v = Number(melBetBalance);
    if (!Number.isFinite(v)) return null;

    if (hasDecimals) {
      return v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    // When the game toggles to a no-currency/no-decimals view, keep it integer.
    return Math.round(v).toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  }

  function _replaceBalance(text) {
    if (typeof text !== "string") return text;

    // Matches:
    // - $1,000,000.00
    // - 1000000
    // - 1,000,000
    // - 399,998.50
    const balanceRegex = /(\$?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/g;

    return text.replace(balanceRegex, (match, dollar, whole, decimal) => {
      const numValue = parseFloat(whole.replace(/,/g, "") + (decimal ? "." + decimal : ""));
      if (!Number.isFinite(numValue)) return match;
      if (numValue < MIN_REPLACE_VALUE) return match;

      const replacement = _formatBalanceForMatch(Boolean(decimal));
      if (!replacement) return match;
      return (dollar || "") + replacement;
    });
  }

  // Identify which frame we're in
  const frameInfo =
    window === window.top ? "TOP FRAME" : "IFRAME: " + window.location.href.substring(0, 50);
  console.log("[Pragmatic Canvas] EARLY INIT in", frameInfo);

  // Fetch balance from wallet API (top frame only)
  async function fetchBalanceFromAPI() {
    try {
      const res = await fetch("/api/wallet/balance");
      const data = await res.json();
      if (data.balance !== undefined) {
        melBetBalance = data.balance;
        console.log("[Pragmatic Canvas] Got balance from API:", melBetBalance);
        // Broadcast to iframes
        document.querySelectorAll("iframe").forEach((iframe) => {
          try {
            iframe.contentWindow.postMessage(
              { type: "MELBET_BALANCE_UPDATE", balance: melBetBalance },
              "*"
            );
          } catch (e) {}
        });
      }
    } catch (e) {
      console.log("[Pragmatic Canvas] Failed to fetch balance from API");
    }
  }

  // Poll for balance updates in top frame
  if (window === window.top) {
    setInterval(fetchBalanceFromAPI, 1000);
    setTimeout(fetchBalanceFromAPI, 100);
  }

  // IMMEDIATELY intercept canvas - before any game code runs
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.getContext = function (contextType, ...args) {
    const context = originalGetContext.call(this, contextType, ...args);

    // Intercept 2D context
    if (context && contextType === "2d" && !context._melBetIntercepted) {
      context._melBetIntercepted = true;
      console.log("[Pragmatic Canvas] Intercepting 2D context in", frameInfo);

      const originalFillText = context.fillText.bind(context);
      context.fillText = function (text, x, y, maxWidth) {
        return originalFillText(_replaceBalance(text), x, y, maxWidth);
      };

      const originalStrokeText = context.strokeText.bind(context);
      context.strokeText = function (text, x, y, maxWidth) {
        return originalStrokeText(_replaceBalance(text), x, y, maxWidth);
      };
    }

    return context;
  };

  // Also intercept prototype directly
  const proto = CanvasRenderingContext2D.prototype;
  const origFillText = proto.fillText;
  const origStrokeText = proto.strokeText;

  proto.fillText = function (text, x, y, maxWidth) {
    return origFillText.call(this, _replaceBalance(text), x, y, maxWidth);
  };

  proto.strokeText = function (text, x, y, maxWidth) {
    return origStrokeText.call(this, _replaceBalance(text), x, y, maxWidth);
  };

  // Listen for balance updates from parent frame
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "MELBET_BALANCE_UPDATE") {
      melBetBalance = parseFloat(e.data.balance) || 500;
      console.log("[Pragmatic Canvas] Balance updated via message:", melBetBalance);
    }
  });

  console.log("[Pragmatic Canvas] Canvas interception ready in", frameInfo);
})();
