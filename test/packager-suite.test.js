'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDefaultTypeRegistry, assertNoPrivateFiles } = require('../src/core/types');
const { loadRegistry } = require('../src/core/registry');
const { exportComponent, inspectComponentPackage, exportSuite } = require('../src/core/packager');
const { applyInstall } = require('../src/core/installer');
const { verifyArchive, readArchiveManifest, extractArchive } = require('../src/core/archive');
const { tempDir, writeFile, makeVault, readFile } = require('./helpers/vault');

const types = createDefaultTypeRegistry();

test('插件导出包含核心文件、排除 data.json 与 sourcemap，描述字段完整', async () => {
  const vault = makeVault();
  writeFile(vault, '.obsidian/plugins/demo/main.js.map', '{"version":3}\n');
  const pkg = await exportComponent({
    vaultRoot: vault,
    types,
    id: 'demo',
    purpose: '演示插件',
    outDir: tempDir('out-'),
  });

  assert.equal(pkg.spec.format, 'vault-meta/component@1');
  assert.equal(pkg.spec.id, 'demo');
  assert.equal(pkg.spec.version, '1.0.0');
  assert.equal(pkg.spec.type, 'obsidian-plugin');
  assert.equal(pkg.spec.purpose, '演示插件');
  assert.equal(pkg.spec.install.location, '.obsidian/plugins/demo');
  assert.deepEqual(pkg.spec.files.map((file) => file.path).sort(), ['main.js', 'manifest.json', 'styles.css']);

  const verified = await verifyArchive(pkg.file);
  assert.equal(verified.ok, true);
  assert.ok(!verified.manifest.entries.some((entry) => entry.path.endsWith('data.json')));
  assert.ok(!verified.manifest.entries.some((entry) => entry.path.endsWith('.map')));
});

test('文件组件可打包，私有数据不会进入安装包', async () => {
  const vault = makeVault();
  writeFile(vault, 'Templates/kit/a.md', '# A\n');
  writeFile(vault, 'Templates/kit/nested/b.md', '# B\n');
  writeFile(vault, 'Templates/kit/.env', 'SECRET=1\n');
  writeFile(vault, 'Templates/kit/data.json', '{"token":"x"}\n');

  const pkg = await exportComponent({
    vaultRoot: vault,
    types,
    id: 'kit',
    type: 'files',
    version: '0.1.0',
    sourceDirRel: 'Templates/kit',
    installLocation: 'Templates/kit',
    outDir: tempDir('out-'),
  });
  const paths = pkg.spec.files.map((file) => file.path);
  assert.deepEqual(paths, ['a.md', 'nested/b.md']);
  assert.ok(!paths.includes('.env'));
  assert.ok(!paths.includes('data.json'));

  assert.throws(() => assertNoPrivateFiles(['ok.md', 'secret.pem']), (err) => err.code === 'E_PRIVATE_DATA');
});

test('inspectComponentPackage 返回描述信息', async () => {
  const vault = makeVault();
  const pkg = await exportComponent({ vaultRoot: vault, types, id: 'demo', outDir: tempDir('out-') });
  const info = await inspectComponentPackage(pkg.file);
  assert.equal(info.spec.id, 'demo');
  assert.equal(info.fileCount, 3);
});

