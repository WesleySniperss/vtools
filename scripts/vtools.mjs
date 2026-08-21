/**
 * VTools — unified toolbar hub for FoundryVTT v13–v14.
 *
 * Other modules register buttons via:
 *   Hooks.once("vtools.ready", () => {
 *     VTools.register({
 *       name:    "my-tool",
 *       title:   "My Tool",
 *       icon:    "fas fa-dice-d20",
 *       onClick: () => { ... }
 *     });
 *   });
 */

class VToolsAPI {
  constructor() { this._tools = []; this._ready = false; }

  /** Виконує cb одразу якщо vtools вже готовий, інакше чекає хука. */
  onReady(cb) {
    if (this._ready) cb();
    else Hooks.once("vtools.ready", cb);
  }

  register({ name, title, icon, onClick }) {
    if (!name || !icon || typeof onClick !== "function") {
      console.error("VTools.register | missing required field (name / icon / onClick)");
      return;
    }
    if (this._tools.find(t => t.name === name)) {
      console.warn(`VTools.register | tool "${name}" already registered — skipping`);
      return;
    }
    this._tools.push({ name, title: title ?? name, icon, onClick });
    if (ui.controls) ui.controls.render();
  }

  unregister(name) {
    this._tools = this._tools.filter(t => t.name !== name);
    if (ui.controls) ui.controls.render();
  }
}

const VTools = new VToolsAPI();
window.VTools = VTools;

// ── VTools Canvas Layer (needed for v13+ to show tools in the secondary panel) ──
// Resolve the base class defensively: v14 namespaces it under foundry.canvas.layers,
// while v13 still exposes the CanvasLayer global. If neither exists we skip the layer
// rather than throwing at module load (which would take the whole module down).
const _CanvasLayerBase =
  globalThis.foundry?.canvas?.layers?.CanvasLayer ?? globalThis.CanvasLayer ?? null;

const _VToolsLayer = _CanvasLayerBase && class extends _CanvasLayerBase {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "vtools", zIndex: 9998 });
  }
  async _draw(options = {}) { return this; }
  async _tearDown(options = {}) { return this; }
};

