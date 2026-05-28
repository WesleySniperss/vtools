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
    name: "Module Absorption",
    hint: "Move simple module controls into the VTools panel.",
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

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const toolEntries = VTools._tools.length > 0 ? VTools._tools : [];

  const tools = {};
  const usedIcons = new Set();
  let order = 1;
  for (const t of toolEntries) {
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

  // Auto-detected DOM-injected tools chosen by user
  for (const toolId of _getAbsorbedDOM()) {
    const info = _detectedDOMTools[toolId];
    if (!info) continue;
    const id = `dom-auto-${toolId}`;
    tools[id] = {
      name:     id,
      order:    order++,
      title:    info.title,
      icon:     _uniqueIcon(info.icon, usedIcons),
      visible:  true,
      button:   true,
      onChange: () => document.querySelector(info.selector)?.click(),
    };
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

// Hide the dummy tool from DOM after render
Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;
  if (ui.controls?.control?.name !== "vtools") return;
  document.querySelector('[data-tool="vtools-dummy"]')
    ?.style.setProperty("display", "none", "important");
});

// ── Whisper feature ──

let _whisperTarget = null;

function _getChatInput() {
  return document.querySelector("#chat-message, textarea[name='message']");
}

function _clearWhisperTarget() {
  _whisperTarget = null;
  document.querySelector(".vtools-whisper-banner")?.remove();
  const input = _getChatInput();
  if (input) input.placeholder = "";
}

function _setWhisperTarget(user) {
  _whisperTarget = user;
  document.querySelector(".vtools-whisper-banner")?.remove();

  const input = _getChatInput();
  if (!input) return;

  const banner = document.createElement("div");
  banner.className = "vtools-whisper-banner";
  banner.innerHTML = `<i class="fas fa-envelope"></i> Whisper to <strong>${user.name}</strong><button type="button" class="vtools-whisper-cancel" title="Cancel">✕</button>`;
  banner.querySelector(".vtools-whisper-cancel").addEventListener("click", _clearWhisperTarget);

  const form = input.closest("form") ?? input.parentElement;
  form.insertAdjacentElement("beforebegin", banner);

  input.placeholder = `Whisper to ${user.name}...`;
  input.focus();
}

function _showWhisperPicker(anchorEl) {
  document.querySelector(".vtools-player-picker")?.remove();

  const users = game.users.filter(u => u.active && u.id !== game.user.id);
  if (!users.length) {
    ui.notifications.warn("No active players to whisper to.");
    return;
  }

  const picker = document.createElement("div");
  picker.className = "vtools-player-picker";

  for (const user of users) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "vtools-picker-item";
    item.innerHTML = `<span class="vtools-player-pip" style="background:${user.color}"></span>${user.name}`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      picker.remove();
      _setWhisperTarget(user);
    });
    picker.appendChild(item);
  }

  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  document.body.appendChild(picker);

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
    if (!_whisperTarget || e.key !== "Enter" || e.shiftKey) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    ChatMessage.create({
      content: message,
      whisper: [_whisperTarget.id],
      speaker: ChatMessage.getSpeaker(),
    });
    input.value = "";
    _clearWhisperTarget();
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
Hooks.once("ready", () => { _hookGmrollBtn(); _hookChatInput(); _absorbDOMModules(); _registerAbsorptionHook(); });

// ── Auto-detection of DOM-injected module tools ──

// Known DOM-injected tools (hardcoded seeds — always show in dialog, auto-absorbed by default)
const _DOM_KNOWN = [
  { toolId: "bossBar", moduleId: "bossbar", title: "Boss Bar", icon: "fas fa-dragon" },
];

// toolId → { title, icon, selector }
const _detectedDOMTools = {};

function _getAbsorbedDOM() {
  return _getAbsorbed().filter(s => s.startsWith("dom:")).map(s => s.slice(4));
}

