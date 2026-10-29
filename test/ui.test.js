'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadWithStub, makeApp, findByClass, findButton, textOf, El } = require('./helpers/obsidian-stub');
const { tempDir, writeFile, makeVault, makePlugin, hashTree } = require('./helpers/vault');
const { createDefaultTypeRegistry } = require('../src/core/types');
const { loadRegistry, saveRegistry } = require('../src/core/registry');
const { loadProjects, saveProjects, upsertProject, emptyProjects, createProjectId } = require('../src/core/projects');
const { sourceIdentity } = require('../src/core/identity');
const { sha256File } = require('../src/core/fs-utils');
const { exportComponent } = require('../src/core/packager');
const { applyInstall } = require('../src/core/installer');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');

async function boot(vaultRoot) {
  const PluginClass = loadWithStub(MAIN);
  const app = makeApp({ vaultRoot });
  const plugin = new PluginClass(app, { id: 'vault-meta', version: '0.1.0' });
  await plugin.onload();
  return { app, plugin, PluginClass };
}

function makeView(plugin, app) {
  const factory = plugin._views.get('vault-meta-view');
  return factory({ app });
}

test('插件注册视图、命令、功能区图标与设置页', async () => {
  const vault = makeVault();
  const { plugin } = await boot(vault);
  assert.ok(plugin._views.has('vault-meta-view'));
  assert.deepEqual(
    plugin._commands.map((command) => command.id).sort(),
    ['open-manager', 'open-restore', 'quick-backup'],
  );
  assert.equal(plugin._ribbons.length, 1);
  assert.match(plugin._ribbons[0].title, /Vault 元系统管理/);

  const tab = plugin._settingsTabs[0];
  tab.display();
  const text = textOf(tab.containerEl);
  assert.match(text, /默认备份目录/);
  assert.match(text, /云同步/);
  assert.match(text, /不会自动运行定期备份/);
});

test('默认在主标签页打开管理器，可在设置中改为右侧边栏', async () => {
  const vault = makeVault();
  const { plugin, app } = await boot(vault);
  assert.equal(plugin.settings.openInSidebar, false);

  await plugin.activateView('projects');
  assert.deepEqual(app.workspace.calls.map((call) => call[0]), ['getLeaf', 'revealLeaf']);
  assert.equal(app.workspace.calls[0][1], 'tab');
  assert.deepEqual(app.workspace.leaves[0].state, { type: 'vault-meta-view', active: true });

  plugin.settings.openInSidebar = true;
  await plugin.activateView();
  const modes = app.workspace.calls.map((call) => call[0]);
  assert.equal(modes[modes.length - 2], 'getRightLeaf');
});

test('已存在同位置的管理器视图时复用而不新开标签页', async () => {
  const vault = makeVault();
  const { plugin, app } = await boot(vault);
  const setTab = async () => {};
  app.workspace.leaves.push({ view: { getViewType: () => 'vault-meta-view', setTab } });

  await plugin.activateView('projects');
  assert.equal(app.workspace.calls.some((call) => call[0] === 'getLeaf'), false);
  assert.equal(app.workspace.calls.some((call) => call[0] === 'getRightLeaf'), false);
  assert.equal(app.workspace.calls.some((call) => call[0] === 'revealLeaf'), true);
});

test('概览页渲染中文状态、边界说明与可访问性结构', async () => {
  const vault = makeVault();
  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.onOpen();

  const text = textOf(view.contentEl);
  assert.match(text, /Vault 元系统管理/);
  assert.match(text, /Vault 路径/);
  assert.match(text, /已登记组件/);
  assert.match(text, /不能当历史备份/);
  assert.match(text, /不运行任何自动定期任务/);

  const tabs = findByClass(view.contentEl, 'vm-tab');
  assert.equal(tabs.length, 4);
  assert.equal(tabs[0].getAttribute('role'), 'tab');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].getAttribute('tabindex'), '-1');

  const panels = findByClass(view.contentEl, 'vm-body');
  assert.equal(panels[0].getAttribute('role'), 'tabpanel');
  assert.equal(panels[0].getAttribute('aria-labelledby'), 'vm-tab-overview');
  assert.equal(panels[0].getAttribute('aria-busy'), 'false');
});