// ── Settings ──
Hooks.once("init", () => {
  if (_VToolsLayer) CONFIG.Canvas.layers["vtools"] = { layerClass: _VToolsLayer, group: "interface" };
  game.settings.register("vtools", "gmSeesWhispers", {
    name: "GM sees player whispers",
    hint: "When enabled, the GM can see private whisper messages sent between players.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // Items pulled into the VTools panel — [{ id, title, icon }], stored in display order.
  game.settings.register("vtools", "absorbedControls", {
    scope: "world",
    config: false,
    type: String,
    default: "[]",
  });

  // Items removed from the toolbar entirely — same entry shape as absorbedControls.
  game.settings.register("vtools", "hiddenControls", {
    scope: "world",
    config: false,
    type: String,
    default: "[]",
  });

  // User-made groups — [{ id, name, icon, items: [{ id, title, icon }] }].
  game.settings.register("vtools", "vtoolsFolders", {
    scope: "world",
    config: false,
    type: String,
    default: "[]",
  });

  // Toolbar sort overrides — { <controlName>: <order> }.
  game.settings.register("vtools", "controlOrder", {
    scope: "world",
    config: false,
    type: String,
    default: "{}",
  });

  try {
    game.settings.registerMenu("vtools", "absorbMenu", {
      name: "Toolbar manager",
      hint: "Absorb, hide, group and reorder any toolbar icon (control or tool button).",
      label: "Configure",
      icon: "fas fa-cubes",
      type: _VToolsAbsorbMenu,
      restricted: true,
    });
  } catch (err) {
    console.error("VTools | registerMenu failed (settings button unavailable):", err);
  }

});

// Hide player-to-player whispers from GM when setting is off.
// Registered on both hook names: v13+ fires renderChatMessageHTML (html = HTMLElement),
// older cores fire renderChatMessage (html = jQuery). The action is idempotent, so it's
// safe if both fire. Handles either html type.
function _crHideWhisper(message, html) {
  if (!game.user.isGM) return;
  if (game.settings.get("vtools", "gmSeesWhispers")) return;
  if (!message.whisper?.length) return;
  if (message.whisper.includes(game.user.id)) return;               // GM is a recipient
  if ((message.author?.id ?? message.user?.id) === game.user.id) return; // GM is the author
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (root) root.style.display = "none";
}
Hooks.on("renderChatMessageHTML", _crHideWhisper);
Hooks.on("renderChatMessage", _crHideWhisper);

// ── Вогонь vtools.ready під час setup, ДО першого рендеру controls ──
// Це гарантує що _tools буде заповнений коли getSceneControlButtons спрацює
Hooks.once("setup", () => {
  Hooks.callAll("vtools.ready");
  VTools._ready = true;
});

// Fallback icons used when two tools share the same icon
const _ICON_FALLBACKS = [
  "fas fa-wand-magic-sparkles", "fas fa-bolt", "fas fa-fire", "fas fa-gem",
  "fas fa-leaf", "fas fa-moon", "fas fa-sun", "fas fa-anchor",
  "fas fa-feather-pointed", "fas fa-hat-wizard", "fas fa-chess-knight",
  "fas fa-flask", "fas fa-drum", "fas fa-wind", "fas fa-tornado",
];

function _uniqueIcon(icon, usedIcons) {
  if (!usedIcons.has(icon)) { usedIcons.add(icon); return icon; }
  for (const fb of _ICON_FALLBACKS) {
    if (!usedIcons.has(fb)) { usedIcons.add(fb); return fb; }
  }
  return icon;
}

// Canonical icon string so style aliases compare equal (fas === fa-solid, etc.)
const _ICON_ALIAS = { fas: "fa-solid", far: "fa-regular", fab: "fa-brands", fal: "fa-light", fad: "fa-duotone" };
function _iconKey(icon) {
  return String(icon ?? "").split(/\s+/).filter(Boolean)
    .map(c => _ICON_ALIAS[c] ?? c).sort().join(" ");
}

// Identity key for a panel entry — used to drop look-alike duplicates (same title + icon),
// e.g. a module that registers the same button twice under different names.
function _dupKey(title, icon) {
  return `${String(title ?? "").trim().toLowerCase()}::${_iconKey(icon)}`;
}

// Build the tool button that stands in for an absorbed entry. Shared by the VTools
// panel and by folder controls — both are just proxies resolved at click time.
function _proxyTool(entry, order, usedIcons) {
  return {
    name:     `abs:${entry.id}`,
    order,
    title:    entry.title ?? entry.id,
    icon:     _uniqueIcon(entry.icon ?? "fas fa-puzzle-piece", usedIcons),
    visible:  true,
    button:   true,
    onChange: () => _invokeAbsorbed(entry.id),
  };
}

// Every VTools-owned control needs a dummy activeTool so no button looks "selected".
function _dummyTool() {
  return { name: "vtools-dummy", order: 999, visible: true, onChange: () => {} };
}

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;

  const tools = {};
  const usedIcons = new Set();
  const seenKeys = new Set();   // drop look-alike duplicates (same title + icon)
  let order = 1;
  try {
    for (const t of VTools._tools) {
      const key = _dupKey(t.title ?? t.name, t.icon);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      tools[t.name] = {
        name:     t.name,
        order:    order++,
        title:    t.title ?? t.name,
        icon:     _uniqueIcon(t.icon, usedIcons),
        visible:  true,
        button:   true,
        onChange: () => t.onClick(),
      };
    }
  } catch (err) {
    console.error("VTools | registered-tool building failed (control kept intact):", err);
  }

  // User-absorbed toolbar icons (whole controls or individual tools).
  // Each stored entry is { id, title, icon }; the handler is resolved at click time.
  // Guarded so a bad entry can NEVER stop the VTools control itself from being created.
  try {
    for (const entry of _getAbsorbed()) {
      if (!entry?.id) continue;
      const proxyId = `abs:${entry.id}`;
      if (tools[proxyId]) continue;
      const key = _dupKey(entry.title ?? entry.id, entry.icon);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      tools[proxyId] = _proxyTool(entry, order++, usedIcons);
    }
  } catch (err) {
    console.error("VTools | absorption injection failed (control kept intact):", err);
  }

  // Dummy — activeTool щоб жодна кнопка не виглядала "вибраною"
  tools["vtools-dummy"] = _dummyTool();

  // Sit immediately after the tokens control → second from the top. Anchor to the
  // tokens control's own order (v13: tokens=1) rather than a global min, because some
  // module controls have order:undefined which would otherwise pull the anchor to 0.
  const tokenCtrl = controls["tokens"] ?? controls["token"];
  const baseOrder = (typeof tokenCtrl?.order === "number") ? tokenCtrl.order : 0;

  controls["vtools"] = {
    name:         "vtools",
    order:        baseOrder + 0.5,
    title:        "VTools",
    icon:         "vtools-icon",
    layer:        "vtools",
    visible:      game.user.isGM,
    onChange:     () => {},
    onToolChange: () => {},
    activeTool:   "vtools-dummy",
    tools,
  };

  // ── Folders ──
  // Scene controls are exactly two levels deep (control → tools); there is no third
  // level to nest into, so a folder is its own control group parked right behind
  // VTools. Same proxy tools inside, own icon and label.
  try {
    // Keep folders pinned next to VTools even after the user re-sorts the bar: anchor
    // them to VTools' own sorted position when one is stored.
    const sorted = _getOrder();
    const vOrder = typeof sorted["vtools"] === "number" ? sorted["vtools"] : baseOrder + 0.5;
    let fi = 1;
    for (const folder of _getFolders()) {
      if (!folder.items.length) continue;       // an empty control renders as a dead icon
      const fTools = {};
      const fIcons = new Set();
      const fKeys  = new Set();
      let fOrder = 1;
      for (const item of folder.items) {
        const proxyId = `abs:${item.id}`;
        if (fTools[proxyId]) continue;
        const key = _dupKey(item.title ?? item.id, item.icon);
        if (fKeys.has(key)) continue;
        fKeys.add(key);
        fTools[proxyId] = _proxyTool(item, fOrder++, fIcons);
      }
      fTools["vtools-dummy"] = _dummyTool();
      const cn = `vtools-folder-${folder.id}`;
      controls[cn] = {
        name:         cn,
        order:        vOrder + 0.001 * fi++,
        title:        folder.name || "Folder",
        icon:         folder.icon || "fas fa-folder",
        layer:        "vtools",
        visible:      true,
        onChange:     () => {},
        onToolChange: () => {},
        activeTool:   "vtools-dummy",
        tools:        fTools,
      };
    }
  } catch (err) {
    console.error("VTools | folder building failed (VTools control kept intact):", err);
  }
});

// (Dummy hiding + absorbed-original hiding handled by the renderSceneControls hook
//  in the Absorption section below.)

// ── Whisper feature ──
// Multi-recipient private whisper: pick one or more active players, type in the
// normal chat box, Enter sends. Selection can be edited/cancelled at any time.

const _whisperTargets = new Set();   // selected user ids

// v14 replaced the chat <textarea> with a <prose-mirror id="chat-message"> custom
// element whose editable surface is a contenteditable div nested inside it. v13 and
// older still use a plain textarea, so match both shapes.
const _CHAT_INPUT_SEL = [
  "#chat-message",                  // v14 <prose-mirror>, v12/v13 <textarea>
  "textarea[name='message']",
  ".chat-form textarea",
].join(",");

function _getChatInput() {
  return document.querySelector(_CHAT_INPUT_SEL);
}

