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

// ── Settings ──
Hooks.once("init", () => {
  game.settings.register("vtools", "gmSeesWhispers", {
    name: "GM sees player whispers",
    hint: "When enabled, the GM can see private whisper messages sent between players.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
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

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
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
    visible:      game.user.isGM,
    onChange:     () => {},
    onToolChange: () => {},
    activeTool:   "vtools-dummy",
    tools,
  };
});

// Ховаємо dummy з DOM після рендеру
Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;
  if (ui.controls?.control?.name !== "vtools") return;
  const toolsEl = document.getElementById("scene-controls-tools");
  const dummy = toolsEl?.querySelector('button[data-tool="vtools-dummy"]');
  if (dummy?.parentElement) dummy.parentElement.style.display = "none";
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
Hooks.once("ready", () => { _hookGmrollBtn(); _hookChatInput(); });
