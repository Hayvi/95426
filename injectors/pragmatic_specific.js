// Pragmatic Play Specific Interceptor - Canvas + PIXI Text override
// Must run before game loads.

(function () {
  "use strict";

  let melBetBalance = 500.0; // Default, will be updated from API/messages

  // Avoid touching buy/bet/win UI numbers like 2,000 / 10,000.
  // Pragmatic demo credits are typically 100,000+ (often 1,000,000).
  const MIN_REPLACE_VALUE = 100000;

  function formatBalance(hasDecimals, hasCurrency) {
    const v = Number(melBetBalance);
    if (!Number.isFinite(v)) return null;

    if (hasDecimals) {
      const s = v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return (hasCurrency ? "$" : "") + s;
    }

    // When the game toggles to a no-currency/no-decimals view, keep it integer.
    const s = Math.round(v).toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    return (hasCurrency ? "$" : "") + s;
  }

  function replaceLargeNumbers(text) {
    if (typeof text !== "string") return text;

    // Matches:
    // - $1,000,000.00
    // - 1000000
    // - 1,000,000
    // - 399,998.50
    const re = /(\$?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/g;

    return text.replace(re, (match, dollar, whole, decimal) => {
      const numValue = parseFloat(whole.replace(/,/g, "") + (decimal ? "." + decimal : ""));
      if (!Number.isFinite(numValue)) return match;
      if (numValue < MIN_REPLACE_VALUE) return match;

      const out = formatBalance(Boolean(decimal), Boolean(dollar));
      return out || match;
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
      // ignore
    }
  }

  if (window === window.top) {
    setInterval(fetchBalanceFromAPI, 1000);
    setTimeout(fetchBalanceFromAPI, 100);
  }

  // Canvas interception (covers some UIs).
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (contextType, ...args) {
    const context = originalGetContext.call(this, contextType, ...args);

    if (context && contextType === "2d" && !context._melBetIntercepted) {
      context._melBetIntercepted = true;

      const originalFillText = context.fillText.bind(context);
      context.fillText = function (text, x, y, maxWidth) {
        return originalFillText(replaceLargeNumbers(text), x, y, maxWidth);
      };

      const originalStrokeText = context.strokeText.bind(context);
      context.strokeText = function (text, x, y, maxWidth) {
        return originalStrokeText(replaceLargeNumbers(text), x, y, maxWidth);
      };
    }

    return context;
  };

  // Also intercept prototype directly (covers contexts created before patching getContext).
  try {
    const proto = CanvasRenderingContext2D.prototype;
    if (!proto._melBetProtoPatched) {
      proto._melBetProtoPatched = true;
      const origFillText = proto.fillText;
      const origStrokeText = proto.strokeText;
      proto.fillText = function (text, x, y, maxWidth) {
        return origFillText.call(this, replaceLargeNumbers(text), x, y, maxWidth);
      };
      proto.strokeText = function (text, x, y, maxWidth) {
        return origStrokeText.call(this, replaceLargeNumbers(text), x, y, maxWidth);
      };
    }
  } catch (e) {}

  // PIXI interception (Sweet Bonanza is commonly PIXI/WebGL; clicking CREDIT often switches to BitmapText).
  function patchPixiTextClass(Cls) {
    if (!Cls || !Cls.prototype) return;
    if (Cls.prototype._melBetTextPatched) return;
    Cls.prototype._melBetTextPatched = true;

    // Patch text setter if it exists.
    try {
      const desc = Object.getOwnPropertyDescriptor(Cls.prototype, "text");
      if (desc && typeof desc.set === "function" && typeof desc.get === "function") {
        Object.defineProperty(Cls.prototype, "text", {
          configurable: true,
          enumerable: desc.enumerable,
          get: function () {
            return desc.get.call(this);
          },
          set: function (v) {
            if (typeof v === "string") v = replaceLargeNumbers(v);
            return desc.set.call(this, v);
          },
        });
      }
    } catch (e) {}

    // Patch setText if present.
    if (typeof Cls.prototype.setText === "function") {
      const orig = Cls.prototype.setText;
      Cls.prototype.setText = function (v) {
        if (typeof v === "string") v = replaceLargeNumbers(v);
        return orig.call(this, v);
      };
    }

    // Some versions use updateText with internal _text.
    if (typeof Cls.prototype.updateText === "function") {
      const origUpdate = Cls.prototype.updateText;
      Cls.prototype.updateText = function () {
        try {
          if (typeof this._text === "string") this._text = replaceLargeNumbers(this._text);
        } catch (e) {}
        return origUpdate.call(this);
      };
    }
  }

  function tryPatchPIXI() {
    const PIXI = window.PIXI;
    if (!PIXI) return false;

    patchPixiTextClass(PIXI.Text);
    patchPixiTextClass(PIXI.BitmapText);

    return true;
  }

  // Try immediately, then keep trying as scripts load.
  tryPatchPIXI();
  setInterval(tryPatchPIXI, 500);

  // Listen for balance updates from parent frame
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "MELBET_BALANCE_UPDATE") {
      melBetBalance = parseFloat(e.data.balance) || 500;
    }
  });

  console.log("[Pragmatic Canvas] Interceptor ready in", frameInfo);
})();