test('组件页展示登记信息与操作按钮', async () => {
  const vault = makeVault();
  const sourcePkg = await exportComponent({
    vaultRoot: vault,
    types: createDefaultTypeRegistry(),
    id: 'demo',
    outDir: tempDir('ui-pkg-'),
    overwrite: true,
  });
  const registry = loadRegistry(vault).registry;
  await applyInstall({ vaultRoot: vault, packageFile: sourcePkg.file, registry, types: createDefaultTypeRegistry() });

  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.onOpen();
  await view.setTab('components');

  const text = textOf(view.contentEl);
  assert.match(text, /安装组件包/);
  assert.match(text, /导出套装/);
  assert.match(text, /demo/);
  assert.match(text, /obsidian-plugin/);
  assert.ok(findButton(view.contentEl, '打包'));
  assert.ok(findButton(view.contentEl, '卸载'));
  assert.match(text, /卸载只删除登记在册且内容未改动的文件/);
});

test('组件页显示磁盘真实版本与登记版本不一致', async () => {
  const vault = makeVault();
  const pkg = await exportComponent({
    vaultRoot: vault,
    types: createDefaultTypeRegistry(),
    id: 'demo',
    purpose: '演示用途',
    outDir: tempDir('ui-pkg2-'),
    overwrite: true,
  });
  await applyInstall({ vaultRoot: vault, packageFile: pkg.file, registry: loadRegistry(vault).registry, types: createDefaultTypeRegistry() });
  // 模拟用户手动替换 main.js/manifest.json 导致版本漂移
  const manifestPath = path.join(vault, '.obsidian/plugins/demo/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = '2.0.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.onOpen();
  await view.setTab('components');
  const text = textOf(view.contentEl);
  assert.match(text, /实际 2.0.0/);
  assert.match(text, /演示用途/);
});

test('恢复页：创建备份后出现记录并可校验', async () => {
  const vault = makeVault();
  const backupDir = tempDir('ui-backup-');
  const { plugin, app } = await boot(vault);
  plugin.settings.backupDir = backupDir;

  const view = makeView(plugin, app);
  await view.onOpen();
  await view.setTab('restore');

  assert.match(textOf(view.contentEl), /备份目录/);
  assert.equal(findByClass(view.contentEl, 'vm-checkbox').length, 4);
  assert.match(textOf(view.contentEl), /该目录还没有备份/);

  const createButton = findButton(view.contentEl, '创建整库备份');
  assert.ok(createButton);
  await createButton.click();

  const text = textOf(view.contentEl);
  assert.match(text, /备份完成/);
  assert.match(text, /vault-backup-/);
  assert.ok(findButton(view.contentEl, '恢复…'));
  assert.ok(findButton(view.contentEl, '校验'));

  const verifyButton = findButton(view.contentEl, '校验');
  await verifyButton.click();
  assert.match(textOf(view.contentEl), /校验通过/);
  assert.equal(plugin.settings.lastBackupAt.length > 0, true);
});

test('动作反馈有成功与失败两种状态，并带 aria-live', async () => {
  const vault = makeVault();
  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.onOpen();

  await view.run('测试成功', async () => ({ statusText: '已完成' }));
  let status = findByClass(view.contentEl, 'vm-status')[0];
  assert.ok(status);
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.match(textOf(status), /已完成/);

  await view.run('测试失败', async () => {
    const error = new Error('磁盘不可写');
    error.name = 'VaultMetaError';
    error.code = 'E_IO';
    error.details = { path: '/tmp/x' };
    throw error;
  });
  status = findByClass(view.contentEl, 'vm-status')[0];
  assert.ok(status.hasClass('vm-status-error'));
  assert.equal(status.getAttribute('role'), 'alert');
  assert.match(textOf(status), /磁盘不可写/);
  assert.match(textOf(status), /E_IO/);
});

test('键盘可在标签间移动焦点', async () => {
  const vault = makeVault();
  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.onOpen();

  const overviewTab = findByClass(view.contentEl, 'vm-tab')[0];
  await overviewTab.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(view.activeTab, 'projects');
  assert.equal(El.activeElement && El.activeElement.getAttribute('role'), 'tab');
  assert.equal(El.activeElement.id, 'vm-tab-projects');
});

test('空状态与加载状态可见', async () => {
  const vault = makeVault();
  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);

  await view.onOpen();
  await view.setTab('components');
  assert.match(textOf(view.contentEl), /尚未登记任何组件/);

  view.busy = true;
  await view.render();
  assert.match(textOf(view.contentEl), /正在处理，请稍候/);
  assert.ok(findByClass(view.contentEl, 'vm-message-loading').length > 0);

  view.busy = false;
  await view.setTab('overview');
  assert.match(textOf(view.contentEl), /已登记组件/);
});

