'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { writeTarGz, iterateTarGz, BLOCK } = require('../src/core/tar');
const { writeArchive, verifyArchive, extractArchive, readArchiveManifest, MANIFEST_PATH, ARCHIVE_FORMAT } = require('../src/core/archive');
const { normalizeRelPath } = require('../src/core/paths');
const { createBackup, verifyBackup, restoreBackup } = require('../src/core/backup');
const { tempDir, writeFile, makeVault, readFile } = require('./helpers/vault');

const REAL_NAME = 'weread-bm-61-907-934_对自己有利没利他不管，看到对别人有利，他就觉得吃了亏。.md';
const REAL_REL = `Books/一句顶一万句/highlights/${REAL_NAME}`;

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  for (;;) {
    const total = Buffer.byteLength(String(len), 'ascii') + Buffer.byteLength(body, 'utf8');
    if (total === len) break;
    len = total;
  }
  return Buffer.from(`${len}${body}`, 'utf8');
}

function buildLegacyUstar(entries) {
  // 模拟修复前生成的 ustar 归档：只有 prefix/base，没有 PAX 头
  const blocks = [];
  const header = (name, size) => {
    const parts = name.split('/');
    let prefix = '';
    let base = name;
    if (Buffer.byteLength(name, 'utf8') > 100) {
      for (let i = 1; i < parts.length; i += 1) {
        const p = parts.slice(0, i).join('/');
        const b = parts.slice(i).join('/');
        if (Buffer.byteLength(p, 'utf8') <= 155 && Buffer.byteLength(b, 'utf8') <= 100) {
          prefix = p;
          base = b;
          break;
        }
      }
    }
    const block = Buffer.alloc(BLOCK, 0);
    block.write(base, 0, 100, 'utf8');
    block.write('0000644\0', 100, 8, 'ascii');
    block.write('0000000\0', 108, 8, 'ascii');
    block.write('0000000\0', 116, 8, 'ascii');
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    block.write('00000000000\0', 136, 12, 'ascii');
    block.write('0', 156, 1, 'ascii');
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
    block.write(prefix, 345, 155, 'utf8');
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return block;
  };
  for (const entry of entries) {
    const data = Buffer.from(entry.data, 'utf8');
    blocks.push(header(entry.path, data.length), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return Buffer.concat(blocks);
}

test('真实中文长文件名（>100 字节）可规范化并原样保留', () => {
  assert.equal(Buffer.byteLength(REAL_NAME, 'utf8'), 105);
  assert.equal(normalizeRelPath(REAL_REL), REAL_REL);
  assert.equal(normalizeRelPath('a'.repeat(300)), 'a'.repeat(300));
});

test('含 105 字节中文文件名的整库备份→校验→恢复保持路径与内容', async () => {
  const vault = makeVault();
  writeFile(vault, REAL_REL, '# 长文件名笔记\n');
  writeFile(vault, 'Books/一句顶一万句/highlights/short.md', 'short\n');

  const dest = tempDir('long-src-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });
  const verified = await verifyBackup(backup.file);
  assert.equal(verified.ok, true);

  const target = path.join(tempDir('long-restore-'), 'copy');
  const restored = await restoreBackup({ file: backup.file, targetDir: target });
  assert.ok(restored.restoredCount >= 2);
  assert.equal(readFile(target, REAL_REL), '# 长文件名笔记\n');
  assert.equal(readFile(target, 'Books/一句顶一万句/highlights/short.md'), 'short\n');
});

test('总路径超过 220 字符与深层目录可完整恢复', async () => {
  const vault = makeVault();
  const deepRel = `${Array.from({ length: 18 }, (_, index) => `目录${String(index).padStart(2, '0')}${'深'.repeat(12)}`).join('/')}/note.md`;
  assert.ok(deepRel.length > 220);
  writeFile(vault, deepRel, 'deep\n');

  const dest = tempDir('deep-src-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });
  assert.equal((await verifyBackup(backup.file)).ok, true);

  const target = path.join(tempDir('deep-restore-'), 'copy');
  await restoreBackup({ file: backup.file, targetDir: target });
  assert.equal(readFile(target, deepRel), 'deep\n');
});

test('旧 ustar 归档仍可读取与恢复', async () => {
  const dir = tempDir('legacy-');
  const rel = `${'p'.repeat(120)}/${'b'.repeat(90)}.txt`;
  const content = 'legacy\n';
  const manifest = {
    format: ARCHIVE_FORMAT,
    kind: 'backup',
    createdAt: new Date().toISOString(),
    meta: {},
    fileCount: 1,
    totalBytes: Buffer.byteLength(content),
    entries: [{
      path: rel,
      size: Buffer.byteLength(content),
      mode: 0o644,
      mtimeMs: 0,
      sha256: require('crypto').createHash('sha256').update(content).digest('hex'),
    }],
  };
  const raw = buildLegacyUstar([
    { path: MANIFEST_PATH, data: JSON.stringify(manifest) },
    { path: `payload/${rel}`, data: content },
  ]);
  const file = path.join(dir, 'legacy.vmbak');
  fs.writeFileSync(file, zlib.gzipSync(raw));

  const read = await readArchiveManifest(file);
  assert.equal(read.entries[0].path, rel);
  const target = path.join(dir, 'out');
  fs.mkdirSync(target);
  await extractArchive(file, target);
  assert.equal(fs.readFileSync(path.join(target, rel), 'utf8'), content);
});

test('PAX 长路径仍拒绝目录穿越与绝对路径', async () => {
  const dir = tempDir('pax-evil-');
  const good = Buffer.from('x');
  const sha = require('crypto').createHash('sha256').update(good).digest('hex');
  const makeArchive = async (evilPath, name) => {
    const manifest = {
      format: ARCHIVE_FORMAT,
      kind: 'backup',
      createdAt: new Date().toISOString(),
      meta: {},
      fileCount: 1,
      totalBytes: 1,
      entries: [{ path: 'ok.txt', size: 1, mode: 0o644, mtimeMs: 0, sha256: sha }],
    };
    const file = path.join(dir, name);
    await writeTarGz(file, [
      { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
      { type: 'pax', data: paxRecord('path', evilPath) },
      { path: 'ok.txt', data: good },
    ]);
    return file;
  };

  const traversal = await makeArchive('../../evil.txt', 'traversal.vmbak');
  const out1 = path.join(dir, 'out1');
  fs.mkdirSync(out1);
  await assert.rejects(() => extractArchive(traversal, out1), (err) => err.code === 'E_PATH_TRAVERSAL');

  const absolute = await makeArchive('/etc/passwd', 'absolute.vmbak');
  const out2 = path.join(dir, 'out2');
  fs.mkdirSync(out2);
  await assert.rejects(() => extractArchive(absolute, out2), (err) => err.code === 'E_PATH_ABSOLUTE');
});

test('超长 PAX 路径被拒绝，且不产生文件', async () => {
  const dir = tempDir('pax-overlong-');
  const good = Buffer.from('x');
  const sha = require('crypto').createHash('sha256').update(good).digest('hex');
  const manifest = {
    format: ARCHIVE_FORMAT,
    kind: 'backup',
    createdAt: new Date().toISOString(),
    meta: {},
    fileCount: 1,
    totalBytes: 1,
    entries: [{ path: 'ok.txt', size: 1, mode: 0o644, mtimeMs: 0, sha256: sha }],
  };
  const build = async (evilPath, name) => {
    const file = path.join(dir, name);
    await writeTarGz(file, [
      { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
      { type: 'pax', data: paxRecord('path', evilPath) },
      { path: 'ok.txt', data: good },
    ]);
    return file;
  };

  const overlong = await build('a'.repeat(5000), 'overlong.vmbak');
  const out1 = path.join(dir, 'out1');
  fs.mkdirSync(out1);
  await assert.rejects(() => extractArchive(overlong, out1), (err) => err.code === 'E_PATH_INVALID');
  assert.deepEqual(fs.readdirSync(out1), []);

});

test('Windows 平台拒绝反斜杠路径（POSIX 上视为普通字符）', () => {
  if (process.platform === 'win32') {
    assert.throws(() => normalizeRelPath('a\\b'), (err) => err.code === 'E_PATH_INVALID');
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.throws(() => normalizeRelPath('a\\b'), (err) => err.code === 'E_PATH_INVALID');
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  }
  assert.equal(normalizeRelPath('a\\b'), 'a\\b');
});

test('POSIX 文件名中的反斜杠可备份恢复', { skip: process.platform === 'win32' }, async () => {
  const vault = makeVault();
  const rel = '🤖\\ AI管理系统/Skill引入指南.md';
  writeFile(vault, rel, 'backslash-name\n');
  assert.equal(normalizeRelPath(rel), rel);

  const dest = tempDir('backslash-src-');
  const backup = await createBackup({ vaultRoot: vault, destDir: dest });
  assert.equal((await verifyBackup(backup.file)).ok, true);

  const target = path.join(tempDir('backslash-restore-'), 'copy');
  await restoreBackup({ file: backup.file, targetDir: target });
  assert.equal(readFile(target, rel), 'backslash-name\n');
});

test('长路径归档保留 raw 字节内容与相对路径', async () => {
  const dir = tempDir('long-arc-');
  const rel = `Books/${REAL_NAME}`;
  writeFile(dir, rel, 'body\n');
  const file = path.join(dir, 'x.vmbak');
  await writeArchive(file, { kind: 'backup', files: [{ path: rel, abs: path.join(dir, rel) }] });
  const result = await verifyArchive(file);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.entries[0].path, rel);
});