// Pre-seed known entries and auto-add to absorbed if not yet configured
function _initKnownDOMTools() {
  const absorbed = _getAbsorbed();
  let changed = false;
  for (const k of _DOM_KNOWN) {
    if (!game.modules.get(k.moduleId)?.active) continue;
    _detectedDOMTools[k.toolId] ??= {
      title: k.title, icon: k.icon, selector: `[data-tool="${k.toolId}"]`,
    };
    // Auto-add on first run (user can uncheck later in dialog)
    if (!absorbed.includes(`dom:${k.toolId}`) && !absorbed.includes(`dom:${k.toolId}__removed`)) {
      absorbed.push(`dom:${k.toolId}`);
      changed = true;
    }
  }
  if (changed) game.settings.set("vtools", "absorbedControls", JSON.stringify(absorbed));
}

function _scanDOMTools() {
  // Exclude only native core tool IDs (from CORE controls), not module tools added to tokens etc.
  const coreToolIds = new Set();
  for (const [ctrlName, ctrl] of Object.entries(ui.controls?.controls ?? {})) {
    if (!_isCoreControl(ctrl)) continue; // skip non-core controls
    for (const id of Object.keys(ctrl.tools ?? {})) coreToolIds.add(id);
  }
  for (const t of VTools._tools) coreToolIds.add(t.name);
  // Also skip already-detected
  for (const id of Object.keys(_detectedDOMTools)) coreToolIds.add(id);

  for (const btn of document.querySelectorAll("[data-tool]")) {
    const toolId = btn.dataset.tool;
    if (!toolId || coreToolIds.has(toolId)) continue;
    const iEl = btn.querySelector("i");
    _detectedDOMTools[toolId] = {
      title:    btn.getAttribute("aria-label") ?? btn.title ?? toolId,
      icon:     iEl ? [...iEl.classList].join(" ") : "fas fa-puzzle-piece",
      selector: `[data-tool="${toolId}"]`,
    };
  }
}

function _absorbDOMModules() {
  _initKnownDOMTools();
}

Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;

  // Hide dummy
  if (ui.controls?.control?.name === "vtools") {
    document.querySelector('[data-tool="vtools-dummy"]')
      ?.style.setProperty("display", "none", "important");
  }

  // Scan DOM for new injected tools
  const prevCount = Object.keys(_detectedDOMTools).length;
  _scanDOMTools();

  // Hide all absorbed DOM tools
  const absorbedDOM = _getAbsorbedDOM();
  for (const toolId of absorbedDOM) {
    const info = _detectedDOMTools[toolId];
    if (info) document.querySelector(info.selector)
      ?.style.setProperty("display", "none", "important");
  }

  // If newly detected absorbed tools found → re-render so they appear in VTools
  if (Object.keys(_detectedDOMTools).length > prevCount) {
    const hasNewAbsorbed = absorbedDOM.some(id => _detectedDOMTools[id]);
    if (hasNewAbsorbed) ui.controls?.render();
  }
});

// ── Module Absorption ──

// v13 renamed core controls to Group* — keep both v12 and v13 names
const _CORE_CONTROLS = new Set([
  "token", "measure", "tiles", "drawings", "walls",
  "lighting", "sounds", "regions", "notes", "vtools",
  "tokens", "measurements", "templates",
  "GroupToken", "GroupMeasure", "GroupTile", "GroupDrawing",
  "GroupWall", "GroupLight", "GroupSound", "GroupRegion", "GroupNote",
]);

function _isCoreControl(control) {
  if (!control?.name) return true;
  if (_CORE_CONTROLS.has(control.name)) return true;
  // Unlocalized Foundry title key = built-in control
  if (typeof control.title === "string" && control.title.startsWith("CONTROLS.")) return true;
  return false;
}

// In v13 ALL controls have control.layer set — check if it's a real canvas layer/group
function _isCanvasLayer(control) {
  if (!control.layer) return false;
  const layers = CONFIG.Canvas?.layers ?? {};
  const groups = CONFIG.Canvas?.groups ?? {};
  return (control.layer in layers) || (control.layer in groups);
}

// name → { title, icon, hasLayer }
const _detectedControls = {};

function _getAbsorbed() {
  try { return JSON.parse(game.settings.get("vtools", "absorbedControls")); }
  catch { return []; }
}