test('无法取得 vault 路径时给出明确错误状态', async () => {
  const { plugin, app } = await boot('');
  const view = makeView(plugin, app);
  await view.onOpen();
  const text = textOf(view.contentEl);
  assert.match(text, /无法取得 vault 路径/);
  assert.match(text, /仅支持 Obsidian 桌面端/);
});


test('恢复页选择目录后显示新路径，仅保存时持久化并在重新打开后保留', async (t) => {
  const vault = makeVault();
  const saved = tempDir('ui-saved-');
  const picked = tempDir('ui-picked-');
  const pickers = require('../src/ui/pickers');
  t.mock.method(pickers, 'pickDirectory', () => picked);
  const { plugin, app } = await boot(vault);
  plugin.settings.backupDir = saved;
  await plugin.saveSettings();
  const view = makeView(plugin, app);
  await view.setTab('restore');
  await findButton(view.contentEl, '选择目录…').click();
  const currentInput = () => findByClass(view.contentEl, 'vm-input')[0];
  assert.equal(currentInput().value, picked);
  assert.equal(plugin.settings.backupDir, saved);
  assert.equal((await plugin.loadData()).backupDir, saved);
  await findButton(view.contentEl, '保存目录').click();
  assert.equal(currentInput().value, picked);
  assert.equal((await plugin.loadData()).backupDir, picked);
  await view.setTab('overview');
  await view.setTab('restore');
  assert.equal(currentInput().value, picked);
  const reopened = makeView(plugin, app);
  await reopened.setTab('restore');
  assert.equal(findByClass(reopened.contentEl, 'vm-input')[0].value, picked);
});

for (const result of [null, undefined]) {
  test(`恢复页选择器返回 ${result} 时不覆盖已保存目录，手动输入仍可保存`, async (t) => {
    const vault = makeVault();
    const saved = tempDir('ui-original-');
    const manual = tempDir('ui-manual-');
    t.mock.method(require('../src/ui/pickers'), 'pickDirectory', () => result);
    const { plugin, app } = await boot(vault);
    plugin.settings.backupDir = saved;
    await plugin.saveSettings();
    const view = makeView(plugin, app);
    await view.setTab('restore');
    await findButton(view.contentEl, '选择目录…').click();
    assert.equal(plugin.settings.backupDir, saved);
    assert.equal(findByClass(view.contentEl, 'vm-input')[0].value, saved);
    const input = findByClass(view.contentEl, 'vm-input')[0];
    input.value = manual;
    await input.dispatch('input');
    await findButton(view.contentEl, '保存目录').click();
    assert.equal((await plugin.loadData()).backupDir, manual);
    assert.equal(findByClass(view.contentEl, 'vm-input')[0].value, manual);
  });
}


