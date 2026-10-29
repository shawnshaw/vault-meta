'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sourceIdentity, artifactDigest, runtimeSlice } = require('../src/core/identity');
const { sha256File } = require('../src/core/fs-utils');
const { tempDir, writeFile, makeVault, makePlugin } = require('./helpers/vault');

function makeTree(files) {
  const root = tempDir('src-');
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  return root;
}

async function makeRecord(vault, id) {
  const location = `.obsidian/plugins/${id}`;
  const abs = path.join(vault, location);
  const files = [];
  for (const name of ['manifest.json', 'main.js', 'styles.css']) {
    const fileAbs = path.join(abs, name);
    files.push({ path: name, sha256: await sha256File(fileAbs), size: fs.statSync(fileAbs).size });
  }
  return { installLocation: location, version: '1.0.0', files };
}

test('相同内容与相对路径得到相同源码身份', async () => {
  const a = makeTree({ 'src/a.js': 'a', 'README.md': '# a' });
  const b = makeTree({ 'src/a.js': 'a', 'README.md': '# a' });
  const first = await sourceIdentity(a);
  const second = await sourceIdentity(b);
  assert.equal(first.status, 'ok');
  assert.equal(first.digest, second.digest);
  assert.equal(first.fileCount, 2);
});

test('内容变化会改变源码身份', async () => {
  const root = makeTree({ 'a.js': 'one' });
  const before = await sourceIdentity(root);
  writeFile(root, 'a.js', 'two');
  const after = await sourceIdentity(root);
  assert.notEqual(before.digest, after.digest);
});

test('排除 .git、node_modules、.obsidian、data.json、.env 与 tmp', async () => {
  const root = makeTree({ 'a.js': 'code' });
  const before = await sourceIdentity(root);
  writeFile(root, '.git/HEAD', 'ref: refs/heads/main');
  writeFile(root, 'node_modules/x/index.js', 'module');
  writeFile(root, '.obsidian/app.json', '{}');
  writeFile(root, 'data.json', '{"secret":1}');
  writeFile(root, '.env', 'TOKEN=1');
  writeFile(root, 'tmp/scratch.txt', 'x');
  const after = await sourceIdentity(root);
  assert.equal(before.digest, after.digest);
  assert.equal(after.fileCount, 1);
});

test('超过文件数上限时返回 too-large 而不是摘要', async () => {
  const root = makeTree({ 'a.js': '1', 'b.js': '2', 'c.js': '3' });
  const result = await sourceIdentity(root, { caps: { maxFiles: 2, maxBytes: 1024 } });
  assert.equal(result.status, 'too-large');
  assert.equal(result.fileCount, 3);
  assert.equal(result.digest, undefined);
});

test('源码目录不存在时报 E_SOURCE_MISSING', async () => {
  await assert.rejects(
    () => sourceIdentity(path.join(tempDir('gone-'), 'missing')),
    (err) => err.code === 'E_SOURCE_MISSING',
  );
});

test('内部符号链接被跳过且身份不受影响', async () => {
  const root = makeTree({ 'a.js': 'code' });
  const before = await sourceIdentity(root);
  fs.symlinkSync('/etc/hosts', path.join(root, 'link.txt'));
  const after = await sourceIdentity(root);
  assert.equal(before.digest, after.digest);
  assert.equal(after.digest.length, 64);
});

test('构建产物摘要：存在时返回哈希，缺失时返回 null', async () => {
  const root = makeTree({ 'main.js': 'bundle' });
  const digest = await artifactDigest(root);
  assert.equal(digest.path, 'main.js');
  assert.equal(digest.size, 6);
  assert.equal(await artifactDigest(tempDir('empty-')), null);
});

test('运行切片匹配登记表时为 ok', async () => {
  const vault = makeVault();
  makePlugin(vault, 'demo');
  const record = await makeRecord(vault, 'demo');
  const slice = await runtimeSlice(vault, record);
  assert.equal(slice.status, 'ok');
  assert.equal(slice.version, '1.0.0');
  assert.deepEqual(slice.modified, []);
  assert.deepEqual(slice.missing, []);
});

test('运行文件被改动时报告 drift，且额外文件不算 drift', async () => {
  const vault = makeVault();
  const dir = makePlugin(vault, 'demo');
  const record = await makeRecord(vault, 'demo');
  writeFile(dir, 'main.js', 'changed bundle');
  writeFile(dir, 'notes.txt', 'user file');
  const slice = await runtimeSlice(vault, record);
  assert.equal(slice.status, 'runtime-modified');
  assert.equal(slice.modified.length, 1);
  assert.equal(slice.modified[0].path, 'main.js');
});

test('运行文件缺失时报告 missing', async () => {
  const vault = makeVault();
  const dir = makePlugin(vault, 'demo');
  const record = await makeRecord(vault, 'demo');
  fs.unlinkSync(path.join(dir, 'styles.css'));
  const slice = await runtimeSlice(vault, record);
  assert.equal(slice.status, 'runtime-modified');
  assert.deepEqual(slice.missing, ['styles.css']);
});

test('未安装时返回 not-installed', async () => {
  const vault = makeVault();
  makePlugin(vault, 'demo');
  const record = await makeRecord(vault, 'demo');
  record.installLocation = '.obsidian/plugins/other';
  const slice = await runtimeSlice(vault, record);
  assert.equal(slice.status, 'not-installed');
});

test('有安装但无登记时返回 unregistered，只显示发现的版本', async () => {
  const vault = makeVault();
  makePlugin(vault, 'demo', { version: '0.9.0' });
  const slice = await runtimeSlice(vault, null, { installLocation: '.obsidian/plugins/demo' });
  assert.equal(slice.status, 'unregistered');
  assert.equal(slice.version, '0.9.0');
  assert.deepEqual(slice.files, []);
});
