// Pragmatic Play Specific Interceptor - display override
// Must run before game loads. Works in iframes.

(function () {
  "use strict";

  let melBetBalance = 500.0; // Updated from /api/wallet/balance or postMessage

  // Avoid touching buy/bet/win UI numbers like 2,000 / 10,000.
  // Pragmatic demo credits are typically 100,000+ (often 1,000,000).
  const MIN_REPLACE_VALUE = 30000;

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

    // In no-currency mode Pragmatic shows values in credits (x10 of dollar amount).
    const credits = v * 10;
    const s = Math.round(credits).toLocaleString("en-US", {
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
      const numValue = parseFloat(
        whole.replace(/,/g, "") + (decimal ? "." + decimal : ""),
      );
      if (!Number.isFinite(numValue)) return match;
      if (numValue < MIN_REPLACE_VALUE) return match;

      const out = formatBalance(Boolean(decimal), Boolean(dollar));
      return out || match;
    });
  }

  function remapLargeNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    if (value < MIN_REPLACE_VALUE) return value;

    // Large integer credit displays (e.g. 1,000,000) are in credits (x10).
    if (value >= 300000) return Number(melBetBalance) * 10;

    // Currency-like large numbers (e.g. 100,000.00 pipeline) map directly.
    return Number(melBetBalance);
  }

  function mapLargeValueForDisplay(value, options) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    if (value < MIN_REPLACE_VALUE) return value;

    const minFd =
      options && typeof options.minimumFractionDigits === "number"
        ? options.minimumFractionDigits
        : undefined;
    const maxFd =
      options && typeof options.maximumFractionDigits === "number"
        ? options.maximumFractionDigits
        : undefined;
    const hasDecimals =
      (minFd !== undefined && minFd > 0) || (maxFd !== undefined && maxFd > 0);

    if (hasDecimals) return Number(melBetBalance);
    return Number(melBetBalance) * 10;
  }

  // Catch formatting paths that bypass text setters (e.g. CREDIT toggle mode).
  try {
    if (!Number.prototype._melBetToLocalePatched) {
      Number.prototype._melBetToLocalePatched = true;
      const originalToLocaleString = Number.prototype.toLocaleString;
      Number.prototype.toLocaleString = function (locales, options) {
        const mapped = mapLargeValueForDisplay(Number(this.valueOf()), options);
        return originalToLocaleString.call(mapped, locales, options);
      };
    }
  } catch (e) {}

  try {
    if (!Intl.NumberFormat.prototype._melBetFormatPatched) {
      Intl.NumberFormat.prototype._melBetFormatPatched = true;
      const originalFormatGetter = Object.getOwnPropertyDescriptor(
        Intl.NumberFormat.prototype,
        "format",
      ).get;
      Object.defineProperty(Intl.NumberFormat.prototype, "format", {
        configurable: true,
        get: function () {
          const formatter = originalFormatGetter.call(this);
          const resolved = this.resolvedOptions ? this.resolvedOptions() : {};
          return function (value) {
            const mapped = mapLargeValueForDisplay(Number(value), resolved);
            return formatter(mapped);
          };
        },
      });
    }
  } catch (e) {}

  // Patch Number.prototype.toString to catch String(value), `${value}`, value+""
  // which the game uses for the non-currency credits display.
  try {
    if (!Number.prototype._melBetToStringPatched) {
      Number.prototype._melBetToStringPatched = true;
      const originalToString = Number.prototype.toString;
      Number.prototype.toString = function (radix) {
        // Only intercept base-10 (default) conversions
        if (radix === undefined || radix === 10) {
          const val = Number(this.valueOf());
          if (Number.isFinite(val) && val >= MIN_REPLACE_VALUE) {
            const mapped = remapLargeNumber(val);
            return originalToString.call(mapped, radix);
          }
        }
        return originalToString.call(this, radix);
      };
    }
  } catch (e) {}

  // Patch Number.prototype.toFixed to catch (balance).toFixed(2) etc.
  try {
    if (!Number.prototype._melBetToFixedPatched) {
      Number.prototype._melBetToFixedPatched = true;
      const originalToFixed = Number.prototype.toFixed;
      Number.prototype.toFixed = function (digits) {
        const val = Number(this.valueOf());
        if (Number.isFinite(val) && val >= MIN_REPLACE_VALUE) {
          // toFixed implies decimal display → map to dollar amount
          const mapped = Number(melBetBalance);
          return originalToFixed.call(mapped, digits);
        }
        return originalToFixed.call(this, digits);
      };
    }
  } catch (e) {}

  // Wrap global String() constructor to catch explicit String(largeNumber) calls.
  try {
    if (!window._melBetStringPatched) {
      window._melBetStringPatched = true;
      const OriginalString = window.String;
      window.String = function (...args) {
        if (args.length === 1 && typeof args[0] === "number") {
          const val = args[0];
          if (Number.isFinite(val) && val >= MIN_REPLACE_VALUE) {
            args[0] = remapLargeNumber(val);
          }
        }
        return OriginalString.apply(this, args);
      };
      // Preserve String static methods and prototype
      Object.setPrototypeOf(window.String, OriginalString);
      window.String.prototype = OriginalString.prototype;
      window.String.prototype.constructor = window.String;
      // Copy static methods
      for (const key of Object.getOwnPropertyNames(OriginalString)) {
        if (key !== "prototype" && key !== "length" && key !== "name") {
          try {
            const desc = Object.getOwnPropertyDescriptor(OriginalString, key);
            if (desc) Object.defineProperty(window.String, key, desc);
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  const frameInfo =
    window === window.top
      ? "TOP FRAME"
      : "IFRAME: " + window.location.href.substring(0, 50);
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
              "*",
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
        return origFillText.call(
          this,
          replaceLargeNumbers(text),
          x,
          y,
          maxWidth,
        );
      };
      proto.strokeText = function (text, x, y, maxWidth) {
        return origStrokeText.call(
          this,
          replaceLargeNumbers(text),
          x,
          y,
          maxWidth,
        );
      };
    }
  } catch (e) {}

  // 2) PIXI Text / BitmapText interception
  function patchPixiTextClass(Cls) {
    if (!Cls || !Cls.prototype) return;
    if (Cls.prototype._melBetTextPatched) return;
    Cls.prototype._melBetTextPatched = true;

    try {
      const desc = Object.getOwnPropertyDescriptor(Cls.prototype, "text");
      if (
        desc &&
        typeof desc.set === "function" &&
        typeof desc.get === "function"
      ) {
        Object.defineProperty(Cls.prototype, "text", {
          configurable: true,
          enumerable: desc.enumerable,
          get: function () {
            return desc.get.call(this);
          },
          set: function (v) {
            if (typeof v === "string") v = replaceLargeNumbers(v);
            else v = remapLargeNumber(v);
            return desc.set.call(this, v);
          },
        });
      }
    } catch (e) {}

    if (typeof Cls.prototype.setText === "function") {
      const orig = Cls.prototype.setText;
      Cls.prototype.setText = function (v) {
        if (typeof v === "string") v = replaceLargeNumbers(v);
        else v = remapLargeNumber(v);
        return orig.call(this, v);
      };
    }

    if (typeof Cls.prototype.updateText === "function") {
      const origUpdate = Cls.prototype.updateText;
      Cls.prototype.updateText = function () {
        try {
          if (typeof this._text === "string")
            this._text = replaceLargeNumbers(this._text);
        } catch (e) {}
        return origUpdate.call(this);
      };
    }
  }

  function rewriteKnownStringProps(obj) {
    if (!obj || typeof obj !== "object") return;

    const textKeys = [
      "text",
      "_text",
      "label",
      "value",
      "displayText",
      "content",
    ];
    for (const key of textKeys) {
      try {
        if (typeof obj[key] === "string") {
          const nv = replaceLargeNumbers(obj[key]);
          if (nv !== obj[key]) obj[key] = nv;
        }
      } catch (e) {}
    }

    // Some wrappers keep numeric balances in plain fields and format later.
    const numericKeys = [
      "balance",
      "credit",
      "currentBalance",
      "displayBalance",
      "walletBalance",
    ];
    for (const key of numericKeys) {
      try {
        if (
          typeof obj[key] === "number" &&
          Number.isFinite(obj[key]) &&
          obj[key] >= MIN_REPLACE_VALUE
        ) {
          obj[key] = Number(melBetBalance);
        }
      } catch (e) {}
    }

    try {
      if (obj.pixiText && typeof obj.pixiText.text === "string") {
        const nv = replaceLargeNumbers(obj.pixiText.text);
        if (nv !== obj.pixiText.text) obj.pixiText.text = nv;
      }
    } catch (e) {}
  }

  let UILabelPatchedLogged = false;

  function wrapProcessPixiText(holder) {
    if (!holder) return;
    try {
      const orig = holder.processPixiText;
      if (typeof orig !== "function" || orig._melBetWrapped) return;

      const wrapped = function (...args) {
        const patchedArgs = args.map((arg) => {
          if (typeof arg === "string") return replaceLargeNumbers(arg);
          return remapLargeNumber(arg);
        });
        const out = orig.apply(this, patchedArgs);
        rewriteKnownStringProps(this);
        if (typeof out === "string") return replaceLargeNumbers(out);
        if (typeof out === "number") return remapLargeNumber(out);
        return out;
      };
      wrapped._melBetWrapped = true;
      holder.processPixiText = wrapped;

      if (!UILabelPatchedLogged) {
        UILabelPatchedLogged = true;
        console.log(
          "[Pragmatic Display] processPixiText patched on runtime object/prototype",
        );
      }
    } catch (e) {}
  }

  function patchUILabel() {
    const UILabel = window.UILabel;
    if (!UILabel || !UILabel.prototype) return;
    wrapProcessPixiText(UILabel.prototype);
  }

  function tryPatchPIXI() {
    const PIXI = window.PIXI;
    if (!PIXI) return;

    patchPixiTextClass(PIXI.Text);
    patchPixiTextClass(PIXI.BitmapText);
    if (PIXI.extras && PIXI.extras.BitmapText)
      patchPixiTextClass(PIXI.extras.BitmapText);
    patchUILabel();
  }

  // 3) Live sweep of scene objects to catch custom wrappers that bypass setters.
  function sweepPIXIObjects() {
    const visited = new Set();
    const buyFeatureTextRe = /BUY\s*(SUPER\s*)?FREE\s*SPINS/i;

    function hidePixiBuyFeaturePanel(node) {
      if (!node || typeof node !== "object") return;
      let matched = false;
      const textKeys = [
        "text",
        "_text",
        "label",
        "value",
        "displayText",
        "content",
      ];
      for (const key of textKeys) {
        try {
          const v = node[key];
          if (typeof v === "string" && buyFeatureTextRe.test(v)) {
            matched = true;
            break;
          }
        } catch (e) {}
      }
      if (!matched) return;

      // Hide ancestor panel so the buy feature card is fully removed.
      let panel = node;
      for (let i = 0; i < 5; i++) {
        try {
          if (!panel.parent) break;
          panel = panel.parent;
        } catch (e) {
          break;
        }
      }
      try {
        panel.visible = false;
        panel.renderable = false;
        panel.alpha = 0;
      } catch (e) {}
    }

    function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 9 || visited.has(node))
        return;
      visited.add(node);

      rewriteKnownStringProps(node);

      // Patch runtime instance methods/prototypes even when class is not global.
      wrapProcessPixiText(node);
      hidePixiBuyFeaturePanel(node);
      try {
        const proto = Object.getPrototypeOf(node);
        if (proto) wrapProcessPixiText(proto);
      } catch (e) {}

      try {
        const children = node.children;
        if (children && children.length) {
          for (const child of children) walk(child, depth + 1);
        }
      } catch (e) {}
    }

    const roots = [
      window,
      window.Game,
      window.game,
      window.Runtime,
      window.runtime,
      window.PIXI,
    ];
    for (const root of roots) walk(root, 0);
  }

  tryPatchPIXI();
  setInterval(tryPatchPIXI, 300);
  setInterval(sweepPIXIObjects, 120);

  // 4) Block user interaction on Buy Feature button area (left panel top section).
  function blockBuyFeatureClicks() {
    if (window._melBetBuyFeatureBlockersMounted) return;
    const host = document.body || document.documentElement;
    if (!host) {
      setTimeout(blockBuyFeatureClicks, 50);
      return;
    }

    function findMainSurface() {
      const surfaces = [
        ...Array.from(document.querySelectorAll("canvas")),
        ...Array.from(document.querySelectorAll("iframe")),
      ];
      let best = null;
      let bestArea = 0;
      for (const el of surfaces) {
        const r = el.getBoundingClientRect();
        if (!r || r.width < 10 || r.height < 10) continue;
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      return best;
    }

    function makeBlocker() {
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.left = "-10000px";
      el.style.top = "-10000px";
      el.style.width = "1px";
      el.style.height = "1px";
      el.style.pointerEvents = "auto";
      el.style.background = "transparent";
      el.style.zIndex = "2147483647";

      const swallow = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function")
          e.stopImmediatePropagation();
      };
      el.addEventListener("pointerdown", swallow, true);
      el.addEventListener("pointerup", swallow, true);
      el.addEventListener("mousedown", swallow, true);
      el.addEventListener("mouseup", swallow, true);
      el.addEventListener("touchstart", swallow, {
        capture: true,
        passive: false,
      });
      el.addEventListener("touchend", swallow, {
        capture: true,
        passive: false,
      });
      el.addEventListener("click", swallow, true);
      host.appendChild(el);
      return el;
    }

    const blockerA = makeBlocker();
    const blockerB = makeBlocker();
    const blockerC = makeBlocker();
    const blockerD = makeBlocker();
    window._melBetBuyFeatureBlockersMounted = true;

    // Normalized zones inside main game surface (with generous overlap/margins).
    const zones = [
      { x1: 0.0, x2: 0.34, y1: 0.0, y2: 0.34 }, // BUY FREE SPINS (oversized)
      { x1: 0.0, x2: 0.34, y1: 0.16, y2: 0.54 }, // BUY SUPER FREE SPINS (oversized)
      { x1: 0.0, x2: 0.34, y1: 0.36, y2: 0.8 }, // DOUBLE CHANCE panel/toggle (oversized)
      { x1: 0.0, x2: 0.36, y1: 0.0, y2: 0.82 }, // full left control-column kill zone
    ];

    function placeBlocker(el, rect, z) {
      const x = rect.left + rect.width * z.x1;
      const y = rect.top + rect.height * z.y1;
      const w = rect.width * (z.x2 - z.x1);
      const h = rect.height * (z.y2 - z.y1);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }

    function tick() {
      const surface = findMainSurface();
      if (!surface) {
        requestAnimationFrame(tick);
        return;
      }
      const rect = surface.getBoundingClientRect();
      placeBlocker(blockerA, rect, zones[0]);
      placeBlocker(blockerB, rect, zones[1]);
      placeBlocker(blockerC, rect, zones[2]);
      placeBlocker(blockerD, rect, zones[3]);
      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);

    // Fallback: frame-viewport guard for left buy panel area.
    // This catches cases where game input is handled in nested surfaces/iframes.
    const frameZones = [{ x1: 0.0, x2: 0.42, y1: 0.0, y2: 0.9 }];

    function inFrameZone(clientX, clientY) {
      const w = Math.max(1, window.innerWidth || 1);
      const h = Math.max(1, window.innerHeight || 1);
      const nx = clientX / w;
      const ny = clientY / h;
      return frameZones.some(
        (z) => nx >= z.x1 && nx <= z.x2 && ny >= z.y1 && ny <= z.y2,
      );
    }

    function stopLeftPanelInput(e) {
      const p = e.touches && e.touches[0] ? e.touches[0] : e;
      if (!p || typeof p.clientX !== "number" || typeof p.clientY !== "number")
        return;
      if (!inFrameZone(p.clientX, p.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function")
        e.stopImmediatePropagation();
    }

    window.addEventListener("pointerdown", stopLeftPanelInput, true);
    window.addEventListener("mousedown", stopLeftPanelInput, true);
    window.addEventListener("touchstart", stopLeftPanelInput, {
      capture: true,
      passive: false,
    });
    window.addEventListener("click", stopLeftPanelInput, true);
  }

  setTimeout(blockBuyFeatureClicks, 50);

  // 5) DOM text interception (for any HTML overlays)
  const buyFeatureTextRe = /BUY\s*(SUPER\s*)?FREE\s*SPINS/i;

  function hideDomBuyFeaturePanels(root) {
    const scope = root && root.nodeType === Node.ELEMENT_NODE ? root : document;
    const all = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
    for (const el of all) {
      try {
        const txt = el.textContent;
        if (!txt || !buyFeatureTextRe.test(txt)) continue;

        // Hide nearest wrapper so button/card/background all disappear.
        let wrapper = el;
        for (let i = 0; i < 4; i++) {
          if (!wrapper.parentElement) break;
          wrapper = wrapper.parentElement;
        }
        wrapper.style.setProperty("display", "none", "important");
      } catch (e) {}
    }
  }

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
    hideDomBuyFeaturePanels(document.body);

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (
          m.type === "characterData" &&
          m.target &&
          m.target.nodeType === Node.TEXT_NODE
        ) {
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
            hideDomBuyFeaturePanels(node);
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
