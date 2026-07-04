/**
 * VTools — unified toolbar hub for FoundryVTT v13.
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

// ── VTools Canvas Layer (needed for v13 to show tools in secondary panel) ──
class _VToolsLayer extends CanvasLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "vtools", zIndex: 9998 });
  }
  async _draw(options = {}) { return this; }
  async _tearDown(options = {}) { return this; }
}

// ── Settings ──
Hooks.once("init", () => {
  CONFIG.Canvas.layers["vtools"] = { layerClass: _VToolsLayer, group: "interface" };
  game.settings.register("vtools", "gmSeesWhispers", {
    name: "GM sees player whispers",
    hint: "When enabled, the GM can see private whisper messages sent between players.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register("vtools", "absorbedControls", {
    scope: "world",
    config: false,
    type: String,
    default: "[]",
  });

  game.settings.registerMenu("vtools", "absorbMenu", {
    name: "Absorb toolbar icons",
    hint: "Pick any toolbar icon (control or tool button) to move it into the VTools panel.",
    label: "Configure",
    icon: "fas fa-cubes",
    type: _VToolsAbsorbMenu,
    restricted: true,
  });

});

// Hide player-to-player whispers from GM when setting is off
Hooks.on("renderChatMessage", (message, html) => {
  if (!game.user.isGM) return;
  if (game.settings.get("vtools", "gmSeesWhispers")) return;
  if (!message.whisper?.length) return;
  // Show if GM is a recipient or the author of the whisper
  if (message.whisper.includes(game.user.id)) return;
  if ((message.author?.id ?? message.user?.id) === game.user.id) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (root) root.style.display = "none";
});

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
      tools[proxyId] = {
        name:     proxyId,
        order:    order++,
        title:    entry.title ?? entry.id,
        icon:     _uniqueIcon(entry.icon ?? "fas fa-puzzle-piece", usedIcons),
        visible:  true,
        button:   true,
        onChange: () => _invokeAbsorbed(entry.id),
      };
    }
  } catch (err) {
    console.error("VTools | absorption injection failed (control kept intact):", err);
  }

  // Dummy — activeTool щоб жодна кнопка не виглядала "вибраною"
  tools["vtools-dummy"] = {
    name:    "vtools-dummy",
    order:   999,
    visible: true,
    onChange: () => {},
  };

  controls["vtools"] = {
    name:         "vtools",
    order:        Object.keys(controls).length + 1,
    title:        "VTools",
    icon:         "vtools-icon",
    layer:        "vtools",
    visible:      game.user.isGM,
    onChange:     () => {},
    onToolChange: () => {},
    activeTool:   "vtools-dummy",
    tools,
  };
});

// (Dummy hiding + absorbed-original hiding handled by the renderSceneControls hook
//  in the Absorption section below.)

// ── Whisper feature ──
// Multi-recipient private whisper: pick one or more active players, type in the
// normal chat box, Enter sends. Selection can be edited/cancelled at any time.

const _whisperTargets = new Set();   // selected user ids

function _getChatInput() {
  return document.querySelector("#chat-message, textarea[name='message']");
}

function _whisperNames() {
  return [..._whisperTargets].map(id => game.users.get(id)?.name).filter(Boolean);
}

function _clearWhisperTargets() {
  _whisperTargets.clear();
  _renderWhisperBanner();
  document.querySelector(".vtools-player-picker")?.remove();
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
  if (_whisperTargets.size === 0) { input.placeholder = ""; return; }

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
  cancel.title = "Cancel whisper";
  cancel.innerHTML = `<i class="fas fa-xmark"></i>`;
  cancel.addEventListener("click", _clearWhisperTargets);
  banner.appendChild(cancel);

  const form = input.closest("form") ?? input.parentElement;
  form.insertAdjacentElement("beforebegin", banner);
  input.placeholder = `Whisper to ${_whisperNames().join(", ")}…`;
}

function _showWhisperPicker(anchorEl) {
  // Toggle: a second click on the button closes an open picker
  const open = document.querySelector(".vtools-player-picker");
  if (open) { open.remove(); return; }

  const users = game.users.filter(u => u.active && u.id !== game.user.id);
  if (!users.length) {
    ui.notifications.warn("No active players to whisper to.");
    return;
  }

  const picker = document.createElement("div");
  picker.className = "vtools-player-picker";
  picker.innerHTML = `<div class="vtools-picker-header">Whisper to…</div>`;

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

  const done = document.createElement("button");
  done.type = "button";
  done.className = "vtools-picker-done";
  done.innerHTML = `<i class="fas fa-check"></i> Done`;
  done.addEventListener("click", (e) => {
    e.stopPropagation();
    picker.remove();
    _getChatInput()?.focus();
  });
  picker.appendChild(done);

  document.body.appendChild(picker);
  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.bottom = `${window.innerHeight - rect.top + 6}px`;

  const onOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorEl) {
      picker.remove();
      document.removeEventListener("click", onOutside);
    }
  };
  setTimeout(() => document.addEventListener("click", onOutside), 0);
}

function _hookChatInput() {
  const input = _getChatInput();
  if (!input || input.dataset.vtoolsHooked) return;
  input.dataset.vtoolsHooked = "1";
  input.addEventListener("keydown", (e) => {
    if (_whisperTargets.size === 0 || e.key !== "Enter" || e.shiftKey) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    ChatMessage.create({
      content: message,
      whisper: [..._whisperTargets],
      speaker: ChatMessage.getSpeaker(),
    });
    input.value = "";
    _clearWhisperTargets();
  }, true);
}

function _hookGmrollBtn() {
  const btn = document.querySelector("button[data-action='rollMode'][data-roll-mode='gmroll']");
  if (!btn || btn.dataset.vtoolsHooked) return;
  btn.dataset.vtoolsHooked = "1";
  btn.addEventListener("click", (e) => {
    e.stopImmediatePropagation();
    e.preventDefault();
    _showWhisperPicker(btn);
  }, true);
}

Hooks.on("renderChatLog", () => { _hookGmrollBtn(); _hookChatInput(); });
Hooks.once("ready", () => {
  _hookGmrollBtn();
  _hookChatInput();
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

// ── Absorption: pull ANY toolbar icon into VTools ──
//
// The user picks any control icon or individual tool button from a catalog built
// directly from ui.controls.controls. Each pick is stored as { id, title, icon } so
// display never depends on render timing; the real handler is resolved at CLICK time.
// Originals are CSS-hidden (never deleted) so their handlers stay resolvable.
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

// Stored list normalised to objects. Legacy string entries from older versions are
// dropped (format changed) — that simply resets absorption to a clean slate.
// Memoised by the raw settings string so the hot renderSceneControls path doesn't
// re-parse JSON on every canvas/tool interaction. The cache self-refreshes whenever
// the stored value changes (e.g. after Save), since the raw string differs.
let _absorbedRaw = null;
let _absorbedVal = [];
function _getAbsorbed() {
  const raw = game.settings.get("vtools", "absorbedControls");
  if (raw === _absorbedRaw) return _absorbedVal;   // cache hit
  _absorbedRaw = raw;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  _absorbedVal = Array.isArray(parsed)
    ? parsed.filter(e => e && typeof e === "object" && typeof e.id === "string")
    : [];
  return _absorbedVal;   // treat as read-only (shared reference)
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

// Hide the originals of everything absorbed (and the VTools dummy) after each render.
Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;
  try {
    if (ui.controls?.control?.name === "vtools") {
      document.querySelector('[data-tool="vtools-dummy"]')
        ?.style.setProperty("display", "none", "important");
    }

    for (const entry of _getAbsorbed()) {
      if (!entry?.id || entry.id === "ctrl:vtools") continue; // never hide VTools itself
      let sel = null;
      if (entry.id.startsWith("ctrl:"))      sel = `[data-control="${entry.id.slice(5)}"]`;
      else if (entry.id.startsWith("tool:")) sel = `[data-tool="${_parseToolId(entry.id).tool}"]`;
      if (!sel) continue;
      for (const el of document.querySelectorAll(sel)) {
        el.style.setProperty("display", "none", "important");
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
    if (cn === "vtools") continue;
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

function _openAbsorbMenu() {
  const catalog = _buildCatalog();
  if (!catalog.length) {
    ui.notifications.warn("VTools: No toolbar icons detected — activate a scene first.");
    return;
  }
  const absorbedIds = new Set(_getAbsorbed().map(e => e.id));

  // Group catalog entries by their control for a readable list
  const groups = {};
  for (const e of catalog) (groups[e.ctrl] ??= []).push(e);

  const rowOf = (e) => `
    <div class="form-group" style="margin:0">
      <label style="flex:1"><i class="${e.icon}" style="width:18px;text-align:center"></i>
        ${e.title}${e.kind === "control" ? " <em style='opacity:.6'>(whole icon)</em>" : ""}
        ${e.hasLayer ? " <span style='color:#f90' title='Has a canvas layer — absorbing still works but clicking switches the layer'>⚠</span>" : ""}
      </label>
      <div class="form-fields" style="flex:0 0 auto">
        <input type="checkbox" name="${e.id}" ${absorbedIds.has(e.id) ? "checked" : ""}>
      </div>
    </div>`;

  const sections = Object.entries(groups).map(([cn, entries]) => {
    const ctrlTitle = entries.find(e => e.kind === "control")?.title ?? cn;
    return `<p style="font-size:11px;color:#8af;margin:10px 0 2px;text-transform:uppercase;border-bottom:1px solid #333">${ctrlTitle}</p>
            ${entries.map(rowOf).join("")}`;
  }).join("");

  new Dialog({
    title: "VTools — Absorb toolbar icons",
    content: `
      <form style="max-height:460px;overflow-y:auto">
        <p style="font-size:12px;color:#aaa;margin:0 0 8px">
          Tick any icon to move it into the VTools panel. ⚠ marks canvas-layer controls.
        </p>
        ${sections}
      </form>`,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Save",
        callback: (html) => {
          const root = html instanceof HTMLElement ? html : html[0];
          const out = [];
          for (const e of catalog) {
            const cb = root.querySelector(`[name="${e.id}"]`);
            if (cb?.checked) out.push({ id: e.id, title: e.title, icon: e.icon });
          }
          game.settings.set("vtools", "absorbedControls", JSON.stringify(out))
            .then(() => ui.controls?.render());
        },
      },
      cancel: { label: "Cancel" },
    },
    default: "save",
  }).render(true);
}

class _VToolsAbsorbMenu extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, { id: "vtools-absorb-menu" });
  }
  getData() { return {}; }
  async _updateObject() {}
  render() { _openAbsorbMenu(); return this; }
}

// Late hook: only de-duplicate modules that register via VTools.register() AND also add
// their own standalone control. Absorption itself is handled in the early hook above.
function _registerAbsorptionHook() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;
    for (const name of Object.keys(controls)) {
      if (name === "vtools") continue;
      if (VTools._tools.find(t => t.name === name)) delete controls[name];
    }
  });
  ui.controls?.render();
}