test('恢复页未保存的选择目录可直接用于创建备份', async (t) => {
  const vault = makeVault();
  const saved = tempDir('ui-backup-old-');
  const picked = tempDir('ui-backup-draft-');
  t.mock.method(require('../src/ui/pickers'), 'pickDirectory', () => picked);
  const { plugin, app } = await boot(vault);
  plugin.settings.backupDir = saved;
  const view = makeView(plugin, app);
  await view.setTab('restore');
  await findButton(view.contentEl, '选择目录…').click();
  assert.equal(plugin.settings.backupDir, saved);
  await findButton(view.contentEl, '创建整库备份').click();
  assert.match(textOf(view.contentEl), /备份完成/);
  assert.equal(plugin.settings.backupDir, picked);
  assert.equal(path.dirname(plugin.settings.lastBackupFile), picked);
  assert.equal(fs.readdirSync(saved).length, 0);
  assert.equal(fs.readdirSync(picked).length, 1);
});

// ---------- 项目生命周期第一阶段 ----------

const COMMIT = '1'.repeat(40);

function makeSourceDir() {
  const root = tempDir('ui-src-');
  writeFile(root, 'manifest.json', JSON.stringify({ id: 'demo', name: 'Demo 插件', version: '1.0.0' }, null, 2));
  writeFile(root, 'main.js', 'bundle');
  writeFile(root, '.git/config', '[remote "origin"]\n\turl = https://github.com/example/demo.git\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n');
  writeFile(root, '.git/HEAD', 'ref: refs/heads/main\n');
  writeFile(root, '.git/refs/heads/main', `${COMMIT}\n`);
  return root;
}

async function registerInstalledDemo(vault) {
  const dir = makePlugin(vault, 'demo', { version: '1.0.0', main: 'bundle' });
  const files = [];
  for (const name of ['manifest.json', 'main.js', 'styles.css']) {
    const abs = path.join(dir, name);
    files.push({ path: name, sha256: await sha256File(abs), size: fs.statSync(abs).size });
  }
  const registry = loadRegistry(vault).registry;
  registry.components.demo = {
    id: 'demo',
    name: 'Demo 插件',
    version: '1.0.0',
    type: 'obsidian-plugin',
    source: { kind: 'vault', path: '.obsidian/plugins/demo', origin: '' },
    installLocation: '.obsidian/plugins/demo',
    files,
    dependencies: [],
    installedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    status: 'installed',
    snapshots: [],
  };
  saveRegistry(vault, registry);
  return dir;
}

async function seedProject(vault, options) {
  const opts = options || {};
  const sourcePath = opts.sourcePath || makeSourceDir();
  const identity = await sourceIdentity(sourcePath);
  const store = emptyProjects();
  upsertProject(store, {
    id: createProjectId('Demo 插件', sourcePath),
    name: 'Demo 插件',
    purpose: '演示项目',
    pluginId: 'demo',
    sourcePath,
    remote: { url: 'https://github.com/example/demo', branch: 'main' },
    installLocation: '.obsidian/plugins/demo',
    baseline: {
      sourceIdentity: identity.digest,
      sourceVersion: '1.0.0',
      commit: COMMIT,
      artifactSha256: await sha256File(path.join(sourcePath, 'main.js')),
      recordedAt: '2026-10-01T00:00:00.000Z',
    },
    lastCheck: opts.lastCheck || null,
  });
  saveProjects(vault, store);
  return { sourcePath, store };
}

test('项目页空状态与只读提示', async () => {
  const vault = makeVault();
  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.setTab('projects');
  const text = textOf(view.contentEl);
  assert.match(text, /尚未接入任何项目/);
  assert.ok(findButton(view.contentEl, '接入项目…'));
  assert.ok(findButton(view.contentEl, '全部检查'));
  assert.match(text, /所有检查均为只读/);
});

