'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDefaultTypeRegistry } = require('../src/core/types');
const { loadRegistry } = require('../src/core/registry');
const { exportComponent } = require('../src/core/packager');
const { preflightInstall, applyInstall, planUninstall, readComponentPackage } = require('../src/core/installer');
const { writeArchive, MANIFEST_PATH } = require('../src/core/archive');
const { COMPONENT_FORMAT } = require('../src/core/component-spec');
const { sha256File } = require('../src/core/fs-utils');
const { tempDir, writeFile, makeVault, makePlugin, readFile } = require('./helpers/vault');

const types = createDefaultTypeRegistry();

function cleanVault() {
  const root = tempDir('clean-vault-');
  writeFile(root, '.obsidian/app.json', '{}\n');
  return root;
}

async function buildPackage(vault, id, options) {
  const opts = options || {};
  const outDir = opts.outDir || tempDir('pkg-');
  return exportComponent({
    vaultRoot: vault,
    types,
    id,
    outDir,
    overwrite: true,
    dependencies: opts.dependencies || [],
  });
}

async function craftPackage(specOverrides, payloadFiles) {
  const dir = tempDir('craft-');
  const specFiles = [];
  for (const item of payloadFiles) {
    specFiles.push({ path: item.path, sha256: await sha256File(item.abs), size: fs.statSync(item.abs).size });
  }
  const spec = {
    format: COMPONENT_FORMAT,
    id: 'demo',
    name: 'Demo',
    purpose: '测试组件',
    version: '1.0.0',
    type: 'obsidian-plugin',
    install: { location: '.obsidian/plugins/demo' },
    files: specFiles,
    dependencies: [],
    ...specOverrides,
  };
  if (specOverrides && specOverrides.files) spec.files = specOverrides.files;
  const file = path.join(dir, 'crafted.vmpkg');
  await writeArchive(file, {
    kind: 'component',
    meta: { component: spec },
    files: payloadFiles.map((item) => ({ path: item.path, abs: item.abs })),
  });
  return { file, spec };
}

test('全新安装写入文件并登记完整元数据，且不包含 data.json', async () => {
  const source = makeVault();
  const pkg = await buildPackage(source, 'demo');
  const target = cleanVault();
  const registry = loadRegistry(target).registry;

  const pre = await preflightInstall({ vaultRoot: target, packageFile: pkg.file, registry, types });
  assert.equal(pre.action, 'install');
  assert.equal(pre.blocked, false);
  assert.equal(pre.fileCount, 3);

  const result = await applyInstall({ vaultRoot: target, packageFile: pkg.file, registry, types });
  assert.equal(result.action, 'install');
  assert.equal(result.record.version, '1.0.0');
  assert.equal(result.record.type, 'obsidian-plugin');
  assert.equal(result.record.installLocation, '.obsidian/plugins/demo');
  assert.equal(result.record.files.length, 3);
  assert.ok(result.record.purpose !== undefined);
  assert.ok(result.record.source.kind);
  assert.ok(Array.isArray(result.record.dependencies));

  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/main.js')));
  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/styles.css')));
  assert.ok(!fs.existsSync(path.join(target, '.obsidian/plugins/demo/data.json')));
  assert.ok(!fs.existsSync(path.join(target, '.obsidian/plugins/demo/main.js.map')));

  const loaded = loadRegistry(target).registry;
  assert.equal(loaded.components.demo.version, '1.0.0');
  assert.equal(loaded.components.demo.status, 'installed');
});

test('未登记的不同内容文件构成冲突，安装被拒绝且不写盘', async () => {
  const source = makeVault();
  const pkg = await buildPackage(source, 'demo');
  const target = cleanVault();
  writeFile(target, '.obsidian/plugins/demo/main.js', '// 用户自己的文件\n');
  const registry = loadRegistry(target).registry;

  const pre = await preflightInstall({ vaultRoot: target, packageFile: pkg.file, registry, types });
  assert.equal(pre.blocked, true);
  assert.equal(pre.conflicts[0].reason, 'unmanaged-file');

  await assert.rejects(
    () => applyInstall({ vaultRoot: target, packageFile: pkg.file, registry, types }),
    (err) => err.code === 'E_CONFLICT',
  );
  assert.equal(readFile(target, '.obsidian/plugins/demo/main.js'), '// 用户自己的文件\n');
  assert.equal(loadRegistry(target).exists, false);
});