function _scanFromUI() {
  const raw = ui.controls?.controls ?? {};
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  for (const control of arr) {
    if (_isCoreControl(control)) continue;
    _detectedControls[control.name] ??= {
      title:    control.title ?? control.name,
      icon:     control.icon,
      hasLayer: _isCanvasLayer(control),
    };
  }
}

function _openAbsorbMenu() {
  _scanFromUI();
  _scanDOMTools();

  const ctrlEntries  = Object.entries(_detectedControls)
    .map(([id, info]) => ({ id, ...info, isDom: false }));
  const domEntries   = Object.entries(_detectedDOMTools)
    .map(([toolId, info]) => ({ id: `dom:${toolId}`, ...info, hasLayer: false, isDom: true }));
  const allEntries   = [...ctrlEntries, ...domEntries];

  if (!allEntries.length) {
    ui.notifications.warn("VTools: No module controls detected — activate a scene first.");
    return;
  }

  const absorbed = _getAbsorbed();

  const row = ({ id, icon, title, hasLayer }) => `
    <div class="form-group">
      <label><i class="${icon ?? "fas fa-puzzle-piece"}"></i> ${title ?? id}
        ${hasLayer ? " <span style='color:#f90' title='Has canvas layer'>⚠</span>" : ""}
      </label>
      <div class="form-fields">
        <input type="checkbox" name="${id}"
          ${absorbed.includes(id) ? "checked" : ""}
          ${hasLayer ? "disabled" : ""}>
      </div>
    </div>`;

  new Dialog({
    title: "VTools — Module Absorption",
    content: `
      <form style="max-height:420px;overflow-y:auto">
        <p style="font-size:12px;color:#aaa;margin:0 0 8px">
          ⚠ = has canvas layer, cannot be absorbed.
        </p>
        ${ctrlEntries.length  ? `<p style="font-size:11px;color:#777;margin:6px 0 2px">SCENE CONTROLS</p>` : ""}
        ${ctrlEntries.map(row).join("")}
        ${domEntries.length   ? `<p style="font-size:11px;color:#777;margin:10px 0 2px">DOM-INJECTED TOOLS</p>` : ""}
        ${domEntries.map(row).join("")}
      </form>`,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Save",
        callback: async (html) => {
          const root = html instanceof HTMLElement ? html : html[0];
          const newAbsorbed = allEntries
            .filter(e => !e.hasLayer && root.querySelector(`[name="${e.id}"]`)?.checked)
            .map(e => e.id);
          await game.settings.set("vtools", "absorbedControls", JSON.stringify(newAbsorbed));
          ui.controls?.render();
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

function _registerAbsorptionHook() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;
    const toAbsorb = _getAbsorbed();

    for (const [name, control] of Object.entries(controls)) {
      if (_isCoreControl(control)) continue;

      // Remove standalone duplicate of anything already in VTools via VTools.register()
      if (VTools._tools.find(t => t.name === name)) {
        delete controls[name];
        continue;
      }

      // Track ALL non-core controls for the menu
      const hasLayer = _isCanvasLayer(control);
      _detectedControls[name] ??= { title: control.title ?? name, icon: control.icon, hasLayer };

      if (!toAbsorb.includes(name) || hasLayer) continue;

      // Inject into VTools — handle both Array and Object tools (v13 compat)
      const vtoolsCtrl = controls["vtools"];
      if (vtoolsCtrl) {
        const toolsArr = Array.isArray(control.tools)
          ? control.tools
          : Object.values(control.tools ?? {});
        const maxOrder = Math.max(0, ...Object.values(vtoolsCtrl.tools).map(t => t.order ?? 0));
        let order = maxOrder + 1;
        for (const tool of toolsArr) {
          const id = `abs-${name}-${tool.name}`;
          vtoolsCtrl.tools[id] = {
            name:     id,
            order:    order++,
            title:    tool.title ?? tool.name,
            icon:     tool.icon ?? "fas fa-puzzle-piece",
            visible:  true,
            button:   true,
            onChange: tool.onChange ?? tool.onClick ?? (() => {}),
          };
        }
      }

      delete controls[name];
    }

  });

  ui.controls?.render();
}
