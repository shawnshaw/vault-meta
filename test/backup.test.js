'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createBackup, listBackups, verifyBackup, restoreBackup } = require('../src/core/backup');
const { readArchiveManifest, writeArchive } = require('../src/core/archive');
const { tempDir, writeFile, makeVault, hashTree } = require('./helpers/vault');
const { validatePath } = require('../src/ui/pickers');

function addNoise(vault) {
  writeFile(vault, '.git/HEAD', 'ref: refs/heads/main\n');
  writeFile(vault, '.git/objects/pack/a.pack', Buffer.from([1, 2, 3]));
  writeFile(vault, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  writeFile(vault, '.trash/old.md', 'old\n');
  writeFile(vault, '.DS_Store', 'junk');
  writeFile(vault, '.obsidian/vault-meta/tmp/scratch.txt', 'tmp\n');
  writeFile(vault, '.obsidian/vault-meta/snapshots/demo/1/snapshot.json', '{}\n');
  writeFile(vault, '.obsidian/vault-meta/registry.json', '{"format":"vault-meta/registry@1","components":{}}\n');
}

test('整库备份包含笔记与配置，排除噪声与备份目录自身', async () => {
  const vault = makeVault();
  addNoise(vault);
  const dest = tempDir('backup-dest-');
  const result = await createBackup({ vaultRoot: vault, destDir: dest });

  const manifest = await readArchiveManifest(result.file);
  const paths = manifest.entries.map((entry) => entry.path);
  assert.ok(paths.includes('note.md'));
  assert.ok(paths.includes('.obsidian/app.json'));
  assert.ok(paths.includes('.obsidian/vault-meta/registry.json'));
  assert.ok(!paths.some((item) => item.startsWith('.git/')));
  assert.ok(!paths.some((item) => item.includes('node_modules/')));
  assert.ok(!paths.some((item) => item.startsWith('.trash/')));
  assert.ok(!paths.some((item) => item.endsWith('.DS_Store')));
  assert.ok(!paths.some((item) => item.startsWith('.obsidian/vault-meta/tmp/')));
  assert.ok(!paths.some((item) => item.startsWith('.obsidian/vault-meta/snapshots/')));
  assert.equal(result.destInsideVault, false);
  assert.ok(manifest.meta.scope);
  assert.ok(manifest.createdAt);

  const verified = await verifyBackup(result.file);
  assert.equal(verified.ok, true);
  assert.equal(verified.checked, manifest.entries.length);
});

test('备份目录位于 vault 内时不会把备份包递归打包', async () => {
  const vault = makeVault();
  const inside = path.join(vault, '.vault-backups');
  const first = await createBackup({ vaultRoot: vault, destDir: inside });
  assert.equal(first.destInsideVault, true);
  const second = await createBackup({ vaultRoot: vault, destDir: inside });
  const manifest = await readArchiveManifest(second.file);
  const paths = manifest.entries.map((entry) => entry.path);
  assert.ok(!paths.some((item) => item.startsWith('.vault-backups/')));
  const listed = await listBackups(inside);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((item) => item.error === null));
});

test('显式包含 .git 与 node_modules 时按范围备份', async () => {
  const vault = makeVault();
  addNoise(vault);
  const dest = tempDir('backup-scope-');
  const result = await createBackup({
    vaultRoot: vault,
    destDir: dest,
    include: { git: true, nodeModules: true },
  });
  const manifest = await readArchiveManifest(result.file);
  const paths = manifest.entries.map((entry) => entry.path);
  assert.ok(paths.includes('.git/HEAD'));
  assert.ok(paths.some((item) => item.startsWith('node_modules/')));
});

