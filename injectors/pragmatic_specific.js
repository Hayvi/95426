// Pragmatic Play Specific Interceptor - display override
// Must run before game loads. Works in iframes.

(function () {
  "use strict";

  let melBetBalance = 500.0; // Updated from /api/wallet/balance or postMessage

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

  const frameInfo =
    window === window.top ? "TOP FRAME" : "IFRAME: " + window.location.href.substring(0, 50);
  console.log("[Pragmatic Display] init in", frameInfo);

  // Balance source
  async function fetchBalanceFromAPI() {
    try {
      const res = await fetch("/api/wallet/balance");
      const data = await res.json();
      if (data && data.balance !== undefined) {
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
    } catch (e) {}
  }

  if (window === window.top) {
    setInterval(fetchBalanceFromAPI, 1000);
    setTimeout(fetchBalanceFromAPI, 100);
  }

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "MELBET_BALANCE_UPDATE") {
      const v = parseFloat(e.data.balance);
      if (Number.isFinite(v)) melBetBalance = v;
    }
  });

  // 1) Canvas 2D text interception
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

  // 2) PIXI Text / BitmapText interception (commonly used for CREDIT toggle)
  function patchPixiTextClass(Cls) {
    if (!Cls || !Cls.prototype) return;
    if (Cls.prototype._melBetTextPatched) return;
    Cls.prototype._melBetTextPatched = true;

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

    if (typeof Cls.prototype.setText === "function") {
      const orig = Cls.prototype.setText;
      Cls.prototype.setText = function (v) {
        if (typeof v === "string") v = replaceLargeNumbers(v);
        return orig.call(this, v);
      };
    }

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
    if (!PIXI) return;

    patchPixiTextClass(PIXI.Text);
    patchPixiTextClass(PIXI.BitmapText);
    if (PIXI.extras && PIXI.extras.BitmapText) patchPixiTextClass(PIXI.extras.BitmapText);
  }

  tryPatchPIXI();
  setInterval(tryPatchPIXI, 500);

  // 3) DOM text interception (for any HTML overlays)
  function walkAndReplaceText(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue;
      if (typeof v === "string") {
        const nv = replaceLargeNumbers(v);
        if (nv !== v) n.nodeValue = nv;
      }
    }
  }

  function startDomObserver() {
    if (!document.body) {
      setTimeout(startDomObserver, 50);
      return;
    }

    walkAndReplaceText(document.body);

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "characterData" && m.target && m.target.nodeType === Node.TEXT_NODE) {
          const v = m.target.nodeValue;
          const nv = replaceLargeNumbers(v);
          if (nv !== v) m.target.nodeValue = nv;
          continue;
        }

        for (const node of m.addedNodes || []) {
          if (node.nodeType === Node.TEXT_NODE) {
            const v = node.nodeValue;
            const nv = replaceLargeNumbers(v);
            if (nv !== v) node.nodeValue = nv;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            walkAndReplaceText(node);
          }
        }
      }
    });

    obs.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  startDomObserver();

  console.log("[Pragmatic Display] ready in", frameInfo);
})();
