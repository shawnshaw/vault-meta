'use strict';

/**
 * 整库备份 / 校验 / 恢复。
 * 云同步（iCloud、OneDrive、坚果云等）只是同步，不是历史备份 —— 本模块不把同步目录当作版本历史。
 */
const fs = require('fs');
const path = require('path');
const { CODES, fail } = require('./errors');
const { isInside } = require('./paths');
const { walkFiles, ensureDir, nowStamp, exists, isDirectory, isEmptyDir, formatBytes } = require('./fs-utils');
const { writeArchive, verifyArchive, extractArchive, readArchiveManifest } = require('./archive');

const BACKUP_KIND = 'backup';
const BACKUP_PREFIX = 'vault-backup-';
const BACKUP_EXT = '.vmbak';

function defaultScope() {
  return { git: false, nodeModules: false, trash: false, snapshots: false };
}

function buildExclude({ vaultRoot, destDir, include }) {
  const scope = { ...defaultScope(), ...(include || {}) };
  const destAbs = destDir ? path.resolve(destDir) : null;
  return (rel) => {
    if (rel === '.obsidian/vault-meta/tmp' || rel.startsWith('.obsidian/vault-meta/tmp/')) return true;
    if (!scope.git && (rel === '.git' || rel.startsWith('.git/'))) return true;
    if (!scope.nodeModules && (rel === 'node_modules' || rel.includes('/node_modules/'))) return true;
    if (!scope.trash && (rel === '.trash' || rel.startsWith('.trash/'))) return true;
    if (!scope.snapshots && (rel === '.obsidian/vault-meta/snapshots' || rel.startsWith('.obsidian/vault-meta/snapshots/'))) return true;
    if (destAbs) {
      const abs = path.resolve(vaultRoot, rel);
      if (abs === destAbs || abs.startsWith(`${destAbs}${path.sep}`)) return true;
    }
    return false;
  };
}

/**
 * 创建整库备份。
 * @param {{vaultRoot: string, destDir: string, include?: object, now?: Date}} input
 */
async function createBackup(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  if (!isDirectory(vaultRoot)) fail(CODES.NOT_FOUND, `vault 目录不存在：${vaultRoot}`, { vaultRoot });
  const destDir = path.resolve(input.destDir);
  if (destDir === vaultRoot) {
    fail(CODES.TARGET_INSIDE_SOURCE, '备份目录不能是 vault 根目录', { destDir });
  }
  ensureDir(destDir);

  const scope = { ...defaultScope(), ...(input.include || {}) };
  const stamp = nowStamp(input.now);
  let file = path.join(destDir, `${BACKUP_PREFIX}${stamp}${BACKUP_EXT}`);
  let seq = 2;
  while (exists(file)) {
    file = path.join(destDir, `${BACKUP_PREFIX}${stamp}-${seq}${BACKUP_EXT}`);
    seq += 1;
  }

  const exclude = buildExclude({ vaultRoot, destDir, include: scope });
  const { files, skipped } = walkFiles(vaultRoot, { exclude });
  if (files.length === 0) fail(CODES.NOT_FOUND, 'vault 中没有可备份的文件', { vaultRoot });

  const manifest = await writeArchive(file, {
    kind: BACKUP_KIND,
    meta: {
      vaultName: path.basename(vaultRoot),
      vaultPath: vaultRoot,
      scope,
      destInsideVault: isInside(vaultRoot, destDir),
      skippedCount: skipped.length,
      skippedSample: skipped.slice(0, 50),
    },
    files: files.map((item) => ({ path: item.path, abs: item.abs, mode: item.mode, mtimeMs: item.mtimeMs })),
  });

  const verifyOption = input.verify === undefined ? true : input.verify;
  let verification = { ok: true, checked: manifest.fileCount };
  if (verifyOption) {
    verification = typeof verifyOption === 'function' ? await verifyOption(file) : await verifyArchive(file);
    const ok = Boolean(verification && verification.ok !== false);
    const checkedOk = !verification || verification.checked === undefined || verification.checked === manifest.fileCount;
    if (!ok || !checkedOk) {
      try {
        fs.unlinkSync(file);
      } catch (cleanupErr) {
        /* 尽力删除本次产物；失败不改变"不得报告成功"的结论 */
      }
      fail(CODES.CHECKSUM_MISMATCH, '备份写入后校验失败，已删除本次产物（既有备份未受影响）', {
        file,
        verification,
      });
    }
  }

  return {
    file,
    manifest,
    verified: Boolean(verifyOption),
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    totalText: formatBytes(manifest.totalBytes),
    skippedCount: skipped.length,
    destInsideVault: isInside(vaultRoot, destDir),
  };
}

/** 列出目录内的备份（按文件名倒序），损坏的备份单独标记而不吞掉。 */
async function listBackups(destDir) {
  const dir = path.resolve(destDir);
  if (!isDirectory(dir)) return [];
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(BACKUP_EXT))
    .sort()
    .reverse();
  const result = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      continue;
    }
    try {
      const manifest = await readArchiveManifest(file);
      result.push({
        file,
        name,
        size: stat.size,
        sizeText: formatBytes(stat.size),
        createdAt: manifest.createdAt,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        totalText: formatBytes(manifest.totalBytes),
        vaultName: (manifest.meta && manifest.meta.vaultName) || '',
        scope: (manifest.meta && manifest.meta.scope) || defaultScope(),
        error: null,
      });
    } catch (err) {
      result.push({ file, name, size: stat.size, sizeText: formatBytes(stat.size), error: err.message });
    }
  }
  return result;
}

/** 校验备份完整性（逐文件 sha256）。 */
async function verifyBackup(file) {
  return verifyArchive(path.resolve(file));
}

/**
 * 恢复到目标目录。目标必须为空（或 overwrite=true）。
 * @param {{file: string, targetDir: string, overwrite?: boolean, vaultRoot?: string, allowInsideVault?: boolean}} input
 */
async function restoreBackup(input) {
  const file = path.resolve(input.file);
  const targetDir = path.resolve(input.targetDir);
  if (!exists(file)) fail(CODES.NOT_FOUND, `备份文件不存在：${file}`, { file });

  if (input.vaultRoot) {
    const vaultRoot = path.resolve(input.vaultRoot);
    if (isInside(vaultRoot, targetDir) && !input.allowInsideVault) {
      fail(CODES.TARGET_INSIDE_SOURCE, '恢复目标位于当前 vault 内，已拒绝直接覆盖；请选择其他目录', { targetDir });
    }
  }

  if (exists(targetDir)) {
    if (!isDirectory(targetDir)) fail(CODES.CONFLICT, `恢复目标不是目录：${targetDir}`, { targetDir });
    if (!isEmptyDir(targetDir) && !input.overwrite) {
      fail(CODES.TARGET_NOT_EMPTY, '恢复目标目录非空；为安全起见请使用空目录', { targetDir });
    }
  } else {
    ensureDir(targetDir);
  }

  const { manifest, restored } = await extractArchive(file, targetDir, {
    overwrite: Boolean(input.overwrite),
  });

  return {
    targetDir,
    manifest,
    restoredCount: restored.length,
    totalText: formatBytes(manifest.totalBytes),
    verified: true,
  };
}

module.exports = {
  BACKUP_KIND,
  BACKUP_PREFIX,
  BACKUP_EXT,
  defaultScope,
  createBackup,
  listBackups,
  verifyBackup,
  restoreBackup,
};
