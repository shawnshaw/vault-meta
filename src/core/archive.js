'use strict';

/**
 * .vmbak / .vmpkg / .vmsuite 容器：gzip(tar(manifest + payload/...))。
 * manifest 永远是第一个条目，包含每个文件的大小与 sha256，恢复时逐文件核验。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { CODES, fail } = require('./errors');
const { normalizeRelPath, resolveWithin, assertNoSymlinkEscape } = require('./paths');
const { writeTarGz, iterateTarGz } = require('./tar');
const {
  ensureDir,
  exists,
  sha256File,
  safeUnlink,
  isDirectory,
} = require('./fs-utils');

const ARCHIVE_FORMAT = 'vault-meta/archive@1';
const MANIFEST_PATH = 'vault-meta.json';
const PAYLOAD_PREFIX = 'payload/';
const KIND_EXTENSIONS = Object.freeze({
  backup: '.vmbak',
  component: '.vmpkg',
  suite: '.vmsuite',
});

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    fail(CODES.ARCHIVE_CORRUPT, '归档缺少清单', {});
  }
  if (manifest.format !== ARCHIVE_FORMAT) {
    fail(CODES.ARCHIVE_FORMAT, `不支持的归档格式：${String(manifest.format)}`, {
      format: manifest.format,
      expected: ARCHIVE_FORMAT,
    });
  }
  if (!Array.isArray(manifest.entries)) {
    fail(CODES.ARCHIVE_CORRUPT, '归档清单缺少文件列表', {});
  }
  const seen = new Set();
  const entries = manifest.entries.map((entry) => {
    const rel = normalizeRelPath(entry.path, '清单路径');
    if (seen.has(rel)) fail(CODES.ARCHIVE_CORRUPT, `归档清单存在重复路径：${rel}`, { path: rel });
    seen.add(rel);
    const sha = String(entry.sha256 || '');
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      fail(CODES.ARCHIVE_CORRUPT, `归档清单校验值非法：${rel}`, { path: rel, sha256: entry.sha256 });
    }
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0) {
      fail(CODES.ARCHIVE_CORRUPT, `归档清单大小非法：${rel}`, { path: rel, size: entry.size });
    }
    return {
      path: rel,
      sha256: sha,
      size,
      mode: Number(entry.mode) & 0o777,
      mtimeMs: Number(entry.mtimeMs) || 0,
    };
  });
  return { ...manifest, entries };
}

/**
 * 写入归档。
 * @param {string} destFile
 * @param {{kind: 'backup'|'component'|'suite', meta?: object, files: Array<{path: string, abs: string, mode?: number, mtimeMs?: number}>, createdAt?: string}} input
 */
async function writeArchive(destFile, input) {
  if (!input || !KIND_EXTENSIONS[input.kind]) {
    fail(CODES.ARCHIVE_FORMAT, `未知归档类型：${input && input.kind}`, { kind: input && input.kind });
  }
  const files = [];
  const seen = new Set();
  for (const file of input.files || []) {
    const rel = normalizeRelPath(file.path, '归档路径');
    if (seen.has(rel)) fail(CODES.CONFLICT, `同一路径重复打包：${rel}`, { path: rel });
    seen.add(rel);
    if (!exists(file.abs) || isDirectory(file.abs)) {
      fail(CODES.NOT_FOUND, `待打包文件不存在：${rel}`, { path: rel, abs: file.abs });
    }
    const stat = fs.statSync(file.abs);
    const expectedSha = typeof file.sha256 === 'string' ? file.sha256 : await sha256File(file.abs);
    if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
      fail(CODES.INVALID_SPEC, `归档文件的校验值非法：${rel}`, { path: rel });
    }
    const expectedSize = file.size === undefined || file.size === null ? stat.size : Number(file.size);
    if (!Number.isFinite(expectedSize) || expectedSize < 0) {
      fail(CODES.INVALID_SPEC, `归档文件的大小非法：${rel}`, { path: rel });
    }
    files.push({
      path: rel,
      abs: file.abs,
      size: expectedSize,
      mode: file.mode === undefined ? stat.mode & 0o777 : file.mode,
      mtimeMs: file.mtimeMs === undefined ? Math.floor(stat.mtimeMs) : file.mtimeMs,
      sha256: expectedSha,
    });
  }

  const manifest = {
    format: ARCHIVE_FORMAT,
    kind: input.kind,
    createdAt: input.createdAt || new Date().toISOString(),
    meta: input.meta || {},
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    entries: files.map((file) => ({
      path: file.path,
      size: file.size,
      mode: file.mode,
      mtimeMs: file.mtimeMs,
      sha256: file.sha256,
    })),
  };

  const tarEntries = [
    { path: MANIFEST_PATH, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), mtimeMs: Date.now() },
  ];
  for (const file of files) {
    tarEntries.push({
      path: `${PAYLOAD_PREFIX}${file.path}`,
      abs: file.abs,
      mode: file.mode,
      mtimeMs: file.mtimeMs,
      sha256: file.sha256,
    });
  }

  ensureDir(path.dirname(destFile));
  await writeTarGz(destFile, tarEntries);
  return manifest;
}

