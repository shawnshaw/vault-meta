'use strict';

/** Obsidian DOM 辅助（全部走 createEl/createDiv，保证主题与可访问性样式生效）。 */
function el(parent, tag, opts) {
  const options = opts || {};
  const node = parent.createEl(tag, {
    cls: options.cls || '',
    text: options.text,
    attr: options.attr,
  });
  if (options.title) node.title = options.title;
  return node;
}

function button(parent, label, opts) {
  const options = opts || {};
  const node = parent.createEl('button', {
    cls: ['vm-btn', options.cls || ''].filter(Boolean).join(' '),
    attr: { type: 'button' },
    text: label,
  });
  if (options.title) {
    node.title = options.title;
    node.setAttribute('aria-label', options.title);
  }
  if (options.disabled) node.disabled = true;
  if (options.onClick) node.addEventListener('click', options.onClick);
  return node;
}

function card(parent, label, value) {
  const node = parent.createDiv({ cls: 'vm-card' });
  node.createDiv({ cls: 'vm-card-label', text: label });
  node.createDiv({ cls: 'vm-card-value', text: String(value) });
  return node;
}

function message(parent, kind, text) {
  const node = parent.createDiv({ cls: `vm-message vm-message-${kind}` });
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.setText(text);
  return node;
}

function table(parent, headers) {
  const wrap = parent.createDiv({ cls: 'vm-table-wrap' });
  const tableEl = wrap.createEl('table', { cls: 'vm-table' });
  const head = tableEl.createEl('thead');
  const headRow = head.createEl('tr');
  for (const header of headers) headRow.createEl('th', { text: header, attr: { scope: 'col' } });
  const body = tableEl.createEl('tbody');
  return { wrap, table: tableEl, body };
}

function row(body) {
  return body.createEl('tr');
}

function cell(rowEl, text, opts) {
  const options = opts || {};
  const td = rowEl.createEl('td', { cls: options.cls || '' });
  if (options.text !== undefined) td.setText(options.text);
  else if (text !== undefined && text !== null) td.setText(String(text));
  return td;
}

module.exports = { el, button, card, message, table, row, cell };
