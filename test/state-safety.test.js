'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDefaultTypeRegistry } = require('../src/core/types');
const { loadRegistry } = require('../src/core/registry');
const { exportComponent } = require('../src/core/packager');
const { applyInstall } = require('../src/core/installer');
const { tempDir, makeVault } = require('./helpers/vault');

const types = createDefaultTypeRegistry();

async function makePackage() {
  const source = makeVault();
  return exportComponent({ vaultRoot: source, types, id: 'demo', outDir: tempDir('pkg-'), overwrite: true });
}

test('状态根目录被符号链接到外部时拒绝安装且外部无变化', async () => {
  const vault = makeVault();
  const outside = tempDir('outside-root-');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  try {
    fs.unlinkSync(path.join(vault, '.obsidian', 'vault-meta'));
  } catch (err) {
    /* 可能不存在 */
  }
  fs.symlinkSync(outside, path.join(vault, '.obsidian', 'vault-meta'), 'dir');
  const pkg = await makePackage();

  assert.throws(() => loadRegistry(vault), (err) => err.code === 'E_SYMLINK_ESCAPE');
  await assert.rejects(
    () => applyInstall({ vaultRoot: vault, packageFile: pkg.file, registry: { components: {} }, types }),
    (err) => err.code === 'E_SYMLINK_ESCAPE',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('snapshots 子目录被符号链接到外部时拒绝安装', async () => {
  const vault = makeVault();
  const outside = tempDir('outside-snap-');
  const stateRoot = path.join(vault, '.obsidian', 'vault-meta');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'registry.json'), JSON.stringify({ format: 'vault-meta/registry@1', components: {} }));
  const registry = loadRegistry(vault).registry;
  fs.symlinkSync(outside, path.join(stateRoot, 'snapshots'), 'dir');
  const pkg = await makePackage();

  await assert.rejects(
    () => applyInstall({ vaultRoot: vault, packageFile: pkg.file, registry, types }),
    (err) => err.code === 'E_SYMLINK_ESCAPE',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('tmp 子目录被符号链接到外部时拒绝安装', async () => {
  const vault = makeVault();
  const outside = tempDir('outside-tmp-');
  const stateRoot = path.join(vault, '.obsidian', 'vault-meta');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'registry.json'), JSON.stringify({ format: 'vault-meta/registry@1', components: {} }));
  const registry = loadRegistry(vault).registry;
  fs.symlinkSync(outside, path.join(stateRoot, 'tmp'), 'dir');
  const pkg = await makePackage();

  await assert.rejects(
    () => applyInstall({ vaultRoot: vault, packageFile: pkg.file, registry, types }),
    (err) => err.code === 'E_SYMLINK_ESCAPE',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});
