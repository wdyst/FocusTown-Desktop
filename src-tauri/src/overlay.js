// Injected into every page before its own scripts run (see lib.rs).
// Part 1 funnels popups through the Rust navigation policy (all origins).
// Part 2 renders the wrapper overlay — FocusTown origin only, backed by the
// window-control commands exposed in capabilities/remote.json. Degrades to
// a no-op if IPC is unavailable (e.g. in a plain browser).
//
// The game-UI hiding and auto-camera features work by *recognizing* the
// game's floating UI by screen position and text, since we ship no game
// code. If a FocusTown update moves things around, those toggles fail
// soft (nothing hidden, nothing clicked).
(function () {
  "use strict";

  var FOCUSTOWN = /(^|\.)focustown\.app$/;
  var OVERLAY_ID = "__focustown_wrapper_overlay";

  function isExternalHref(href) {
    try {
      var u = new URL(href, location.href);
      return (u.protocol === "http:" || u.protocol === "https:") &&
             !FOCUSTOWN.test(u.hostname);
    } catch (err) { return false; }
  }

  // ---------- Part 1: popup funnel ----------
  window.open = function (url) {
    if (url) { window.location.href = String(url); }
    return null;
  };
  document.addEventListener("click", function (e) {
    var el = e.target;
    if (!el || !el.closest) { return; }
    var a = el.closest("a[href]");
    if (!a) { return; }
    if (isExternalHref(a.href)) {
      toast("Opening in your browser…");
    }
    if (a.target === "_blank") {
      e.preventDefault();
      window.location.href = a.href;
    }
  }, true);

  // ---------- toasts ----------
  var toastHost = null;
  function toast(msg) {
    if (!document.documentElement) { return; }
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.id = OVERLAY_ID + "_toasts";
      toastHost.style.cssText = "position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;" +
        "overflow:visible;left:50%;bottom:24px;transform:translateX(-50%);" +
        "z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none";
      document.documentElement.appendChild(toastHost);
      // Top layer, so toasts render above the game's own top-layer UI.
      if (typeof toastHost.showPopover === "function") {
        toastHost.setAttribute("popover", "manual");
        try { toastHost.showPopover(); } catch (err) { toastHost.removeAttribute("popover"); }
      }
    }
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "background:rgba(17,24,39,.92);color:#e5e7eb;border:1px solid rgba(255,255,255,.15);" +
      "border-radius:999px;padding:7px 16px;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
      "opacity:0;transition:opacity .2s";
    toastHost.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = "1"; });
    setTimeout(function () {
      t.style.opacity = "0";
      setTimeout(function () { t.remove(); }, 250);
    }, 2600);
  }

  window.addEventListener("offline", function () { toast("Connection lost — waiting for network…"); });
  window.addEventListener("online", function () { toast("Back online"); });

  // ---------- Part 2: wrapper overlay ----------
  if (!FOCUSTOWN.test(location.hostname)) { return; }

  function invoke(cmd, args) {
    var t = window.__TAURI_INTERNALS__;
    if (t && typeof t.invoke === "function") { return t.invoke(cmd, args); }
    return Promise.reject(new Error("wrapper IPC unavailable"));
  }

  var state = {
    zoom: 1, fullscreen: false, mini: false, pin: false, hideGear: false,
    closeToTray: false, keepAwake: false, keepAwakeSupported: false,
    autostart: false, globalShortcut: false, version: "",
    web: {
      gear_x: null, gear_y: null,
      auto_camera: false, auto_camera_secs: 45,
      theme: "none", theme_intensity: 100, reskin: "none",
      hide_bug: true, hide_radio: false, hide_chat: false,
      hide_game_settings: false, hide_friends: false,
      hide_bottom_popup: false, hide_all_ui: false,
      render_scale: 1.0,
      friend_queue: []
    }
  };
  var els = null;
  var hostEl = null;
  var panelOpen = false;

  function clampZoom(z) { return Math.min(3, Math.max(0.5, Math.round(z * 10) / 10)); }
  function quiet() {}

  // Shows/hides an overlay element via the Popover API when available, so
  // it lives in the browser top layer — above the game's own top-layer UI
  // (e.g. the focus-session timer card), which plain z-index cannot beat.
  function setLayer(el, show, promote) {
    el.style.display = show ? "" : "none";
    if (typeof el.showPopover === "function" && el.isConnected) {
      try {
        var open = el.matches(":popover-open");
        // `promote` re-asserts top-layer membership by re-showing: the top
        // layer stacks by promotion order, so this lifts us above any game
        // UI (e.g. the timer) that promoted itself after us.
        if (show && open && promote) { el.hidePopover(); open = false; }
        if (show && !open) { el.showPopover(); }
        else if (!show && open) { el.hidePopover(); }
      } catch (err) { /* fall back to display toggling */ }
    }
  }

  // ---------- themes ----------
  // Each theme: filter(t) with t = intensity 0..1, plus an optional
  // full-screen tint [r,g,b,alpha] with a blend mode.
  var THEMES = {
    "none":          { label: "None", f: function () { return ""; }, tint: null },
    "dark-academia": { label: "Dark Academia", tint: [56, 40, 22, 0.25], blend: "multiply",
      f: function (t) { return "sepia(" + 0.35 * t + ") contrast(" + (1 + 0.08 * t) + ") brightness(" + (1 - 0.16 * t) + ") saturate(" + (1 - 0.15 * t) + ")"; } },
    "pastel":        { label: "Pastel", tint: [255, 214, 236, 0.14], blend: "soft-light",
      f: function (t) { return "saturate(" + (1 - 0.28 * t) + ") brightness(" + (1 + 0.1 * t) + ") contrast(" + (1 - 0.08 * t) + ")"; } },
    "midnight":      { label: "Midnight", tint: [24, 34, 80, 0.3], blend: "multiply",
      f: function (t) { return "brightness(" + (1 - 0.24 * t) + ") contrast(" + (1 + 0.1 * t) + ") saturate(" + (1 - 0.2 * t) + ")"; } },
    "cozy-ember":    { label: "Cozy Ember", tint: [255, 140, 60, 0.14], blend: "soft-light",
      f: function (t) { return "sepia(" + 0.25 * t + ") saturate(" + (1 + 0.08 * t) + ") brightness(" + (1 - 0.03 * t) + ")"; } },
    "noir":          { label: "Noir", tint: [0, 0, 0, 0.12], blend: "multiply",
      f: function (t) { return "grayscale(" + t + ") contrast(" + (1 + 0.15 * t) + ")"; } },
    "sunset":        { label: "Sunset", tint: [255, 94, 58, 0.16], blend: "soft-light",
      f: function (t) { return "hue-rotate(" + -12 * t + "deg) saturate(" + (1 + 0.2 * t) + ") brightness(" + (1 - 0.04 * t) + ")"; } },
    "forest":        { label: "Forest", tint: [40, 90, 55, 0.2], blend: "multiply",
      f: function (t) { return "hue-rotate(" + 18 * t + "deg) saturate(" + (1 - 0.08 * t) + ") brightness(" + (1 - 0.07 * t) + ")"; } },
    "ocean":         { label: "Ocean", tint: [40, 90, 160, 0.2], blend: "multiply",
      f: function (t) { return "hue-rotate(" + -16 * t + "deg) saturate(" + (1 - 0.05 * t) + ") brightness(" + (1 - 0.05 * t) + ")"; } },
    "vaporwave":     { label: "Vaporwave", tint: [255, 71, 207, 0.12], blend: "screen",
      f: function (t) { return "hue-rotate(" + 28 * t + "deg) saturate(" + (1 + 0.35 * t) + ") contrast(" + (1 + 0.04 * t) + ")"; } },
    "mono-cream":    { label: "Mono Cream", tint: null,
      f: function (t) { return "grayscale(" + 0.65 * t + ") sepia(" + 0.3 * t + ") brightness(" + (1 + 0.05 * t) + ")"; } },
    "dreamy":        { label: "Dreamy Haze", tint: [255, 255, 255, 0.09], blend: "soft-light",
      f: function (t) { return "saturate(" + (1 + 0.08 * t) + ") brightness(" + (1 + 0.07 * t) + ") contrast(" + (1 - 0.1 * t) + ")"; } },
    "high-contrast": { label: "Punchy", tint: null,
      f: function (t) { return "contrast(" + (1 + 0.22 * t) + ") saturate(" + (1 + 0.15 * t) + ")"; } },
    "sakura":        { label: "Sakura", tint: [255, 183, 213, 0.18], blend: "soft-light",
      f: function (t) { return "hue-rotate(" + -6 * t + "deg) saturate(" + (1 + 0.05 * t) + ") brightness(" + (1 + 0.05 * t) + ") contrast(" + (1 - 0.05 * t) + ")"; } },
    "coffee":        { label: "Coffee House", tint: [64, 41, 27, 0.28], blend: "multiply",
      f: function (t) { return "sepia(" + 0.45 * t + ") saturate(" + (1 + 0.05 * t) + ") brightness(" + (1 - 0.1 * t) + ") contrast(" + (1 + 0.06 * t) + ")"; } },
    "arctic":        { label: "Arctic", tint: [190, 225, 255, 0.14], blend: "soft-light",
      f: function (t) { return "hue-rotate(" + -14 * t + "deg) saturate(" + (1 - 0.18 * t) + ") brightness(" + (1 + 0.08 * t) + ")"; } },
    "golden-hour":   { label: "Golden Hour", tint: [255, 190, 92, 0.2], blend: "soft-light",
      f: function (t) { return "sepia(" + 0.18 * t + ") hue-rotate(" + -8 * t + "deg) saturate(" + (1 + 0.18 * t) + ") brightness(" + (1 + 0.02 * t) + ")"; } },
    "lavender":      { label: "Lavender Dusk", tint: [150, 120, 220, 0.18], blend: "soft-light",
      f: function (t) { return "hue-rotate(" + 12 * t + "deg) saturate(" + (1 - 0.1 * t) + ") brightness(" + (1 - 0.06 * t) + ") contrast(" + (1 + 0.04 * t) + ")"; } },
    "terminal":      { label: "Terminal Green", tint: [26, 84, 38, 0.32], blend: "multiply",
      f: function (t) { return "grayscale(" + 0.85 * t + ") sepia(" + 0.35 * t + ") hue-rotate(" + 55 * t + "deg) saturate(" + (1 + 0.9 * t) + ") contrast(" + (1 + 0.1 * t) + ")"; } },
    "old-film":      { label: "Old Film", tint: [30, 24, 18, 0.22], blend: "multiply",
      f: function (t) { return "grayscale(" + 0.9 * t + ") sepia(" + 0.5 * t + ") contrast(" + (1 + 0.12 * t) + ") brightness(" + (1 - 0.05 * t) + ")"; } },
    "candy":         { label: "Candy Pop", tint: [255, 120, 190, 0.1], blend: "screen",
      f: function (t) { return "saturate(" + (1 + 0.5 * t) + ") brightness(" + (1 + 0.06 * t) + ") contrast(" + (1 + 0.08 * t) + ")"; } },
    "deep-space":    { label: "Deep Space", tint: [12, 14, 40, 0.4], blend: "multiply",
      f: function (t) { return "brightness(" + (1 - 0.32 * t) + ") contrast(" + (1 + 0.14 * t) + ") saturate(" + (1 - 0.28 * t) + ") hue-rotate(" + -10 * t + "deg)"; } }
  };

  var tintEl = null;
  function applyTheme() {
    var theme = THEMES[state.web.theme] || THEMES.none;
    var t = Math.min(100, Math.max(0, state.web.theme_intensity)) / 100;
    document.documentElement.style.filter = theme.f(t);
    if (!tintEl) {
      tintEl = document.createElement("div");
      tintEl.id = OVERLAY_ID + "_tint";
      tintEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483600";
      document.documentElement.appendChild(tintEl);
    }
    if (theme.tint) {
      tintEl.style.background = "rgba(" + theme.tint[0] + "," + theme.tint[1] + "," + theme.tint[2] + "," + (theme.tint[3] * t) + ")";
      tintEl.style.mixBlendMode = theme.blend || "multiply";
      tintEl.style.display = "";
    } else {
      tintEl.style.display = "none";
    }
  }

  // ---------- UI reskin (dark mode) ----------
  // FocusTown exposes its whole palette as inline --ft-* CSS variables on
  // <main>. We recolor the HTML chrome (cards, menus, timer, buttons) by
  // reading those variables and re-declaring them, transformed, in a
  // stylesheet with !important — which beats the inline values and, because
  // it targets by selector, keeps applying across SPA re-renders. The 3D
  // town is a <canvas> and is unaffected, so only the UI is reskinned.
  var RESKINS = { "none": "None", "dark": "Dark", "midnight": "Midnight Blue", "warm": "Warm Dark" };

  function parseColor(str) {
    str = str.trim();
    if (str.charAt(0) === "#") {
      var hex = str.slice(1);
      if (hex.length === 3) { hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]; }
      if (hex.length !== 6 || /[^0-9a-f]/i.test(hex)) { return null; }
      var n = parseInt(hex, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    var m = str.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      var p = m[1].split(",");
      if (p.length < 3) { return null; }
      var r = parseFloat(p[0]), g = parseFloat(p[1]), b = parseFloat(p[2]);
      var a = p.length > 3 ? parseFloat(p[3]) : 1;
      if (isNaN(r) || isNaN(g) || isNaN(b)) { return null; }
      return { r: r, g: g, b: b, a: isNaN(a) ? 1 : a };
    }
    return null;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0, s = 0, l = (max + min) / 2;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) { h = (g - b) / d + (g < b ? 6 : 0); }
      else if (max === g) { h = (b - r) / d + 2; }
      else { h = (r - g) / d + 4; }
      h *= 60;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    function hue(p, q, t) {
      if (t < 0) { t += 1; } if (t > 1) { t -= 1; }
      if (t < 1 / 6) { return p + (q - p) * 6 * t; }
      if (t < 1 / 2) { return q; }
      if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
      return p;
    }
    var r, g, b;
    if (!s) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  function reskinColor(c, mode) {
    var hsl = rgbToHsl(c.r, c.g, c.b), h = hsl[0], s = hsl[1], l = hsl[2];
    // Leave near-pure white/black untouched: these are semantic "text on a
    // colored button is white" / "pure black" tokens. Inverting them would
    // put dark text on now-dark buttons.
    if (s < 0.15 && (l > 0.9 || l < 0.1)) { return null; }
    // Chroma (not HSL saturation, which spikes near white) separates neutral
    // chrome surfaces from vivid accent colors. Only neutral surfaces get
    // tinted toward the theme hue; accents (blue buttons, green success…)
    // keep their real hue so the dark UI stays coherent.
    var chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    var neutralish = chroma < 40;
    var nl, ns = s, nh = h;
    if (mode === "dark") { nl = 1 - 0.90 * l; ns = s * 0.85; }
    else if (mode === "midnight") {
      nl = 1 - 0.92 * l; ns = s * 0.85;
      if (neutralish) { nh = 222; ns = Math.max(ns * 0.6 + 0.12, 0.14); }
    } else if (mode === "warm") {
      nl = 1 - 0.88 * l; ns = s * 0.9;
      if (neutralish) { nh = 30; ns = Math.max(ns * 0.6 + 0.10, 0.12); }
    } else { return null; }
    nl = Math.max(0, Math.min(1, nl));
    var o = hslToRgb(nh, ns, nl);
    return c.a < 1 ? "rgba(" + o[0] + "," + o[1] + "," + o[2] + "," + c.a + ")"
                   : "rgb(" + o[0] + "," + o[1] + "," + o[2] + ")";
  }

  var reskinStyleEl = null, reskinBuiltMode = null;
  function applyReskin() {
    var mode = state.web.reskin || "none";
    if (mode === "none") {
      if (reskinStyleEl) { reskinStyleEl.textContent = ""; }
      reskinBuiltMode = "none";
      return;
    }
    if (reskinBuiltMode === mode && reskinStyleEl && reskinStyleEl.textContent) { return; }
    var main = document.querySelector('main[class*="ft-webapp"]') || document.querySelector("main");
    if (!main) { return; }
    var decls = [];
    for (var i = 0; i < main.style.length; i++) {
      var n = main.style[i];
      if (n.indexOf("--ft-") !== 0) { continue; }
      var c = parseColor(main.style.getPropertyValue(n));
      if (!c) { continue; }
      var rc = reskinColor(c, mode);
      if (rc) { decls.push(n + ":" + rc + " !important"); }
    }
    if (!decls.length) { return; } // palette not present yet — retry next tick
    if (!reskinStyleEl) {
      reskinStyleEl = document.createElement("style");
      reskinStyleEl.id = OVERLAY_ID + "_reskin";
      document.documentElement.appendChild(reskinStyleEl);
    }
    reskinStyleEl.textContent = 'main[class*="ft-webapp"]{' + decls.join(";") + "}";
    reskinBuiltMode = mode;
  }

  // ---------- game-UI recognition + hiding ----------
  // Classifies the game's floating UI by viewport position (see screenshots
  // in the repo history): radio bottom-left, chat left-middle, settings
  // gear top-right, friends panel right-middle, popup pill bottom-center,
  // bug-report button right side above the timer.
  var hiddenEls = [];

  function isOurs(el) {
    return el.id && el.id.indexOf(OVERLAY_ID) === 0;
  }

  function bucketFor(el, r, vw, vh) {
    if (r.width < 8 || r.height < 8) { return null; }
    if (r.width > vw * 0.45 || r.height > vh * 0.45) { return null; } // canvas/panels
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    // aria-labels are the most stable signal (confirmed against the live
    // DOM): "Open room chat panel", "Back", "Close room card".
    var aria = "";
    if (el.getAttribute) {
      aria = (el.getAttribute("aria-label") || "").toLowerCase();
      if (!aria && el.querySelector) {
        var labelled = el.querySelector("[aria-label]");
        if (labelled && el.children.length === 1) {
          aria = (labelled.getAttribute("aria-label") || "").toLowerCase();
        }
      }
    }
    // Exact match from the live page source: the bug-report widget ships
    // with its own class and aria-label, wherever it's positioned.
    if (/report bug/.test(aria) ||
        (el.querySelector && el.querySelector(".ft-web-bug-report-shell"))) {
      return "bug";
    }
    if (/chat panel/.test(aria)) { return "chat"; }
    if (/^back$/.test(aria) || /close room card/.test(aria)) { return "protected"; }
    var text = (el.textContent || "").toLowerCase();
    if (text.length < 60 && /camera\s*angle/.test(text)) { return "camera_bar"; }
    if (cy < vh * 0.15 && cx > vw * 0.80) {
      return r.width < 110 ? "game_settings" : "top_right_bar";
    }
    if (cx < vw * 0.12 && cy > vh * 0.72) { return "radio"; }
    if (cx < vw * 0.06 && cy > vh * 0.30 && cy <= vh * 0.72) { return "chat"; }
    if (cx > vw * 0.94 && cy > vh * 0.30 && cy < vh * 0.75) { return "friends"; }
    if (cy > vh * 0.90 && cx > vw * 0.40 && cx < vw * 0.60) { return "bottom_popup"; }
    return null;
  }

  function shouldHide(bucket) {
    var w = state.web;
    if (bucket === "protected") { return false; } // Back / Close buttons
    if (w.hide_all_ui) { return true; }
    switch (bucket) {
      case "bug": return w.hide_bug;
      case "radio": return w.hide_radio;
      case "chat": return w.hide_chat;
      case "game_settings": return w.hide_game_settings;
      case "friends": return w.hide_friends;
      case "bottom_popup": return w.hide_bottom_popup;
      // camera bar and the top-right currency bar only hide with "all".
      default: return false;
    }
  }

  function applyUiHiding() {
    // Unhide everything from the previous pass, then re-classify. This
    // self-heals across SPA re-renders and toggle changes.
    for (var i = 0; i < hiddenEls.length; i++) {
      hiddenEls[i].style.removeProperty("visibility");
    }
    hiddenEls = [];
    if (!document.body) { return; }

    var vw = window.innerWidth, vh = window.innerHeight;
    var work = [{ el: document.body, depth: 0 }];
    while (work.length) {
      var item = work.pop();
      var children = item.el.children;
      for (var j = 0; j < children.length; j++) {
        var c = children[j];
        if (isOurs(c) || c.tagName === "CANVAS" || c.tagName === "SCRIPT" || c.tagName === "STYLE") { continue; }
        var cs;
        try { cs = getComputedStyle(c); } catch (err) { continue; }
        if (cs.display === "none") { continue; }
        var bucket = null;
        if (cs.position === "fixed" || cs.position === "absolute") {
          bucket = bucketFor(c, c.getBoundingClientRect(), vw, vh);
        }
        if (bucket) {
          if (shouldHide(bucket)) {
            // visibility (not display) so the layout survives and
            // programmatic clicks (auto camera) keep working.
            c.style.setProperty("visibility", "hidden", "important");
            hiddenEls.push(c);
          }
          // classified: don't descend into it
        } else if (item.depth < 6) {
          work.push({ el: c, depth: item.depth + 1 });
        }
      }
    }
  }
  setInterval(function () {
    applyUiHiding();
    applyReskin();
    scanOccupantCard();
    checkRoomExit();
  }, 2500);

  // ---------- add friend from player cards ----------
  // When a player card (article with an "occupant-card" class, confirmed
  // against the live DOM) is open, inject an avatar+plus button that
  // captures the @username. Clicking it: queues the name, copies it to the
  // clipboard, and best-effort automates the game's own add-friend UI —
  // in-session, no navigation, so the room connection is never touched.
  var autoAddAttempted = {};

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(quiet);
        return;
      }
    } catch (err) { /* fall through */ }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.documentElement.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch (err2) { quiet(); }
  }

  function setNativeValue(input, value) {
    var proto = Object.getPrototypeOf(input);
    var desc = Object.getOwnPropertyDescriptor(proto, "value") ||
               Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) { desc.set.call(input, value); } else { input.value = value; }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findFriendInput() {
    var inputs = document.querySelectorAll("input[type='text'], input[type='search'], input:not([type])");
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (!visible(inp)) { continue; }
      var hint = ((inp.getAttribute("placeholder") || "") + " " +
                  (inp.getAttribute("aria-label") || "") + " " +
                  (inp.getAttribute("name") || "") + " " +
                  (inp.className || "")).toLowerCase();
      if (/friend|username|search|invite|add/.test(hint)) { return inp; }
    }
    return null;
  }

  function findNear(root, re) {
    var scope = root;
    for (var up = 0; up < 6 && scope; up++) {
      var btns = scope.querySelectorAll("button, [role='button']");
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (!visible(b)) { continue; }
        var label = ((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
        if (re.test(label) && label.length < 60) { return b; }
      }
      scope = scope.parentElement;
    }
    return null;
  }

  function attemptAutoAdd(username, silent) {
    var input = findFriendInput();
    if (!input) {
      // Try opening a friends/people panel first, then re-look.
      var opener = findNear(document.body, /friend|people|member|social/);
      if (opener) {
        opener.click();
        setTimeout(function () { attemptAutoAddStage2(username, silent); }, 1200);
        return;
      }
      if (!silent) { toast("Saved @" + username + " — copied to clipboard, paste it in the friends panel"); }
      return;
    }
    attemptAutoAddFill(input, username, silent);
  }
  function attemptAutoAddStage2(username, silent) {
    var input = findFriendInput();
    if (!input) {
      if (!silent) { toast("Saved @" + username + " — copied to clipboard, paste it in the friends panel"); }
      return;
    }
    attemptAutoAddFill(input, username, silent);
  }
  function attemptAutoAddFill(input, username, silent) {
    setNativeValue(input, username);
    setTimeout(function () {
      var addBtn = findNear(input, /\badd\b|invite|send/);
      if (addBtn) {
        addBtn.click();
        toast("Tried to add @" + username + " — check your friends list");
        state.web.friend_queue = state.web.friend_queue.filter(function (u) { return u !== username; });
        saveWebPrefs();
      } else if (!silent) {
        toast("Typed @" + username + " into the friends search — finish it there");
      }
    }, 900);
  }

  function addFriend(username) {
    copyText("@" + username);
    if (state.web.friend_queue.indexOf(username) === -1) {
      state.web.friend_queue.push(username);
      saveWebPrefs();
    }
    toast("Captured @" + username + " (copied)");
    attemptAutoAdd(username, false);
  }

  function scanOccupantCard() {
    var cards = document.querySelectorAll("article[class*='occupant-card']");
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.getAttribute("data-ftw-friend")) { continue; }
      var m = (card.textContent || "").match(/@([A-Za-z0-9_.-]{2,32})/);
      if (!m) { continue; }
      var username = m[1];
      card.setAttribute("data-ftw-friend", username);

      var btn = document.createElement("button");
      btn.setAttribute("data-ftw", "1");
      btn.title = "Add @" + username + " (wrapper)";
      btn.style.cssText = "position:absolute;left:12px;bottom:12px;z-index:99999;width:40px;height:40px;" +
        "border-radius:50%;border:2px solid rgba(255,255,255,.9);background:#10b981;color:#fff;" +
        "cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3);padding:0;overflow:visible";
      // Use the card's avatar image as the icon when one exists.
      var imgs = card.querySelectorAll("img");
      var face = null;
      for (var j = 0; j < imgs.length; j++) {
        var r = imgs[j].getBoundingClientRect();
        if (r.width >= 24 && Math.abs(r.width - r.height) < r.width * 0.4 &&
            !/flag|icon|item/.test(imgs[j].src || "")) { face = imgs[j]; break; }
      }
      if (face) {
        var clone = face.cloneNode(false);
        clone.removeAttribute("class");
        clone.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;display:block";
        btn.appendChild(clone);
        var plus = document.createElement("span");
        plus.textContent = "+";
        plus.style.cssText = "position:absolute;right:-4px;bottom:-4px;width:18px;height:18px;border-radius:50%;" +
          "background:#10b981;color:#fff;font:bold 14px/17px system-ui;text-align:center;border:1.5px solid #fff";
        btn.appendChild(plus);
      } else {
        btn.textContent = "＋";
        btn.style.font = "bold 20px system-ui";
      }
      (function (name) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          addFriend(name);
        });
      })(username);

      var cs = getComputedStyle(card);
      if (cs.position === "static") { card.style.position = "relative"; }
      card.appendChild(btn);
    }
  }

  // Retry queued names when leaving a room (the friends UI is usually
  // reachable from the main app pages).
  var lastPath = location.pathname;
  function checkRoomExit() {
    var path = location.pathname;
    if (path !== lastPath) {
      var wasInRoom = /\/room\//.test(lastPath);
      lastPath = path;
      if (wasInRoom && !/\/room\//.test(path) && state.web.friend_queue.length) {
        var name = state.web.friend_queue[0];
        if (!autoAddAttempted[name]) {
          autoAddAttempted[name] = true;
          setTimeout(function () { attemptAutoAdd(name, true); }, 3000);
        }
      }
    }
  }

  // ---------- auto camera rotation ----------
  var cameraTimer = null;
  function findCameraButton() {
    var candidates = document.querySelectorAll("button, [role='button']");
    for (var i = 0; i < candidates.length; i++) {
      var text = (candidates[i].textContent || "").trim();
      if (text.length < 60 && /camera\s*angle/i.test(text)) { return candidates[i]; }
    }
    return null;
  }
  function applyAutoCamera() {
    if (cameraTimer) { clearInterval(cameraTimer); cameraTimer = null; }
    if (!state.web.auto_camera) { return; }
    var secs = Math.min(600, Math.max(10, state.web.auto_camera_secs || 45));
    cameraTimer = setInterval(function () {
      if (document.hidden) { return; }
      var btn = findCameraButton();
      if (btn) { btn.click(); }
    }, secs * 1000);
  }

  function applyWebPrefs() {
    applyTheme();
    applyReskin();
    applyAutoCamera();
    applyUiHiding();
    applyGearPosition();
  }

  function saveWebPrefs() {
    invoke("set_web_prefs", { prefs: state.web }).then(function (applied) {
      state.web = applied;
      applyWebPrefs();
      render();
    }).catch(quiet);
  }

  // ---------- wrapper commands ----------
  function applyUiState(s) {
    state.zoom = s.settings.zoom;
    state.pin = s.settings.always_on_top;
    state.hideGear = s.settings.hide_gear;
    state.closeToTray = s.settings.close_to_tray;
    state.keepAwake = s.settings.keep_awake;
    state.globalShortcut = s.settings.global_shortcut;
    state.web = s.settings.web;
    state.fullscreen = s.fullscreen;
    state.mini = s.mini;
    state.autostart = s.autostart;
    state.keepAwakeSupported = s.keep_awake_supported;
    state.version = s.version;
  }

  function toggleFullscreen() {
    invoke("toggle_fullscreen").then(function (fs) { state.fullscreen = fs; render(); }).catch(quiet);
  }
  function toggleMini() {
    invoke("toggle_mini_mode").then(function (mini) {
      state.mini = mini;
      if (mini) { state.fullscreen = false; togglePanel(false); }
      render();
    }).catch(quiet);
  }
  function setZoom(z) {
    invoke("set_zoom", { zoom: clampZoom(z) }).then(function (applied) { state.zoom = applied; render(); }).catch(quiet);
  }
  function setPin(on) {
    invoke("set_always_on_top", { on: on }).then(function () { state.pin = on; render(); }).catch(quiet);
  }
  function setHideGear(hide) {
    invoke("set_hide_gear", { hide: hide }).then(function () { state.hideGear = hide; render(); }).catch(quiet);
  }
  function setCloseToTray(on) {
    invoke("set_close_to_tray", { on: on }).then(function () {
      state.closeToTray = on;
      render();
      if (on) { toast("Closing the window now hides to the tray"); }
    }).catch(quiet);
  }
  function setKeepAwake(on) {
    invoke("set_keep_awake", { on: on }).then(function () {
      state.keepAwake = on;
      render();
      toast(on ? "Screen will stay awake" : "Screen may sleep normally");
    }).catch(quiet);
  }
  function setAutostart(on) {
    invoke("set_autostart", { on: on }).then(function (enabled) { state.autostart = enabled; render(); }).catch(quiet);
  }
  function setGlobalShortcut(on) {
    invoke("set_global_shortcut", { on: on }).then(function (enabled) {
      state.globalShortcut = enabled;
      render();
      if (on && !enabled) { toast("Couldn't register Ctrl+Alt+F (in use by another app)"); }
    }).catch(quiet);
  }
  function clearData() {
    if (window.confirm("Clear all app data? This signs you out and reloads FocusTown.")) {
      invoke("clear_browsing_data").catch(quiet);
    }
  }
  function toggleHideAll() {
    state.web.hide_all_ui = !state.web.hide_all_ui;
    saveWebPrefs();
    toast(state.web.hide_all_ui ? "Game UI hidden — F10 to restore" : "Game UI restored");
  }
  function togglePanel(open) {
    panelOpen = (typeof open === "boolean") ? open : !panelOpen;
    if (panelOpen) {
      syncPanelTheme();
      invoke("get_ui_state").then(function (s) { applyUiState(s); render(); }).catch(quiet);
    }
    render();
  }

  // Window-level capture: our init script runs before the game's, so this
  // listener fires ahead of any game handler that might swallow the key.
  window.addEventListener("keydown", function (e) {
    if (e.key === "F11") { e.preventDefault(); e.stopPropagation(); toggleFullscreen(); return; }
    if (e.key === "F9") { e.preventDefault(); e.stopPropagation(); toggleMini(); return; }
    if (e.key === "F10") { e.preventDefault(); e.stopPropagation(); toggleHideAll(); return; }
    if (e.key === "Escape" && panelOpen) { e.preventDefault(); e.stopPropagation(); togglePanel(false); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === ",") { e.preventDefault(); e.stopPropagation(); togglePanel(); }
      else if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(state.zoom + 0.1); }
      else if (e.key === "-") { e.preventDefault(); setZoom(state.zoom - 0.1); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); }
    }
  }, true);

  // Clicking anywhere outside the overlay closes the panel. (Shadow DOM
  // retargets events from inside the overlay to the host element.)
  document.addEventListener("pointerdown", function (e) {
    if (panelOpen && hostEl && e.target !== hostEl) { togglePanel(false); }
  }, true);

  // ---------- gear position / dragging ----------
  function applyGearPosition() {
    if (!els) { return; }
    var g = els.gear;
    if (state.web.gear_x == null || state.web.gear_y == null) {
      // Default sits above the game's focus-session timer card, which
      // occupies the bottom-right corner.
      g.style.left = ""; g.style.top = "";
      g.style.right = "14px"; g.style.bottom = "190px";
    } else {
      g.style.right = ""; g.style.bottom = "";
      g.style.left = "calc(" + state.web.gear_x + "vw - 18px)";
      g.style.top = "calc(" + state.web.gear_y + "vh - 18px)";
    }
  }

  function makeGearDraggable(gear) {
    var dragging = false, moved = false, startX = 0, startY = 0;
    gear.addEventListener("pointerdown", function (e) {
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      gear.setPointerCapture(e.pointerId);
    });
    gear.addEventListener("pointermove", function (e) {
      if (!dragging) { return; }
      if (!moved && Math.abs(e.clientX - startX) < 5 && Math.abs(e.clientY - startY) < 5) { return; }
      moved = true;
      var x = Math.min(98, Math.max(2, (e.clientX / window.innerWidth) * 100));
      var y = Math.min(98, Math.max(2, (e.clientY / window.innerHeight) * 100));
      state.web.gear_x = x; state.web.gear_y = y;
      applyGearPosition();
    });
    gear.addEventListener("pointerup", function (e) {
      if (!dragging) { return; }
      dragging = false;
      if (moved) { saveWebPrefs(); }
      else { togglePanel(true); }
    });
    gear.addEventListener("dblclick", function () {
      // double-click resets to the default corner
      state.web.gear_x = null; state.web.gear_y = null;
      applyGearPosition();
      saveWebPrefs();
    });
  }

  // ---------- panel ----------
  function render() {
    if (!els) { return; }
    setLayer(els.gear, !(state.hideGear || panelOpen));
    // Re-promote the panel to the top layer each time it's shown.
    setLayer(els.panel, panelOpen, panelOpen);
    els.fs.checked = state.fullscreen;
    els.pin.checked = state.pin;
    els.hideGear.checked = state.hideGear;
    els.closeTray.checked = state.closeToTray;
    els.keepAwake.checked = state.keepAwake;
    els.keepAwakeRow.style.display = state.keepAwakeSupported ? "" : "none";
    els.autostart.checked = state.autostart;
    els.globalShortcut.checked = state.globalShortcut;
    els.mini.textContent = state.mini ? "Exit mini mode" : "Mini mode";
    els.zoomVal.textContent = Math.round(state.zoom * 100) + "%";
    els.version.textContent = state.version ? "v" + state.version : "";
    els.theme.value = state.web.theme;
    els.reskin.value = state.web.reskin || "none";
    els.intensity.value = String(state.web.theme_intensity);
    els.intensityVal.textContent = state.web.theme_intensity + "%";
    els.autoCam.checked = state.web.auto_camera;
    els.camSecs.value = String(state.web.auto_camera_secs);
    els.camSecs.disabled = !state.web.auto_camera;
    els.hideBug.checked = state.web.hide_bug;
    els.hideRadio.checked = state.web.hide_radio;
    els.hideChat.checked = state.web.hide_chat;
    els.hideSettings.checked = state.web.hide_game_settings;
    els.hideFriends.checked = state.web.hide_friends;
    els.hidePopup.checked = state.web.hide_bottom_popup;
    els.hideAll.textContent = state.web.hide_all_ui ? "Show game UI (F10)" : "Hide ALL game UI (F10)";
    els.renderScale.value = String(state.web.render_scale);
    renderFriendQueue();
  }

  function renderFriendQueue() {
    var host = els.friendQueue;
    host.textContent = "";
    if (!state.web.friend_queue.length) {
      var empty = document.createElement("div");
      empty.textContent = "No captured usernames yet.";
      empty.style.cssText = "color:var(--wp-muted);padding:4px 0";
      host.appendChild(empty);
      return;
    }
    state.web.friend_queue.forEach(function (name) {
      var row = document.createElement("div");
      row.className = "row";
      var label = document.createElement("span");
      label.className = "lbl";
      label.textContent = "@" + name;
      label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis";
      var retry = document.createElement("button");
      retry.className = "btn";
      retry.textContent = "Add";
      retry.addEventListener("click", function () { copyText("@" + name); attemptAutoAdd(name, false); });
      var copy = document.createElement("button");
      copy.className = "btn";
      copy.textContent = "Copy";
      copy.addEventListener("click", function () { copyText("@" + name); toast("Copied @" + name); });
      var del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "✕";
      del.addEventListener("click", function () {
        state.web.friend_queue = state.web.friend_queue.filter(function (u) { return u !== name; });
        saveWebPrefs();
      });
      row.appendChild(label); row.appendChild(retry); row.appendChild(copy); row.appendChild(del);
      host.appendChild(row);
    });
  }

  function mount() {
    if (els || !document.documentElement) { return; }
    hostEl = document.createElement("div");
    hostEl.id = OVERLAY_ID;
    var root = hostEl.attachShadow({ mode: "closed" });
    var themeOptions = "";
    for (var key in THEMES) {
      themeOptions += '<option value="' + key + '">' + THEMES[key].label + "</option>";
    }
    var reskinOptions = "";
    for (var rk in RESKINS) {
      reskinOptions += '<option value="' + rk + '">' + RESKINS[rk] + "</option>";
    }
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      // --wp-* are synced from the game's own palette in syncPanelTheme()
      // (so the panel matches FocusTown and follows dark mode); the values
      // here are cream-theme fallbacks used before the page palette loads.
      ':host{--wp-surface:#FFF8E7;--wp-frame:#C4B5A0;--wp-border:#83715B;' +
      '--wp-soft:#DDD5C7;--wp-text:#5D4037;--wp-muted:#8B7355;--wp-accent:#78ADFD;' +
      '--wp-accent-dark:#6B8FC9;--wp-tabbar:#FFF1D8;--wp-pill:#FFDAA1;' +
      '--wp-danger:#C6410D;--wp-success:#90BE6D;--wp-font:system-ui,sans-serif}' +
      '*{box-sizing:border-box;font-family:var(--wp-font)}' +
      '#gear{position:fixed;inset:auto;left:auto;top:auto;right:14px;bottom:190px;margin:0;padding:0;' +
      'z-index:2147483647;width:40px;height:40px;border-radius:50%;' +
      'border:2px solid var(--wp-border);border-bottom-width:4px;background:var(--wp-surface);' +
      'color:var(--wp-text);font-size:19px;line-height:1;cursor:grab;opacity:.55;' +
      'box-shadow:0 4px 10px rgba(54,43,34,.25);transition:opacity .15s;touch-action:none}' +
      '#gear:hover{opacity:1}' +
      // Top-right, away from the bottom-right game timer.
      '#panel{position:fixed;inset:auto;left:auto;bottom:auto;top:14px;right:14px;margin:0;' +
      'z-index:2147483647;width:320px;max-height:calc(100vh - 28px);display:flex;flex-direction:column;' +
      'padding:0;border:3px solid var(--wp-border);border-bottom-width:8px;border-radius:22px;' +
      'background:var(--wp-frame);color:var(--wp-text);font-size:13px;box-shadow:0 14px 36px rgba(54,43,34,.32)}' +
      '.inner{background:var(--wp-surface);border-radius:18px;margin:4px;padding:12px 14px 14px;' +
      'overflow-y:auto;display:flex;flex-direction:column;gap:2px}' +
      '.hdr{display:flex;align-items:center;gap:8px;margin-bottom:8px}' +
      '.hdr .ttl{font-size:15px;font-weight:700;color:var(--wp-text)}' +
      '.hdr .ver{font-size:11px;color:var(--wp-muted);font-weight:600}' +
      '#headerClose{margin-left:auto;width:28px;height:28px;padding:0;font-size:16px;border-radius:10px}' +
      '.tabs{display:flex;gap:3px;padding:3px;background:var(--wp-tabbar);border-radius:12px;margin-bottom:10px}' +
      '.tab{flex:1;border:none;background:transparent;color:var(--wp-muted);font-weight:700;font-size:12px;' +
      'padding:6px 4px;border-radius:9px;cursor:pointer}' +
      '.tab.on{background:var(--wp-pill);color:var(--wp-text);box-shadow:0 2px 4px rgba(92,69,46,.18)}' +
      '.pane{display:none;flex-direction:column;gap:2px}' +
      '.pane.on{display:flex}' +
      '.opt{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;cursor:pointer;' +
      'border-bottom:1px solid var(--wp-soft)}' +
      '.opt:last-child{border-bottom:none}' +
      '.opt>.lbl{flex:1;color:var(--wp-text);font-weight:600}' +
      '.opt .sub{display:block;font-weight:500;font-size:11px;color:var(--wp-muted)}' +
      'input[type=checkbox]{appearance:none;-webkit-appearance:none;width:40px;height:23px;border-radius:999px;' +
      'background:var(--wp-soft);border:none;position:relative;cursor:pointer;transition:background .15s;flex:0 0 auto;margin:0}' +
      'input[type=checkbox]::before{content:"";position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;' +
      'background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}' +
      'input[type=checkbox]:checked{background:var(--wp-accent)}' +
      'input[type=checkbox]:checked::before{transform:translateX(17px)}' +
      'select{background:var(--wp-surface);color:var(--wp-text);border:2px solid var(--wp-soft);' +
      'border-radius:10px;padding:5px 8px;font-size:12px;font-weight:600;cursor:pointer}' +
      'input[type=range]{flex:1;accent-color:var(--wp-accent)}' +
      '.btn{border:2px solid var(--wp-border);border-bottom-width:4px;background:var(--wp-surface);' +
      'color:var(--wp-text);border-radius:12px;padding:5px 11px;cursor:pointer;font-size:12px;font-weight:700}' +
      '.btn:active{transform:translateY(2px);border-bottom-width:2px}' +
      '.btn.primary{background:var(--wp-accent);border-color:var(--wp-accent-dark);color:#fff}' +
      '.btn.danger{border-color:var(--wp-danger);color:var(--wp-danger)}' +
      '.btn.wide{width:100%;margin-top:6px}' +
      '.row{display:flex;align-items:center;gap:8px;padding:6px 0}' +
      '.row .lbl{flex:1;font-weight:600}' +
      'kbd{border:1.5px solid var(--wp-soft);border-radius:5px;padding:0 5px;font-size:11px;color:var(--wp-muted);font-weight:700}' +
      '.val{min-width:44px;text-align:center;color:var(--wp-text);font-weight:700}' +
      '.hint{margin:8px 0 0;color:var(--wp-muted);font-size:11px;line-height:1.5}' +
      '.fq .row{border-bottom:1px solid var(--wp-soft)}' +
      '.fq .btn{padding:3px 8px}' +
      '</style>' +
      '<button id="gear" title="FocusTown settings (Ctrl+,) — drag to move, double-click to reset">&#9881;</button>' +
      '<div id="panel" style="display:none"><div class="inner">' +
      '<div class="hdr"><span class="ttl">FocusTown</span><span class="ver" id="version"></span>' +
      '<button class="btn" id="headerClose" title="Close (Esc)">&times;</button></div>' +
      '<div class="tabs">' +
      '<button class="tab on" data-pane="Look">Look</button>' +
      '<button class="tab" data-pane="Window">Window</button>' +
      '<button class="tab" data-pane="Game">Game</button>' +
      '<button class="tab" data-pane="More">More</button></div>' +

      '<div class="pane on" data-pane="Look">' +
      '<div class="row"><span class="lbl">Filter</span><select id="theme">' + themeOptions + '</select></div>' +
      '<div class="row"><span class="lbl">Strength</span><input type="range" id="intensity" min="25" max="100" step="25"><span class="val" id="intensityVal">100%</span></div>' +
      '<div class="row"><span class="lbl">UI skin</span><select id="reskin">' + reskinOptions + '</select></div>' +
      '<p class="hint">UI skin recolors the menus, cards and timer (dark mode) — the town stays full-colour. Filters tint the whole view.</p>' +
      '</div>' +

      '<div class="pane" data-pane="Window">' +
      '<label class="opt"><span class="lbl">Fullscreen <kbd>F11</kbd></span><input type="checkbox" id="fs"></label>' +
      '<label class="opt"><span class="lbl">Always on top</span><input type="checkbox" id="pin"></label>' +
      '<div class="row"><span class="lbl">Mini mode <kbd>F9</kbd></span><button class="btn" id="mini">Mini mode</button></div>' +
      '<div class="row"><span class="lbl">Zoom</span><button class="btn" id="zoomOut">&minus;</button>' +
      '<span class="val" id="zoomVal">100%</span><button class="btn" id="zoomIn">+</button><button class="btn" id="zoomReset">Reset</button></div>' +
      '<label class="opt"><span class="lbl">Close button hides to tray</span><input type="checkbox" id="closeTray"></label>' +
      '<label class="opt" id="keepAwakeRow"><span class="lbl">Keep screen awake</span><input type="checkbox" id="keepAwake"></label>' +
      '<label class="opt"><span class="lbl">Start with computer<span class="sub">launches hidden in the tray</span></span><input type="checkbox" id="autostart"></label>' +
      '<label class="opt"><span class="lbl">Global show / hide <kbd>Ctrl+Alt+F</kbd></span><input type="checkbox" id="globalShortcut"></label>' +
      '</div>' +

      '<div class="pane" data-pane="Game">' +
      '<label class="opt"><span class="lbl">Hide bug-report button</span><input type="checkbox" id="hideBug"></label>' +
      '<label class="opt"><span class="lbl">Hide radio<span class="sub">bottom-left</span></span><input type="checkbox" id="hideRadio"></label>' +
      '<label class="opt"><span class="lbl">Hide chat tab<span class="sub">left</span></span><input type="checkbox" id="hideChat"></label>' +
      '<label class="opt"><span class="lbl">Hide game settings<span class="sub">top-right</span></span><input type="checkbox" id="hideSettings"></label>' +
      '<label class="opt"><span class="lbl">Hide friends tab<span class="sub">right</span></span><input type="checkbox" id="hideFriends"></label>' +
      '<label class="opt"><span class="lbl">Hide bottom popup</span><input type="checkbox" id="hidePopup"></label>' +
      '<button class="btn wide" id="hideAll">Hide ALL game UI (F10)</button>' +
      '<label class="opt" style="margin-top:6px"><span class="lbl">Auto-rotate camera</span><input type="checkbox" id="autoCam"></label>' +
      '<div class="row"><span class="lbl">Rotate every</span><select id="camSecs">' +
      '<option value="20">20 seconds</option><option value="45">45 seconds</option>' +
      '<option value="90">1.5 minutes</option><option value="180">3 minutes</option></select></div>' +
      '<p class="hint">Friends: open a player card in a room and tap the green + to capture them.</p>' +
      '<div class="fq" id="friendQueue"></div>' +
      '</div>' +

      '<div class="pane" data-pane="More">' +
      '<div class="row"><button class="btn" id="reload">Reload page</button>' +
      '<button class="btn danger" id="clearData">Clear app data…</button></div>' +
      '<label class="opt"><span class="lbl">Hide the &#9881; button <kbd>Ctrl+,</kbd></span><input type="checkbox" id="hideGear"></label>' +
      '<div class="row"><span class="lbl">Render scale<span class="sub">experimental · sharper, uses GPU</span></span><select id="renderScale">' +
      '<option value="1">100%</option><option value="1.25">125%</option>' +
      '<option value="1.5">150%</option><option value="2">200%</option></select></div>' +
      '<p class="hint"><b>Shortcuts:</b> F11 fullscreen · F9 mini · F10 hide UI · Ctrl+, settings · Ctrl +/&minus;/0 zoom.<br>' +
      'Drag the &#9881; anywhere; double-click it to reset. Game-UI hiding matches FocusTown\'s buttons and fails safe if the game changes.</p>' +
      '<p class="hint">Unofficial community app — not affiliated with FocusTown.</p>' +
      '<div class="row"><button class="btn primary wide" id="close">Close</button></div>' +
      '</div>' +
      '</div></div>';

    els = {
      gear: root.getElementById("gear"),
      panel: root.getElementById("panel"),
      fs: root.getElementById("fs"),
      pin: root.getElementById("pin"),
      mini: root.getElementById("mini"),
      hideGear: root.getElementById("hideGear"),
      closeTray: root.getElementById("closeTray"),
      keepAwake: root.getElementById("keepAwake"),
      keepAwakeRow: root.getElementById("keepAwakeRow"),
      autostart: root.getElementById("autostart"),
      globalShortcut: root.getElementById("globalShortcut"),
      zoomVal: root.getElementById("zoomVal"),
      version: root.getElementById("version"),
      theme: root.getElementById("theme"),
      reskin: root.getElementById("reskin"),
      intensity: root.getElementById("intensity"),
      intensityVal: root.getElementById("intensityVal"),
      autoCam: root.getElementById("autoCam"),
      camSecs: root.getElementById("camSecs"),
      hideBug: root.getElementById("hideBug"),
      hideRadio: root.getElementById("hideRadio"),
      hideChat: root.getElementById("hideChat"),
      hideSettings: root.getElementById("hideSettings"),
      hideFriends: root.getElementById("hideFriends"),
      hidePopup: root.getElementById("hidePopup"),
      hideAll: root.getElementById("hideAll"),
      renderScale: root.getElementById("renderScale"),
      friendQueue: root.getElementById("friendQueue")
    };

    // Top-layer membership (see setLayer). "manual" popovers don't
    // light-dismiss or trap focus; we manage visibility ourselves.
    els.gear.setAttribute("popover", "manual");
    els.panel.setAttribute("popover", "manual");

    makeGearDraggable(els.gear);
    root.getElementById("close").addEventListener("click", function () { togglePanel(false); });
    root.getElementById("headerClose").addEventListener("click", function () { togglePanel(false); });
    els.fs.addEventListener("change", toggleFullscreen);
    els.pin.addEventListener("change", function () { setPin(els.pin.checked); });
    els.mini.addEventListener("click", toggleMini);
    els.hideGear.addEventListener("change", function () { setHideGear(els.hideGear.checked); });
    els.closeTray.addEventListener("change", function () { setCloseToTray(els.closeTray.checked); });
    els.keepAwake.addEventListener("change", function () { setKeepAwake(els.keepAwake.checked); });
    els.autostart.addEventListener("change", function () { setAutostart(els.autostart.checked); });
    els.globalShortcut.addEventListener("change", function () { setGlobalShortcut(els.globalShortcut.checked); });
    root.getElementById("zoomIn").addEventListener("click", function () { setZoom(state.zoom + 0.1); });
    root.getElementById("zoomOut").addEventListener("click", function () { setZoom(state.zoom - 0.1); });
    root.getElementById("zoomReset").addEventListener("click", function () { setZoom(1); });
    root.getElementById("reload").addEventListener("click", function () { location.reload(); });
    root.getElementById("clearData").addEventListener("click", clearData);

    els.theme.addEventListener("change", function () { state.web.theme = els.theme.value; saveWebPrefs(); });
    els.reskin.addEventListener("change", function () { state.web.reskin = els.reskin.value; saveWebPrefs(); });
    els.intensity.addEventListener("input", function () {
      state.web.theme_intensity = parseInt(els.intensity.value, 10) || 100;
      els.intensityVal.textContent = state.web.theme_intensity + "%";
      applyTheme();
    });
    els.intensity.addEventListener("change", saveWebPrefs);
    els.autoCam.addEventListener("change", function () { state.web.auto_camera = els.autoCam.checked; saveWebPrefs(); });
    els.camSecs.addEventListener("change", function () { state.web.auto_camera_secs = parseInt(els.camSecs.value, 10) || 45; saveWebPrefs(); });
    function bindHide(el, key) {
      el.addEventListener("change", function () { state.web[key] = el.checked; saveWebPrefs(); });
    }
    bindHide(els.hideBug, "hide_bug");
    bindHide(els.hideRadio, "hide_radio");
    bindHide(els.hideChat, "hide_chat");
    bindHide(els.hideSettings, "hide_game_settings");
    bindHide(els.hideFriends, "hide_friends");
    bindHide(els.hidePopup, "hide_bottom_popup");
    els.hideAll.addEventListener("click", toggleHideAll);
    els.renderScale.addEventListener("change", function () {
      state.web.render_scale = parseFloat(els.renderScale.value) || 1;
      invoke("set_web_prefs", { prefs: state.web }).then(function (applied) {
        state.web = applied;
        toast("Render scale saved — reloading…");
        setTimeout(function () { location.reload(); }, 900);
      }).catch(quiet);
    });

    // Tabs
    var tabs = root.querySelectorAll(".tab");
    var panes = root.querySelectorAll(".pane");
    for (var ti = 0; ti < tabs.length; ti++) {
      tabs[ti].addEventListener("click", function (e) {
        var want = e.currentTarget.getAttribute("data-pane");
        for (var a = 0; a < tabs.length; a++) {
          tabs[a].classList.toggle("on", tabs[a].getAttribute("data-pane") === want);
        }
        for (var b = 0; b < panes.length; b++) {
          panes[b].classList.toggle("on", panes[b].getAttribute("data-pane") === want);
        }
      });
    }

    document.documentElement.appendChild(hostEl);
    syncPanelTheme();
    applyWebPrefs();
    render();

    // First-run tip (per browser profile).
    try {
      if (!localStorage.getItem("ftw_onboarded")) {
        localStorage.setItem("ftw_onboarded", "1");
        setTimeout(function () { toast("Tip: press Ctrl+, for FocusTown wrapper settings"); }, 4500);
      }
    } catch (err) { /* storage blocked — skip */ }
  }

  // Copies FocusTown's live palette onto the panel (via --wp-* custom
  // properties on the shadow host) so it matches the game and follows the
  // dark-mode reskin. Falls back to the cream defaults baked into the CSS.
  function syncPanelTheme() {
    if (!hostEl) { return; }
    var main = document.querySelector('main[class*="ft-webapp"]') || document.querySelector("main");
    if (!main) { return; }
    var cs;
    try { cs = getComputedStyle(main); } catch (err) { return; }
    var map = {
      "--wp-surface": "--ft-chrome-webapp-raised-card-inner-alt-bg",
      "--wp-frame": "--ft-chrome-webapp-raised-card-outer-bg",
      "--wp-border": "--ft-colors-borders-brown",
      "--wp-soft": "--ft-colors-borders-soft-taupe",
      "--wp-text": "--ft-colors-text-primary",
      "--wp-muted": "--ft-colors-text-secondary",
      "--wp-accent": "--ft-colors-semantic-primary",
      "--wp-accent-dark": "--ft-colors-semantic-primary-dark",
      "--wp-tabbar": "--ft-chrome-webapp-tab-bar-segment-bg",
      "--wp-pill": "--ft-chrome-webapp-tab-pill-bg",
      "--wp-danger": "--ft-colors-semantic-danger",
      "--wp-success": "--ft-colors-semantic-success"
    };
    for (var k in map) {
      var v = cs.getPropertyValue(map[k]).trim();
      if (v) { hostEl.style.setProperty(k, v); }
    }
    var font = cs.fontFamily;
    if (font) { hostEl.style.setProperty("--wp-font", font); }
  }

  invoke("get_ui_state").then(function (s) {
    applyUiState(s);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount);
    } else {
      mount();
    }
  }).catch(quiet);
})();