function parseManifest(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    fail(CODES.ARCHIVE_CORRUPT, '归档清单不是合法 JSON', {});
  }
  return assertManifest(parsed);
}

/**
 * 只读取归档清单（不读取 payload）。
 * @param {string} file
 */
async function readArchiveManifest(file) {
  for await (const entry of iterateTarGz(file)) {
    if (entry.path !== MANIFEST_PATH) {
      fail(CODES.ARCHIVE_FORMAT, '归档首个条目必须是清单', { first: entry.path });
    }
    const chunks = [];
    await entry.read((chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    return parseManifest(Buffer.concat(chunks).toString('utf8'));
  }
  fail(CODES.ARCHIVE_CORRUPT, '归档为空或缺少清单', { file });
  return null;
}

/**
 * 逐文件核验归档内容与清单一致。
 * @param {string} file
 */
async function verifyArchive(file) {
  const manifest = await readArchiveManifest(file);
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const mismatches = [];
  const seen = new Set();
  let checked = 0;

  for await (const entry of iterateTarGz(file)) {
    if (entry.path === MANIFEST_PATH) continue;
    if (!entry.path.startsWith(PAYLOAD_PREFIX)) {
      // 先走路径安全规则，让 PAX 覆盖成 ../ 或绝对路径的恶意条目得到明确错误码
      normalizeRelPath(entry.path, '归档条目');
      fail(CODES.ARCHIVE_FORMAT, `归档包含未知条目：${entry.path}`, { path: entry.path });
    }
    const rel = normalizeRelPath(entry.path.slice(PAYLOAD_PREFIX.length), '归档条目');
    const record = expected.get(rel);
    if (!record) {
      fail(CODES.ARCHIVE_FORMAT, `归档包含清单外文件：${rel}`, { path: rel });
    }
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    await entry.read((chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    const digest = hash.digest('hex');
    checked += 1;
    seen.add(rel);
    if (bytes !== record.size || digest !== record.sha256) {
      mismatches.push({ path: rel, expected: record.sha256, actual: digest, expectedSize: record.size, actualSize: bytes });
    }
  }

  for (const entry of manifest.entries) {
    if (!seen.has(entry.path)) {
      mismatches.push({ path: entry.path, expected: entry.sha256, actual: null, reason: 'missing' });
    }
  }

  return { ok: mismatches.length === 0, checked, manifest, mismatches };
}

/**
 * 解包到空目录（或 overwrite 允许已存在）。
 * @param {string} file
 * @param {string} destRoot
 * @param {{overwrite?: boolean, onFile?: (info: {path: string, index: number, total: number}) => void}} [opts]
 */
async function extractArchive(file, destRoot, opts) {
  const overwrite = Boolean(opts && opts.overwrite);
  const onFile = opts && opts.onFile;
  const manifest = await readArchiveManifest(file);
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const restored = [];
  const seen = new Set();
  let index = 0;

  for await (const entry of iterateTarGz(file)) {
    if (entry.path === MANIFEST_PATH) continue;
    if (!entry.path.startsWith(PAYLOAD_PREFIX)) {
      // 先走路径安全规则，让 PAX 覆盖成 ../ 或绝对路径的恶意条目得到明确错误码
      normalizeRelPath(entry.path, '归档条目');
      fail(CODES.ARCHIVE_FORMAT, `归档包含未知条目：${entry.path}`, { path: entry.path });
    }
    const rel = normalizeRelPath(entry.path.slice(PAYLOAD_PREFIX.length), '归档条目');
    const record = expected.get(rel);
    if (!record) fail(CODES.ARCHIVE_FORMAT, `归档包含清单外文件：${rel}`, { path: rel });

    const target = resolveWithin(destRoot, rel, { label: '恢复路径' });
    assertNoSymlinkEscape(destRoot, rel);
    if (!overwrite && exists(target)) {
      fail(CODES.CONFLICT, `目标已存在同名文件：${rel}`, { path: rel, target });
    }
    ensureDir(path.dirname(target));

    const tmp = `${target}.vmtmp-${process.pid}-${index}-${crypto.randomBytes(4).toString('hex')}`;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    // 临时文件先以 0600 创建并独占打开，避免私有内容在恢复过程中以默认权限暴露
    const stream = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    let tempCreated = false;
    stream.on('open', () => {
      tempCreated = true;
    });
    const streamError = new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.on('finish', resolve);
    });
    try {
      await entry.read(async (chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
        if (!stream.write(chunk)) await once(stream, 'drain');
      });
      stream.end();
      await streamError;
      const digest = hash.digest('hex');
      if (bytes !== record.size || digest !== record.sha256) {
        fail(CODES.CHECKSUM_MISMATCH, `文件校验失败：${rel}`, {
          path: rel,
          expected: record.sha256,
          actual: digest,
        });
      }
      if (process.platform !== 'win32') {
        // 只保留权限位，丢弃 setuid/setgid/sticky；记录为 0 时退回 0600。
        // 权限设置失败必须中止：不得以默认/更宽松权限把文件 rename 出去。
        const safeMode = (record.mode & 0o777) || 0o600;
        try {
          fs.chmodSync(tmp, safeMode);
        } catch (err) {
          fail(CODES.PERMISSION, `恢复文件权限失败：${rel}（期望 ${safeMode.toString(8)}）`, {
            path: rel,
            target,
            mode: safeMode,
            cause: err.code || err.message,
          });
        }
      }
      fs.renameSync(tmp, target);
      if (record.mtimeMs > 0) {
        try {
          fs.utimesSync(target, new Date(record.mtimeMs), new Date(record.mtimeMs));
        } catch (err) {
          /* 时间戳失败不影响内容正确性 */
        }
      }
    } catch (err) {
      if (tempCreated) safeUnlink(tmp); // 只清理本次确实创建的文件
      stream.destroy();
      throw err;
    }

    index += 1;
    seen.add(rel);
    restored.push({ path: rel, sha256: record.sha256, size: bytes });
    if (onFile) onFile({ path: rel, index, total: manifest.entries.length });
  }

  for (const entry of manifest.entries) {
    if (!seen.has(entry.path)) {
      fail(CODES.ARCHIVE_CORRUPT, `归档缺少清单中的文件：${entry.path}`, { path: entry.path });
    }
  }

  return { manifest, restored };
}

module.exports = {
  ARCHIVE_FORMAT,
  MANIFEST_PATH,
  PAYLOAD_PREFIX,
  KIND_EXTENSIONS,
  writeArchive,
  readArchiveManifest,
  verifyArchive,
  extractArchive,
};
