'use strict';

const path = require('path');
const { ItemView } = require('obsidian');
const { describeError } = require('../core/errors');
const { loadRegistry, listRecords } = require('../core/registry');
const {
  loadProjects,
  saveProjects,
  upsertProject,
  removeProject,
  listProjects,
  getProject,
  findBySourcePath,
  createProjectId,
} = require('../core/projects');
const { sourceIdentity, artifactDigest, runtimeSlice } = require('../core/identity');
const { readGitMeta } = require('../core/git-meta');
const {
  inspectProject: inspectProjectState,
  lastCheckFromInspection,
  readSourceVersion,
  recordForProject,
} = require('../core/project-inspect');
const { createBackup, listBackups, verifyBackup, restoreBackup, defaultScope } = require('../core/backup');
const { exportComponent, exportSuite, inspectComponentPackage } = require('../core/packager');
const { preflightInstall, applyInstall, applyUninstall, readInstalledManifest } = require('../core/installer');
const { normalizeSuiteSpec, SUITE_FORMAT } = require('../core/component-spec');
const { formatBytes, nowStamp } = require('../core/fs-utils');
const { askPath, askForm, confirmAction } = require('./modals');
const { validatePath, pickDirectory } = require('./pickers');
const ui = require('./dom');

const VIEW_TYPE = 'vault-meta-view';
const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'projects', label: '项目' },
  { id: 'components', label: '组件' },
  { id: 'restore', label: '恢复' },
];

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function scopeText(scope) {
  const items = ['笔记与附件', '.obsidian 配置'];
  if (scope.git) items.push('.git');
  if (scope.nodeModules) items.push('node_modules');
  if (scope.snapshots) items.push('组件快照');
  if (scope.trash) items.push('.trash');
  return items.join('、');
}