// True for the chat input or anything inside it — on v14 keyboard events originate in
// ProseMirror's inner contenteditable, never on #chat-message itself.
function _isChatInput(el) {
  try { return !!(el?.closest?.(_CHAT_INPUT_SEL) ?? el?.matches?.(_CHAT_INPUT_SEL)); }
  catch { return false; }
}

// v14 renamed the concept wholesale: core.rollMode → core.messageMode, and the mode
// keys lost their "roll" suffix ("gmroll" → "gm"). Resolve once, at call time, so the
// same build works on both.
function _msgMode() {
  const v14 = !!game.settings?.settings?.has?.("core.messageMode");
  return v14
    ? { key: "messageMode", gm: "gm",     pub: "public" }
    : { key: "rollMode",    gm: "gmroll", pub: "publicroll" };
}

// v13 textareas use the placeholder attribute; v14's <prose-mirror> renders its
// placeholder from the --chat-message-placeholder custom property.
function _setChatPlaceholder(input, text) {
  if (!input) return;
  try {
    if ("placeholder" in input) input.placeholder = text ?? "";
    if (text === null) input.style.removeProperty("--chat-message-placeholder");
    else {
      // CSS string literal: escape backslashes first, then the delimiting quotes.
      const css = String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      input.style.setProperty("--chat-message-placeholder", `'${css}'`);
    }
  } catch (err) { console.warn("VTools | could not set the chat placeholder:", err); }
}

function _whisperNames() {
  return [..._whisperTargets].map(id => game.users.get(id)?.name).filter(Boolean);
}

// Torn down together with the picker so outside-click listeners can't pile up across
// open/close cycles and fire against a detached element.
let _pickerCleanup = null;

function _closeWhisperPicker() {
  document.querySelector(".vtools-player-picker")?.remove();
  if (_pickerCleanup) { _pickerCleanup(); _pickerCleanup = null; }
}

// Drop everyone but keep the picker open, so the selection can be rebuilt from scratch.
function _clearWhisperSelection() {
  _whisperTargets.clear();
  _renderWhisperBanner();
  _syncPickerState();
}

// Cancel the whisper outright: no recipients, no picker, back to normal chat.
function _clearWhisperTargets() {
  _whisperTargets.clear();
  _renderWhisperBanner();
  _closeWhisperPicker();
  _getChatInput()?.focus();
}

function _toggleWhisperTarget(id) {
  if (_whisperTargets.has(id)) _whisperTargets.delete(id);
  else _whisperTargets.add(id);
  _renderWhisperBanner();
  _syncPickerState();
}

// Reflect current selection in an open picker (checkmarks / highlight)
function _syncPickerState() {
  const picker = document.querySelector(".vtools-player-picker");
  if (!picker) return;
  picker.querySelectorAll(".vtools-picker-item").forEach(item => {
    item.classList.toggle("vtools-picker-item--on", _whisperTargets.has(item.dataset.userId));
  });
}

function _renderWhisperBanner() {
  document.querySelector(".vtools-whisper-banner")?.remove();
  const input = _getChatInput();
  if (!input) return;
  if (_whisperTargets.size === 0) { _setChatPlaceholder(input, null); return; }

  const banner = document.createElement("div");
  banner.className = "vtools-whisper-banner";

  const label = document.createElement("span");
  label.className = "vtools-whisper-label";
  label.innerHTML = `<i class="fas fa-user-secret"></i> Whisper`;
  banner.appendChild(label);

  const chips = document.createElement("div");
  chips.className = "vtools-whisper-chips";
  for (const id of _whisperTargets) {
    const user = game.users.get(id);
    if (!user) continue;
    const chip = document.createElement("span");
    chip.className = "vtools-whisper-chip";
    chip.innerHTML =
      `<span class="vtools-player-pip" style="background:${user.color}"></span>` +
      `<span class="vtools-chip-name">${user.name}</span>` +
      `<i class="fas fa-xmark vtools-chip-x" title="Remove"></i>`;
    chip.querySelector(".vtools-chip-x").addEventListener("click", (e) => {
      e.stopPropagation();
      _whisperTargets.delete(id);
      _renderWhisperBanner();
      _syncPickerState();
    });
    chips.appendChild(chip);
  }
  banner.appendChild(chips);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "vtools-whisper-cancel";
  cancel.title = "Cancel whisper (Esc)";
  cancel.innerHTML = `<i class="fas fa-xmark"></i>`;
  cancel.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _clearWhisperTargets();
  });
  banner.appendChild(cancel);

  // v14 keeps the input outside any form, so anchor the banner to the input itself.
  const anchor = input.closest("form.chat-form") ?? input;
  anchor.insertAdjacentElement("beforebegin", banner);
  _setChatPlaceholder(input, `Whisper to ${_whisperNames().join(", ")}…`);
}