test('其他组件已拥有的同名文件构成冲突', async () => {
  const source = makeVault();
  const pkg = await buildPackage(source, 'demo');
  const other = makeVault({ pluginId: 'other' });
  const otherPkg = await buildPackage(other, 'other');
  const target = cleanVault();

  let registry = loadRegistry(target).registry;
  await applyInstall({ vaultRoot: target, packageFile: otherPkg.file, registry, types });

  // 手工把 other 的登记位置改到 demo 的位置，模拟归属冲突
  registry = loadRegistry(target).registry;
  registry.components.other.installLocation = '.obsidian/plugins/demo';
  registry.components.other.files = [{ path: 'main.js', sha256: '0'.repeat(64), size: 1 }];
  writeFile(target, '.obsidian/plugins/demo/main.js', '// 归 other 所有\n');

  const pre = await preflightInstall({ vaultRoot: target, packageFile: pkg.file, registry, types });
  assert.equal(pre.blocked, true);
  assert.equal(pre.conflicts[0].reason, 'owned-by-another');
});

test('缺失依赖与版本不满足都会阻止安装', async () => {
  const source = makeVault();
  const pkg = await buildPackage(source, 'demo', { dependencies: [{ id: 'core-lib', version: '^1.0.0' }] });
  const target = cleanVault();
  let registry = loadRegistry(target).registry;

  let pre = await preflightInstall({ vaultRoot: target, packageFile: pkg.file, registry, types });
  assert.equal(pre.blocked, true);
  assert.equal(pre.missingDependencies[0].reason, 'not-installed');
  await assert.rejects(
    () => applyInstall({ vaultRoot: target, packageFile: pkg.file, registry, types }),
    (err) => err.code === 'E_MISSING_DEPENDENCY',
  );

  pre = await preflightInstall({
    vaultRoot: target,
    packageFile: pkg.file,
    registry,
    types,
    available: [{ id: 'core-lib', version: '1.2.0' }],
  });
  assert.equal(pre.blocked, false);

  pre = await preflightInstall({
    vaultRoot: target,
    packageFile: pkg.file,
    registry,
    types,
    available: [{ id: 'core-lib', version: '2.0.0' }],
  });
  assert.equal(pre.blocked, true);
  assert.equal(pre.missingDependencies[0].reason, 'version-mismatch');
});

test('升级前建立快照，登记真实版本', async () => {
  const source = makeVault();
  const pkgV1 = await buildPackage(source, 'demo');
  const target = cleanVault();
  let registry = loadRegistry(target).registry;
  await applyInstall({ vaultRoot: target, packageFile: pkgV1.file, registry, types });
  const v1Body = readFile(target, '.obsidian/plugins/demo/main.js');

  makePlugin(source, 'demo', { version: '1.1.0', main: "module.exports = 'v2';\n" });
  const pkgV2 = await buildPackage(source, 'demo');
  registry = loadRegistry(target).registry;
  const result = await applyInstall({ vaultRoot: target, packageFile: pkgV2.file, registry, types });

  assert.equal(result.action, 'upgrade');
  assert.equal(result.record.version, '1.1.0');
  assert.equal(result.record.snapshots.length, 2);
  assert.equal(readFile(target, '.obsidian/plugins/demo/main.js'), "module.exports = 'v2';\n");

  const latest = result.record.snapshots[result.record.snapshots.length - 1];
  const snapshotFile = path.join(target, latest.path, 'files', 'main.js');
  assert.equal(fs.readFileSync(snapshotFile, 'utf8'), v1Body);
  assert.equal(loadRegistry(target).registry.components.demo.version, '1.1.0');
});