test('恢复必须写入空目录，并逐文件核验', async () => {
  const vault = makeVault();
  const dest = tempDir('backup-src-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });

  const target = path.join(tempDir('restore-'), 'vault-copy');
  const result = await restoreBackup({ file: backup.file, targetDir: target });
  assert.equal(result.verified, true);
  assert.ok(result.restoredCount > 0);
  assert.equal(fs.readFileSync(path.join(target, 'note.md'), 'utf8'), '# 测试笔记\n\n内容\n');
  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/main.js')));
  assert.ok(fs.existsSync(path.join(target, '.obsidian/plugins/demo/data.json')));

  const sourceHashes = hashTree(vault, { ignore: ['.git', 'node_modules', '.trash'] });
  const restoredHashes = hashTree(target);
  for (const [rel, hash] of Object.entries(restoredHashes)) {
    assert.equal(hash, sourceHashes[rel], `内容不一致：${rel}`);
  }
});

test('非空目标与 vault 内目标默认被拒绝', async () => {
  const vault = makeVault();
  const dest = tempDir('backup-src2-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });

  const occupied = tempDir('occupied-');
  writeFile(occupied, 'keep.txt', 'keep');
  await assert.rejects(
    () => restoreBackup({ file: backup.file, targetDir: occupied }),
    (err) => err.code === 'E_TARGET_NOT_EMPTY',
  );

  await assert.rejects(
    () => restoreBackup({ file: backup.file, targetDir: path.join(vault, 'restore-here'), vaultRoot: vault }),
    (err) => err.code === 'E_TARGET_INSIDE_SOURCE',
  );
});

test('损坏的备份会报错而不是静默成功', async () => {
  const vault = makeVault();
  const dest = tempDir('backup-bad-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });
  const buffer = fs.readFileSync(backup.file);
  fs.writeFileSync(backup.file, buffer.subarray(0, Math.floor(buffer.length / 2)));
  await assert.rejects(async () => verifyBackup(backup.file));
  await assert.rejects(
    () => restoreBackup({ file: backup.file, targetDir: path.join(tempDir('r-'), 'x') }),
  );
});

test('iCloud / OneDrive 形态的绝对路径可以正常使用', async () => {
  const base = tempDir('cloud-');
  const iCloud = path.join(base, 'Mobile Documents', 'com~apple~CloudDocs', 'Vault Backups');
  const oneDrive = path.join(base, 'OneDrive', 'Vault Backups');
  fs.mkdirSync(iCloud, { recursive: true });
  fs.mkdirSync(oneDrive, { recursive: true });

  for (const dir of [iCloud, oneDrive]) {
    const check = validatePath(dir, { kind: 'directory', mustExist: true });
    assert.equal(check.ok, true);
    const vault = makeVault();
    const backup = await createBackup({ vaultRoot: vault, destDir: dir });
    assert.ok(fs.existsSync(backup.file));
    const verified = await verifyBackup(backup.file);
    assert.equal(verified.ok, true);
  }
});


test('打包期间文件内容变化会被拒绝，不会产出无效归档', async () => {
  const dir = tempDir('change-');
  writeFile(dir, 'note.md', 'AAAA');
  const abs = path.join(dir, 'note.md');
  const staleSha = require('../src/core/fs-utils').sha256Buffer
    ? require('../src/core/fs-utils').sha256Buffer(Buffer.from('AAAA'))
    : require('crypto').createHash('sha256').update('AAAA').digest('hex');
  fs.writeFileSync(abs, 'BBBB'); // 同长度、不同内容
  const dest = path.join(dir, 'x.vmbak');
  await assert.rejects(
    () =>
      writeArchive(dest, {
        kind: 'backup',
        files: [{ path: 'note.md', abs, sha256: staleSha, size: 4 }],
      }),
    (err) => err.code === 'E_CHECKSUM_MISMATCH',
  );
  assert.equal(fs.existsSync(dest), false);
});

test('打包期间文件大小变化会被拒绝', async () => {
  const dir = tempDir('grow-');
  writeFile(dir, 'note.md', 'AAAA');
  const abs = path.join(dir, 'note.md');
  const sha = require('crypto').createHash('sha256').update('AAAA').digest('hex');
  fs.writeFileSync(abs, 'AAAA-BBBB-CCCC');
  const dest = path.join(dir, 'y.vmbak');
  await assert.rejects(
    () => writeArchive(dest, { kind: 'backup', files: [{ path: 'note.md', abs, sha256: sha, size: 4 }] }),
    (err) => ['E_CHECKSUM_MISMATCH', 'E_IO'].includes(err.code),
  );
  assert.equal(fs.existsSync(dest), false);
});

test('写入后校验失败会删除本次备份且不影响既有备份', async () => {
  const vault = makeVault();
  const dest = tempDir('verify-fail-');
  const first = await createBackup({ vaultRoot: vault, destDir: dest });
  assert.equal((await verifyBackup(first.file)).ok, true);

  await assert.rejects(
    () =>
      createBackup({
        vaultRoot: vault,
        destDir: dest,
        verify: () => ({ ok: false, checked: 1, mismatches: [{ path: 'note.md' }] }),
      }),
    (err) => err.code === 'E_CHECKSUM_MISMATCH',
  );

  const remaining = fs.readdirSync(dest).filter((name) => name.endsWith('.vmbak'));
  assert.equal(remaining.length, 1);
  assert.equal((await verifyBackup(first.file)).ok, true);
});

test('恢复保留可执行与私有文件权限', async () => {
  const vault = makeVault();
  writeFile(vault, 'Scripts/run.sh', '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(vault, 'Scripts/run.sh'), 0o755);
  writeFile(vault, 'secret.txt', 'private\n');
  fs.chmodSync(path.join(vault, 'secret.txt'), 0o600);

  const dest = tempDir('perm-src-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });
  const target = path.join(tempDir('perm-restore-'), 'copy');
  await restoreBackup({ file: backup.file, targetDir: target });

  assert.equal(fs.statSync(path.join(target, 'Scripts/run.sh')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(target, 'secret.txt')).mode & 0o777, 0o600);
});


test('权限设置失败时中止恢复、清理临时文件且不发布目标文件', async () => {
  const vault = makeVault();
  writeFile(vault, 'secret.txt', 'private\n');
  fs.chmodSync(path.join(vault, 'secret.txt'), 0o600);

  const dest = tempDir('perm-fail-src-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });
  const target = path.join(tempDir('perm-fail-restore-'), 'copy');

  const originalChmod = fs.chmodSync;
  let observedTempMode = null;
  fs.chmodSync = (file, mode) => {
    if (!String(file).includes('secret.txt')) return originalChmod(file, mode);
    observedTempMode = fs.statSync(file).mode & 0o777;
    const error = new Error('EPERM: operation not permitted');
    error.code = 'EPERM';
    throw error;
  };

  try {
    await assert.rejects(
      () => restoreBackup({ file: backup.file, targetDir: target }),
      (err) => {
        assert.equal(err.code, 'E_PERMISSION');
        assert.equal(err.details.path, 'secret.txt');
        assert.equal(err.details.mode, 0o600);
        return true;
      },
    );
  } finally {
    fs.chmodSync = originalChmod;
  }

  assert.equal(observedTempMode, 0o600, '临时文件必须以限制性权限创建');
  assert.equal(fs.existsSync(path.join(target, 'secret.txt')), false, '目标文件不得被发布');
  const leftovers = fs.existsSync(target)
    ? fs.readdirSync(target, { recursive: true }).filter((name) => String(name).includes('.vmtmp-'))
    : [];
  assert.deepEqual(leftovers, [], '临时文件必须被清理');
});
