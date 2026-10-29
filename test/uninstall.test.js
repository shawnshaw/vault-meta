'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDefaultTypeRegistry } = require('../src/core/types');
const { loadRegistry } = require('../src/core/registry');
const { exportComponent } = require('../src/core/packager');
const { applyInstall, planUninstall, applyUninstall } = require('../src/core/installer');
const { tempDir, writeFile, makeVault, readFile } = require('./helpers/vault');

const types = createDefaultTypeRegistry();

async function installDemo(vault) {
  const source = makeVault();
  const pkg = await exportComponent({ vaultRoot: source, types, id: 'demo', outDir: tempDir('pkg-'), overwrite: true });
  const target = tempDir('target-');
  writeFile(target, '.obsidian/app.json', '{}\n');
  const registry = loadRegistry(target).registry;
  await applyInstall({ vaultRoot: target, packageFile: pkg.file, registry, types });
  return target;
}

test('卸载只删除未改动文件，保留用户数据与已修改文件', async () => {
  const target = await installDemo();
  // 用户在插件目录里写入自己的数据
  writeFile(target, '.obsidian/plugins/demo/data.json', '{"token":"user"}\n');
  writeFile(target, '.obsidian/plugins/demo/my-note.md', '用户笔记\n');
  fs.appendFileSync(path.join(target, '.obsidian/plugins/demo/main.js'), '\n// 用户手动修改\n');

  const registry = loadRegistry(target).registry;
  const plan = await planUninstall({ vaultRoot: target, registry, id: 'demo' });
  assert.deepEqual(plan.keep.map((item) => item.path), ['main.js']);
  assert.ok(plan.remove.includes('styles.css'));
  assert.ok(plan.remove.includes('manifest.json'));

  const result = await applyUninstall({ vaultRoot: target, registry, id: 'demo' });
  assert.equal(result.status, 'partial');
  assert.equal(result.removed.length, 2);
  assert.ok(result.kept.some((item) => item.path === 'main.js'));

  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/main.js')));
  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/data.json')));
  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/my-note.md')));
  assert.ok(!fs.existsSync(path.join(target, '.obsidian/plugins/demo/styles.css')));
  assert.equal(readFile(target, '.obsidian/plugins/demo/data.json'), '{"token":"user"}\n');

  const record = loadRegistry(target).registry.components.demo;
  assert.equal(record.status, 'partial');
  assert.equal(record.files.length, 1);
  assert.equal(record.files[0].path, 'main.js');
});

test('全部文件未改动时卸载干净并移除登记', async () => {
  const target = await installDemo();
  const registry = loadRegistry(target).registry;
  const result = await applyUninstall({ vaultRoot: target, registry, id: 'demo' });
  assert.equal(result.status, 'removed');
  assert.equal(result.removed.length, 3);
  assert.equal(fs.existsSync(path.join(target, '.obsidian/plugins/demo')), false);
  assert.equal(loadRegistry(target).registry.components.demo, undefined);
});

test('用户数据存在时保留目录但不保留登记', async () => {
  const target = await installDemo();
  writeFile(target, '.obsidian/plugins/demo/data.json', '{}\n');
  const registry = loadRegistry(target).registry;
  const result = await applyUninstall({ vaultRoot: target, registry, id: 'demo' });
  assert.equal(result.status, 'removed');
  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/data.json')));
  assert.equal(loadRegistry(target).registry.components.demo, undefined);
});

test('卸载未登记组件报错', async () => {
  const target = tempDir('target-');
  writeFile(target, '.obsidian/app.json', '{}\n');
  const registry = loadRegistry(target).registry;
  await assert.rejects(
    () => applyUninstall({ vaultRoot: target, registry, id: 'ghost' }),
    (err) => err.code === 'E_NOT_FOUND',
  );
});