test('安装后校验失败会回滚原文件与登记表', async () => {
  const source = makeVault();
  const pkgV1 = await buildPackage(source, 'demo');
  const target = cleanVault();
  const registry = loadRegistry(target).registry;
  await applyInstall({ vaultRoot: target, packageFile: pkgV1.file, registry, types });
  const before = readFile(target, '.obsidian/plugins/demo/main.js');

  const pluginDir = path.join(source, '.obsidian/plugins/demo');
  const bad = await craftPackage(
    {
      version: '9.9.9',
      files: [
        { path: 'manifest.json', sha256: await sha256File(path.join(pluginDir, 'manifest.json')), size: fs.statSync(path.join(pluginDir, 'manifest.json')).size },
        { path: 'main.js', sha256: await sha256File(path.join(pluginDir, 'main.js')), size: fs.statSync(path.join(pluginDir, 'main.js')).size },
        { path: 'styles.css', sha256: await sha256File(path.join(pluginDir, 'styles.css')), size: fs.statSync(path.join(pluginDir, 'styles.css')).size },
      ],
    },
    [
      { path: 'manifest.json', abs: path.join(pluginDir, 'manifest.json') },
      { path: 'main.js', abs: path.join(pluginDir, 'main.js') },
      { path: 'styles.css', abs: path.join(pluginDir, 'styles.css') },
    ],
  );

  await assert.rejects(
    () => applyInstall({ vaultRoot: target, packageFile: bad.file, registry, types }),
    (err) => err.code === 'E_INVALID_SPEC' && /已回滚/.test(err.message) && err.details.rollback.ok === true,
  );
  assert.equal(readFile(target, '.obsidian/plugins/demo/main.js'), before);
  assert.equal(loadRegistry(target).registry.components.demo.version, '1.0.0');
});

test('失败快照保留并标记 failed', async () => {
  const source = makeVault();
  const pkgV1 = await buildPackage(source, 'demo');
  const target = cleanVault();
  const registry = loadRegistry(target).registry;
  await applyInstall({ vaultRoot: target, packageFile: pkgV1.file, registry, types });

  const pluginDir = path.join(source, '.obsidian/plugins/demo');
  const names = ['manifest.json', 'main.js', 'styles.css'];
  const files = [];
  for (const name of names) {
    const abs = path.join(pluginDir, name);
    files.push({ path: name, sha256: await sha256File(abs), size: fs.statSync(abs).size });
  }
  const bad = await craftPackage({ version: '9.9.9', files }, names.map((name) => ({ path: name, abs: path.join(pluginDir, name) })));

  let snapshotPath = '';
  try {
    await applyInstall({ vaultRoot: target, packageFile: bad.file, registry, types });
  } catch (err) {
    snapshotPath = err.details.snapshot.path;
  }
  assert.ok(snapshotPath);
  const meta = JSON.parse(fs.readFileSync(path.join(target, snapshotPath, 'snapshot.json'), 'utf8'));
  assert.equal(meta.failed, true);
  assert.ok(fs.existsSync(path.join(target, snapshotPath, 'files', 'main.js')));
});

test('组件包描述与内容不一致时拒绝打开', async () => {
  const dir = tempDir('mismatch-');
  writeFile(dir, 'main.js', 'x');
  const manifest = {
    format: 'vault-meta/archive@1',
    kind: 'component',
    createdAt: new Date().toISOString(),
    meta: {
      component: {
        format: COMPONENT_FORMAT,
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        type: 'obsidian-plugin',
        install: { location: '.obsidian/plugins/demo' },
        files: [
          { path: 'main.js', sha256: 'a'.repeat(64), size: 1 },
          { path: 'manifest.json', sha256: 'b'.repeat(64), size: 1 },
        ],
      },
    },
    fileCount: 1,
    totalBytes: 1,
    entries: [{ path: 'main.js', size: 1, mode: 420, mtimeMs: 0, sha256: 'c'.repeat(64) }],
  };
  const file = path.join(dir, 'bad.vmpkg');
  const { writeTarGz } = require('../src/core/tar');
  await writeTarGz(file, [
    { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'payload/main.js', data: Buffer.from('x') },
  ]);
  await assert.rejects(() => readComponentPackage(file), (err) => err.code === 'E_CHECKSUM_MISMATCH');
});

