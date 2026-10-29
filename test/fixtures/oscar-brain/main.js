'use strict';
/*
 * Oscar Brain — 最小 Obsidian 面板插件（桌面端）。
 * 面板承载：投递 / AI 处理 / 提问 / 审阅；内部调本地 Python（knowledge_brain）。
 * 不做语义判断、不写数据库；Vault 仍是唯一真源；密钥只读环境变量（本插件不接触）。
 */
const { Plugin, Notice, ItemView } = require('obsidian');
const { execFile } = require('child_process');
const nodePath = require('path');

const VIEW_TYPE = 'oscar-brain-view';
const PROVIDERS = ['claude', 'codex', 'deepseek'];

/** 运行一个 knowledge_brain 模块（--vault 指向当前 Obsidian vault）。 */
function runMod(plugin, moduleName, args) {
  return new Promise(function (resolve, reject) {
    const vaultPath = plugin.getVaultPath();
    if (!vaultPath) { reject(new Error('无法取得 vault 路径（仅支持桌面端）')); return; }
    const env = Object.assign({}, process.env, { PYTHONPATH: plugin.getBackendPath() });
    if (plugin.settings && plugin.settings.claudeCmd) { env.OB_CLAUDE_CMD = plugin.settings.claudeCmd; }
    if (plugin.settings && plugin.settings.codexCmd) { env.OB_CODEX_CMD = plugin.settings.codexCmd; }
    execFile(
      plugin.settings && plugin.settings.pythonCmd ? plugin.settings.pythonCmd : 'python3',
      ['-m', moduleName, '--vault', vaultPath].concat(args),
      { env: env, cwd: vaultPath, maxBuffer: 32 * 1024 * 1024 },
      function (err, stdout, stderr) {
        if (err) { reject(new Error(String(stderr || err.message || '').trim())); return; }
        resolve(stdout);
      }
    );
  });
}
function runKb(plugin, args) { return runMod(plugin, 'knowledge_brain.cli', args); }

function parseJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/* ------------------------------- 面板 ------------------------------- */
class OscarBrainView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Oscar Brain'; }
  getIcon() { return 'brain'; }

  async onOpen() {
    try { this.render(); }
    catch (e) {
      const el = this.contentEl || this.containerEl.children[1];
      el.empty();
      el.createEl('h3', { text: 'Oscar Brain — 渲染出错' });
      el.createEl('pre', { text: String((e && e.stack) || e) });
    }
  }
  async onClose() { /* 无长期资源 */ }

  render() {
    const el = this.contentEl || this.containerEl.children[1];
    el.empty();
    el.createEl('div', { cls: 'ob-muted', text: 'Oscar Brain v0.3.0 · vault: ' + (this.plugin.getVaultPath() || '(未知)') });
    el.createEl('h3', { text: 'Oscar Brain' });
    el.createEl('div', { cls: 'ob-muted', text: '投递 → AI 处理 → 审阅。未核验内容不得当事实。' });

    /* ① 投递 + AI 处理 */
    const c = el.createDiv({ cls: 'ob-sec' });
    c.createEl('h4', { text: '① 投递 / AI 处理' });
    const ta = c.createEl('textarea', { cls: 'ob-textarea' });
    ta.placeholder = '每行一条碎片（空行忽略）';
    const ctl = c.createDiv();
    const dd = ctl.createEl('select');
    ['chat', 'meeting', 'web', 'email', 'wechat', 'qq', 'manual', 'reading'].forEach(function (t) {
      dd.createEl('option', { text: t, value: t });
    });
    const pv = ctl.createEl('select');
    PROVIDERS.forEach(function (t) { pv.createEl('option', { text: t, value: t }); });
    const capBtn = ctl.createEl('button', { text: '投递', cls: 'mod-cta' });
    const aiBtn = ctl.createEl('button', { text: 'AI 处理', cls: 'mod-cta' });
    aiBtn.disabled = true;
    const capOut = c.createDiv({ cls: 'ob-muted' });
    const self = this;

    capBtn.onclick = async function () {
      const frags = (ta.value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!frags.length) { new Notice('材料为空'); return; }
      const args = ['capture', '--source-type', dd.value];
      frags.forEach(function (f) { args.push('--text', f); });
      capBtn.disabled = true;
      try {
        const out = parseJson(await runKb(self.plugin, args));
        self.lastSid = out && out.submission_id;
        aiBtn.disabled = !self.lastSid;
        capOut.setText(self.lastSid ? ('已投递：' + self.lastSid + (out.created ? '（新增）' : '（已存在）') + '；可点「AI 处理」') : '投递失败');
        ta.value = '';
      } catch (e) { capOut.setText('失败：' + e.message); }
      capBtn.disabled = false;
    };

    aiBtn.onclick = async function () {
      if (!self.lastSid) { new Notice('先投递材料'); return; }
      aiBtn.disabled = true;
      capOut.setText('AI 处理中…（' + pv.value + '，可能十几秒）');
      try {
        const out = parseJson(await runMod(self.plugin, 'knowledge_brain.ai.suggest', ['--submission-id', self.lastSid, '--provider', pv.value]));
        const n = out && out.patches_proposed ? out.patches_proposed.length : 0;
        capOut.setText('处理完成：账本 ' + (out && out.ledger_status) + '；生成 ' + n + ' 条待审阅补丁。');
        if (self.reviewListEl) { await self.refreshReview(self.reviewListEl); }
      } catch (e) { capOut.setText('AI 处理失败：' + e.message); }
      aiBtn.disabled = false;
    };

    /* ② 提问 */
    const a = el.createDiv({ cls: 'ob-sec' });
    a.createEl('h4', { text: '② 提问（检索材料）' });
    const qi = a.createEl('input', { cls: 'ob-input', type: 'text' });
    qi.placeholder = '你的问题（关键词式短句更稳）';
    const askBtn = a.createEl('button', { text: '检索', cls: 'mod-cta' });
    const askOut = a.createDiv();
    askBtn.onclick = async function () {
      if (!qi.value.trim()) { new Notice('请输入问题'); return; }
      askBtn.disabled = true; askOut.empty();
      try { self.renderAsk(askOut, parseJson(await runKb(self.plugin, ['context', '--question', qi.value.trim()]))); }
      catch (e) { askOut.setText('失败：' + e.message); }
      askBtn.disabled = false;
    };

    /* ③ 审阅 */
    const r = el.createDiv({ cls: 'ob-sec' });
    const rh = r.createEl('h4', { text: '③ 审阅待确认补丁' });
    const rBtn = rh.createEl('button', { text: '刷新' });
    r.createEl('div', { cls: 'ob-muted', text: '只有「接受」才会落盘；拒绝/暂缓不动原文。' });
    const rList = r.createDiv();
    this.reviewListEl = rList;
    rBtn.onclick = function () { self.refreshReview(rList); };
    this.refreshReview(rList);
  }

  renderAsk(outEl, ctx) {
    outEl.empty();
    if (!ctx) { outEl.setText('无结果'); return; }
    const std = ctx.standard || {};
    outEl.createEl('div', { text: '标准：' + (std.current || '—') + ' · 独立来源数：' + (ctx.independent_evidence_count != null ? ctx.independent_evidence_count : '—') });
    (ctx.evidence || []).forEach(function (h) {
      const d = outEl.createDiv({ cls: 'ob-hit' });
      d.createEl('div', { text: h.kind + ' · ' + h.status + (h.verified ? ' · 已核验' : (h.unverified_note ? ' · ' + h.unverified_note : '')) });
      d.createEl('div', { cls: 'ob-muted', text: h.path + (h.block_id ? ('#^' + h.block_id) : '') });
      d.createEl('div', { text: h.snippet || '' });
    });
    if (ctx.recall_limits) { outEl.createEl('div', { cls: 'ob-muted', text: '召回限制：' + ctx.recall_limits }); }
  }

  async refreshReview(listEl) {
    listEl.empty();
    let items = [];
    try { items = parseJson(await runKb(this.plugin, ['patch-list', '--status', 'proposed'])) || []; }
    catch (e) { listEl.setText('读取失败：' + e.message); return; }
    if (!items.length) { listEl.setText('没有待确认补丁。'); return; }
    const self = this;
    items.forEach(function (p) {
      const card = listEl.createDiv({ cls: 'ob-card' });
      card.createEl('div', { text: p.action + ' → ' + p.target });
      card.createEl('div', { cls: 'ob-muted', text: '理由：' + p.reason });
      card.createEl('div', { cls: 'ob-muted', text: '建议：' + String(p.suggested || '').slice(0, 300) });
      const bar = card.createDiv();
      [['接受', 'patch-confirm'], ['拒绝', 'patch-reject'], ['暂缓', 'patch-defer']].forEach(function (pair) {
        const btn = bar.createEl('button', { text: pair[0] });
        btn.onclick = async function () {
          btn.disabled = true;
          try { await runKb(self.plugin, [pair[1], '--id', p.patch_id, '--by', 'user']); new Notice(pair[0] + '：' + p.patch_id); await self.refreshReview(listEl); }
          catch (e) { new Notice('失败：' + e.message); btn.disabled = false; }
        };
      });
    });
  }
}

/* ------------------------------ 插件本体 ------------------------------ */
module.exports = class OscarBrainPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ backendPath: '', pythonCmd: '', claudeCmd: '', codexCmd: '' }, await this.loadData());
    this.registerView(VIEW_TYPE, function (leaf) { return new OscarBrainView(leaf, this); }.bind(this));
    this.addRibbonIcon('brain', 'Oscar Brain：打开面板', function () { this.activateView(); }.bind(this));
    this.addCommand({ id: 'ob-open', name: 'Oscar Brain：打开面板', callback: function () { this.activateView(); }.bind(this) });
    this.addCommand({ id: 'ob-capture', name: 'Oscar Brain：投递材料', callback: function () { this.activateView(); }.bind(this) });
    this.addCommand({ id: 'ob-ask', name: 'Oscar Brain：提问', callback: function () { this.activateView(); }.bind(this) });
    this.addCommand({ id: 'ob-review', name: 'Oscar Brain：审阅补丁', callback: function () { this.activateView(); }.bind(this) });
    new Notice('Oscar Brain 已加载');
  }

  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  async activateView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false);
      if (!leaf) { new Notice('无法创建面板'); return; }
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
    try { if (leaf.view && typeof leaf.view.render === 'function') { leaf.view.render(); } } catch (e) { /* ignore */ }
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    return adapter && adapter.basePath ? adapter.basePath : '';
  }

  /** 后端代码路径：优先 data.json 的 backendPath（库外独立维护），否则退回 vault/Scripts。 */
  getBackendPath() {
    const p = this.settings && this.settings.backendPath;
    return p ? p : nodePath.join(this.getVaultPath(), 'Scripts');
  }
};