function shortValue(value, len) {
  if (!value) return '—';
  const size = len || 8;
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

const RUNTIME_STATUS_TEXT = {
  'not-installed': '未安装',
  unregistered: '无登记记录',
  ok: '与登记一致',
  'runtime-modified': '运行文件已改动',
};

class VaultMetaView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = 'overview';
    this.busy = false;
    this.status = null;
    this.renderToken = 0;
    this.tabEls = {};
    this.scope = defaultScope();
    this.backupDirDraft = null;
    this.activeProjectId = null;
    this.projectInspections = {};
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Vault 元系统管理';
  }

  getIcon() {
    return 'archive';
  }

  async onOpen() {
    await this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  vaultRoot() {
    return this.plugin.getVaultRoot();
  }

  defaultBackupDir() {
    const root = this.vaultRoot();
    return root ? path.join(path.dirname(root), 'vault-meta-backups') : '';
  }

  defaultExportDir() {
    const root = this.vaultRoot();
    return root ? path.join(path.dirname(root), 'vault-meta-exports') : '';
  }

  setTab(tab) {
    if (!TABS.some((item) => item.id === tab)) return Promise.resolve();
    this.activeTab = tab;
    return this.render();
  }

  /** 统一动作包装：加载态、成功/失败反馈、aria-busy。 */
  async run(label, task) {
    if (this.busy) return null;
    this.busy = true;
    this.status = { kind: 'pending', text: `${label}…` };
    await this.render();

    let result = null;
    try {
      result = await task();
      if (result && result.statusText) this.status = { kind: 'ok', text: result.statusText };
      else this.status = { kind: 'ok', text: '操作完成' };
    } catch (err) {
      const detail = describeError(err);
      this.status = {
        kind: 'error',
        text: `${detail.message}${detail.hint ? `（${detail.hint}）` : ''}`,
        details: detail.details,
        code: detail.code,
      };
    } finally {
      this.busy = false;
    }
    await this.render();
    return result;
  }

  async render() {
    const token = (this.renderToken += 1);
    const root = this.contentEl;
    root.empty();
    root.addClass('vault-meta-view');

    const header = root.createDiv({ cls: 'vm-header' });
    header.createEl('h2', { cls: 'vm-title', text: 'Vault 元系统管理' });
    header.createEl('div', {
      cls: 'vm-subtitle',
      text: '整库备份与恢复 · 组件登记与打包迁移 · 本版本只管理当前 vault',
    });

    this.renderTabs(root);

    const body = root.createDiv({
      cls: 'vm-body',
      attr: {
        role: 'tabpanel',
        id: `vm-panel-${this.activeTab}`,
        'aria-labelledby': `vm-tab-${this.activeTab}`,
        'aria-busy': this.busy ? 'true' : 'false',
      },
    });

    try {
      if (this.activeTab === 'overview') await this.renderOverview(body);
      else if (this.activeTab === 'projects') await this.renderProjects(body);
      else if (this.activeTab === 'components') await this.renderComponents(body);
      else await this.renderRestore(body);
    } catch (err) {
      if (token !== this.renderToken) return;
      this.renderError(body, err);
    }

    if (token !== this.renderToken) return;
    this.renderStatus(root);
  }

  renderTabs(root) {
    const tablist = root.createDiv({
      cls: 'vm-tabs',
      attr: { role: 'tablist', 'aria-label': '管理器分区' },
    });
    this.tabEls = {};
    TABS.forEach((tab, index) => {
      const active = this.activeTab === tab.id;
      const btn = tablist.createEl('button', {
        cls: `vm-tab${active ? ' is-active' : ''}`,
        attr: {
          role: 'tab',
          id: `vm-tab-${tab.id}`,
          'aria-selected': active ? 'true' : 'false',
          'aria-controls': `vm-panel-${tab.id}`,
          tabindex: active ? '0' : '-1',
          type: 'button',
        },
        text: tab.label,
      });
      btn.addEventListener('click', () => {
        this.setTab(tab.id);
      });
      btn.addEventListener('keydown', (evt) => this.onTabKey(evt, index));
      this.tabEls[tab.id] = btn;
    });
  }

  onTabKey(evt, index) {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(evt.key)) return;
    evt.preventDefault();
    let next = index;
    if (evt.key === 'ArrowRight') next = (index + 1) % TABS.length;
    if (evt.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    if (evt.key === 'Home') next = 0;
    if (evt.key === 'End') next = TABS.length - 1;
    const tab = TABS[next];
    this.activeTab = tab.id;
    Promise.resolve(this.render()).then(() => {
      const btn = this.tabEls[tab.id];
      if (btn && typeof btn.focus === 'function') btn.focus();
    });
  }

  renderStatus(root) {
    if (!this.status) return;
    const kind = this.status.kind;
    const bar = root.createDiv({
      cls: `vm-status vm-status-${kind}`,
      attr: { role: kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    bar.setText(this.status.text);
    if (this.status.code) bar.createEl('span', { cls: 'vm-status-code', text: ` ${this.status.code}` });
    if (this.status.details && Object.keys(this.status.details).length > 0) {
      const details = bar.createEl('details');
      details.createEl('summary', { text: '技术细节' });
      details.createEl('pre', { text: JSON.stringify(this.status.details, null, 2) });
    }
  }

  renderError(container, err) {
    const detail = describeError(err);
    const box = container.createDiv({ cls: 'vm-message vm-message-error', attr: { role: 'alert' } });
    box.createEl('strong', { text: '操作失败' });
    box.createEl('div', { text: detail.message });
    if (detail.hint) box.createEl('div', { cls: 'vm-hint', text: detail.hint });
  }

  renderEmpty(container, text, hint) {
    const box = container.createDiv({ cls: 'vm-empty' });
    box.createEl('div', { cls: 'vm-empty-title', text });
    if (hint) box.createEl('div', { cls: 'vm-hint', text: hint });
  }

  async renderOverview(body) {
    const vaultRoot = this.vaultRoot();
    if (!vaultRoot) {
      this.renderEmpty(body, '无法取得 vault 路径', 'Vault 元系统管理仅支持 Obsidian 桌面端。');
      return;
    }
    if (this.busy) {
      ui.message(body, 'loading', '正在读取 vault 信息…');
      return;
    }

    const { registry } = loadRegistry(vaultRoot);
    const records = listRecords(registry);
    const backupDir = this.plugin.settings.backupDir;
    let projectCount = 0;
    try {
      projectCount = loadProjects(vaultRoot).store.projects.length;
    } catch (err) {
      projectCount = 0;
    }

    const grid = body.createDiv({ cls: 'vm-grid' });
    ui.card(grid, 'Vault 路径', vaultRoot);
    ui.card(grid, '已接入项目', `${projectCount} 个`);
    ui.card(grid, '已登记组件', `${records.length} 个`);
    ui.card(grid, '备份目录', backupDir || '未设置');
    ui.card(grid, '最近备份', this.plugin.settings.lastBackupAt ? formatTime(this.plugin.settings.lastBackupAt) : '尚无记录');

    const actions = body.createDiv({ cls: 'vm-toolbar' });
    ui.button(actions, '查看项目', { onClick: () => this.setTab('projects') });
    ui.button(actions, '去创建备份', { cls: 'mod-cta', onClick: () => this.setTab('restore') });
    ui.button(actions, '查看组件', { onClick: () => this.setTab('components') });

    const note = body.createDiv({ cls: 'vm-note' });
    note.createEl('strong', { text: '边界说明' });
    note.createEl('p', {
      text: '云同步（iCloud / OneDrive）只同步“当前状态”，误删会被同步到所有设备，不能当历史备份。本管理器在所选目录生成带时间、范围与校验值的独立归档。',
    });
    note.createEl('p', {
      text: '本版本不运行任何自动定期任务：只有点击“创建整库备份”时才会执行，不会声称后台任务正在运行。',
    });

    if (records.length > 0) {
      body.createEl('h3', { cls: 'vm-section-title', text: '组件概览' });
      const list = body.createDiv({ cls: 'vm-chip-list' });
      for (const record of records) {
        const chip = list.createDiv({ cls: 'vm-chip' });
        chip.createEl('span', { cls: 'vm-chip-name', text: record.name || record.id });
        chip.createEl('span', { cls: 'vm-chip-version', text: record.version });
      }
    }
  }

  locationCard(parent, title, lines) {
    const cardEl = parent.createDiv({ cls: 'vm-card vm-location-card' });
    cardEl.createDiv({ cls: 'vm-card-label', text: title });
    for (const line of lines) {
      const rowEl = cardEl.createDiv({ cls: 'vm-location-line' });
      rowEl.createEl('span', { cls: 'vm-location-key', text: line.label });
      rowEl.createEl('span', { cls: 'vm-location-value', text: line.value });
    }
  }

  registryOrNull() {
    try {
      return loadRegistry(this.vaultRoot()).registry;
    } catch (err) {
      return null;
    }
  }

  async runtimeFor(project, registry) {
    try {
      return await runtimeSlice(this.vaultRoot(), recordForProject(registry, project), {
        installLocation: project.installLocation,
      });
    } catch (err) {
      return { status: 'error', location: project.installLocation, version: '', files: [], modified: [], missing: [] };
    }
  }

  async runInspection(id, withNetwork) {
    const vaultRoot = this.vaultRoot();
    const { store } = loadProjects(vaultRoot);
    const project = getProject(store, id);
    if (!project) return null;
    const inspection = await inspectProjectState({
      vaultRoot,
      registry: this.registryOrNull(),
      project,
      checkRemoteNow: Boolean(withNetwork) && Boolean(project.remote.url),
    });
    this.projectInspections[id] = inspection;
    if (withNetwork) {
      const lastCheck = lastCheckFromInspection(inspection);
      if (lastCheck) {
        upsertProject(store, { ...project, lastCheck });
        saveProjects(vaultRoot, store);
      }
    }
    return inspection;
  }

  async openProject(id) {
    this.activeProjectId = id;
    await this.run('读取项目状态', async () => {
      const inspection = await this.runInspection(id, false);
      if (!inspection) throw new Error('项目记录不存在，可能已被移除');
      return { statusText: `状态：${inspection.comparison.label}` };
    });
  }

  async renderProjects(body) {
    const vaultRoot = this.vaultRoot();
    if (!vaultRoot) {
      this.renderEmpty(body, '无法取得 vault 路径', '仅支持 Obsidian 桌面端。');
      return;
    }

    const { store } = loadProjects(vaultRoot);
    if (this.activeProjectId) {
      const project = getProject(store, this.activeProjectId);
      if (project) {
        await this.renderProjectDetail(body, project);
        return;
      }
      this.activeProjectId = null;
    }

    const toolbar = body.createDiv({ cls: 'vm-toolbar' });
    ui.button(toolbar, '接入项目…', { cls: 'mod-cta', disabled: this.busy, onClick: () => this.registerProjectFlow() });
    ui.button(toolbar, '全部检查', { disabled: this.busy, onClick: () => this.checkAllProjectsFlow() });
    ui.button(toolbar, '刷新', {
      disabled: this.busy,
      onClick: () => this.run('刷新项目列表', async () => ({ statusText: '项目列表已刷新' })),
    });

    if (this.busy) {
      ui.message(body, 'loading', '正在处理，请稍候…');
      return;
    }

    const projects = listProjects(store);
    const addReadOnlyHint = () => {
      body
        .createDiv({ cls: 'vm-hint' })
        .setText('所有检查均为只读：不会修改源码目录，也不会修改 .obsidian/plugins 下的运行文件。');
    };
    if (projects.length === 0) {
      this.renderEmpty(
        body,
        '尚未接入任何项目',
        '接入本地源码目录后，这里会显示本地源码、云端仓库与当前库三个位置，并比较真实版本。',
      );
      addReadOnlyHint();
      return;
    }

    const registry = this.registryOrNull();
    const tableRef = ui.table(body, ['项目', '本地源码', '云端', '当前库', '状态', '最后检查', '操作']);
    for (const project of projects) {
      const runtime = await this.runtimeFor(project, registry);
      const rowEl = ui.row(tableRef.body);

      const nameCell = ui.cell(rowEl, '');
      nameCell.createEl('div', { cls: 'vm-cell-strong', text: project.name });
      nameCell.createEl('div', { cls: 'vm-cell-sub', text: project.id });
      if (project.purpose) nameCell.createEl('div', { cls: 'vm-cell-purpose', text: project.purpose });

      ui.cell(
        rowEl,
        project.baseline && project.baseline.sourceVersion
          ? project.baseline.sourceVersion
          : project.sourcePath
            ? '未记录基线'
            : '未关联',
      );
      const lastCheck = project.lastCheck;
      const cloudText = !project.remote.url
        ? '未关联'
        : lastCheck && lastCheck.ok
          ? (lastCheck.release ? `发布 ${lastCheck.release.version}` : `开发线 ${lastCheck.developmentVersion || '—'}`)
          : lastCheck
            ? '检查失败'
            : '未检查';
      ui.cell(rowEl, cloudText);

      const runtimeCell = ui.cell(rowEl, runtime.version || '—');
      if (runtime.status === 'runtime-modified') runtimeCell.createEl('div', { cls: 'vm-cell-warn', text: '文件已改动' });
      if (runtime.status === 'unregistered') runtimeCell.createEl('div', { cls: 'vm-cell-warn', text: '无登记记录' });

      const cached = this.projectInspections[project.id];
      const stateCell = ui.cell(rowEl, cached ? cached.comparison.label : '未检查');
      if (cached) stateCell.addClass(`vm-state-${cached.comparison.tone}`);

      ui.cell(rowEl, formatTime(lastCheck && lastCheck.at));

      const actions = ui.cell(rowEl, '');
      const bar = actions.createDiv({ cls: 'vm-row-actions' });
      ui.button(bar, '查看', { disabled: this.busy, onClick: () => this.openProject(project.id) });
    }

    addReadOnlyHint();
  }

  async renderProjectDetail(body, project) {
    const inspection = this.projectInspections[project.id];

    const toolbar = body.createDiv({ cls: 'vm-toolbar' });
    ui.button(toolbar, '返回列表', {
      disabled: this.busy,
      onClick: () => {
        this.activeProjectId = null;
        this.render();
      },
    });
    ui.button(toolbar, '检查', { cls: 'mod-cta', disabled: this.busy, onClick: () => this.checkProjectFlow(project.id) });
    ui.button(toolbar, '更新基线', { disabled: this.busy, onClick: () => this.updateBaselineFlow(project.id) });
    ui.button(toolbar, '编辑关联', { disabled: this.busy, onClick: () => this.editProjectFlow(project.id) });
    ui.button(toolbar, '移除关联', {
      cls: 'mod-warning',
      disabled: this.busy,
      onClick: () => this.removeProjectFlow(project.id),
    });

    const header = body.createDiv({ cls: 'vm-project-head' });
    header.createEl('h3', { cls: 'vm-section-title', text: project.name });
    if (project.purpose) header.createEl('div', { cls: 'vm-hint', text: project.purpose });

    if (this.busy) {
      ui.message(body, 'loading', '正在读取项目状态…');
      return;
    }

    const source = inspection ? inspection.source : null;
    const remote = inspection ? inspection.remote : null;
    const runtime = inspection ? inspection.runtime : null;

    const grid = body.createDiv({ cls: 'vm-grid vm-location-grid' });
    this.locationCard(grid, '本地源码', [
      { label: '目录', value: project.sourcePath },
      { label: '版本', value: project.baseline && project.baseline.sourceVersion ? project.baseline.sourceVersion : '未记录' },
      { label: '提交', value: shortValue(project.baseline && project.baseline.commit) },
      { label: '源码身份', value: inspection ? shortValue(source.identity) : '待检查' },
      { label: '基线时间', value: project.baseline ? formatTime(project.baseline.recordedAt) : '尚未记录' },
    ]);

    const lastCheck = project.lastCheck;
    this.locationCard(grid, '云端项目', [
      { label: '地址', value: project.remote.url || '未关联' },
      { label: '分支', value: (remote && remote.branch) || project.remote.branch || '—' },
      {
        label: '最新发布',
        value: remote && remote.release
          ? `${remote.release.tag || remote.release.version}（${remote.release.version}）`
          : lastCheck && lastCheck.release
            ? `${lastCheck.release.tag || lastCheck.release.version}（${lastCheck.release.version}）`
            : remote && remote.status === 'ok'
              ? '无正式发布'
              : '—',
      },
      {
        label: '开发线',
        value: (remote && remote.developmentVersion) || (lastCheck && lastCheck.developmentVersion) || '—',
      },
      { label: '最后检查', value: formatTime((remote && remote.at) || (lastCheck && lastCheck.at)) },
      { label: '检查结果', value: remote && remote.error ? remote.error : '—' },
    ]);

    this.locationCard(grid, '当前库使用', [
      { label: '安装位置', value: project.installLocation },
      { label: '版本', value: runtime ? runtime.version || '—' : '待检查' },
      { label: '状态', value: runtime ? RUNTIME_STATUS_TEXT[runtime.status] || runtime.status : '待检查' },
      {
        label: '文件',
        value: runtime && (runtime.status === 'ok' || runtime.status === 'runtime-modified')
          ? `${runtime.files.length} 个；改动 ${runtime.modified.length}，缺失 ${runtime.missing.length}`
          : '—',
      },
      { label: '来源', value: runtime && runtime.status === 'unregistered' ? '无登记记录' : '组件登记表' },
    ]);

    if (!inspection) {
      ui.message(body, 'warn', '尚未读取项目状态，点击“检查”读取三个位置。');
      return;
    }

    const comparison = inspection.comparison;
    const kind = comparison.tone === 'ok' ? 'ok' : comparison.tone === 'error' ? 'error' : 'warn';
    ui.message(body, kind, comparison.headline || comparison.label);
    if (remote.cached) {
      body
        .createDiv({ cls: 'vm-hint' })
        .setText(`云端信息来自上次检查（${formatTime(remote.at)}），点击“检查”刷新。`);
    }

    if (comparison.details && comparison.details.length > 0) {
      const tableRef = ui.table(body, ['检查项', '结果']);
      for (const item of comparison.details) {
        const rowEl = ui.row(tableRef.body);
        ui.cell(rowEl, item.label);
        ui.cell(rowEl, item.value);
      }
    }
    body.createEl('div', {
      cls: 'vm-hint',
      text: `检查时间：${formatTime(inspection.checkedAt)}；只读检查不会修改源码或运行文件。`,
    });
  }

  async registerProjectFlow() {
    const { pickDirectory } = require('./pickers');
    const { askForm } = require('./modals');
    const vaultRoot = this.vaultRoot();
    const picked = pickDirectory(this.plugin.settings.lastSourceDir || (vaultRoot ? path.dirname(vaultRoot) : undefined));
    if (picked === undefined) {
      this.status = { kind: 'error', text: '当前环境不支持系统选择器，请在表单中手动填写源码目录' };
      await this.render();
      return;
    }
    if (!picked) return;

    const info = readSourceVersion(picked);
    const git = readGitMeta(picked);
    const projectId = info.id || path.basename(picked);
    const pluginId = String(projectId).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const values = await askForm(this.app, {
      title: '接入项目',
      description: '已根据源码目录自动识别名称、插件 id 与远端；安装位置可修改。接入过程只读源码。',
      fields: [
        { key: 'name', label: '项目名称', value: info.name || path.basename(picked) },
        { key: 'purpose', label: '用途', kind: 'textarea', rows: 3, value: '', required: false },
        { key: 'pluginId', label: '插件 id', value: pluginId },
        { key: 'sourcePath', label: '源码目录', kind: 'directory', value: picked },
        {
          key: 'remoteUrl',
          label: '远端仓库地址',
          value: git.remoteUrl,
          required: false,
          description: '支持 github.com 的 https / ssh 地址；留空表示暂不关联云端。',
        },
        { key: 'remoteBranch', label: '远端分支', value: git.branch, required: false },
        { key: 'installLocation', label: '当前库安装位置', value: `.obsidian/plugins/${pluginId}` },
      ],
      submitText: '接入',
    });
    if (!values) return;

    await this.run('接入项目', async () => {
      const { store } = loadProjects(vaultRoot);
      if (findBySourcePath(store, values.sourcePath)) throw new Error('该源码目录已关联项目');
      const identity = await sourceIdentity(values.sourcePath);
      const artifact = await artifactDigest(values.sourcePath);
      const versionInfo = readSourceVersion(values.sourcePath);
      const gitInfo = readGitMeta(values.sourcePath);
      const project = {
        id: createProjectId(values.name, values.sourcePath),
        name: values.name,
        purpose: values.purpose,
        pluginId: values.pluginId,
        sourcePath: values.sourcePath,
        remote: { url: values.remoteUrl, branch: values.remoteBranch },
        installLocation: values.installLocation,
        baseline: {
          sourceIdentity: identity.status === 'ok' ? identity.digest : '',
          sourceVersion: versionInfo.version,
          commit: gitInfo.commit,
          artifactSha256: artifact ? artifact.sha256 : '',
          recordedAt: new Date().toISOString(),
        },
      };
      upsertProject(store, project);
      saveProjects(vaultRoot, store);
      this.activeProjectId = project.id;
      await this.runInspection(project.id, false);
      return { statusText: `已接入项目：${project.name}` };
    });
  }

  async checkProjectFlow(id) {
    await this.run('检查项目', async () => {
      const inspection = await this.runInspection(id, true);
      if (!inspection) throw new Error('项目记录不存在，可能已被移除');
      const suffix = inspection.remote.error ? `（${inspection.remote.error}）` : '';
      return { statusText: `检查完成：${inspection.comparison.label}${suffix}` };
    });
  }

  async checkAllProjectsFlow() {
    await this.run('检查全部项目', async () => {
      const vaultRoot = this.vaultRoot();
      const { store } = loadProjects(vaultRoot);
      const projects = listProjects(store);
      if (projects.length === 0) return { statusText: '没有可检查的项目' };
      let ok = 0;
      let failed = 0;
      let skipped = 0;
      for (const project of projects) {
        const inspection = await this.runInspection(project.id, Boolean(project.remote.url));
        if (!inspection || !inspection.checkResult) skipped += 1;
        else if (inspection.checkResult.ok) ok += 1;
        else failed += 1;
      }
      return { statusText: `已检查 ${projects.length} 个项目：成功 ${ok}，失败 ${failed}，未联网 ${skipped}` };
    });
  }

  async updateBaselineFlow(id) {
    const vaultRoot = this.vaultRoot();
    const { confirmAction } = require('./modals');
    const { store } = loadProjects(vaultRoot);
    const project = getProject(store, id);
    if (!project) return;
    const ok = await confirmAction(this.app, {
      title: '更新源码基线',
      lines: [
        { label: '项目', value: project.name },
        { label: '源码目录', value: project.sourcePath },
        { label: '说明', value: '只更新本机的源码身份记录，不修改源码或插件文件' },
      ],
      confirmText: '更新基线',
    });
    if (!ok) return;

    await this.run('更新源码基线', async () => {
      const current = loadProjects(vaultRoot).store;
      const target = getProject(current, id);
      if (!target) throw new Error('项目记录不存在，可能已被移除');
      const identity = await sourceIdentity(target.sourcePath);
      if (identity.status !== 'ok') {
        throw new Error('源码目录超过检查上限，无法记录基线');
      }
      const artifact = await artifactDigest(target.sourcePath);
      const versionInfo = readSourceVersion(target.sourcePath);
      const git = readGitMeta(target.sourcePath);
      upsertProject(current, {
        ...target,
        baseline: {
          sourceIdentity: identity.digest,
          sourceVersion: versionInfo.version,
          commit: git.commit,
          artifactSha256: artifact ? artifact.sha256 : '',
          recordedAt: new Date().toISOString(),
        },
      });
      saveProjects(vaultRoot, current);
      await this.runInspection(id, false);
      return { statusText: '源码基线已更新（未修改任何文件）' };
    });
  }

  async editProjectFlow(id) {
    const vaultRoot = this.vaultRoot();
    const { askForm } = require('./modals');
    const { store } = loadProjects(vaultRoot);
    const project = getProject(store, id);
    if (!project) return;
    const values = await askForm(this.app, {
      title: '编辑项目关联',
      description: '修改只影响本机项目记录；更换源码目录后需要重新记录基线。',
      fields: [
        { key: 'name', label: '项目名称', value: project.name },
        { key: 'purpose', label: '用途', kind: 'textarea', rows: 3, value: project.purpose, required: false },
        { key: 'pluginId', label: '插件 id', value: project.pluginId },
        { key: 'sourcePath', label: '源码目录', kind: 'directory', value: project.sourcePath },
        { key: 'remoteUrl', label: '远端仓库地址', value: project.remote.url, required: false },
        { key: 'remoteBranch', label: '远端分支', value: project.remote.branch, required: false },
        { key: 'installLocation', label: '当前库安装位置', value: project.installLocation },
      ],
      submitText: '保存',
    });
    if (!values) return;

    await this.run('保存项目关联', async () => {
      const current = loadProjects(vaultRoot).store;
      const target = getProject(current, id);
      if (!target) throw new Error('项目记录不存在，可能已被移除');
      const sourceChangedPath = target.sourcePath !== values.sourcePath;
      upsertProject(current, {
        ...target,
        name: values.name,
        purpose: values.purpose,
        pluginId: values.pluginId,
        sourcePath: values.sourcePath,
        remote: { url: values.remoteUrl, branch: values.remoteBranch },
        installLocation: values.installLocation,
        baseline: sourceChangedPath ? null : target.baseline,
      });
      saveProjects(vaultRoot, current);
      await this.runInspection(id, false);
      return {
        statusText: sourceChangedPath ? '关联已保存；源码目录已更换，请更新基线' : '项目关联已保存（未修改任何文件）',
      };
    });
  }

  async removeProjectFlow(id) {
    const vaultRoot = this.vaultRoot();
    const { confirmAction } = require('./modals');
    const { store } = loadProjects(vaultRoot);
    const project = getProject(store, id);
    if (!project) return;
    const ok = await confirmAction(this.app, {
      title: '移除项目关联',
      lines: [
        { label: '项目', value: project.name },
        { label: '源码目录', value: project.sourcePath },
        { label: '安装位置', value: project.installLocation },
        { label: '说明', value: '只删除本机项目记录，不删除源码、插件文件或用户数据' },
      ],
      confirmText: '移除关联',
      danger: true,
    });
    if (!ok) return;

    await this.run('移除项目关联', async () => {
      const current = loadProjects(vaultRoot).store;
      removeProject(current, id);
      saveProjects(vaultRoot, current);
      delete this.projectInspections[id];
      this.activeProjectId = null;
      return { statusText: `已移除项目关联：${project.name}` };
    });
  }

  async renderComponents(body) {
    const vaultRoot = this.vaultRoot();
    if (!vaultRoot) {
      this.renderEmpty(body, '无法取得 vault 路径', '仅支持 Obsidian 桌面端。');
      return;
    }

    const toolbar = body.createDiv({ cls: 'vm-toolbar' });
    ui.button(toolbar, '安装组件包…', { cls: 'mod-cta', disabled: this.busy, onClick: () => this.installFlow() });
    ui.button(toolbar, '打包组件…', { disabled: this.busy, onClick: () => this.packFlow(null) });
    ui.button(toolbar, '导出套装…', { disabled: this.busy, onClick: () => this.suiteFlow() });
    ui.button(toolbar, '刷新', { disabled: this.busy, onClick: () => this.run('刷新组件列表', async () => ({ statusText: '组件列表已刷新' })) });

    if (this.busy) {
      ui.message(body, 'loading', '正在处理，请稍候…');
      return;
    }

    const { registry } = loadRegistry(vaultRoot);
    const records = listRecords(registry);
    if (records.length === 0) {
      this.renderEmpty(body, '尚未登记任何组件', '安装 .vmpkg 组件包后，这里会显示版本、类型与安装位置。');
      return;
    }

    const tableRef = ui.table(body, ['组件', '版本', '类型', '安装位置', '文件', '操作']);
    for (const record of records) {
      const rowEl = ui.row(tableRef.body);
      const nameCell = ui.cell(rowEl, '');
      nameCell.createEl('div', { cls: 'vm-cell-strong', text: record.name || record.id });
      nameCell.createEl('div', { cls: 'vm-cell-sub', text: record.id });
      if (record.purpose) nameCell.createEl('div', { cls: 'vm-cell-purpose', text: record.purpose });

      const versionCell = ui.cell(rowEl, record.version);
      const installed = readInstalledManifest(path.join(vaultRoot, record.installLocation));
      if (installed && installed.version !== record.version) {
        versionCell.createEl('div', {
          cls: 'vm-cell-warn',
          text: `实际 ${installed.version}`,
          title: '磁盘上的 manifest.json 版本与登记版本不一致，请重新打包或重新安装',
        });
      }
      if (record.status === 'partial') versionCell.createEl('div', { cls: 'vm-cell-warn', text: '部分卸载' });

      ui.cell(rowEl, record.type);
      ui.cell(rowEl, record.installLocation);
      ui.cell(rowEl, String(record.files.length));

      const actions = ui.cell(rowEl, '');
      const bar = actions.createDiv({ cls: 'vm-row-actions' });
      ui.button(bar, '打包', { disabled: this.busy, onClick: () => this.packFlow(record) });
      ui.button(bar, '卸载', {
        cls: 'mod-warning',
        disabled: this.busy,
        onClick: () => this.uninstallFlow(record),
      });
    }

    const hint = body.createDiv({ cls: 'vm-hint' });
    hint.setText('卸载只删除登记在册且内容未改动的文件；被修改过的文件与 data.json 等用户数据会保留。');
  }

  async installFlow() {
    const vaultRoot = this.vaultRoot();
    const file = await askPath(this.app, {
      title: '安装组件包',
      label: '组件包路径',
      description: '选择 .vmpkg 组件包；系统选择器不可用时手动填写绝对路径。',
      kind: 'file',
      filters: [{ name: 'Vault Meta 组件包', extensions: ['vmpkg'] }],
      value: this.plugin.settings.exportDir || this.defaultExportDir(),
      confirmText: '预检',
    });
    if (!file) return;

    await this.run('预检组件包', async () => {
      const info = await inspectComponentPackage(file);
      const { registry } = loadRegistry(vaultRoot);
      const pre = await preflightInstall({
        vaultRoot,
        packageFile: file,
        registry,
        types: this.plugin.types,
      });

      const lines = [
        { label: '组件', value: `${pre.spec.name}（${pre.spec.id}）` },
        {
          label: '版本',
          value: pre.existingRecord ? `${pre.existingRecord.version} → ${pre.spec.version}` : pre.spec.version,
        },
        { label: '类型', value: `${pre.handler.label}（${pre.spec.type}）` },
        { label: '安装位置', value: pre.spec.install.location },
        { label: '文件', value: `${pre.fileCount} 个 / ${formatBytes(pre.totalBytes)}` },
        {
          label: '变更',
          value: pre.existingRecord ? `${pre.action === 'downgrade' ? '降级' : pre.action === 'reinstall' ? '重装' : '升级'}，安装前会建快照` : '新安装',
        },
      ];
      for (const conflict of pre.conflicts) {
        lines.push({ label: '冲突', value: `${conflict.path}（${conflict.reason}）`, warn: true });
      }
      for (const dep of pre.missingDependencies) {
        lines.push({
          label: '缺失依赖',
          value: dep.reason === 'version-mismatch' ? `${dep.id}@${dep.range}（当前 ${dep.actual}）` : `${dep.id}@${dep.range}`,
          warn: true,
        });
      }

      const ok = await confirmAction(this.app, {
        title: pre.blocked ? '预检未通过' : '确认安装',
        lines,
        blocked: pre.blocked,
        blockedText: pre.blocked
          ? '存在文件冲突或缺失依赖，已阻止写入。请先处理后再试。'
          : undefined,
        confirmText: pre.action === 'install' ? '安装' : '升级',
      });
      if (!ok) return { statusText: '已取消安装' };
      if (pre.blocked) return { statusText: '安装被拒绝：存在冲突或缺失依赖' };

      const result = await applyInstall({
        vaultRoot,
        packageFile: file,
        registry,
        types: this.plugin.types,
      });
      return {
        statusText: `已${result.action === 'install' ? '安装' : '更新'} ${result.record.id}@${result.record.version}（${result.fileCount} 个文件）`,
      };
    });
  }

  async packFlow(record) {
    const vaultRoot = this.vaultRoot();
    const exportDir = this.plugin.settings.exportDir || this.defaultExportDir();

    const values = await askForm(this.app, {
      title: record ? `打包组件：${record.name || record.id}` : '打包插件/组件',
      description: record
        ? '从当前安装位置重新打包（不含 data.json 等用户配置）。'
        : '用于打包尚未登记的插件：源目录必须是 vault 内的插件目录。',
      submitText: '导出',
      fields: record
        ? [{ key: 'outDir', label: '导出目录', kind: 'directory', value: exportDir, mustExist: false }]
        : [
            { key: 'id', label: '组件 ID', value: '', placeholder: '例如 my-plugin' },
            { key: 'sourceDir', label: '源目录（vault 内相对路径）', value: '', placeholder: '.obsidian/plugins/my-plugin' },
            { key: 'outDir', label: '导出目录', kind: 'directory', value: exportDir, mustExist: false },
          ],
    });
    if (!values) return;

    await this.run('打包组件', async () => {
      const result = await exportComponent({
        vaultRoot,
        types: this.plugin.types,
        registry: loadRegistry(vaultRoot).registry,
        id: record ? record.id : values.id,
        sourceDirRel: record ? record.installLocation : values.sourceDir,
        installLocation: record ? record.installLocation : values.sourceDir,
        outDir: values.outDir,
        overwrite: true,
      });
      this.plugin.settings.exportDir = values.outDir;
      await this.plugin.saveSettings();
      return {
        statusText: `已导出 ${path.basename(result.file)}（${result.fileCount} 个文件，${result.totalText}）`,
        details: { file: result.file },
      };
    });
  }

  async suiteFlow() {
    const vaultRoot = this.vaultRoot();
    const { registry } = loadRegistry(vaultRoot);
    const records = listRecords(registry);
    if (records.length === 0) {
      this.status = { kind: 'error', text: '导出套装需要先登记至少一个组件' };
      await this.render();
      return;
    }

    const template = {
      format: SUITE_FORMAT,
      id: 'base-suite',
      name: '基础套装',
      version: '1.0.0',
      components: records.slice(0, 3).map((record) => ({ id: record.id, version: record.version })),
    };

    const values = await askForm(this.app, {
      title: '导出套装',
      description: '套装描述会解析成员版本并自动补齐必需依赖，导出为单个 .vmsuite。',
      submitText: '导出',
      fields: [
        { key: 'suite', label: '套装描述（JSON）', kind: 'textarea', value: JSON.stringify(template, null, 2), rows: 12 },
        {
          key: 'outDir',
          label: '导出目录',
          kind: 'directory',
          value: this.plugin.settings.exportDir || this.defaultExportDir(),
          mustExist: false,
        },
      ],
    });
    if (!values) return;

    await this.run('导出套装', async () => {
      let suite;
      try {
        suite = normalizeSuiteSpec(JSON.parse(values.suite));
      } catch (err) {
        if (err && err.name === 'SyntaxError') {
          throw new Error('套装描述不是合法 JSON');
        }
        throw err;
      }
      const result = await exportSuite({
        vaultRoot,
        registry: loadRegistry(vaultRoot).registry,
        types: this.plugin.types,
        outDir: values.outDir,
        suite,
        overwrite: true,
      });
      this.plugin.settings.exportDir = values.outDir;
      await this.plugin.saveSettings();
      return {
        statusText: `已导出 ${path.basename(result.file)}（${result.components.map((item) => `${item.id}@${item.version}`).join('、')}）`,
        details: result.autoIncluded.length > 0 ? { autoIncluded: result.autoIncluded } : undefined,
      };
    });
  }

  async uninstallFlow(record) {
    const vaultRoot = this.vaultRoot();
    const ok = await confirmAction(this.app, {
      title: `卸载组件：${record.name || record.id}`,
      lines: [
        { label: '版本', value: record.version },
        { label: '安装位置', value: record.installLocation },
        { label: '登记文件', value: `${record.files.length} 个` },
        { label: '保护规则', value: '已修改文件与用户数据（如 data.json）不会被删除', warn: true },
      ],
      confirmText: '卸载',
      danger: true,
    });
    if (!ok) return;

    await this.run('卸载组件', async () => {
      const result = await applyUninstall({ vaultRoot, registry: loadRegistry(vaultRoot).registry, id: record.id });
      const kept = result.kept.length > 0 ? `；保留 ${result.kept.length} 个已修改文件（${result.kept.map((item) => item.path).join('、')}）` : '';
      return {
        statusText: result.status === 'removed' ? `已卸载 ${record.id}：删除 ${result.removed.length} 个文件${kept}` : `已部分卸载 ${record.id}：删除 ${result.removed.length} 个文件${kept}`,
      };
    });
  }

  async renderRestore(body) {
    const vaultRoot = this.vaultRoot();
    if (!vaultRoot) {
      this.renderEmpty(body, '无法取得 vault 路径', '仅支持 Obsidian 桌面端。');
      return;
    }

    const dirRow = body.createDiv({ cls: 'vm-field' });
    dirRow.createEl('label', {
      cls: 'vm-field-label',
      text: '备份目录',
      attr: { for: 'vm-backup-dir' },
    });
    const dirInput = dirRow.createEl('input', {
      cls: 'vm-input',
      attr: { type: 'text', id: 'vm-backup-dir', 'aria-label': '备份目录', placeholder: this.defaultBackupDir() },
    });
    dirInput.value = this.backupDirDraft ?? (this.plugin.settings.backupDir || this.defaultBackupDir());
    dirInput.addEventListener('input', () => { this.backupDirDraft = dirInput.value; });
    dirRow.createEl('div', {
      cls: 'vm-field-desc',
      text: '可填写任意可访问的绝对路径，包括 iCloud、OneDrive 等同步目录；备份文件本身带校验信息。',
    });

    const dirActions = body.createDiv({ cls: 'vm-toolbar' });
    ui.button(dirActions, '保存目录', {
      disabled: this.busy,
      onClick: () =>
        this.run('保存备份目录', async () => {
          const check = validatePath(dirInput.value, { kind: 'directory', mustExist: false });
          if (!check.ok) throw new Error(check.message);
          this.plugin.settings.backupDir = check.path;
          await this.plugin.saveSettings();
          this.backupDirDraft = null;
          return { statusText: `备份目录已保存：${check.path}` };
        }),
    });
    ui.button(dirActions, '选择目录…', {
      disabled: this.busy,
      onClick: async () => {
        const { pickDirectory } = require('./pickers');
        const picked = pickDirectory(dirInput.value || undefined);
        if (picked === undefined) {
          this.status = { kind: 'error', text: '当前环境不支持系统选择器，请手动填写绝对路径' };
          await this.render();
          return;
        }
        if (picked) {
          this.backupDirDraft = picked;
          this.status = { kind: 'ok', text: `已选择：${picked}（记得点“保存目录”）` };
          await this.render();
        }
      },
    });

    const scopeRow = body.createDiv({ cls: 'vm-scope' });
    scopeRow.createEl('span', { cls: 'vm-field-label', text: '备份范围' });
    const scopeOptions = [
      { key: 'git', label: '包含 .git（较大）' },
      { key: 'nodeModules', label: '包含 node_modules（很大）' },
      { key: 'snapshots', label: '包含组件快照' },
      { key: 'trash', label: '包含 .trash' },
    ];
    for (const option of scopeOptions) {
      const label = scopeRow.createEl('label', { cls: 'vm-checkbox' });
      const input = label.createEl('input', { attr: { type: 'checkbox' } });
      input.checked = Boolean(this.scope[option.key]);
      input.addEventListener('change', () => {
        this.scope[option.key] = input.checked;
      });
      label.createEl('span', { text: option.label });
    }
    body.createEl('div', {
      cls: 'vm-hint',
      text: '默认排除备份目录自身（避免备份包递归包含自己）、管理器临时目录与系统垃圾文件。',
    });

    const actions = body.createDiv({ cls: 'vm-toolbar' });
    ui.button(actions, '创建整库备份', {
      cls: 'mod-cta',
      disabled: this.busy,
      onClick: () =>
        this.run('创建整库备份', async () => {
          const check = validatePath(dirInput.value, { kind: 'directory', mustExist: false });
          if (!check.ok) throw new Error(check.message);
          const result = await createBackup({
            vaultRoot,
            destDir: check.path,
            include: { ...this.scope },
          });
          this.plugin.settings.backupDir = check.path;
          this.plugin.settings.lastBackupAt = result.manifest.createdAt;
          this.plugin.settings.lastBackupFile = result.file;
          await this.plugin.saveSettings();
          this.backupDirDraft = null;
          return {
            statusText: `备份完成${result.verified ? '并已校验' : ''}：${result.fileCount} 个文件，${result.totalText} → ${result.file}`,
            details: result.destInsideVault ? { note: '备份目录位于 vault 内，已自动排除其自身' } : undefined,
          };
        }),
    });
    ui.button(actions, '刷新列表', {
      disabled: this.busy,
      onClick: () => this.run('刷新备份列表', async () => ({ statusText: '备份列表已刷新' })),
    });

    const dirCheck = validatePath(
      this.plugin.settings.backupDir || this.defaultBackupDir(),
      { kind: 'directory', mustExist: false },
    );
    if (!dirCheck.ok) {
      this.renderEmpty(body, '请先设置备份目录', dirCheck.message);
      return;
    }
    if (this.busy) {
      ui.message(body, 'loading', '正在读取备份列表…');
      return;
    }

    let backups = [];
    try {
      backups = await listBackups(dirCheck.path);
    } catch (err) {
      this.renderError(body, err);
      return;
    }

    body.createEl('h3', { cls: 'vm-section-title', text: `备份列表（${backups.length}）` });
    if (backups.length === 0) {
      this.renderEmpty(body, '该目录还没有备份', '点击“创建整库备份”生成第一个归档。');
      return;
    }

    const tableRef = ui.table(body, ['创建时间', '文件数', '大小', '范围', '状态', '操作']);
    for (const backup of backups) {
      const rowEl = ui.row(tableRef.body);
      ui.cell(rowEl, formatTime(backup.createdAt));
      ui.cell(rowEl, backup.fileCount === undefined ? '—' : String(backup.fileCount));
      ui.cell(rowEl, backup.sizeText);
      ui.cell(rowEl, backup.scope ? scopeText(backup.scope) : '—');
      const statusCell = ui.cell(rowEl, backup.error ? '损坏' : '可校验');
      if (backup.error) statusCell.addClass('vm-cell-warn');

      const actionCell = ui.cell(rowEl, '');
      const bar = actionCell.createDiv({ cls: 'vm-row-actions' });
      ui.button(bar, '校验', {
        disabled: this.busy,
        onClick: () =>
          this.run('校验备份', async () => {
            const result = await verifyBackup(backup.file);
            if (!result.ok) {
              throw new Error(`校验失败：${result.mismatches.length} 个文件不一致`);
            }
            return { statusText: `校验通过：${result.checked} 个文件，${backup.name}` };
          }),
      });
      ui.button(bar, '恢复…', {
        disabled: this.busy,
        onClick: () => this.restoreFlow(backup),
      });
    }
  }

  async restoreFlow(backup) {
    const vaultRoot = this.vaultRoot();
    const defaultTarget = path.join(path.dirname(backup.file), `restore-${nowStamp()}`);
    const target = await askPath(this.app, {
      title: '恢复到目录',
      label: '目标目录',
      description: '为避免覆盖当前 vault，请选择空目录或新目录；目标非空时会被拒绝。',
      kind: 'directory',
      value: defaultTarget,
      mustExist: false,
      confirmText: '恢复',
    });
    if (!target) return;

    const ok = await confirmAction(this.app, {
      title: '确认恢复',
      lines: [
        { label: '备份', value: backup.name },
        { label: '文件数', value: String(backup.fileCount) },
        { label: '目标目录', value: target },
        { label: '校验', value: '逐文件核对 sha256，不一致即中止' },
      ],
      confirmText: '开始恢复',
    });
    if (!ok) return;

    await this.run('恢复备份', async () => {
      const result = await restoreBackup({ file: backup.file, targetDir: target, vaultRoot });
      return {
        statusText: `已恢复 ${result.restoredCount} 个文件并逐文件核验 → ${result.targetDir}`,
      };
    });
  }
}

module.exports = { VaultMetaView, VIEW_TYPE, formatTime, scopeText };