test('越界安装位置、绝对文件路径与符号链接逃逸都被拒绝', async () => {
  const target = cleanVault();
  const registry = loadRegistry(target).registry;

  const outsideFile = path.join(tempDir('payload-'), 'main.js');
  fs.writeFileSync(outsideFile, 'x');
  const escape = await craftPackage(
    { id: 'escape', install: { location: '../outside' }, files: [{ path: 'main.js', sha256: await sha256File(outsideFile), size: 1 }] },
    [{ path: 'main.js', abs: outsideFile }],
  );
  await assert.rejects(
    () => preflightInstall({ vaultRoot: target, packageFile: escape.file, registry, types }),
    (err) => err.code === 'E_PATH_TRAVERSAL',
  );

  const absolute = await craftPackage(
    { id: 'absolute', files: [{ path: '/etc/passwd', sha256: await sha256File(outsideFile), size: 1 }] },
    [{ path: 'main.js', abs: outsideFile }],
  );
  await assert.rejects(
    () => preflightInstall({ vaultRoot: target, packageFile: absolute.file, registry, types }),
    (err) => err.code === 'E_PATH_ABSOLUTE',
  );

  const outsideDir = tempDir('outside-dir-');
  fs.mkdirSync(path.join(target, '.obsidian/plugins'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(target, '.obsidian/plugins/demo'), 'dir');
  const normal = await craftPackage(
    {
      id: 'demo',
      files: [
        { path: 'main.js', sha256: await sha256File(outsideFile), size: 1 },
        { path: 'manifest.json', sha256: await sha256File(outsideFile), size: 1 },
      ],
    },
    [
      { path: 'main.js', abs: outsideFile },
      { path: 'manifest.json', abs: outsideFile },
    ],
  );
  await assert.rejects(
    () => preflightInstall({ vaultRoot: target, packageFile: normal.file, registry, types }),
    (err) => err.code === 'E_SYMLINK_ESCAPE',
  );
  assert.equal(fs.readdirSync(outsideDir).length, 0);
});

test('未实现的组件类型被明确拒绝', async () => {
  const target = cleanVault();
  const file = path.join(tempDir('type-'), 'main.js');
  fs.writeFileSync(file, 'x');
  const pkg = await craftPackage(
    { type: 'theme', id: 'theme-demo', files: [{ path: 'main.js', sha256: await sha256File(file), size: 1 }] },
    [{ path: 'main.js', abs: file }],
  );
  await assert.rejects(
    () => preflightInstall({ vaultRoot: target, packageFile: pkg.file, registry: loadRegistry(target).registry, types }),
    (err) => err.code === 'E_UNSUPPORTED_TYPE' && err.details.registered.includes('obsidian-plugin'),
  );
});


test('父子安装目录重叠时按完整相对路径判定归属，拒绝写入', async () => {
  const target = cleanVault();
  let registry = loadRegistry(target).registry;

  const payloadDir = tempDir('overlap-');
  const shared = path.join(payloadDir, 'a.md');
  fs.writeFileSync(shared, '# 同一份内容\n');
  const sha = await sha256File(shared);
  const size = fs.statSync(shared).size;

  const alpha = await craftPackage(
    {
      id: 'alpha',
      name: 'Alpha',
      type: 'files',
      install: { location: 'Templates' },
      files: [{ path: 'nested/a.md', sha256: sha, size }],
    },
    [{ path: 'nested/a.md', abs: shared }],
  );
  await applyInstall({ vaultRoot: target, packageFile: alpha.file, registry, types });
  assert.ok(fs.existsSync(path.join(target, 'Templates/nested/a.md')));

  const beta = await craftPackage(
    {
      id: 'beta',
      name: 'Beta',
      type: 'files',
      install: { location: 'Templates/nested' },
      files: [{ path: 'a.md', sha256: sha, size }],
    },
    [{ path: 'a.md', abs: shared }],
  );

  registry = loadRegistry(target).registry;
  const pre = await preflightInstall({ vaultRoot: target, packageFile: beta.file, registry, types });
  assert.equal(pre.blocked, true);
  assert.equal(pre.conflicts[0].reason, 'owned-by-another');
  assert.equal(pre.conflicts[0].ownerId, 'alpha');

  await assert.rejects(
    () => applyInstall({ vaultRoot: target, packageFile: beta.file, registry, types }),
    (err) => err.code === 'E_CONFLICT',
  );
  assert.equal(loadRegistry(target).registry.components.beta, undefined);
  assert.equal(fs.readFileSync(path.join(target, 'Templates/nested/a.md'), 'utf8'), '# 同一份内容\n');
});

test('卸载时同一完整路径被其他组件登记为归属则保留文件', async () => {
  const target = cleanVault();
  const registry = loadRegistry(target).registry;
  const payloadDir = tempDir('claim-');
  const shared = path.join(payloadDir, 'a.md');
  fs.writeFileSync(shared, 'x');
  const sha = await sha256File(shared);
  const size = fs.statSync(shared).size;
  const pkg = await craftPackage(
    {
      id: 'beta',
      name: 'Beta',
      type: 'files',
      install: { location: 'Templates/nested' },
      files: [{ path: 'a.md', sha256: sha, size }],
    },
    [{ path: 'a.md', abs: shared }],
  );
  await applyInstall({ vaultRoot: target, packageFile: pkg.file, registry, types });

  const loaded = loadRegistry(target).registry;
  loaded.components.alpha = {
    id: 'alpha',
    name: 'Alpha',
    version: '1.0.0',
    type: 'files',
    installLocation: 'Templates',
    files: [{ path: 'nested/a.md', sha256: sha, size }],
    dependencies: [],
    status: 'installed',
    snapshots: [],
  };
  const plan = await planUninstall({ vaultRoot: target, registry: loaded, id: 'beta' });
  assert.equal(plan.remove.length, 0);
  assert.equal(plan.keep[0].reason, 'claimed-by-other');
  assert.ok(fs.existsSync(path.join(target, 'Templates/nested/a.md')));
});

test('同一时刻的连续安装不会复用快照目录', async () => {
  const source = makeVault();
  const pkg = await buildPackage(source, 'demo');
  const target = cleanVault();
  const fixed = new Date('2026-10-24T00:00:00Z');

  const first = await applyInstall({ vaultRoot: target, packageFile: pkg.file, registry: loadRegistry(target).registry, types, now: fixed });
  const firstSnapshotMeta = fs.readFileSync(path.join(target, first.snapshot.path, 'snapshot.json'), 'utf8');
  const second = await applyInstall({ vaultRoot: target, packageFile: pkg.file, registry: loadRegistry(target).registry, types, now: fixed });

  assert.notEqual(first.snapshot.path, second.snapshot.path);
  assert.equal(fs.readFileSync(path.join(target, first.snapshot.path, 'snapshot.json'), 'utf8'), firstSnapshotMeta);
  assert.equal(fs.existsSync(path.join(target, first.snapshot.path, 'files', 'main.js')), false);
  assert.equal(fs.existsSync(path.join(target, second.snapshot.path, 'snapshot.json')), true);
  assert.equal(fs.existsSync(path.join(target, second.snapshot.path, 'files', 'main.js')), true);
  const record = loadRegistry(target).registry.components.demo;
  assert.equal(new Set(record.snapshots.map((item) => item.path)).size, record.snapshots.length);
});

test('失败快照与后续成功快照相互独立', async () => {
  const source = makeVault();
  const pkg = await buildPackage(source, 'demo');
  const target = cleanVault();
  const fixed = new Date('2026-10-24T00:00:00Z');
  await applyInstall({ vaultRoot: target, packageFile: pkg.file, registry: loadRegistry(target).registry, types, now: fixed });

  const pluginDir = path.join(source, '.obsidian/plugins/demo');
  const names = ['manifest.json', 'main.js', 'styles.css'];
  const files = [];
  for (const name of names) {
    const abs = path.join(pluginDir, name);
    files.push({ path: name, sha256: await sha256File(abs), size: fs.statSync(abs).size });
  }
  const bad = await craftPackage({ version: '9.9.9', files }, names.map((name) => ({ path: name, abs: path.join(pluginDir, name) })));

  let failedSnapshot = '';
  try {
    await applyInstall({ vaultRoot: target, packageFile: bad.file, registry: loadRegistry(target).registry, types, now: fixed });
  } catch (err) {
    failedSnapshot = err.details.snapshot.path;
  }
  const success = await applyInstall({ vaultRoot: target, packageFile: pkg.file, registry: loadRegistry(target).registry, types, now: fixed });

  assert.ok(failedSnapshot);
  assert.notEqual(failedSnapshot, success.snapshot.path);
  const failedMeta = JSON.parse(fs.readFileSync(path.join(target, failedSnapshot, 'snapshot.json'), 'utf8'));
  assert.equal(failedMeta.failed, true);
  assert.equal(fs.existsSync(path.join(target, failedSnapshot, 'files', 'main.js')), true);
});
