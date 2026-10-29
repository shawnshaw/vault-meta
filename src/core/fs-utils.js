'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CODES, fail } = require('./errors');

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * 递归列出 root 下的普通文件。
 * 不跟随符号链接；符号链接/特殊文件记入 skipped。
 * @param {string} rootAbs
 * @param {{exclude?: (rel: string, entry: fs.Dirent) => boolean}} [opts]
 * @returns {{files: Array<{path: string, abs: string, size: number, mode: number, mtimeMs: number}>, skipped: Array<{path: string, reason: string}>}}
 */
function walkFiles(rootAbs, opts) {
  const exclude = opts && opts.exclude;
  const files = [];
  const skipped = [];
  const stack = [''];

  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(rootAbs, relDir) : rootAbs;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: relDir || '.', reason: `readdir:${err.code || 'ERR'}` });
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (JUNK_NAMES.has(entry.name)) {
        skipped.push({ path: rel, reason: 'junk' });
        continue;
      }
      if (exclude && exclude(rel, entry)) {
        skipped.push({ path: rel, reason: 'excluded' });
        continue;
      }
      const abs = path.join(absDir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: rel, reason: 'special' });
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        skipped.push({ path: rel, reason: `stat:${err.code || 'ERR'}` });
        continue;
      }
      files.push({
        path: rel,
        abs,
        size: stat.size,
        mode: stat.mode & 0o777,
        mtimeMs: Math.floor(stat.mtimeMs),
      });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

/** @returns {Promise<string>} 文件 sha256（hex） */
function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function ensureDir(absDir) {
  fs.mkdirSync(absDir, { recursive: true });
}

function exists(absPath) {
  try {
    fs.lstatSync(absPath);
    return true;
  } catch (err) {
    return false;
  }
}

function isDirectory(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch (err) {
    return false;
  }
}

function isEmptyDir(absPath) {
  try {
    return fs.readdirSync(absPath).length === 0;
  } catch (err) {
    return false;
  }
}

function tmpName(absPath) {
  const rand = crypto.randomBytes(6).toString('hex');
  return `${absPath}.vmtmp-${process.pid}-${rand}`;
}

/** 原子写入：先写同目录临时文件再 rename。 */
function writeFileAtomic(absPath, data, mode) {
  ensureDir(path.dirname(absPath));
  const tmp = tmpName(absPath);
  try {
    fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
    fs.renameSync(tmp, absPath);
  } catch (err) {
    safeUnlink(tmp);
    fail(CODES.IO, `写入失败：${path.basename(absPath)}`, { path: absPath, cause: err.code });
  }
}

function copyFileAtomic(srcAbs, destAbs, mode) {
  ensureDir(path.dirname(destAbs));
  const tmp = tmpName(destAbs);
  try {
    fs.copyFileSync(srcAbs, tmp);
    if (mode) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, destAbs);
  } catch (err) {
    safeUnlink(tmp);
    fail(CODES.IO, `复制失败：${path.basename(destAbs)}`, { path: destAbs, cause: err.code });
  }
}

function safeUnlink(absPath) {
  try {
    fs.unlinkSync(absPath);
  } catch (err) {
    /* 临时文件清理失败不掩盖主错误 */
  }
}

function readJson(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    fail(CODES.IO, `读取 JSON 失败：${path.basename(absPath)}`, { path: absPath, cause: err.code });
  }
}

function writeJsonAtomic(absPath, value) {
  writeFileAtomic(absPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

/**
 * 在 startAbs 向上删除空目录，直到 rootAbs（不含）。
 */
function pruneEmptyDirs(rootAbs, startAbs) {
  let current = path.resolve(startAbs);
  const root = path.resolve(rootAbs);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    if (!isDirectory(current) || !isEmptyDir(current)) return;
    try {
      fs.rmdirSync(current);
    } catch (err) {
      return;
    }
    current = path.dirname(current);
  }
}

function nowStamp(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

module.exports = {
  walkFiles,
  sha256File,
  sha256Buffer,
  ensureDir,
  exists,
  isDirectory,
  isEmptyDir,
  writeFileAtomic,
  copyFileAtomic,
  readJson,
  writeJsonAtomic,
  pruneEmptyDirs,
  nowStamp,
  formatBytes,
  safeUnlink,
};
