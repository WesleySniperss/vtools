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

// ── Вогонь vtools.ready під час setup, ДО першого рендеру controls ──
// Це гарантує що _tools буде заповнений коли getSceneControlButtons спрацює
Hooks.once("setup", () => {
  Hooks.callAll("vtools.ready");
  VTools._ready = true;
});

Hooks.on("getSceneControlButtons", (controls) => {
  const toolEntries = VTools._tools.length > 0 ? VTools._tools : [];

  const tools = {};
  let order = 1;
  for (const t of toolEntries) {
    tools[t.name] = {
      name:     t.name,
      order:    order++,
      title:    t.title ?? t.name,
      icon:     t.icon,
      visible:  true,
      button:   true,
      onChange: () => t.onClick(),
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
    visible:      true,
    onChange:     () => {},
    onToolChange: () => {},
    activeTool:   "vtools-dummy",
    tools,
  };
});

// Ховаємо dummy з DOM після рендеру
Hooks.on("renderSceneControls", () => {
  if (ui.controls?.control?.name !== "vtools") return;
  const toolsEl = document.getElementById("scene-controls-tools");
  const dummy = toolsEl?.querySelector('button[data-tool="vtools-dummy"]');
  if (dummy?.parentElement) dummy.parentElement.style.display = "none";
});
