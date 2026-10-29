'use strict';

/**
 * 组件安装 / 升级 / 卸载。
 * 铁律：
 * 1. 安装或升级前先建快照；任何一步失败都回到安装前状态。
 * 2. 只写入 install.location 之内，且不穿越符号链接。
 * 3. 卸载只删除"登记在册且内容未被改动"的文件，用户数据一律保留。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CODES, VaultMetaError, fail, isVaultMetaError } = require('./errors');
const { normalizeRelPath, resolveWithin, assertNoSymlinkEscape, toPosixRel } = require('./paths');
const { normalizeComponentSpec, compareVersions, satisfies } = require('./component-spec');
const { readArchiveManifest, extractArchive } = require('./archive');
const {
  loadRegistry,
  saveRegistry,
  getRecord,
  upsertRecord,
  removeRecord,
  assertStateSafe,
  statePaths,
} = require('./registry');
const {
  walkFiles,
  exists,
  isDirectory,
  ensureDir,
  copyFileAtomic,
  writeJsonAtomic,
  nowStamp,
  pruneEmptyDirs,
  sha256File,
  readJson,
  safeUnlink,
} = require('./fs-utils');

const MAX_SNAPSHOTS = 5;

function relativeTo(vaultRoot, absPath) {
  return path.relative(vaultRoot, absPath).split(path.sep).join('/');
}

/**
 * 读取组件包并交叉校验描述与内容。
 * @param {string} packageFile
 */
async function readComponentPackage(packageFile) {
  const manifest = await readArchiveManifest(packageFile);
  if (manifest.kind !== 'component') {
    fail(CODES.ARCHIVE_FORMAT, '该文件不是组件包', { kind: manifest.kind });
  }
  const rawSpec = manifest.meta && manifest.meta.component;
  if (!rawSpec) fail(CODES.ARCHIVE_FORMAT, '组件包缺少 component 描述', { file: packageFile });
  const spec = normalizeComponentSpec(rawSpec);
  if (manifest.entries.length !== spec.files.length) {
    fail(CODES.CHECKSUM_MISMATCH, '组件包文件数量与描述不一致', {
      declared: spec.files.length,
      actual: manifest.entries.length,
    });
  }
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const file of spec.files) {
    const entry = byPath.get(file.path);
    if (!entry || entry.sha256 !== file.sha256 || entry.size !== file.size) {
      fail(CODES.CHECKSUM_MISMATCH, `组件包描述与内容不一致：${file.path}`, { path: file.path });
    }
  }
  return { manifest, spec };
}

/** 登记记录中某个文件的完整 vault 相对路径（父子目录重叠时以此判定归属）。 */
function recordFileRelPath(record, filePath) {
  return normalizeRelPath(`${record.installLocation}/${filePath}`, '登记文件路径');
}

function findOwner(registry, fullRelPath, excludeId) {
  for (const record of Object.values(registry.components)) {
    if (excludeId && record.id === excludeId) continue;
    for (const file of record.files || []) {
      if (recordFileRelPath(record, file.path) === fullRelPath) return record;
    }
  }
  return null;
}

