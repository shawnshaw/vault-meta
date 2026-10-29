'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeTarGz, iterateTarGz } = require('../src/core/tar');
const { writeArchive, readArchiveManifest, verifyArchive, extractArchive, ARCHIVE_FORMAT, MANIFEST_PATH } = require('../src/core/archive');
const { tempDir, writeFile } = require('./helpers/vault');

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readAll(file) {
  const entries = [];
  for await (const entry of iterateTarGz(file)) {
    if (entry.type === 'dir') {
      entries.push({ path: entry.path, type: 'dir' });
      continue;
    }
    const chunks = [];
    await entry.read((chunk) => chunks.push(Buffer.from(chunk)));
    entries.push({ path: entry.path, type: 'file', data: Buffer.concat(chunks), mode: entry.mode, mtimeMs: entry.mtimeMs });
  }
  return entries;
}

test('tar 往返：二进制、空文件、长路径与时间戳', async () => {
  const dir = tempDir('tar-');
  const binary = Buffer.alloc(1025);
  for (let i = 0; i < binary.length; i += 1) binary[i] = i % 251;
  const longRel = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(40)}.bin`;
  writeFile(dir, 'bin/data.bin', binary);
  writeFile(dir, 'empty.txt', '');
  writeFile(dir, longRel, 'long');

  const target = path.join(dir, 'out.tgz');
  await writeTarGz(target, [
    { path: 'bin/data.bin', abs: path.join(dir, 'bin/data.bin') },
    { path: 'empty.txt', abs: path.join(dir, 'empty.txt') },
    { path: longRel, abs: path.join(dir, longRel) },
  ]);

  const entries = await readAll(target);
  assert.equal(entries.length, 3);
  const bin = entries.find((entry) => entry.path === 'bin/data.bin');
  assert.equal(sha(bin.data), sha(binary));
  assert.equal(entries.find((entry) => entry.path === 'empty.txt').data.length, 0);
  assert.ok(entries.some((entry) => entry.path === longRel));
  assert.ok(bin.mtimeMs > 0);
});

test('tar 损坏时拒绝读取', async () => {
  const dir = tempDir('tar-bad-');
  const file = path.join(dir, 'x.tgz');
  await writeTarGz(file, [{ path: 'a.txt', data: Buffer.from('hello') }]);
  const buffer = fs.readFileSync(file);
  for (let i = 20; i < Math.min(buffer.length, 120); i += 1) buffer[i] = 0;
  fs.writeFileSync(file, buffer);
  await assert.rejects(async () => readAll(file), (err) => err.code === 'E_ARCHIVE_CORRUPT');
});

test('writeArchive 生成可校验归档，并逐文件核验', async () => {
  const dir = tempDir('arc-');
  writeFile(dir, 'a.txt', 'aaa');
  writeFile(dir, 'sub/b.bin', Buffer.from([1, 2, 3]));
  const file = path.join(dir, 'x.vmbak');
  const manifest = await writeArchive(file, {
    kind: 'backup',
    meta: { vaultName: 'demo' },
    files: [
      { path: 'a.txt', abs: path.join(dir, 'a.txt') },
      { path: 'sub/b.bin', abs: path.join(dir, 'sub/b.bin') },
    ],
  });
  assert.equal(manifest.fileCount, 2);
  const roundTrip = await readArchiveManifest(file);
  assert.equal(roundTrip.format, ARCHIVE_FORMAT);
  const result = await verifyArchive(file);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 2);
});

test('verifyArchive 能发现内容与清单不一致', async () => {
  const dir = tempDir('arc-tamper-');
  const payload = Buffer.from('tampered');
  const manifest = {
    format: ARCHIVE_FORMAT,
    kind: 'component',
    createdAt: new Date().toISOString(),
    meta: {},
    fileCount: 1,
    totalBytes: 4,
    entries: [{ path: 'payload.txt', size: 4, mode: 420, mtimeMs: 0, sha256: sha(Buffer.from('good')) }],
  };
  const file = path.join(dir, 'bad.vmpkg');
  await writeTarGz(file, [
    { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'payload/payload.txt', data: payload },
  ]);
  const result = await verifyArchive(file);
  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 1);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  await assert.rejects(() => extractArchive(file, out), (err) => err.code === 'E_CHECKSUM_MISMATCH');
});

test('清单中的越界路径被拒绝', async () => {
  const dir = tempDir('arc-path-');
  const manifest = {
    format: ARCHIVE_FORMAT,
    kind: 'backup',
    createdAt: new Date().toISOString(),
    meta: {},
    fileCount: 1,
    totalBytes: 1,
    entries: [{ path: '../evil.txt', size: 1, mode: 420, mtimeMs: 0, sha256: sha(Buffer.from('x')) }],
  };
  const file = path.join(dir, 'evil.vmbak');
  await writeTarGz(file, [
    { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'payload/x.txt', data: Buffer.from('x') },
  ]);
  await assert.rejects(() => readArchiveManifest(file), (err) => err.code === 'E_PATH_TRAVERSAL');
});

test('payload 中的绝对路径被拒绝', async () => {
  const dir = tempDir('arc-abs-');
  const manifest = {
    format: ARCHIVE_FORMAT,
    kind: 'backup',
    createdAt: new Date().toISOString(),
    meta: {},
    fileCount: 1,
    totalBytes: 1,
    entries: [{ path: 'x.txt', size: 1, mode: 420, mtimeMs: 0, sha256: sha(Buffer.from('x')) }],
  };
  const file = path.join(dir, 'abs.vmbak');
  await writeTarGz(file, [
    { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'payload//etc/passwd', data: Buffer.from('x') },
  ]);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  await assert.rejects(() => extractArchive(file, out), (err) => err.code === 'E_PATH_ABSOLUTE');
});

test('归档中出现清单外文件时拒绝', async () => {
  const dir = tempDir('arc-extra-');
  const manifest = {
    format: ARCHIVE_FORMAT,
    kind: 'backup',
    createdAt: new Date().toISOString(),
    meta: {},
    fileCount: 1,
    totalBytes: 1,
    entries: [{ path: 'x.txt', size: 1, mode: 420, mtimeMs: 0, sha256: sha(Buffer.from('x')) }],
  };
  const file = path.join(dir, 'extra.vmbak');
  await writeTarGz(file, [
    { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'payload/x.txt', data: Buffer.from('x') },
    { path: 'payload/y.txt', data: Buffer.from('y') },
  ]);
  await assert.rejects(() => verifyArchive(file), (err) => err.code === 'E_ARCHIVE_FORMAT');
});

test('恢复目标中的符号链接不能被穿越', async () => {
  const dir = tempDir('arc-sym-');
  writeFile(dir, 'src/x.txt', 'x');
  const file = path.join(dir, 'x.vmbak');
  await writeArchive(file, {
    kind: 'backup',
    files: [{ path: 'link/x.txt', abs: path.join(dir, 'src/x.txt') }],
  });
  const out = path.join(dir, 'out');
  const outside = tempDir('arc-out-');
  fs.mkdirSync(out);
  fs.symlinkSync(outside, path.join(out, 'link'), 'dir');
  await assert.rejects(() => extractArchive(file, out), (err) => err.code === 'E_SYMLINK_ESCAPE');
});
