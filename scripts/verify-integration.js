#!/usr/bin/env node
'use strict';

/**
 * 端到端验证（真实文件、临时目录，不触碰正式 vault）：
 * 1. 用 fixture 插件打包 → 干净 vault 安装 → 加载插件验证核心功能
 * 2. 整库备份 → 恢复到另一目录 → 逐文件比对
 * 3. 冲突拒绝、缺失依赖拒绝、失败回滚、卸载保护
 * 4. 套装导出（依赖闭包）
 * 输出 JSON 报告；任一步失败以非 0 退出。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createDefaultTypeRegistry } = require('../src/core/types');
const { loadRegistry, saveRegistry } = require('../src/core/registry');
const pack = require('../src/core/packager');
const inst = require('../src/core/installer');
const backup = require('../src/core/backup');
const identity = require('../src/core/identity');
const projects = require('../src/core/projects');
const { inspectProject } = require('../src/core/project-inspect');
const { sha256File } = require('../src/core/fs-utils');
const { loadWithStub, makeApp } = require('../test/helpers/obsidian-stub');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'oscar-brain');
const report = { startedAt: new Date().toISOString(), steps: [], ok: false };

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashTree(root, ignore = []) {
  const out = {};
  const walk = (dir, relDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (ignore.some((item) => rel === item || rel.startsWith(`${item}/`))) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out[rel] = sha(abs);
    }
  };
  walk(root, '');
  return out;
}

function record(name, detail, ok) {
  const passed = ok !== false;
  report.steps.push({ name, ok: passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) throw new Error(`验证失败：${name}`);
}

(async () => {
  const types = createDefaultTypeRegistry();

  // 0. 准备源 vault：fixture 插件 + 笔记 + 伪造私有配置
  const sourceVault = tmp('vm-source-');
  write(path.join(sourceVault, 'note.md'), '# 源 vault\n');
  write(path.join(sourceVault, '.obsidian/app.json'), '{"attachmentFolderPath":"images"}\n');
  const pluginDir = path.join(sourceVault, '.obsidian/plugins/oscar-brain');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, 'main.js'), path.join(pluginDir, 'main.js'));
  fs.copyFileSync(path.join(FIXTURE, 'manifest.json'), path.join(pluginDir, 'manifest.json'));
  write(path.join(pluginDir, 'data.json'), '{"backendPath":"/Users/private/path"}\n');
  write(path.join(sourceVault, 'Library/attachments/a.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));

  // 0b. 构建产物自检：真实 main.js 能被加载并注册命令
  const BuiltPlugin = loadWithStub(path.join(ROOT, 'main.js'));
  const builtApp = makeApp({ vaultRoot: sourceVault });
  const built = new BuiltPlugin(builtApp, JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')));
  await built.onload();
  record(
    '构建产物 main.js 可加载',
    `commands=${built._commands.map((command) => command.id).join(',')}`,
    built._views.has('vault-meta-view') && built._commands.length === 3,
  );

  // 1. 打包
  const exportsDir = tmp('vm-exports-');
  const pkg = await pack.exportComponent({
    vaultRoot: sourceVault,
    types,
    id: 'oscar-brain',
    purpose: '投递/提问/审阅面板',
    outDir: exportsDir,
  });
  const manifest = await require('../src/core/archive').readArchiveManifest(pkg.file);
  const packaged = manifest.entries.map((entry) => entry.path);
  record('打包代表性插件', `${path.basename(pkg.file)} / ${pkg.fileCount} 文件`);
  record(
    '安装包不含 data.json 等私有配置',
    `entries=${packaged.join(',')}`,
    !packaged.some((item) => item.endsWith('data.json')),
  );

  // 2. 干净 vault 安装
  const targetVault = tmp('vm-target-');
  write(path.join(targetVault, '.obsidian/app.json'), '{}\n');
  const registry = loadRegistry(targetVault).registry;
  const result = await inst.applyInstall({ vaultRoot: targetVault, packageFile: pkg.file, registry, types });
  const installedMain = path.join(targetVault, '.obsidian/plugins/oscar-brain/main.js');
  record(
    '安装到干净 vault',
    `版本 ${result.record.version}，${result.fileCount} 个文件`,
    fs.existsSync(installedMain) && !fs.existsSync(path.join(targetVault, '.obsidian/plugins/oscar-brain/data.json')),
  );

  // 3. 加载已安装插件，验证核心功能注册
  const PluginClass = loadWithStub(installedMain);
  const app = makeApp({ vaultRoot: targetVault });
  const plugin = new PluginClass(app, JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')));
  await plugin.onload();
  const commandIds = plugin._commands.map((command) => command.id);
  record(
    '已安装插件可加载并注册核心能力',
    `commands=${commandIds.join(',')}`,
    plugin._views.has('oscar-brain-view') && commandIds.includes('ob-open') && commandIds.includes('ob-review'),
  );

  // 4. 套装导出（在卸载前执行，确保成员文件完整）
  const suite = await pack.exportSuite({
    vaultRoot: sourceVault,
    registry: loadRegistry(targetVault).registry,
    types,
    outDir: exportsDir,
    suite: {
      format: 'vault-meta/suite@1',
      id: 'base-suite',
      name: '基础套装',
      version: '1.0.0',
      components: [{ id: 'oscar-brain' }],
    },
    overwrite: true,
  });
  record('套装导出', `${path.basename(suite.file)}`, fs.existsSync(suite.file));

  // 4. 升级 + 失败回滚
  const v2Main = `${fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8')}\n// integration v2\n`;
  write(path.join(pluginDir, 'main.js'), v2Main);
  write(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({ id: 'oscar-brain', name: 'Oscar Brain', version: '0.4.1', minAppVersion: '1.0.0', isDesktopOnly: true }, null, 2),
  );
  const pkg2 = await pack.exportComponent({ vaultRoot: sourceVault, types, id: 'oscar-brain', outDir: exportsDir, overwrite: true });
  const upgrade = await inst.applyInstall({
    vaultRoot: targetVault,
    packageFile: pkg2.file,
    registry: loadRegistry(targetVault).registry,
    types,
  });
  record(
    '升级并登记真实版本',
    `${upgrade.record.version}，快照 ${upgrade.record.snapshots.length} 个`,
    upgrade.record.version === '0.4.1' && upgrade.record.snapshots.length >= 2,
  );

  // 4b. 构造描述版本与 manifest 不一致的包，触发写入后失败并回滚
  const { writeArchive } = require('../src/core/archive');
  const specFiles = [];
  for (const name of ['manifest.json', 'main.js']) {
    const abs = path.join(pluginDir, name);
    specFiles.push({ path: name, sha256: await sha256File(abs), size: fs.statSync(abs).size });
  }
  const badFile = path.join(exportsDir, 'bad.vmpkg');
  await writeArchive(badFile, {
    kind: 'component',
    meta: {
      component: {
        format: 'vault-meta/component@1',
        id: 'oscar-brain',
        name: 'Oscar Brain',
        version: '9.9.9',
        type: 'obsidian-plugin',
        install: { location: '.obsidian/plugins/oscar-brain' },
        files: specFiles,
        dependencies: [],
      },
    },
    files: ['manifest.json', 'main.js'].map((name) => ({ path: name, abs: path.join(pluginDir, name) })),
  });
  let rollbackOk = false;
  let rollbackDetail = '';
  try {
    await inst.applyInstall({
      vaultRoot: targetVault,
      packageFile: badFile,
      registry: loadRegistry(targetVault).registry,
      types,
    });
  } catch (err) {
    rollbackOk = Boolean(err.details && err.details.rollback && err.details.rollback.ok);
    rollbackDetail = err.code;
  }
  const afterRollback = fs.readFileSync(installedMain, 'utf8');
  record(
    '失败安装自动回滚',
    `${rollbackDetail}，main.js 已还原`,
    rollbackOk && afterRollback === v2Main,
  );

  // 5. 冲突拒绝
  const conflictVault = tmp('vm-conflict-');
  write(path.join(conflictVault, '.obsidian/plugins/oscar-brain/main.js'), '// 用户已有文件\n');
  const pre = await inst.preflightInstall({
    vaultRoot: conflictVault,
    packageFile: pkg.file,
    registry: loadRegistry(conflictVault).registry,
    types,
  });
  record('冲突预检', `${pre.conflicts.length} 处冲突`, pre.blocked && pre.conflicts.length > 0);

  // 6. 缺失依赖拒绝
  const depPkg = await pack.exportComponent({
    vaultRoot: sourceVault,
    types,
    id: 'oscar-brain',
    outDir: tmp('vm-dep-'),
    dependencies: [{ id: 'missing-core', version: '^2.0.0' }],
    overwrite: true,
  });
  let depCode = '';
  try {
    await inst.applyInstall({
      vaultRoot: targetVault,
      packageFile: depPkg.file,
      registry: loadRegistry(targetVault).registry,
      types,
    });
  } catch (err) {
    depCode = err.code;
  }
  record('缺失依赖拒绝', depCode, depCode === 'E_MISSING_DEPENDENCY');

  // 7. 卸载保护
  fs.appendFileSync(installedMain, '\n// 用户修改\n');
  const uninstall = await inst.applyUninstall({
    vaultRoot: targetVault,
    registry: loadRegistry(targetVault).registry,
    id: 'oscar-brain',
  });
  record(
    '卸载保护已修改文件',
    `删除 ${uninstall.removed.length}，保留 ${uninstall.kept.length}`,
    uninstall.status === 'partial' && fs.existsSync(installedMain),
  );

  // 8. 备份 → 恢复 → 内容比对
  const backupDir = tmp('vm-backup-');
  const created = await backup.createBackup({ vaultRoot: sourceVault, destDir: backupDir });
  const verified = await backup.verifyBackup(created.file);
  const restoredDir = path.join(tmp('vm-restore-'), 'copy');
  const restored = await backup.restoreBackup({ file: created.file, targetDir: restoredDir });
  const sourceHashes = hashTree(sourceVault, ['.obsidian/vault-meta/tmp']);
  const restoredHashes = hashTree(restoredDir);
  const mismatch = Object.keys(restoredHashes).filter((rel) => restoredHashes[rel] !== sourceHashes[rel]);
  record(
    '整库备份并恢复到另一目录',
    `${restored.restoredCount} 个文件 / ${created.totalText}`,
    verified.ok && mismatch.length === 0 && restored.restoredCount === created.fileCount,
  );

  // 9. 项目三位置只读检查：源码 / 云端元数据 / 当前库切片
  const projectSource = tmp('vm-project-src-');
  write(path.join(projectSource, 'manifest.json'), JSON.stringify({ id: 'demo-project', name: 'Demo Project', version: '1.0.0' }, null, 2));
  write(path.join(projectSource, 'main.js'), 'module.exports = {};\n');
  write(path.join(projectSource, '.git/config'), '[remote "origin"]\n\turl = https://github.com/example/demo.git\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n');
  write(path.join(projectSource, '.git/HEAD'), 'ref: refs/heads/main\n');
  write(path.join(projectSource, '.git/refs/heads/main'), `${'1'.repeat(40)}\n`);
  write(path.join(projectSource, '.git/refs/remotes/origin/main'), `${'1'.repeat(40)}\n`);

  const projectVault = tmp('vm-project-vault-');
  const projectInstall = '.obsidian/plugins/demo-project';
  const projectInstallAbs = path.join(projectVault, projectInstall);
  fs.mkdirSync(projectInstallAbs, { recursive: true });
  fs.copyFileSync(path.join(projectSource, 'manifest.json'), path.join(projectInstallAbs, 'manifest.json'));
  fs.copyFileSync(path.join(projectSource, 'main.js'), path.join(projectInstallAbs, 'main.js'));
  const projectFiles = [];
  for (const name of ['manifest.json', 'main.js']) {
    const abs = path.join(projectInstallAbs, name);
    projectFiles.push({ path: name, sha256: await sha256File(abs), size: fs.statSync(abs).size });
  }
  const projectRegistry = loadRegistry(projectVault).registry;
  projectRegistry.components['demo-project'] = {
    id: 'demo-project',
    name: 'Demo Project',
    version: '1.0.0',
    type: 'obsidian-plugin',
    source: { kind: 'vault', path: projectInstall, origin: '' },
    installLocation: projectInstall,
    files: projectFiles,
    dependencies: [],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'installed',
    snapshots: [],
  };
  saveRegistry(projectVault, projectRegistry);

  const sourceIdentity = await identity.sourceIdentity(projectSource);
  const artifact = await identity.artifactDigest(projectSource);
  const projectStore = projects.emptyProjects();
  const project = projects.upsertProject(projectStore, {
    id: projects.createProjectId('Demo Project', projectSource),
    name: 'Demo Project',
    purpose: '端到端只读检查',
    pluginId: 'demo-project',
    sourcePath: projectSource,
    remote: { url: 'https://github.com/example/demo', branch: 'main' },
    installLocation: projectInstall,
    baseline: {
      sourceIdentity: sourceIdentity.digest,
      sourceVersion: '1.0.0',
      commit: '1'.repeat(40),
      artifactSha256: artifact.sha256,
      recordedAt: new Date().toISOString(),
    },
  });
  projects.saveProjects(projectVault, projectStore);

  const sourceBefore = hashTree(projectSource);
  const installBefore = hashTree(projectInstallAbs);
  const vaultBefore = hashTree(projectVault);
  const inspection = await inspectProject({
    vaultRoot: projectVault,
    registry: loadRegistry(projectVault).registry,
    project,
  });
  const readonlyOk =
    inspection.source.status === 'ok'
    && inspection.runtime.status === 'ok'
    && JSON.stringify(hashTree(projectSource)) === JSON.stringify(sourceBefore)
    && JSON.stringify(hashTree(projectInstallAbs)) === JSON.stringify(installBefore)
    && JSON.stringify(hashTree(projectVault)) === JSON.stringify(vaultBefore);
  record(
    '项目三位置只读检查',
    `源码 ${inspection.source.version}，当前库 ${inspection.runtime.version}，云端未检查；目录未变`,
    readonlyOk,
  );

  report.ok = true;
  report.finishedAt = new Date().toISOString();
  report.artifacts = { package: pkg.file, backup: created.file, suite: suite.file };
  fs.writeFileSync(path.join(exportsDir, 'verify-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n全部通过 ${report.steps.length}/${report.steps.length}`);
  console.log(`报告：${path.join(exportsDir, 'verify-report.json')}`);
})().catch((err) => {
  report.ok = false;
  report.error = { message: err.message, code: err.code, details: err.details };
  console.error(`\n验证中止：${err.message}`);
  console.error(JSON.stringify(report.steps, null, 2));
  process.exit(1);
});