function _showWhisperPicker(anchorEl) {
  // Toggle: a second click on the button closes an open picker
  if (document.querySelector(".vtools-player-picker")) { _closeWhisperPicker(); return; }

  // The GM-only mode button is ours now (we consume the click), so a core setting still
  // stuck on it can only be stale state from before — and while it is set, every message
  // goes to the GM alone no matter who is picked here. Clear it.
  try {
    const m = _msgMode();
    if (game.settings.get("core", m.key) === m.gm) game.settings.set("core", m.key, m.pub);
  } catch (err) { console.warn("VTools | could not reset the core message mode:", err); }

  const users = game.users.filter(u => u.active && u.id !== game.user.id);
  if (!users.length) {
    ui.notifications.warn("No active players to whisper to.");
    return;
  }

  const picker = document.createElement("div");
  picker.className = "vtools-player-picker";
  picker.innerHTML = `<div class="vtools-picker-header">Whisper to… <em>click to toggle</em></div>`;

  for (const user of users) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "vtools-picker-item";
    item.dataset.userId = user.id;
    if (_whisperTargets.has(user.id)) item.classList.add("vtools-picker-item--on");
    item.innerHTML =
      `<span class="vtools-picker-check"><i class="fas fa-check"></i></span>` +
      `<span class="vtools-player-pip" style="background:${user.color}"></span>` +
      `<span class="vtools-picker-name">${user.name}</span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      _toggleWhisperTarget(user.id);
    });
    picker.appendChild(item);
  }

  const foot = document.createElement("div");
  foot.className = "vtools-picker-foot";

  // Deselecting one by one is fine, but there was no way to drop the whole selection
  // from inside the picker — this is it. Leaves the picker open to re-pick.
  const none = document.createElement("button");
  none.type = "button";
  none.className = "vtools-picker-none";
  none.title = "Deselect everyone";
  none.innerHTML = `<i class="fas fa-user-slash"></i> None`;
  none.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _clearWhisperSelection();
  });
  foot.appendChild(none);

  const done = document.createElement("button");
  done.type = "button";
  done.className = "vtools-picker-done";
  done.innerHTML = `<i class="fas fa-check"></i> Done`;
  done.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _closeWhisperPicker();
    _getChatInput()?.focus();
  });
  foot.appendChild(done);
  picker.appendChild(foot);

  document.body.appendChild(picker);
  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.bottom = `${window.innerHeight - rect.top + 6}px`;

  const onOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorEl) _closeWhisperPicker();
  };
  _pickerCleanup = () => document.removeEventListener("click", onOutside);
  setTimeout(() => document.addEventListener("click", onOutside), 0);
}

// Send the pending whisper. Returns true if it was taken over by us.
function _sendWhisper(text) {
  const whisper = [..._whisperTargets];
  if (!whisper.length || !text) return false;
  ChatMessage.create({
    content: text,
    whisper,                                  // explicit recipients — ignores the core mode
    speaker: ChatMessage.getSpeaker(),
  }).catch(err => {
    console.error("VTools | whisper send failed:", err);
    ui.notifications?.error("VTools: whisper failed to send.");
  });
  _clearWhisperTargets();
  return true;
}

// ── Delegated listeners ──
// Bound ONCE on document in the capture phase instead of on the chat elements
// themselves, so a chat re-render can never leave us unbound.
//
// v14 rebuilt this whole area, which is what broke the feature:
//   • the mode buttons are now [data-action="messageMode"][data-mode="gm"] — the old
//     [data-roll-mode="gmroll"] markup is gone, so our click never matched, the click
//     reached core, core.messageMode became "gm", and every message went to the GM.
//   • the chat box is a <prose-mirror> element, not a <textarea>: it has no .value,
//     and Enter is handled inside a ProseMirror plugin rather than by a DOM listener.
// So the send path is the "chatMessage" hook alone (stable v11→v14) — core's own
// plugin clears the input for us afterwards even when the hook cancels creation.

// Every shape the GM-only mode control has taken across cores.
const _GMROLL_SEL = [
  "[data-action='messageMode'][data-mode='gm']",   // v14
  "[data-roll-mode='gmroll']",                     // v13
  "[data-rollmode='gmroll']",
  "[data-value='gmroll']",
  "button[value='gmroll']",
  "input[name='rollMode'][value='gmroll']",
].join(",");

function _gmrollTrigger(target) {
  let el = null;
  try { el = target?.closest?.(_GMROLL_SEL); } catch { return null; }
  if (!el) return null;
  if (el.tagName === "OPTION") return null;                        // the change listener owns these
  if (el.closest(".message, .chat-message, #chat-log, .chat-log")) return null;  // never a posted message
  return el;
}

document.addEventListener("click", (e) => {
  const trigger = _gmrollTrigger(e.target);
  if (!trigger) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _showWhisperPicker(trigger);
}, true);

// Right-click the same control to drop the whole selection without opening the picker.
document.addEventListener("contextmenu", (e) => {
  const trigger = _gmrollTrigger(e.target);
  if (!trigger || _whisperTargets.size === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _clearWhisperTargets();
}, true);

// Escape closes the picker; a second Escape (or Escape from the chat box) cancels the
// whisper entirely. Only swallowed while a whisper is actually pending, so core's own
// Escape handling is untouched the rest of the time.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".vtools-player-picker")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    _closeWhisperPicker();
    return;
  }
  if (_whisperTargets.size === 0 || !_isChatInput(e.target)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _clearWhisperTargets();
}, true);

// v12/v13-style <select name="rollMode">: picking gmroll opens the picker and the
// select snaps back, so core's mode is never left on "GM only".
const _rollModePrev = new WeakMap();
document.addEventListener("change", (e) => {
  const sel = e.target;
  if (!(sel instanceof HTMLSelectElement)) return;
  if (sel.name !== "rollMode" && sel.dataset?.action !== "rollMode") return;
  if (sel.value !== "gmroll") { _rollModePrev.set(sel, sel.value); return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  const back = _rollModePrev.get(sel) ?? game.settings.get("core", "rollMode");
  sel.value = (back && back !== "gmroll") ? back : "publicroll";
  _showWhisperPicker(sel);
}, true);

// THE send path. Core calls this from ChatLog#processMessage on every submit, on every
// version from v11 to v14, and returning false stops core creating its own message —
// after which core's input plugin still clears the chat box for us.
Hooks.on("chatMessage", (_chatLog, message) => {
  if (_whisperTargets.size === 0 || typeof message !== "string") return;
  const html = message.trim();
  if (!html) return;
  // v14 hands us ProseMirror markup ("<p>hello</p>"); v13 hands us plain text. Command
  // detection has to run on the text, while the posted message keeps its markup.
  let text = html;
  try {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    text = (tpl.content.textContent ?? "").trim();
  } catch { /* fall back to the raw string */ }
  if (!text || text.startsWith("/")) return;   // slash commands stay core's business
  if (_sendWhisper(html)) return false;
});

// Re-draw the banner after a chat re-render wipes it. Everything else is delegated on
// document, so there is nothing per-render to re-bind — and no button of our own to
// inject: the whisper-to-GM control is the trigger.
// renderChatLog (v13) / renderChatInput (v14 split out the input) — both are safe to
// listen on; the work is idempotent.
const _rehookChat = () => { if (_whisperTargets.size) _renderWhisperBanner(); };
Hooks.on("renderChatLog", _rehookChat);
Hooks.on("renderChatInput", _rehookChat);
Hooks.once("ready", () => {
  // One-time cleanup: rewrite the stored list to the clean object format, dropping any
  // legacy string entries from older versions so nothing stale can break absorption.
  if (game.user.isGM) {
    try {
      const clean = JSON.stringify(_getAbsorbed());
      if (clean !== game.settings.get("vtools", "absorbedControls")) {
        game.settings.set("vtools", "absorbedControls", clean);
      }
    } catch (err) { console.error("VTools | settings cleanup failed:", err); }
  }
  _registerAbsorptionHook();
});

// ── Toolbar manager: absorb / hide / group / sort ANY toolbar icon ──
//
// The user picks any control icon or individual tool button from a catalog built
// directly from ui.controls.controls, and gives it a destination:
//   • VTools panel — a proxy button inside the VTools control (original CSS-hidden)
//   • a folder     — a proxy button inside a user-made control group (original hidden)
//   • hidden       — dropped from the toolbar via core's own `visible: false`
//   • normal       — left alone
// Each pick is stored as { id, title, icon } so display never depends on render
// timing; the real handler is resolved at CLICK time. Proxied originals are
// CSS-hidden rather than removed, because the click-proxy needs them in the DOM.
//   id formats:  "ctrl:<controlName>"             — a whole top-level control icon
//                "tool:<controlName>::<toolName>"  — one tool button inside a control

function _isCanvasLayer(control) {
  if (!control?.layer) return false;
  const layers = CONFIG.Canvas?.layers ?? {};
  const groups = CONFIG.Canvas?.groups ?? {};
  return (control.layer in layers) || (control.layer in groups);
}

function _localize(s) {
  return (typeof s === "string" && game.i18n) ? game.i18n.localize(s) : s;
}

// Stored lists normalised to objects. Legacy string entries from older versions are
// dropped (format changed) — that simply resets absorption to a clean slate.
// Memoised by the raw settings string so the hot renderSceneControls path doesn't
// re-parse JSON on every canvas/tool interaction. The cache self-refreshes whenever
// the stored value changes (e.g. after Save), since the raw string differs.
const _jsonCache = {};
function _readJSON(key, normalise, fallback) {
  const raw = game.settings.get("vtools", key);
  const hit = _jsonCache[key];
  if (hit && hit.raw === raw) return hit.val;      // cache hit
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  let val;
  try { val = normalise(parsed) ?? fallback; } catch { val = fallback; }
  _jsonCache[key] = { raw, val };
  return val;                                      // treat as read-only (shared reference)
}

const _isEntry = (e) => !!e && typeof e === "object" && typeof e.id === "string";
const _entryList = (p) => Array.isArray(p) ? p.filter(_isEntry) : null;

function _getAbsorbed() { return _readJSON("absorbedControls", _entryList, []); }
function _getHidden()   { return _readJSON("hiddenControls",   _entryList, []); }

function _getFolders() {
  return _readJSON("vtoolsFolders", (p) => Array.isArray(p) ? p
    .filter(f => !!f && typeof f === "object" && typeof f.id === "string")
    .map(f => ({
      id:    f.id,
      name:  typeof f.name === "string" ? f.name : "Folder",
      icon:  typeof f.icon === "string" ? f.icon : "fas fa-folder",
      items: _entryList(f.items) ?? [],
    })) : null, []);
}

function _getOrder() {
  return _readJSON("controlOrder",
    (p) => (!!p && typeof p === "object" && !Array.isArray(p)) ? p : null, {});
}

// Every entry that is proxied somewhere (VTools panel or a folder) — its original
// must stay in the DOM but out of sight.
function _proxiedEntries() {
  return [..._getAbsorbed(), ..._getFolders().flatMap(f => f.items)];
}

// "tool:<ctrl>::<tool>" → { ctrl, tool }
function _parseToolId(id) {
  const rest = id.slice("tool:".length);
  const sep = rest.indexOf("::");
  return { ctrl: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

// Call an absorbed entry's real action. Resolved at click time, when every module's
// getSceneControlButtons hook has run and ui.controls.controls is complete.
function _invokeAbsorbed(id) {
  if (id.startsWith("ctrl:")) {
    // Top-level control icons are always in the DOM → click-proxy is reliable.
    document.querySelector(`[data-control="${id.slice(5)}"]`)?.click();
    return;
  }
  if (id.startsWith("tool:")) {
    const { ctrl, tool } = _parseToolId(id);
    const c = ui.controls?.controls?.[ctrl];
    const tools = Array.isArray(c?.tools) ? c.tools : Object.values(c?.tools ?? {});
    const t = tools.find(x => x?.name === tool);
    const handler = t?.onClick ?? t?.onChange;
    if (typeof handler === "function") { handler(); return; }
    document.querySelector(`[data-tool="${tool}"]`)?.click(); // DOM fallback
  }
}

// CSS-hide the original button of a proxied entry. Tool buttons are only rendered for
// the active control, so scope tool hiding to it — otherwise a same-named tool in a
// different control would be hidden too.
function _hideOriginal(id) {
  if (!id || id === "ctrl:vtools") return;         // never hide VTools itself
  let sel = null;
  if (id.startsWith("ctrl:")) {
    sel = `[data-control="${CSS.escape(id.slice(5))}"]`;
  } else if (id.startsWith("tool:")) {
    const { ctrl, tool } = _parseToolId(id);
    if (ui.controls?.control?.name !== ctrl) return;
    sel = `[data-tool="${CSS.escape(tool)}"]`;
  }
  if (!sel) return;
  for (const el of document.querySelectorAll(sel)) {
    el.style.setProperty("display", "none", "important");
  }
}

// Hide the originals of everything proxied (and the VTools dummy) after each render.
let _vtoolsHealAt = 0;   // cooldown for the self-heal re-render below
Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;
  try {
    // Every VTools-owned control (panel + folders) carries a dummy activeTool.
    if (ui.controls?.control?.name?.startsWith("vtools")) {
      for (const el of document.querySelectorAll('[data-tool="vtools-dummy"]')) {
        el.style.setProperty("display", "none", "important");
      }
    }

    for (const entry of _proxiedEntries()) _hideOriginal(entry.id);
    // Belt-and-braces: hidden entries are dropped via core `visible: false` in the late
    // hook, but a module that rebuilds its control afterwards would resurrect them.
    for (const entry of _getHidden()) _hideOriginal(entry.id);

    // Self-heal: if the toolbar rendered WITHOUT our button (render race at startup,
    // or a later module clobbering the controls record), force one re-render.
    // Only when other control buttons exist (i.e. the bar itself is on screen), and
    // with a cooldown so a persistent failure can never loop.
    const anyBtn = document.querySelector("[data-control]");
    if (anyBtn && !document.querySelector('[data-control="vtools"]')) {
      const now = Date.now();
      if (now - _vtoolsHealAt > 2000) {
        _vtoolsHealAt = now;
        console.warn("VTools | control missing from toolbar — re-rendering");
        ui.controls?.render();
      }
    }
  } catch (err) {
    console.error("VTools | renderSceneControls hook failed:", err);
  }
});

// Build a catalog of every absorbable icon from the live controls structure.
function _buildCatalog() {
  const out = [];
  const controls = ui.controls?.controls ?? {};
  for (const [cn, c] of Object.entries(controls)) {
    if (cn === "vtools" || cn.startsWith("vtools-folder-")) continue;   // our own icons
    out.push({
      id:    `ctrl:${cn}`,
      kind:  "control",
      ctrl:  cn,
      title: _localize(c.title) || cn,
      icon:  c.icon || "fas fa-puzzle-piece",
      hasLayer: _isCanvasLayer(c),
    });
    const tools = Array.isArray(c.tools) ? c.tools : Object.values(c.tools ?? {});
    for (const t of tools) {
      if (!t?.name || t.name === "vtools-dummy") continue;
      out.push({
        id:    `tool:${cn}::${t.name}`,
        kind:  "tool",
        ctrl:  cn,
        title: _localize(t.title) || t.name,
        icon:  t.icon || "fas fa-puzzle-piece",
        hasLayer: false,
      });
    }
  }
  return out;
}

const _esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const _newId = () => (foundry?.utils?.randomID?.(8) ?? Math.random().toString(36).slice(2, 10));

// Top-level controls in their current effective order, for the sort list.
function _toolbarList() {
  const controls = ui.controls?.controls ?? {};
  return Object.entries(controls)
    .map(([name, c]) => ({
      name,
      title: name === "vtools" ? "VTools" : (_localize(c.title) || name),
      icon:  c.icon || "fas fa-puzzle-piece",
      order: typeof c.order === "number" ? c.order : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.order - b.order);
}

function _openToolbarManager() {
  const catalog = _buildCatalog();
  if (!catalog.length) {
    ui.notifications.warn("VTools: No toolbar icons detected — activate a scene first.");
    return;
  }

  // Live working copy — every interaction mutates this, Save writes it out.
  const model = {
    absorbed: _getAbsorbed().map(e => ({ ...e })),
    hidden:   _getHidden().map(e => ({ ...e })),
    folders:  _getFolders().map(f => ({ ...f, items: f.items.map(i => ({ ...i })) })),
    toolbar:  _toolbarList(),
  };

  // A hidden control drops out of ui.controls.controls, and a module can be disabled
  // between sessions — without this, an assigned icon would vanish from the manager and
  // could never be put back. Re-add anything assigned but no longer live.
  const MISSING = "__vtools_missing";
  const live = new Set(catalog.map(c => c.id));
  for (const e of [...model.absorbed, ...model.hidden, ...model.folders.flatMap(f => f.items)]) {
    if (live.has(e.id)) continue;
    live.add(e.id);
    catalog.push({
      id:    e.id,
      kind:  e.id.startsWith("ctrl:") ? "control" : "tool",
      ctrl:  MISSING,
      title: e.title ?? e.id,
      icon:  e.icon ?? "fas fa-puzzle-piece",
      hasLayer: false,
    });
  }

  const groups = {};
  for (const e of catalog) (groups[e.ctrl] ??= []).push(e);

  const groupTitle = (cn, entries) => cn === MISSING
    ? "Not on the toolbar right now"
    : (entries.find(e => e.kind === "control")?.title ?? cn);

  const placeOf = (id) => {
    if (model.absorbed.some(e => e.id === id)) return "vtools";
    if (model.hidden.some(e => e.id === id))   return "hidden";
    const f = model.folders.find(f => f.items.some(i => i.id === id));
    return f ? `folder:${f.id}` : "normal";
  };

  const setPlace = (cat, dest) => {
    model.absorbed = model.absorbed.filter(e => e.id !== cat.id);
    model.hidden   = model.hidden.filter(e => e.id !== cat.id);
    for (const f of model.folders) f.items = f.items.filter(i => i.id !== cat.id);
    const entry = { id: cat.id, title: cat.title, icon: cat.icon };
    if (dest === "vtools") model.absorbed.push(entry);
    else if (dest === "hidden") model.hidden.push(entry);
    else if (dest.startsWith("folder:")) {
      model.folders.find(f => f.id === dest.slice(7))?.items.push(entry);
    }
  };

  // scope → the array a reorder/remove row acts on
  const listOf = (scope) => {
    if (scope === "absorbed") return model.absorbed;
    if (scope === "hidden")   return model.hidden;
    if (scope === "toolbar")  return model.toolbar;
    if (scope.startsWith("folder:")) return model.folders.find(f => f.id === scope.slice(7))?.items ?? [];
    return [];
  };

  // ── rendering ──
  const destOptions = (id) => {
    const cur = placeOf(id);
    const opts = [["normal", "On toolbar"], ["vtools", "VTools panel"], ["hidden", "Hidden"]];
    for (const f of model.folders) opts.push([`folder:${f.id}`, `Folder: ${f.name}`]);
    return opts.map(([v, l]) =>
      `<option value="${_esc(v)}"${v === cur ? " selected" : ""}>${_esc(l)}</option>`).join("");
  };

  const catRow = (e) => `
    <div class="vtools-mrow">
      <i class="${_esc(e.icon)} vtools-mrow-icon"></i>
      <span class="vtools-mrow-name">${_esc(e.title)}${e.kind === "control" ? ' <em>(whole icon)</em>' : ""}${
        e.hasLayer ? ' <span class="vtools-warn" title="Has a canvas layer — clicking it also switches the layer">⚠</span>' : ""}</span>
      <select class="vtools-dest" data-id="${_esc(e.id)}">${destOptions(e.id)}</select>
    </div>`;

  const sortRow = (item, scope, i, len, removable = true) => `
    <div class="vtools-mrow vtools-mrow--sort">
      <i class="${_esc(item.icon)} vtools-mrow-icon"></i>
      <span class="vtools-mrow-name">${_esc(item.title)}</span>
      <button type="button" data-act="up" data-scope="${_esc(scope)}" data-i="${i}"${i === 0 ? " disabled" : ""} title="Move up"><i class="fas fa-chevron-up"></i></button>
      <button type="button" data-act="down" data-scope="${_esc(scope)}" data-i="${i}"${i === len - 1 ? " disabled" : ""} title="Move down"><i class="fas fa-chevron-down"></i></button>
      ${removable ? `<button type="button" data-act="rm" data-scope="${_esc(scope)}" data-i="${i}" title="Put back on the toolbar"><i class="fas fa-xmark"></i></button>` : ""}
    </div>`;

  const sortBlock = (label, scope, items, removable = true) => !items.length ? "" : `
    <p class="vtools-msub">${_esc(label)}</p>
    ${items.map((it, i) => sortRow(it, scope, i, items.length, removable)).join("")}`;

  const build = () => `
    <p class="vtools-mhint">
      Give any toolbar icon a home: leave it where it is, pull it into the VTools panel,
      drop it into a folder of your own, or hide it outright. ⚠ marks canvas-layer controls.
    </p>

    <details open>
      <summary>Icons</summary>
      ${Object.entries(groups).map(([cn, entries]) => `
        <p class="vtools-mhead">${_esc(groupTitle(cn, entries))}</p>
        ${entries.map(catRow).join("")}`).join("")}
    </details>

    <details${model.folders.length ? " open" : ""}>
      <summary>Folders</summary>
      <p class="vtools-mhint">Each folder becomes its own icon on the toolbar, holding whatever you put in it.</p>
      ${model.folders.map((f, i) => `
        <div class="vtools-mrow">
          <input type="text" class="vtools-ficon" data-i="${i}" value="${_esc(f.icon)}" title="Font Awesome classes, e.g. fas fa-folder" placeholder="fas fa-folder">
          <i class="${_esc(f.icon)} vtools-mrow-icon"></i>
          <input type="text" class="vtools-fname" data-i="${i}" value="${_esc(f.name)}" placeholder="Folder name">
          <button type="button" data-act="delFolder" data-i="${i}" title="Delete folder (contents go back to the toolbar)"><i class="fas fa-trash"></i></button>
        </div>`).join("")}
      <button type="button" data-act="newFolder" class="vtools-madd"><i class="fas fa-folder-plus"></i> New folder</button>
    </details>

    <details>
      <summary>Contents &amp; order</summary>
      ${sortBlock("VTools panel", "absorbed", model.absorbed)}
      ${model.folders.map(f => sortBlock(f.name || "Folder", `folder:${f.id}`, f.items)).join("")}
      ${sortBlock("Hidden", "hidden", model.hidden)}
      ${(!model.absorbed.length && !model.hidden.length && !model.folders.some(f => f.items.length))
        ? `<p class="vtools-mhint">Nothing assigned yet.</p>` : ""}
    </details>

    <details>
      <summary>Toolbar order</summary>
      <p class="vtools-mhint">Sort the top-level icons down the left edge of the screen.</p>
      ${model.toolbar.map((c, i) => sortRow(c, "toolbar", i, model.toolbar.length, false)).join("")}
    </details>`;

  const onRender = (root) => {
    const host = root?.querySelector(".vtools-manager");
    if (!host) return;
    // Keep <details> open/closed state across redraws so the dialog doesn't jump.
    const redraw = () => {
      const open = [...host.querySelectorAll("details")].map(d => d.open);
      host.innerHTML = build();
      host.querySelectorAll("details").forEach((d, i) => { if (open[i] !== undefined) d.open = open[i]; });
    };
    redraw();

    host.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn || !host.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const { act, scope } = btn.dataset;
      const i = Number(btn.dataset.i);
      if (act === "newFolder") {
        model.folders.push({ id: _newId(), name: "New folder", icon: "fas fa-folder", items: [] });
      } else if (act === "delFolder") {
        model.folders.splice(i, 1);                      // items simply return to the toolbar
      } else if (act === "up" || act === "down") {
        const list = listOf(scope);
        const j = act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
      } else if (act === "rm") {
        listOf(scope).splice(i, 1);
      } else return;
      redraw();
    });

    // DialogV2 wraps content in a form — Enter in a folder-name field would otherwise
    // fire the default button and close the dialog mid-edit.
    host.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target.matches("input")) { ev.preventDefault(); ev.target.blur(); }
    });

    host.addEventListener("change", (ev) => {
      const sel = ev.target.closest("select.vtools-dest");
      if (sel) {
        const cat = catalog.find(c => c.id === sel.dataset.id);
        if (cat) { setPlace(cat, sel.value); redraw(); }
        return;
      }
      const name = ev.target.closest("input.vtools-fname");
      if (name) { const f = model.folders[Number(name.dataset.i)]; if (f) f.name = name.value; redraw(); return; }
      const icon = ev.target.closest("input.vtools-ficon");
      if (icon) { const f = model.folders[Number(icon.dataset.i)]; if (f) f.icon = icon.value.trim() || "fas fa-folder"; redraw(); }
    });
  };

  const commit = () => {
    // Drop empty folders so they can't leave a dead icon on the bar.
    const folders = model.folders.filter(f => f.items.length);
    const order = Object.fromEntries(model.toolbar.map((c, i) => [c.name, i]));
    Promise.all([
      game.settings.set("vtools", "absorbedControls", JSON.stringify(model.absorbed)),
      game.settings.set("vtools", "hiddenControls",   JSON.stringify(model.hidden)),
      game.settings.set("vtools", "vtoolsFolders",    JSON.stringify(folders)),
      game.settings.set("vtools", "controlOrder",     JSON.stringify(order)),
    ]).then(() => ui.controls?.render())
      .catch(err => {
        console.error("VTools | saving toolbar layout failed:", err);
        ui.notifications?.error("VTools: could not save the toolbar layout.");
      });
  };

  _vtoolsDialog("VTools — Toolbar manager", `<div class="vtools-manager"></div>`, commit, onRender);
}

// Cross-version dialog: prefer ApplicationV2 DialogV2 (v13/v14), fall back to the
// deprecated V1 Dialog for older cores. onRender receives the dialog root HTMLElement
// once it is in the DOM; onSave runs when Save is pressed.
function _vtoolsDialog(title, content, onSave, onRender) {
  const DV2 = foundry?.applications?.api?.DialogV2;
  if (DV2) {
    const dlg = new DV2({
      window: { title, icon: "fas fa-cubes" },
      position: { width: 520 },
      content,
      buttons: [
        { action: "save", label: "Save", icon: "fas fa-save", default: true,
          callback: () => onSave() },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" },
      ],
    });
    Promise.resolve(dlg.render(true))
      .then(() => onRender?.(dlg.element))
      .catch(err => console.error("VTools | dialog render failed:", err));
    return;
  }
  new Dialog({
    title,
    content,
    render: (html) => onRender?.(html instanceof HTMLElement ? html : html?.[0]),
    buttons: {
      save:   { icon: '<i class="fas fa-save"></i>', label: "Save", callback: () => onSave() },
      cancel: { label: "Cancel" },
    },
    default: "save",
  }).render(true);
}

// Settings-menu launcher. Base resolves to ApplicationV2 (v13/v14) or the deprecated
// V1 FormApplication, whichever exists — registerMenu just needs a class whose
// render() we override to open our own dialog.
const _MenuAppBase =
  globalThis.foundry?.applications?.api?.ApplicationV2 ?? globalThis.FormApplication ?? Object;
class _VToolsAbsorbMenu extends _MenuAppBase {
  render() { _openToolbarManager(); return this; }
}

// Hidden entries use core's own `visible: false` rather than a CSS hack — nothing has
// to proxy them, so they can leave the toolbar properly.
function _applyHidden(controls) {
  const proxied = new Set(_proxiedEntries().map(e => e.id));
  for (const entry of _getHidden()) {
    const id = entry.id;
    if (id === "ctrl:vtools") continue;
    if (proxied.has(id)) continue;   // a proxy needs its original left in the DOM
    if (id.startsWith("ctrl:")) {
      const c = controls[id.slice(5)];
      if (c) c.visible = false;
    } else if (id.startsWith("tool:")) {
      const { ctrl, tool } = _parseToolId(id);
      const c = controls[ctrl];
      if (!c?.tools) continue;
      const t = Array.isArray(c.tools) ? c.tools.find(x => x?.name === tool) : c.tools[tool];
      if (t) t.visible = false;
    }
  }
}

// Late hook: de-duplicate modules that register via VTools.register() AND also add their
// own standalone control, then apply hiding and the user's sort. Runs last on purpose —
// every other module has added its controls by now, so nothing can overwrite us.
function _registerAbsorptionHook() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;
    for (const name of Object.keys(controls)) {
      if (name === "vtools") continue;
      if (VTools._tools.find(t => t.name === name)) delete controls[name];
    }
    try { _applyHidden(controls); }
    catch (err) { console.error("VTools | hiding failed:", err); }
    try {
      const order = _getOrder();
      for (const [name, c] of Object.entries(controls)) {
        if (c && typeof order[name] === "number") c.order = order[name];
      }
    } catch (err) { console.error("VTools | sorting failed:", err); }
  });
  // Re-render ONLY if a duplicate standalone control is actually on screen right now.
  // The old unconditional render here raced Foundry's initial async render — the loser
  // of that race could paint the toolbar without the VTools button (intermittent).
  const cur = ui.controls?.controls ?? {};
  const hasDupe = Object.keys(cur).some(n => n !== "vtools" && VTools._tools.find(t => t.name === n));
  if (hasDupe) ui.controls.render();
}