test('套装导出解析版本并自动补齐必需依赖', async () => {
  const vault = makeVault({ plugins: false });
  writeFile(vault, '.obsidian/app.json', '{}\n');
  // alpha
  const alphaDir = path.join(vault, '.obsidian/plugins/alpha');
  writeFile(vault, '.obsidian/plugins/alpha/manifest.json', JSON.stringify({ id: 'alpha', name: 'Alpha', version: '1.0.0', minAppVersion: '1.5.0' }));
  writeFile(vault, '.obsidian/plugins/alpha/main.js', 'alpha');
  writeFile(vault, '.obsidian/plugins/alpha/styles.css', '.a{}');
  // beta 依赖 alpha
  writeFile(vault, '.obsidian/plugins/beta/manifest.json', JSON.stringify({ id: 'beta', name: 'Beta', version: '2.0.0', minAppVersion: '1.5.0' }));
  writeFile(vault, '.obsidian/plugins/beta/main.js', 'beta');
  writeFile(vault, '.obsidian/plugins/beta/styles.css', '.b{}');

  const outDir = tempDir('suite-');
  const alphaPkg = await exportComponent({ vaultRoot: vault, types, id: 'alpha', outDir, overwrite: true });
  const betaPkg = await exportComponent({
    vaultRoot: vault,
    types,
    id: 'beta',
    outDir,
    overwrite: true,
    dependencies: [{ id: 'alpha', version: '^1.0.0' }],
  });

  const target = tempDir('suite-vault-');
  writeFile(target, '.obsidian/app.json', '{}\n');
  let registry = loadRegistry(target).registry;
  await applyInstall({ vaultRoot: target, packageFile: alphaPkg.file, registry, types });
  registry = loadRegistry(target).registry;
  await applyInstall({ vaultRoot: target, packageFile: betaPkg.file, registry, types });

  const result = await exportSuite({
    vaultRoot: target,
    registry: loadRegistry(target).registry,
    types,
    outDir,
    suite: {
      format: 'vault-meta/suite@1',
      id: 'base',
      name: '基础套装',
      version: '1.0.0',
      components: [{ id: 'beta' }],
    },
  });

  assert.deepEqual(result.components.map((item) => `${item.id}@${item.version}`).sort(), ['alpha@1.0.0', 'beta@2.0.0']);
  assert.deepEqual(result.autoIncluded, ['alpha']);

  const manifest = await readArchiveManifest(result.file);
  assert.equal(manifest.kind, 'suite');
  assert.equal(manifest.meta.suite.id, 'base');
  const entries = manifest.entries.map((entry) => entry.path);
  assert.ok(entries.includes('suite.json'));
  assert.ok(entries.some((item) => item.startsWith('components/alpha/')));
  assert.ok(entries.some((item) => item.startsWith('components/beta/')));

  const extracted = path.join(tempDir('suite-out-'), 'x');
  fs.mkdirSync(extracted, { recursive: true });
  await extractArchive(result.file, extracted);
  const suiteDoc = JSON.parse(readFile(extracted, 'suite.json'));
  assert.equal(suiteDoc.components.length, 2);
  assert.ok(fs.existsSync(path.join(extracted, suiteDoc.components[0].path)));
});

test('套装缺少依赖或版本不符时报错', async () => {
  const vault = makeVault({ plugins: false });
  writeFile(vault, '.obsidian/app.json', '{}\n');
  writeFile(vault, '.obsidian/plugins/beta/manifest.json', JSON.stringify({ id: 'beta', name: 'Beta', version: '2.0.0', minAppVersion: '1.5.0' }));
  writeFile(vault, '.obsidian/plugins/beta/main.js', 'beta');
  writeFile(vault, '.obsidian/plugins/beta/styles.css', '.b{}');
  const outDir = tempDir('suite2-');
  const betaPkg = await exportComponent({
    vaultRoot: vault,
    types,
    id: 'beta',
    outDir,
    dependencies: [{ id: 'gamma', version: '^1.0.0' }],
  });

  const target = tempDir('suite2-vault-');
  writeFile(target, '.obsidian/app.json', '{}\n');
  const registry = loadRegistry(target).registry;
  await applyInstall({
    vaultRoot: target,
    packageFile: betaPkg.file,
    registry,
    types,
    available: [{ id: 'gamma', version: '1.0.0' }],
  });

  await assert.rejects(
    () =>
      exportSuite({
        vaultRoot: target,
        registry: loadRegistry(target).registry,
        types,
        outDir,
        suite: { format: 'vault-meta/suite@1', id: 's', name: 'S', version: '1.0.0', components: [{ id: 'beta' }] },
      }),
    (err) => err.code === 'E_MISSING_DEPENDENCY' && err.details.id === 'gamma',
  );

  await assert.rejects(
    () =>
      exportSuite({
        vaultRoot: target,
        registry: loadRegistry(target).registry,
        types,
        outDir,
        suite: { format: 'vault-meta/suite@1', id: 's', name: 'S', version: '1.0.0', components: [{ id: 'beta', version: '9.9.9' }] },
      }),
    (err) => err.code === 'E_MISSING_DEPENDENCY',
  );
});