/** 创建不碰撞的目录：时间戳 + 随机后缀，失败重试；已存在目录绝不覆盖。 */
function createUniqueDir(vaultRoot, parentAbs, prefix) {
  assertNoSymlinkEscape(vaultRoot, toPosixRel(path.relative(vaultRoot, parentAbs)));
  ensureDir(parentAbs);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = path.join(parentAbs, `${prefix}${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        fail(CODES.IO, `无法创建目录：${path.basename(candidate)}`, { path: candidate, cause: err.code });
      }
    }
  }
  fail(CODES.IO, '无法创建唯一目录（多次碰撞）', { parent: parentAbs });
  return null;
}

/**
 * 安装前预检：依赖、冲突、路径安全。不写任何文件。
 * @param {{vaultRoot: string, packageFile: string, registry: object, types: object, available?: Array<{id: string, version: string}>}} input
 */
async function preflightInstall(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  const registry = input.registry;
  const available = input.available || [];
  const { spec, manifest } = await readComponentPackage(input.packageFile);

  const handler = input.types.get(spec.type);
  handler.validateSpec(spec, { vaultRoot });

  const targetAbs = resolveWithin(vaultRoot, spec.install.location, { label: '安装位置' });
  if (targetAbs === vaultRoot) fail(CODES.PATH_ESCAPE, '安装位置不能是 vault 根目录', { location: spec.install.location });
  assertNoSymlinkEscape(vaultRoot, spec.install.location);

  const conflicts = [];
  const overwriteFiles = [];

  for (const file of spec.files) {
    const rel = `${spec.install.location}/${file.path}`;
    assertNoSymlinkEscape(vaultRoot, rel);
    const abs = resolveWithin(vaultRoot, rel, { label: '安装文件路径' });
    if (!exists(abs)) continue;
    if (isDirectory(abs)) {
      conflicts.push({ path: file.path, reason: 'target-is-directory' });
      continue;
    }
    const digest = await sha256File(abs);
    const fullRel = normalizeRelPath(`${spec.install.location}/${file.path}`, '安装文件路径');
    const owner = findOwner(registry, fullRel);
    if (!owner) {
      if (digest !== file.sha256) conflicts.push({ path: file.path, reason: 'unmanaged-file' });
      continue;
    }
    if (owner.id !== spec.id) {
      // 内容相同也算冲突：一个文件不能被两个组件同时"独占"。
      conflicts.push({ path: file.path, reason: 'owned-by-another', ownerId: owner.id });
      continue;
    }
    if (digest !== file.sha256) overwriteFiles.push({ path: file.path, ownerId: owner.id });
  }

  const missingDependencies = [];
  for (const dep of spec.dependencies) {
    if (dep.optional) continue;
    const installed = getRecord(registry, dep.id);
    const provided = available.find((item) => item.id === dep.id);
    const candidate = installed || provided;
    if (!candidate) {
      missingDependencies.push({ id: dep.id, range: dep.range, reason: 'not-installed' });
      continue;
    }
    if (!satisfies(candidate.version, dep.range)) {
      missingDependencies.push({ id: dep.id, range: dep.range, reason: 'version-mismatch', actual: candidate.version });
    }
  }

  const existing = getRecord(registry, spec.id);
  let action = 'install';
  if (existing) {
    const delta = compareVersions(spec.version, existing.version);
    action = delta > 0 ? 'upgrade' : delta < 0 ? 'downgrade' : 'reinstall';
  }

  return {
    spec,
    manifest,
    handler,
    targetAbs,
    conflicts,
    overwriteFiles,
    missingDependencies,
    existingRecord: existing,
    action,
    blocked: conflicts.length > 0 || missingDependencies.length > 0,
    fileCount: spec.files.length,
    totalBytes: spec.files.reduce((sum, file) => sum + file.size, 0),
  };
}

function copyTree(srcDir, destDir) {
  if (!isDirectory(srcDir)) return 0;
  const { files } = walkFiles(srcDir);
  for (const file of files) {
    copyFileAtomic(file.abs, path.join(destDir, file.path), file.mode);
  }
  return files.length;
}

function pruneSnapshots(vaultRoot, record) {
  assertStateSafe(vaultRoot);
  const dir = path.join(statePaths(vaultRoot).snapshots, record.id);
  if (!isDirectory(dir)) return;
  const referenced = new Set((record.snapshots || []).map((item) => path.basename(item.path)));
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (referenced.has(name)) continue;
    let meta = null;
    try {
      meta = readJson(path.join(abs, 'snapshot.json'), null);
    } catch (err) {
      meta = null;
    }
    if (meta && meta.failed) continue; // 失败快照保留用于排查
    try {
      fs.rmSync(abs, { recursive: true, force: true });
    } catch (err) {
      /* 清理失败不影响安装结果 */
    }
  }
}

function buildRecord(spec, existing, snapshotRef) {
  const now = new Date().toISOString();
  const snapshots = [...((existing && existing.snapshots) || []), snapshotRef].slice(-MAX_SNAPSHOTS);
  return {
    id: spec.id,
    name: spec.name,
    purpose: spec.purpose,
    version: spec.version,
    type: spec.type,
    source: spec.source,
    installLocation: spec.install.location,
    files: spec.files,
    dependencies: spec.dependencies,
    installedAt: (existing && existing.installedAt) || now,
    updatedAt: now,
    status: 'installed',
    snapshots,
  };
}

/**
 * 回滚：恢复快照中存在的文件，删除本次新建且快照中没有的文件。
 * @param {{vaultRoot: string, installLocation: string, snapshotAbs: string, written: string[], hadSnapshot: boolean}} input
 */
async function rollback(input) {
  const { vaultRoot, installLocation, snapshotAbs, written, hadSnapshot } = input;
  const prefix = `${installLocation}/`;
  const restored = [];
  const removed = [];
  const errors = [];

  for (const rel of [...written].reverse()) {
    const abs = resolveWithin(vaultRoot, rel, { label: '回滚路径' });
    const inner = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
    const snapshotFile = path.join(snapshotAbs, 'files', inner);
    try {
      if (hadSnapshot && exists(snapshotFile)) {
        copyFileAtomic(snapshotFile, abs);
        restored.push(rel);
      } else if (exists(abs)) {
        fs.unlinkSync(abs);
        removed.push(rel);
      }
    } catch (err) {
      errors.push({ path: rel, cause: err.code || String(err) });
    }
  }

  for (const rel of written) {
    try {
      pruneEmptyDirs(vaultRoot, path.dirname(resolveWithin(vaultRoot, rel, { label: '回滚路径' })));
    } catch (err) {
      /* 目录清理失败不影响文件内容回滚 */
    }
  }

  return { ok: errors.length === 0, restored, removed, errors };
}

/**
 * 执行安装/升级。失败自动回滚并保留失败快照。
 * @param {{vaultRoot: string, packageFile: string, registry: object, types: object, available?: Array}} input
 */
async function applyInstall(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  assertStateSafe(vaultRoot);
  const registry = input.registry || loadRegistry(vaultRoot).registry;
  const pre = await preflightInstall({ ...input, vaultRoot, registry });

  if (pre.conflicts.length > 0) {
    fail(CODES.CONFLICT, `安装被拒绝：${pre.conflicts.length} 处文件冲突`, { conflicts: pre.conflicts });
  }
  if (pre.missingDependencies.length > 0) {
    fail(CODES.MISSING_DEPENDENCY, '安装被拒绝：缺少依赖组件', { dependencies: pre.missingDependencies });
  }

  const stamp = nowStamp(input.now);
  const snapshotsRoot = statePaths(vaultRoot).snapshots;
  const snapshotParent = path.join(snapshotsRoot, pre.spec.id);
  const snapshotAbs = createUniqueDir(vaultRoot, snapshotParent, `${stamp}-`);
  const snapshotRef = {
    path: relativeTo(vaultRoot, snapshotAbs),
    createdAt: new Date().toISOString(),
    reason: pre.action,
    fromVersion: pre.existingRecord ? pre.existingRecord.version : null,
    toVersion: pre.spec.version,
  };

  const hadSnapshot = isDirectory(pre.targetAbs);
  let copied = 0;
  if (hadSnapshot) {
    copied = copyTree(pre.targetAbs, path.join(snapshotAbs, 'files'));
  }
  writeJsonAtomic(path.join(snapshotAbs, 'snapshot.json'), {
    ...snapshotRef,
    id: pre.spec.id,
    installLocation: pre.spec.install.location,
    copiedFiles: copied,
  });

  const tmpDir = createUniqueDir(vaultRoot, statePaths(vaultRoot).tmp, `install-${pre.spec.id}-${stamp}-`);
  const written = [];
  const previousRecord = pre.existingRecord ? JSON.parse(JSON.stringify(pre.existingRecord)) : null;

  try {
    await extractArchive(input.packageFile, tmpDir);

    for (const file of pre.spec.files) {
      const rel = `${pre.spec.install.location}/${file.path}`;
      assertNoSymlinkEscape(vaultRoot, rel);
      const dest = resolveWithin(vaultRoot, rel, { label: '安装目标文件' });
      copyFileAtomic(resolveWithin(tmpDir, file.path), dest, file.mode);
      written.push(rel);
    }

    const verification = await pre.handler.verifyInstalled({ targetAbs: pre.targetAbs, spec: pre.spec });

    const record = buildRecord(pre.spec, previousRecord, snapshotRef);
    upsertRecord(registry, record);
    saveRegistry(vaultRoot, registry);
    pruneSnapshots(vaultRoot, record);

    return {
      status: 'installed',
      action: pre.action,
      record,
      snapshot: snapshotRef,
      verification,
      fileCount: pre.spec.files.length,
    };
  } catch (err) {
    const result = await rollback({ vaultRoot, installLocation: pre.spec.install.location, snapshotAbs, written, hadSnapshot });
    if (previousRecord) registry.components[pre.spec.id] = previousRecord;
    else removeRecord(registry, pre.spec.id);
    try {
      saveRegistry(vaultRoot, registry);
    } catch (saveErr) {
      result.ok = false;
      result.errors.push({ path: 'registry', cause: saveErr.code || String(saveErr) });
    }
    try {
      writeJsonAtomic(path.join(snapshotAbs, 'snapshot.json'), {
        ...snapshotRef,
        id: pre.spec.id,
        installLocation: pre.spec.install.location,
        copiedFiles: copied,
        failed: true,
        failedAt: new Date().toISOString(),
        error: { code: isVaultMetaError(err) ? err.code : CODES.IO, message: err && err.message },
      });
    } catch (markErr) {
      /* 标记失败不影响回滚结果 */
    }

    const message = isVaultMetaError(err) ? err.message : `安装失败：${err && err.message}`;
    const suffix = result.ok ? '（已回滚到安装前状态）' : '（回滚未完成，请检查快照）';
    throw new VaultMetaError(
      isVaultMetaError(err) ? err.code : CODES.IO,
      `${message}${suffix}`,
      { ...(err.details || {}), rollback: result, snapshot: snapshotRef },
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      /* ignore */
    }
  }
}

/**
 * 卸载预检：区分"可删除"和"已改动需保留"。
 */
async function planUninstall(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  const record = getRecord(input.registry, input.id);
  if (!record) fail(CODES.NOT_FOUND, `未登记的组件：${input.id}`, { id: input.id });

  const targetAbs = resolveWithin(vaultRoot, record.installLocation, { label: '安装位置' });
  const remove = [];
  const keep = [];
  const missing = [];

  for (const file of record.files) {
    const rel = `${record.installLocation}/${file.path}`;
    assertNoSymlinkEscape(vaultRoot, rel);
    const abs = resolveWithin(vaultRoot, rel, { label: '卸载文件路径' });
    if (!exists(abs)) {
      missing.push({ path: file.path });
      continue;
    }
    const fullRel = normalizeRelPath(rel, '卸载文件路径');
    const owner = findOwner(input.registry, fullRel, record.id);
    if (owner && owner.id !== record.id) {
      keep.push({ path: file.path, reason: 'claimed-by-other', ownerId: owner.id });
      continue;
    }
    const digest = await sha256File(abs);
    if (digest !== file.sha256) {
      keep.push({ path: file.path, reason: 'modified' });
      continue;
    }
    remove.push(file.path);
  }

  return { record, targetAbs, remove, keep, missing };
}

/**
 * 执行卸载：只删登记且未改动的文件；用户新增/修改的文件保留。
 */
async function applyUninstall(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  assertStateSafe(vaultRoot);
  const registry = input.registry || loadRegistry(vaultRoot).registry;
  const plan = await planUninstall({ vaultRoot, registry, id: input.id });

  const removed = [];
  for (const rel of plan.remove) {
    const abs = resolveWithin(vaultRoot, `${plan.record.installLocation}/${rel}`, { label: '卸载文件路径' });
    try {
      fs.unlinkSync(abs);
      removed.push(rel);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        fail(CODES.IO, `删除失败：${rel}`, { path: rel, cause: err.code });
      }
    }
  }
  pruneEmptyDirs(vaultRoot, plan.targetAbs);

  const remainingFiles = plan.record.files.filter((file) => plan.keep.some((kept) => kept.path === file.path));
  if (remainingFiles.length > 0) {
    plan.record.files = remainingFiles;
    plan.record.status = 'partial';
    plan.record.updatedAt = new Date().toISOString();
    upsertRecord(registry, plan.record);
  } else {
    removeRecord(registry, input.id);
  }
  saveRegistry(vaultRoot, registry);

  return {
    status: remainingFiles.length > 0 ? 'partial' : 'removed',
    removed,
    kept: plan.keep,
    missing: plan.missing,
    remainingFiles: remainingFiles.map((file) => file.path),
    installLocation: plan.record.installLocation,
  };
}

/** 读取插件目录里的 manifest，用于 UI 展示真实版本。 */
function readInstalledManifest(targetAbs) {
  return readJson(path.join(targetAbs, 'manifest.json'), null);
}

module.exports = {
  MAX_SNAPSHOTS,
  readComponentPackage,
  preflightInstall,
  applyInstall,
  planUninstall,
  applyUninstall,
  readInstalledManifest,
  relativeTo,
};
