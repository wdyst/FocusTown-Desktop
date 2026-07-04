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
      theme: "none", theme_intensity: 100,
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
  function setLayer(el, show) {
    el.style.display = show ? "" : "none";
    if (typeof el.showPopover === "function" && el.isConnected) {
      try {
        var open = el.matches(":popover-open");
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
    setLayer(els.panel, panelOpen);
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
      empty.style.cssText = "color:#9ca3af;padding:2px 0";
      host.appendChild(empty);
      return;
    }
    state.web.friend_queue.forEach(function (name) {
      var row = document.createElement("div");
      row.className = "row";
      var label = document.createElement("span");
      label.textContent = "@" + name;
      label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis";
      var retry = document.createElement("button");
      retry.textContent = "Add";
      retry.addEventListener("click", function () { copyText("@" + name); attemptAutoAdd(name, false); });
      var copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.addEventListener("click", function () { copyText("@" + name); toast("Copied @" + name); });
      var del = document.createElement("button");
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
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:system-ui,sans-serif}' +
      // inset/margin/padding overrides neutralize the UA popover styles;
      // explicit left/top:auto keep right/bottom anchoring in control.
      '#gear{position:fixed;inset:auto;left:auto;top:auto;right:14px;bottom:190px;margin:0;padding:0;' +
      'z-index:2147483647;width:36px;height:36px;' +
      'border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(17,24,39,.55);' +
      'color:#e5e7eb;font-size:18px;line-height:1;cursor:grab;opacity:.35;transition:opacity .15s;touch-action:none}' +
      '#gear:hover{opacity:1}' +
      '#panel{position:fixed;inset:auto;left:auto;top:auto;right:14px;bottom:14px;margin:0;' +
      'z-index:2147483647;width:310px;max-height:calc(100vh - 28px);' +
      'overflow-y:auto;padding:14px 16px;border-radius:12px;border:1px solid rgba(255,255,255,.15);' +
      'background:rgba(17,24,39,.96);color:#e5e7eb;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.45)}' +
      '#panel h2{margin:0 0 6px;font-size:13px;font-weight:600;display:flex;justify-content:space-between;align-items:center}' +
      '#panel h2 small{font-weight:400;color:#9ca3af}' +
      '#panel h3{margin:10px 0 2px;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em}' +
      '#panel label{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer}' +
      '#panel .row{display:flex;align-items:center;gap:8px;padding:4px 0}' +
      '#panel button{border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e5e7eb;' +
      'border-radius:6px;padding:3px 9px;cursor:pointer;font-size:13px}' +
      '#panel button:hover{background:rgba(255,255,255,.16)}' +
      '#panel button.danger{border-color:rgba(248,113,113,.4);color:#fca5a5}' +
      '#panel select{background:rgba(255,255,255,.08);color:#e5e7eb;border:1px solid rgba(255,255,255,.2);' +
      'border-radius:6px;padding:3px 6px;font-size:13px}' +
      '#panel select option{background:#111827}' +
      '#panel input[type=range]{flex:1;accent-color:#93c5fd}' +
      '#zoomVal{min-width:44px;text-align:center;color:#d1d5db}' +
      '#intensityVal{min-width:40px;text-align:right;color:#d1d5db}' +
      'kbd{border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:0 4px;font-size:11px;color:#9ca3af;margin-left:auto}' +
      '.hint{margin:8px 0 0;color:#9ca3af;font-size:11px;line-height:1.55}' +
      '#close{margin-left:auto}' +
      '#hideAll{width:100%;margin-top:4px}' +
      '</style>' +
      '<button id="gear" title="Wrapper settings (Ctrl+,) — drag to move, double-click to reset">&#9881;</button>' +
      '<div id="panel" style="display:none">' +
      '<h2>Wrapper settings <small id="version"></small></h2>' +

      '<h3>Window</h3>' +
      '<label><input type="checkbox" id="fs">Fullscreen<kbd>F11</kbd></label>' +
      '<label><input type="checkbox" id="pin">Always on top</label>' +
      '<div class="row"><button id="mini">Mini mode</button><kbd>F9</kbd></div>' +
      '<div class="row">Zoom <button id="zoomOut">&minus;</button><span id="zoomVal">100%</span>' +
      '<button id="zoomIn">+</button><button id="zoomReset">Reset</button></div>' +

      '<h3>Appearance</h3>' +
      '<div class="row">Theme <select id="theme">' + themeOptions + '</select></div>' +
      '<div class="row">Strength <input type="range" id="intensity" min="25" max="100" step="25"><span id="intensityVal">100%</span></div>' +

      '<h3>Camera</h3>' +
      '<label><input type="checkbox" id="autoCam">Auto-rotate camera angle</label>' +
      '<div class="row">Every <select id="camSecs">' +
      '<option value="20">20 seconds</option><option value="45">45 seconds</option>' +
      '<option value="90">1.5 minutes</option><option value="180">3 minutes</option>' +
      '</select></div>' +

      '<h3>Game UI</h3>' +
      '<label><input type="checkbox" id="hideBug">Hide bug-report button</label>' +
      '<label><input type="checkbox" id="hideRadio">Hide radio (bottom-left)</label>' +
      '<label><input type="checkbox" id="hideChat">Hide chat tab (left)</label>' +
      '<label><input type="checkbox" id="hideSettings">Hide game settings (top-right)</label>' +
      '<label><input type="checkbox" id="hideFriends">Hide friends tab (right)</label>' +
      '<label><input type="checkbox" id="hidePopup">Hide bottom popup button</label>' +
      '<button id="hideAll">Hide ALL game UI (F10)</button>' +

      '<h3>Friend queue</h3>' +
      '<div id="friendQueue"></div>' +
      '<p class="hint" style="margin:2px 0 0">Open someone\'s player card and click the green + button to capture their @username. The wrapper tries to add them via the game\'s own friends UI; if it can\'t, the name stays here (and on your clipboard) to paste manually.</p>' +

      '<h3>Behavior</h3>' +
      '<label><input type="checkbox" id="closeTray">Close button hides to tray</label>' +
      '<label id="keepAwakeRow"><input type="checkbox" id="keepAwake">Keep screen awake</label>' +
      '<label><input type="checkbox" id="autostart">Start with computer (in tray)</label>' +
      '<label><input type="checkbox" id="globalShortcut">Global show/hide<kbd>Ctrl+Alt+F</kbd></label>' +

      '<h3>Experimental</h3>' +
      '<div class="row">Render scale <select id="renderScale">' +
      '<option value="1">100% (off)</option><option value="1.25">125%</option>' +
      '<option value="1.5">150%</option><option value="2">200%</option>' +
      '</select></div>' +
      '<p class="hint" style="margin:2px 0 0">Supersampling: renders the game larger and scales it down for a sharper image. Costs GPU. Reloads the page when changed.</p>' +

      '<h3>Maintenance</h3>' +
      '<div class="row"><button id="reload">Reload</button><button id="clearData" class="danger">Clear app data…</button></div>' +
      '<label><input type="checkbox" id="hideGear">Hide this button<kbd>Ctrl+,</kbd></label>' +
      '<div class="row"><button id="close">Close</button></div>' +

      '<p class="hint">Drag the &#9881; button anywhere (double-click it to reset). ' +
      'Game-UI hiding recognizes FocusTown\'s buttons by position, so a game update can shift them — ' +
      'if a toggle stops working, it fails safe (nothing breaks). The focus timer always stays visible.</p>' +
      '</div>';

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

    document.documentElement.appendChild(hostEl);
    applyWebPrefs();
    render();
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
