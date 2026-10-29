'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalizeRelPath, assertInside, resolveWithin, assertNoSymlinkEscape, isInside } = require('../src/core/paths');
const { tempDir, writeFile } = require('./helpers/vault');

test('normalizeRelPath 接受并规范化普通相对路径', () => {
  assert.equal(normalizeRelPath('a/b/c.txt'), 'a/b/c.txt');
  assert.equal(normalizeRelPath('./a//b/./c.txt'), 'a/b/c.txt');
  assert.equal(normalizeRelPath('dir/'), 'dir');
});

test('normalizeRelPath 拒绝绝对路径、盘符与 NUL（反斜杠按平台处理）', () => {
  assert.throws(() => normalizeRelPath('/etc/passwd'), /绝对路径/);
  assert.throws(() => normalizeRelPath('C:\\Windows\\system32'), (err) => err.code === 'E_PATH_ABSOLUTE');
  if (process.platform === 'win32') {
    assert.throws(() => normalizeRelPath('a\\b'), (err) => err.code === 'E_PATH_INVALID');
  } else {
    // POSIX 上反斜杠是合法文件名字符，vault 中确有此类目录
    assert.equal(normalizeRelPath('a\\b'), 'a\\b');
  }
  assert.throws(() => normalizeRelPath('a\0b'), (err) => err.code === 'E_PATH_INVALID');
  assert.throws(() => normalizeRelPath(''), (err) => err.code === 'E_PATH_INVALID');
});

test('normalizeRelPath 拒绝 .. 越界', () => {
  assert.throws(() => normalizeRelPath('../secret'), (err) => err.code === 'E_PATH_TRAVERSAL');
  assert.throws(() => normalizeRelPath('a/../../b'), (err) => err.code === 'E_PATH_TRAVERSAL');
  // 归一化后仍在内部：允许（等价于 a/c）
  assert.equal(normalizeRelPath('a/b/../c'), 'a/c');
});

test('assertInside / resolveWithin 阻止目录逃逸', () => {
  const root = tempDir('inside-');
  const child = path.join(root, 'a', 'b.txt');
  assert.equal(isInside(root, child), true);
  assert.doesNotThrow(() => assertInside(root, child));
  assert.throws(() => assertInside(root, path.join(root, '..', 'x')), (err) => err.code === 'E_PATH_ESCAPE');
  assert.throws(() => resolveWithin(root, '../x'), (err) => err.code === 'E_PATH_TRAVERSAL');
  assert.equal(resolveWithin(root, 'a/b.txt'), child);
});

test('assertNoSymlinkEscape 拒绝指向外部的符号链接', (t) => {
  const root = tempDir('sym-');
  const outside = tempDir('outside-');
  writeFile(outside, 'secret.txt', 'secret');
  fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
  assert.throws(() => assertNoSymlinkEscape(root, 'link/secret.txt'), (err) => err.code === 'E_SYMLINK_ESCAPE');
});

test('assertNoSymlinkEscape 允许内部符号链接与尚不存在的尾部路径', () => {
  const root = tempDir('sym-ok-');
  writeFile(root, 'real/a.txt', 'a');
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'dir');
  assert.doesNotThrow(() => assertNoSymlinkEscape(root, 'alias/a.txt'));
  assert.doesNotThrow(() => assertNoSymlinkEscape(root, 'new/dir/file.txt'));
});

test('父级是文件时阻止写入', () => {
  const root = tempDir('notdir-');
  writeFile(root, 'afile', 'x');
  assert.throws(() => assertNoSymlinkEscape(root, 'afile/child.txt'), (err) => err.code === 'E_PATH_NOT_DIRECTORY');
});
