'use strict';

const path = require('path');
const fs = require('fs');
const { CODES, fail } = require('./errors');

// 以字节数计，对齐常见系统 PATH_MAX（4096）；ustar 的长度限制由 PAX 归档层解决
const MAX_REL_LENGTH = 4096;
// Windows 风格的绝对路径前缀（盘符 + 分隔符或盘符结尾）
const WINDOWS_DRIVE = /^[a-zA-Z]:(?:[\\/]|$)/;

/**
 * 校验并规范化归档内的相对路径（posix 分隔）。
 * 拒绝：空值、绝对路径、盘符、NUL、反斜杠、`..` 越界。
 * @param {string} input
 * @param {string} [label] 用于错误提示的字段名
 * @returns {string} 规范化后的相对路径（无首尾斜杠）
 */
function normalizeRelPath(input, label) {
  const field = label || '路径';
  if (typeof input !== 'string') {
    fail(CODES.PATH_INVALID, `${field}必须是字符串`, { path: input });
  }
  if (input.length === 0) {
    fail(CODES.PATH_INVALID, `${field}不能为空`, { path: input });
  }
  if (input.includes('\0')) {
    fail(CODES.PATH_INVALID, `${field}包含 NUL 字符`, { path: input });
  }
  if (WINDOWS_DRIVE.test(input) || input.startsWith('/')) {
    fail(CODES.PATH_ABSOLUTE, `${field}不能是绝对路径`, { path: input });
  }
  // 反斜杠在 POSIX 上是合法文件名字符（vault 中确有此类目录）；仅在 Windows 上视为分隔符而拒绝
  if (process.platform === 'win32' && input.includes('\\')) {
    fail(CODES.PATH_INVALID, `${field}在 Windows 上不能包含反斜杠`, { path: input });
  }

  const normalized = path.posix.normalize(input).replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') {
    fail(CODES.PATH_INVALID, `${field}规范化后为空`, { path: input });
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    fail(CODES.PATH_TRAVERSAL, `${field}包含 “..”，拒绝越界路径`, { path: input });
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_REL_LENGTH) {
    fail(CODES.PATH_INVALID, `${field}过长（超过 ${MAX_REL_LENGTH} 字节）`, { path: input });
  }
  return normalized;
}

/**
 * 判断 target 是否位于 root 之内（含相等）。
 * @returns {boolean}
 */
function isInside(rootAbs, targetAbs) {
  const rel = path.relative(path.resolve(rootAbs), path.resolve(targetAbs));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 断言 target 位于 root 内。
 * @param {string} rootAbs
 * @param {string} targetAbs
 * @param {{allowRoot?: boolean, label?: string}} [opts]
 */
function assertInside(rootAbs, targetAbs, opts) {
  const allowRoot = Boolean(opts && opts.allowRoot);
  const label = (opts && opts.label) || '目标路径';
  if (path.resolve(rootAbs) === path.resolve(targetAbs)) {
    if (allowRoot) return;
    fail(CODES.PATH_ESCAPE, `${label}不能等于根目录`, { root: rootAbs, target: targetAbs });
  }
  if (!isInside(rootAbs, targetAbs)) {
    fail(CODES.PATH_ESCAPE, `${label}越出允许目录`, { root: rootAbs, target: targetAbs });
  }
}

/**
 * 在 root 内解析相对路径，得到绝对路径并校验包含性。
 * @returns {string}
 */
function resolveWithin(rootAbs, relPath, opts) {
  const rel = normalizeRelPath(relPath, (opts && opts.label) || '路径');
  const abs = path.resolve(rootAbs, rel);
  assertInside(rootAbs, abs, opts);
  return abs;
}

/**
 * 检查 root/rel 的既有祖先链中没有指向 root 之外的符号链接。
 * 不存在尾部不视为错误（将在写入时创建）。
 * @param {string} rootAbs
 * @param {string} relPath
 */
function assertNoSymlinkEscape(rootAbs, relPath) {
  const rel = normalizeRelPath(relPath, '路径');
  const realRoot = fs.realpathSync(rootAbs);
  const parts = rel.split('/');
  let current = rootAbs;
  let existingDepth = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const next = path.join(current, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (err) {
      if (err.code === 'ENOENT') break;
      fail(CODES.IO, `无法读取路径信息：${parts[i]}`, { path: next, cause: err.code });
    }
    if (i < parts.length - 1 && !stat.isDirectory() && !stat.isSymbolicLink()) {
      fail(CODES.PATH_NOT_DIRECTORY, `父级不是目录：${parts[i]}`, { path: next });
    }
    if (stat.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(next);
      } catch (err) {
        fail(CODES.SYMLINK_ESCAPE, `符号链接无法解析：${parts[i]}`, { path: next });
      }
      try {
        assertInside(realRoot, real, { label: '符号链接目标' });
      } catch (err) {
        fail(CODES.SYMLINK_ESCAPE, `符号链接指向允许目录之外：${parts[i]}`, {
          path: next,
          target: real,
        });
      }
      current = real;
    } else {
      current = next;
    }
    existingDepth = i + 1;
  }

  if (existingDepth > 0) {
    let realExisting;
    try {
      realExisting = fs.realpathSync(current);
    } catch (err) {
      realExisting = current;
    }
    assertInside(realRoot, realExisting, { label: '实际写入路径' });
  }
  return true;
}

/** 归档路径使用 posix 形式。 */
function toPosixRel(p) {
  return String(p).split(path.sep).join('/');
}

module.exports = {
  MAX_REL_LENGTH,
  normalizeRelPath,
  isInside,
  assertInside,
  resolveWithin,
  assertNoSymlinkEscape,
  toPosixRel,
};
