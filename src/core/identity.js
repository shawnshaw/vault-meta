'use strict';

/**
 * 只读身份计算：源码树摘要、构建产物摘要、当前库运行切片校验。
 * 不写入任何文件，也不跟随符号链接。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CODES, fail } = require('./errors');
const { walkFiles, sha256File, readJson } = require('./fs-utils');
const { assertInside } = require('./paths');

const DEFAULT_CAPS = Object.freeze({ maxFiles: 8000, maxBytes: 200 * 1024 * 1024 });
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'tmp']);
const EXCLUDED_FILES = new Set(['data.json', '.env']);

function sourceExclude(rel, entry) {
  const base = rel.split('/').pop();
  if (entry.isDirectory() && EXCLUDED_DIRS.has(base)) return true;
  if (EXCLUDED_FILES.has(base)) return true;
  return false;
}

async function hashAll(files) {
  const hashes = new Array(files.length);
  let next = 0;
  const workerCount = Math.min(8, files.length);
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push((async () => {
      while (next < files.length) {
        const index = next;
        next += 1;
        try {
          hashes[index] = await sha256File(files[index].abs);
        } catch (err) {
          fail(CODES.IO, `无法读取源码文件：${files[index].path}`, { path: files[index].abs });
        }
      }
    })());
  }
  await Promise.all(workers);
  return hashes;
}

/**
 * 源码树身份：按 path\0sha256 排序后取整体 sha256。
 * @param {string} rootAbs
 * @param {{exclude?: Function, caps?: {maxFiles: number, maxBytes: number}}} [opts]
 */
async function sourceIdentity(rootAbs, opts) {
  const options = opts || {};
  const caps = { ...DEFAULT_CAPS, ...(options.caps || {}) };
  let stat;
  try {
    stat = fs.statSync(rootAbs);
  } catch (err) {
    fail(CODES.SOURCE_MISSING, '本地源码目录不存在或不可读', { path: rootAbs });
  }
  if (!stat.isDirectory()) {
    fail(CODES.SOURCE_MISSING, '本地源码路径不是目录', { path: rootAbs });
  }
  const realPath = fs.realpathSync(rootAbs);
  const { files, skipped } = walkFiles(rootAbs, { exclude: options.exclude || sourceExclude });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > caps.maxFiles || totalBytes > caps.maxBytes) {
    return {
      status: 'too-large',
      fileCount: files.length,
      totalBytes,
      maxFiles: caps.maxFiles,
      maxBytes: caps.maxBytes,
      symlinkedRoot: realPath !== path.resolve(rootAbs),
    };
  }
  const hashes = await hashAll(files);
  const digest = crypto.createHash('sha256');
  for (let i = 0; i < files.length; i += 1) {
    digest.update(`${files[i].path}\0${hashes[i]}\n`);
  }
  return {
    status: 'ok',
    digest: digest.digest('hex'),
    fileCount: files.length,
    totalBytes,
    skippedCount: skipped.length,
    symlinkedRoot: realPath !== path.resolve(rootAbs),
    realPath,
  };
}

/**
 * 构建产物摘要（默认 main.js），不存在或为符号链接时返回 null。
 */
async function artifactDigest(rootAbs, name) {
  const rel = name || 'main.js';
  const abs = path.join(rootAbs, rel);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    return null;
  }
  if (!stat.isFile()) return null;
  return { path: rel, sha256: await sha256File(abs), size: stat.size };
}

function readManifestSafe(absDir) {
  const manifest = readJson(path.join(absDir, 'manifest.json'), null);
  if (!manifest || typeof manifest !== 'object') return null;
  return {
    id: typeof manifest.id === 'string' ? manifest.id : '',
    name: typeof manifest.name === 'string' ? manifest.name : '',
    version: typeof manifest.version === 'string' ? manifest.version : '',
  };
}

/**
 * 当前库运行切片：按登记表声明的文件逐项校验。
 * 额外文件（data.json 等）不属于托管范围，不记为 drift。
 * @param {string} vaultRoot
 * @param {object|null} record 登记表记录
 * @param {{installLocation?: string}} [opts]
 */
async function runtimeSlice(vaultRoot, record, opts) {
  const options = opts || {};
  const installLocation = (record && record.installLocation) || options.installLocation || '';
  if (!installLocation) return { status: 'not-installed', location: '' };
  const absDir = path.join(vaultRoot, installLocation);
  assertInside(vaultRoot, absDir, { label: '安装位置' });
  let dirStat = null;
  try {
    dirStat = fs.statSync(absDir);
  } catch (err) {
    dirStat = null;
  }
  if (!dirStat || !dirStat.isDirectory()) {
    return { status: 'not-installed', location: installLocation };
  }
  const manifest = readManifestSafe(absDir);
  if (!record) {
    if (!manifest) return { status: 'not-installed', location: installLocation };
    return {
      status: 'unregistered',
      location: installLocation,
      version: manifest.version,
      manifestId: manifest.id,
      manifest,
      files: [],
      modified: [],
      missing: [],
      hashes: {},
    };
  }

  const declared = Array.isArray(record.files) ? record.files : [];
  const modified = [];
  const missing = [];
  const hashes = {};
  for (const file of declared) {
    const abs = path.join(absDir, file.path);
    let stat = null;
    try {
      stat = fs.lstatSync(abs);
    } catch (err) {
      missing.push(file.path);
      continue;
    }
    if (!stat.isFile()) {
      missing.push(file.path);
      continue;
    }
    const sha256 = await sha256File(abs);
    hashes[file.path] = sha256;
    if (sha256 !== file.sha256 || stat.size !== Number(file.size)) {
      modified.push({ path: file.path, expected: file.sha256, actual: sha256 });
    }
  }
  const status = declared.length === 0
    ? 'unregistered'
    : modified.length > 0 || missing.length > 0
      ? 'runtime-modified'
      : 'ok';
  return {
    status,
    location: installLocation,
    version: (manifest && manifest.version) || record.version || '',
    recordedVersion: record.version || '',
    manifestId: manifest ? manifest.id : '',
    files: declared.map((file) => file.path),
    modified,
    missing,
    hashes,
  };
}

module.exports = {
  DEFAULT_CAPS,
  sourceIdentity,
  artifactDigest,
  runtimeSlice,
  sourceExclude,
};
