'use strict';

const { Modal } = require('obsidian');
const { validatePath, pickDirectory, pickFile } = require('./pickers');

/** 路径输入框：支持原生选择器与手动输入。 */
class PathModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options || {};
    this.settled = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.options.title || '选择路径' });
    if (this.options.description) {
      contentEl.createEl('p', { cls: 'vm-modal-desc', text: this.options.description });
    }

    const input = contentEl.createEl('input', {
      cls: 'vm-input',
      attr: { type: 'text', 'aria-label': this.options.label || '路径' },
    });
    input.value = this.options.value || '';
    const hint = contentEl.createEl('div', { cls: 'vm-modal-hint', attr: { role: 'status' } });
    hint.setText(this.options.hint || '');

    const kind = this.options.kind === 'file' ? 'file' : 'directory';
    const bar = contentEl.createDiv({ cls: 'vm-modal-actions' });
    const cancel = bar.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.finish(null));

    const browse = bar.createEl('button', { text: '浏览…', attr: { type: 'button' } });
    browse.addEventListener('click', () => {
      const picked =
        kind === 'file' ? pickFile(this.options.filters, input.value || undefined) : pickDirectory(input.value || undefined);
      if (picked === undefined) {
        hint.setText('当前环境不支持系统选择器，请手动填写绝对路径。');
        return;
      }
      if (picked) input.value = picked;
    });

    const confirm = bar.createEl('button', {
      cls: 'mod-cta',
      text: this.options.confirmText || '确定',
      attr: { type: 'button' },
    });
    confirm.addEventListener('click', () => {
      const check = validatePath(input.value, {
        kind,
        mustExist: this.options.mustExist !== false,
      });
      if (!check.ok) {
        hint.setText(check.message);
        input.focus();
        return;
      }
      this.finish(check.path);
    });

    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') confirm.click();
    });
    if (!this.options.value) input.focus();
  }

  finish(value) {
    if (this.settled) return;
    this.settled = true;
    this.close();
    if (this.options.onDone) this.options.onDone(value);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      if (this.options.onDone) this.options.onDone(null);
    }
  }
}

/** 多字段表单（打包、套装导出等）。 */
class FormModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options || {};
    this.fields = this.options.fields || [];
    this.settled = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.options.title || '填写信息' });
    if (this.options.description) {
      contentEl.createEl('p', { cls: 'vm-modal-desc', text: this.options.description });
    }

    this.inputs = {};
    this.hints = {};

    for (const field of this.fields) {
      const wrap = contentEl.createDiv({ cls: 'vm-field' });
      const id = `vm-field-${field.key}`;
      wrap.createEl('label', { cls: 'vm-field-label', text: field.label, attr: { for: id } });
      let input;
      if (field.kind === 'textarea') {
        input = wrap.createEl('textarea', {
          cls: 'vm-input vm-textarea',
          attr: { id, rows: String(field.rows || 10), 'aria-label': field.label },
        });
      } else {
        input = wrap.createEl('input', {
          cls: 'vm-input',
          attr: { type: 'text', id, 'aria-label': field.label, placeholder: field.placeholder || '' },
        });
      }
      input.value = field.value || '';
      this.inputs[field.key] = input;
      if (field.description) wrap.createEl('div', { cls: 'vm-field-desc', text: field.description });

      const hint = wrap.createEl('div', { cls: 'vm-field-hint', attr: { role: 'status' } });
      this.hints[field.key] = hint;

      if (field.kind === 'directory' || field.kind === 'file') {
        const browse = wrap.createEl('button', { cls: 'vm-btn', text: '浏览…', attr: { type: 'button' } });
        browse.addEventListener('click', () => {
          const picked =
            field.kind === 'file' ? pickFile(field.filters, input.value || undefined) : pickDirectory(input.value || undefined);
          if (picked === undefined) {
            hint.setText('当前环境不支持系统选择器，请手动填写绝对路径。');
            return;
          }
          if (picked) input.value = picked;
        });
      }
    }

    const bar = contentEl.createDiv({ cls: 'vm-modal-actions' });
    const cancel = bar.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.finish(null));
    const submit = bar.createEl('button', {
      cls: 'mod-cta',
      text: this.options.submitText || '确定',
      attr: { type: 'button' },
    });
    submit.addEventListener('click', () => this.submit());
    const first = this.fields[0];
    if (first && this.inputs[first.key]) this.inputs[first.key].focus();
  }

  submit() {
    const values = {};
    for (const field of this.fields) {
      const input = this.inputs[field.key];
      const hint = this.hints[field.key];
      const raw = String(input.value || '').trim();
      if (field.required !== false && raw === '') {
        hint.setText(`${field.label}不能为空`);
        input.focus();
        return;
      }
      if (raw !== '' && (field.kind === 'directory' || field.kind === 'file')) {
        const check = validatePath(raw, { kind: field.kind, mustExist: field.mustExist !== false });
        if (!check.ok) {
          hint.setText(check.message);
          input.focus();
          return;
        }
        values[field.key] = check.path;
        continue;
      }
      values[field.key] = raw;
    }
    this.finish(values);
  }

  finish(value) {
    if (this.settled) return;
    this.settled = true;
    this.close();
    if (this.options.onDone) this.options.onDone(value);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      if (this.options.onDone) this.options.onDone(null);
    }
  }
}

/** 确认对话框：结构化摘要，danger 时按钮标红。 */
class ConfirmModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options || {};
    this.settled = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.options.title || '确认操作' });
    const body = contentEl.createDiv({ cls: 'vm-modal-body' });
    for (const line of this.options.lines || []) {
      const rowEl = body.createDiv({ cls: `vm-modal-line${line.warn ? ' is-warn' : ''}` });
      rowEl.createEl('span', { cls: 'vm-modal-line-label', text: line.label });
      rowEl.createEl('span', { cls: 'vm-modal-line-value', text: line.value });
    }
    if (this.options.blocked) {
      const warn = body.createDiv({ cls: 'vm-message vm-message-error' });
      warn.setText(this.options.blockedText || '存在阻断问题，无法继续。');
    }

    const bar = contentEl.createDiv({ cls: 'vm-modal-actions' });
    const cancel = bar.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.finish(false));
    if (!this.options.blocked) {
      const confirm = bar.createEl('button', {
        cls: this.options.danger ? 'mod-warning' : 'mod-cta',
        text: this.options.confirmText || '确认',
        attr: { type: 'button' },
      });
      confirm.addEventListener('click', () => this.finish(true));
      confirm.focus();
    } else {
      cancel.focus();
    }
  }

  finish(value) {
    if (this.settled) return;
    this.settled = true;
    this.close();
    if (this.options.onDone) this.options.onDone(value);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      if (this.options.onDone) this.options.onDone(false);
    }
  }
}

function askPath(app, options) {
  return new Promise((resolve) => {
    new PathModal(app, { ...options, onDone: resolve }).open();
  });
}

function askForm(app, options) {
  return new Promise((resolve) => {
    new FormModal(app, { ...options, onDone: resolve }).open();
  });
}

function confirmAction(app, options) {
  return new Promise((resolve) => {
    new ConfirmModal(app, { ...options, onDone: resolve }).open();
  });
}

module.exports = { PathModal, FormModal, ConfirmModal, askPath, askForm, confirmAction };