test('项目列表受控显示，详情展示三个位置与离线状态，且不修改任何文件', async () => {
  const vault = makeVault({ plugins: false });
  await registerInstalledDemo(vault);
  const { sourcePath } = await seedProject(vault, {
    lastCheck: {
      at: '2026-10-27T10:00:00.000Z',
      ok: false,
      code: 'E_NETWORK',
      error: '网络请求失败或超时，无法确认云端最新版本',
    },
  });
  const sourceBefore = hashTree(sourcePath);
  const pluginBefore = hashTree(path.join(vault, '.obsidian/plugins/demo'));

  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.setTab('projects');

  let text = textOf(view.contentEl);
  assert.match(text, /Demo 插件/);
  assert.match(text, /检查失败/);
  assert.match(text, /1\.0\.0/);

  const openButton = findButton(view.contentEl, '查看');
  assert.ok(openButton);
  await openButton.click();

  text = textOf(view.contentEl);
  assert.match(text, /本地源码/);
  assert.match(text, /云端项目/);
  assert.match(text, /当前库使用/);
  assert.match(text, /无法确认最新/);
  assert.match(text, /最后检查/);
  assert.match(text, /只读检查不会修改源码或运行文件/);
  assert.ok(findButton(view.contentEl, '检查'));
  assert.ok(findButton(view.contentEl, '更新基线'));
  assert.ok(findButton(view.contentEl, '移除关联'));

  assert.deepEqual(hashTree(sourcePath), sourceBefore);
  assert.deepEqual(hashTree(path.join(vault, '.obsidian/plugins/demo')), pluginBefore);
});

test('接入项目自动识别字段并写入 projects.json，源码目录保持不变', async (t) => {
  const vault = makeVault({ plugins: false });
  const sourcePath = makeSourceDir();
  const sourceBefore = hashTree(sourcePath);
  t.mock.method(require('../src/ui/pickers'), 'pickDirectory', () => sourcePath);
  t.mock.method(require('../src/ui/modals'), 'askForm', async (app, options) => {
    const values = {};
    for (const field of options.fields) values[field.key] = field.value;
    return values;
  });

  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.setTab('projects');
  await findButton(view.contentEl, '接入项目…').click();

  const { store } = loadProjects(vault);
  assert.equal(store.projects.length, 1);
  assert.equal(store.projects[0].name, 'Demo 插件');
  assert.equal(store.projects[0].pluginId, 'demo');
  assert.equal(store.projects[0].sourcePath, sourcePath);
  assert.equal(store.projects[0].baseline.sourceVersion, '1.0.0');
  assert.equal(store.projects[0].baseline.commit, COMMIT);
  assert.match(store.projects[0].baseline.sourceIdentity, /^[0-9a-f]{64}$/);

  const text = textOf(view.contentEl);
  assert.match(text, /本地源码/);
  assert.match(text, /云端项目/);
  assert.match(text, /当前库使用/);
  assert.deepEqual(hashTree(sourcePath), sourceBefore);
  assert.equal(fs.existsSync(path.join(vault, '.obsidian/vault-meta/projects.json')), true);
});

test('移除关联只删除项目记录，不删除源码或插件文件', async (t) => {
  const vault = makeVault({ plugins: false });
  const pluginDir = await registerInstalledDemo(vault);
  const { sourcePath } = await seedProject(vault);
  t.mock.method(require('../src/ui/modals'), 'confirmAction', async () => true);

  const { plugin, app } = await boot(vault);
  const view = makeView(plugin, app);
  await view.setTab('projects');
  await findButton(view.contentEl, '查看').click();
  await findButton(view.contentEl, '移除关联').click();

  const { store } = loadProjects(vault);
  assert.equal(store.projects.length, 0);
  assert.equal(fs.existsSync(path.join(sourcePath, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(pluginDir, 'main.js')), true);
  assert.match(textOf(view.contentEl), /尚未接入任何项目/);
});
