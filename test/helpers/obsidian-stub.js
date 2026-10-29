'use strict';

/**
 * 最小 Obsidian 运行时替身：仅用于在 Node 里真实执行插件/视图代码。
 * 这不是像素级 UI 测试，也不能替代人工截图；它验证的是渲染不崩溃、结构与可访问性属性。
 */
const path = require('path');
const Module = require('module');

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  get className() {
    return Array.from(this._classes).join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  createEl(tag, opts) {
    const options = opts || {};
    const node = new El(tag);
    if (options.cls) node.addClass(Array.isArray(options.cls) ? options.cls.join(' ') : options.cls);
    if (options.text !== undefined) node.setText(options.text);
    if (options.attr) {
      for (const [key, value] of Object.entries(options.attr)) node.setAttribute(key, value);
    }
    this.appendChild(node);
    return node;
  }

  createDiv(opts) {
    return this.createEl('div', opts);
  }

  createSpan(opts) {
    return this.createEl('span', opts);
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addClass(...names) {
    names.forEach((name) => String(name).split(/\s+/).filter(Boolean).forEach((item) => this._classes.add(item)));
  }

  removeClass(...names) {
    names.forEach((name) => this._classes.delete(name));
  }

  hasClass(name) {
    return this._classes.has(name);
  }

  setText(text) {
    this.textContent = String(text === undefined || text === null ? '' : text);
    this.children = [];
    return this;
  }

  empty() {
    this.children = [];
    this.textContent = '';
    return this;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.addClass(value);
    if (name === 'type') this.type = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'aria-label') this.ariaLabel = String(value);
    return this;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  async dispatch(type, event) {
    const list = this.listeners[type] || [];
    for (const handler of list) await handler(event || {});
  }

  async click() {
    if (this.disabled) return;
    await this.dispatch('click', { preventDefault() {}, target: this });
  }

  focus() {
    El.activeElement = this;
  }

  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
    }
  }

  querySelector() {
    return null;
  }

  /** 递归收集所有后代（测试辅助）。 */
  descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

El.activeElement = null;

class Events {}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest || { id: 'vault-meta', version: '0.1.0' };
    this._views = new Map();
    this._commands = [];
    this._ribbons = [];
    this._settingsTabs = [];
    this._data = {};
  }

  registerView(type, factory) {
    this._views.set(type, factory);
  }

  addRibbonIcon(icon, title, callback) {
    this._ribbons.push({ icon, title, callback });
  }

  addCommand(command) {
    this._commands.push(command);
  }

  addSettingTab(tab) {
    this._settingsTabs.push(tab);
  }

  registerEvent() {}

  registerInterval() {}

  async loadData() {
    return this._data;
  }

  async saveData(data) {
    this._data = data;
  }
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf || {};
    this.containerEl = new El('div');
    this.contentEl = new El('div');
    this.containerEl.appendChild(this.contentEl);
    this.app = this.leaf.app || null;
  }
}

class Notice {
  constructor(message) {
    Notice.messages.push(String(message));
  }
}
Notice.messages = [];

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = new El('div');
    this.containerEl = new El('div');
    this.containerEl.appendChild(this.contentEl);
    this.isOpen = false;
  }

  open() {
    this.isOpen = true;
    if (this.onOpen) this.onOpen();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.onClose) this.onClose();
  }
}

class TextComponent {
  constructor(input) {
    this.input = input;
  }

  setPlaceholder(value) {
    this.input.setAttribute('placeholder', value);
    return this;
  }

  setValue(value) {
    this.input.value = value === undefined || value === null ? '' : String(value);
    return this;
  }

  onChange(handler) {
    this.input.addEventListener('change', () => handler(this.input.value));
    return this;
  }
}

class ButtonComponent {
  constructor(el) {
    this.el = el;
  }

  setButtonText(text) {
    this.el.setText(text);
    return this;
  }

  onClick(handler) {
    this.el.addEventListener('click', handler);
    return this;
  }
}

class DropdownComponent {
  constructor(el) {
    this.el = el;
    this.value = '';
    this.options = [];
  }

  addOption(value, label) {
    this.options.push([value, label]);
    return this;
  }

  setValue(value) {
    this.value = String(value);
    this.el.setAttribute('data-value', this.value);
    return this;
  }

  onChange(handler) {
    this.el.addEventListener('change', () => handler(this.value));
    return this;
  }
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.settingEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }

  setName(name) {
    this.nameEl.setText(name);
    return this;
  }

  setDesc(desc) {
    this.descEl.setText(desc);
    return this;
  }

  addText(callback) {
    callback(new TextComponent(this.controlEl.createEl('input', { attr: { type: 'text' } })));
    return this;
  }

  addButton(callback) {
    callback(new ButtonComponent(this.controlEl.createEl('button', { attr: { type: 'button' } })));
    return this;
  }

  addDropdown(callback) {
    callback(new DropdownComponent(this.controlEl.createEl('select')));
    return this;
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new El('div');
  }
}

const stub = {
  Plugin,
  ItemView,
  Modal,
  Notice,
  Setting,
  PluginSettingTab,
  Events,
  setIcon(el, icon) {
    el.setAttribute('data-icon', icon);
  },
  normalizePath(value) {
    return String(value);
  },
  requestUrl() {
    throw new Error('requestUrl 不可用（测试环境）');
  },
};

/**
 * 在受控环境下加载一个依赖 obsidian 的 CJS 模块。
 * @param {string} modulePath
 */
function loadWithStub(modulePath) {
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'obsidian') return stub;
    if (request === 'electron' || request === '@electron/remote') {
      throw new Error(`MODULE_NOT_FOUND:${request}`);
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(resolved);
  } finally {
    Module._load = original;
  }
}

function makeApp({ vaultRoot }) {
  const calls = [];
  const workspace = {
    leaves: [],
    calls,
    getLeavesOfType(type) {
      return this.leaves.filter((leaf) => leaf.view && leaf.view.getViewType() === type);
    },
    createLeaf() {
      const leaf = {
        state: null,
        view: { getViewType: () => 'empty' },
        async setViewState(state) {
          this.state = state;
          this.view = { getViewType: () => state.type, setTab: async () => {} };
        },
      };
      this.leaves.push(leaf);
      return leaf;
    },
    getLeaf(mode) {
      calls.push(['getLeaf', mode]);
      return this.createLeaf();
    },
    getRightLeaf() {
      calls.push(['getRightLeaf']);
      return this.createLeaf();
    },
    revealLeaf(leaf) {
      calls.push(['revealLeaf', leaf]);
    },
    detachLeavesOfType() {},
  };
  return {
    vault: { adapter: { basePath: vaultRoot } },
    workspace,
  };
}

function findByClass(rootEl, className) {
  return rootEl.descendants().filter((node) => node.hasClass(className));
}

function textOf(rootEl) {
  const parts = [];
  const walk = (node) => {
    if (node.textContent) parts.push(node.textContent);
    node.children.forEach(walk);
  };
  walk(rootEl);
  return parts.join('\n');
}

function findButton(rootEl, label) {
  return rootEl.descendants().find((node) => node.tagName === 'BUTTON' && node.textContent === label) || null;
}

module.exports = {
  El,
  stub,
  loadWithStub,
  makeApp,
  findByClass,
  findButton,
  textOf,
  Notice,
};
