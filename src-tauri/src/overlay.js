// Injected into every page before its own scripts run (see lib.rs).
// Part 1 funnels popups through the Rust navigation policy (all origins).
// Part 2 renders the wrapper settings overlay — FocusTown origin only,
// backed by the window-control commands exposed in capabilities/remote.json.
// It degrades to a no-op if IPC is unavailable (e.g. in a plain browser).
(function () {
  "use strict";

  var FOCUSTOWN = /(^|\.)focustown\.app$/;

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
      // Rust blocks this navigation and opens the default browser; the
      // toast just makes that visible so the click doesn't feel dead.
      toast("Opening in your browser…");
    }
    if (a.target === "_blank") {
      e.preventDefault();
      window.location.href = a.href;
    }
  }, true);

  // ---------- toasts (used by part 1 and 2) ----------
  var toastHost = null;
  function toast(msg) {
    if (!document.documentElement) { return; }
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
        "z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none";
      document.documentElement.appendChild(toastHost);
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

  // ---------- Part 2: settings overlay ----------
  if (!FOCUSTOWN.test(location.hostname)) { return; }

  function invoke(cmd, args) {
    var t = window.__TAURI_INTERNALS__;
    if (t && typeof t.invoke === "function") { return t.invoke(cmd, args); }
    return Promise.reject(new Error("wrapper IPC unavailable"));
  }

  var state = {
    zoom: 1, fullscreen: false, mini: false, pin: false, hideGear: false,
    closeToTray: false, keepAwake: false, keepAwakeSupported: false,
    autostart: false, globalShortcut: false, version: ""
  };
  var els = null;
  var panelOpen = false;

  function clampZoom(z) { return Math.min(3, Math.max(0.5, Math.round(z * 10) / 10)); }
  function quiet() {}

  function applyUiState(s) {
    state.zoom = s.settings.zoom;
    state.pin = s.settings.always_on_top;
    state.hideGear = s.settings.hide_gear;
    state.closeToTray = s.settings.close_to_tray;
    state.keepAwake = s.settings.keep_awake;
    state.globalShortcut = s.settings.global_shortcut;
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
  function togglePanel(open) {
    panelOpen = (typeof open === "boolean") ? open : !panelOpen;
    if (panelOpen) {
      // Window state (fullscreen/mini/autostart) can change outside the
      // panel (F-keys, tray) — refresh before showing.
      invoke("get_ui_state").then(function (s) { applyUiState(s); render(); }).catch(quiet);
    }
    render();
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === "F9") { e.preventDefault(); toggleMini(); return; }
    if (e.key === "Escape" && panelOpen) { e.preventDefault(); togglePanel(false); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === ",") { e.preventDefault(); togglePanel(); }
      else if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(state.zoom + 0.1); }
      else if (e.key === "-") { e.preventDefault(); setZoom(state.zoom - 0.1); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); }
    }
  }, true);

  function render() {
    if (!els) { return; }
    els.gear.style.display = (state.hideGear || panelOpen) ? "none" : "";
    els.panel.style.display = panelOpen ? "" : "none";
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
  }

  function mount() {
    if (els || !document.documentElement) { return; }
    var hostEl = document.createElement("div");
    hostEl.id = "__focustown_wrapper_overlay";
    var root = hostEl.attachShadow({ mode: "closed" });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:system-ui,sans-serif}' +
      '#gear{position:fixed;right:14px;bottom:14px;z-index:2147483646;width:36px;height:36px;' +
      'border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(17,24,39,.55);' +
      'color:#e5e7eb;font-size:18px;line-height:1;cursor:pointer;opacity:.35;transition:opacity .15s}' +
      '#gear:hover{opacity:1}' +
      '#panel{position:fixed;right:14px;bottom:14px;z-index:2147483646;width:300px;max-height:calc(100vh - 28px);' +
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
      '#zoomVal{min-width:44px;text-align:center;color:#d1d5db}' +
      'kbd{border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:0 4px;font-size:11px;color:#9ca3af;margin-left:auto}' +
      '.hint{margin:8px 0 0;color:#9ca3af;font-size:11px;line-height:1.55}' +
      '#close{margin-left:auto}' +
      '</style>' +
      '<button id="gear" title="Wrapper settings (Ctrl+,)">&#9881;</button>' +
      '<div id="panel" style="display:none">' +
      '<h2>Wrapper settings <small id="version"></small></h2>' +

      '<h3>Window</h3>' +
      '<label><input type="checkbox" id="fs">Fullscreen<kbd>F11</kbd></label>' +
      '<label><input type="checkbox" id="pin">Always on top</label>' +
      '<div class="row"><button id="mini">Mini mode</button><kbd>F9</kbd></div>' +
      '<div class="row">Zoom <button id="zoomOut">&minus;</button><span id="zoomVal">100%</span>' +
      '<button id="zoomIn">+</button><button id="zoomReset">Reset</button></div>' +

      '<h3>Behavior</h3>' +
      '<label><input type="checkbox" id="closeTray">Close button hides to tray</label>' +
      '<label id="keepAwakeRow"><input type="checkbox" id="keepAwake">Keep screen awake</label>' +
      '<label><input type="checkbox" id="autostart">Start with computer (in tray)</label>' +
      '<label><input type="checkbox" id="globalShortcut">Global show/hide<kbd>Ctrl+Alt+F</kbd></label>' +

      '<h3>Maintenance</h3>' +
      '<div class="row"><button id="reload">Reload</button><button id="clearData" class="danger">Clear app data…</button></div>' +
      '<label><input type="checkbox" id="hideGear">Hide this button<kbd>Ctrl+,</kbd></label>' +
      '<div class="row"><button id="close">Close</button></div>' +

      '<p class="hint">Mini mode keeps a small always-on-top FocusTown window in the corner while you work. ' +
      'Zoom: Ctrl + / Ctrl &minus; / Ctrl 0. Tray icon: left-click to show/hide. ' +
      'Links outside FocusTown open in your browser.</p>' +
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
      version: root.getElementById("version")
    };

    els.gear.addEventListener("click", function () { togglePanel(true); });
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

    document.documentElement.appendChild(hostEl);
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
