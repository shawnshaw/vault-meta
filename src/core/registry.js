'use strict';

/**
 * 安装登记表：.obsidian/vault-meta/registry.json
 * 记录每个组件的版本、来源、文件清单（含 sha256）与安装位置，
 * 作为"这是谁的文件 / 能不能删"的唯一依据。
 */
const fs = require('fs');
const path = require('path');
const { CODES, fail } = require('./errors');
const { normalizeRelPath, assertNoSymlinkEscape } = require('./paths');
const { readJson, writeJsonAtomic, ensureDir, nowStamp } = require('./fs-utils');

const REGISTRY_FORMAT = 'vault-meta/registry@1';
const STATE_DIR = '.obsidian/vault-meta';

function statePaths(vaultRoot) {
  const root = path.join(vaultRoot, STATE_DIR);
  return {
    root,
    registry: path.join(root, 'registry.json'),
    projects: path.join(root, 'projects.json'),
    snapshots: path.join(root, 'snapshots'),
    tmp: path.join(root, 'tmp'),
  };
}

/**
 * 状态目录（登记表、快照、临时目录）必须整体位于 vault 内，
 * 任一环节被符号链接指向外部都直接拒绝，避免写入越界。
 * @param {string} vaultRoot
 */
function assertStateSafe(vaultRoot) {
  for (const rel of [
    STATE_DIR,
    `${STATE_DIR}/projects.json`,
    `${STATE_DIR}/snapshots`,
    `${STATE_DIR}/tmp`,
  ]) {
    assertNoSymlinkEscape(vaultRoot, rel);
  }
}

function emptyRegistry() {
  return { format: REGISTRY_FORMAT, updatedAt: new Date().toISOString(), components: {} };
}

function normalizeRecord(record) {
  return {
    id: record.id,
    name: record.name,
    purpose: record.purpose || '',
    version: record.version,
    type: record.type,
    source: record.source || {},
    installLocation: normalizeRelPath(record.installLocation, 'installLocation'),
    files: (record.files || []).map((file) => ({
      path: normalizeRelPath(file.path, '登记文件路径'),
      sha256: file.sha256,
      size: Number(file.size) || 0,
    })),
    dependencies: record.dependencies || [],
    installedAt: record.installedAt || new Date().toISOString(),
    updatedAt: record.updatedAt || new Date().toISOString(),
    status: record.status === 'partial' ? 'partial' : 'installed',
    snapshots: Array.isArray(record.snapshots) ? record.snapshots : [],
  };
}

/**
 * @param {string} vaultRoot
 * @returns {{registry: object, path: string, exists: boolean}}
 */
function loadRegistry(vaultRoot) {
  assertStateSafe(vaultRoot);
  const file = statePaths(vaultRoot).registry;
  if (!fs.existsSync(file)) {
    return { registry: emptyRegistry(), path: file, exists: false };
  }
  const raw = readJson(file, null);
  if (!raw || raw.format !== REGISTRY_FORMAT) {
    fail(CODES.INVALID_SPEC, `安装登记表格式不受支持：${String(raw && raw.format)}`, { path: file });
  }
  const components = {};
  for (const [id, record] of Object.entries(raw.components || {})) {
    components[id] = normalizeRecord({ ...record, id });
  }
  return { registry: { ...emptyRegistry(), ...raw, components }, path: file, exists: true };
}

function saveRegistry(vaultRoot, registry) {
  assertStateSafe(vaultRoot);
  const paths = statePaths(vaultRoot);
  ensureDir(paths.root);
  const next = { ...registry, format: REGISTRY_FORMAT, updatedAt: new Date().toISOString() };
  writeJsonAtomic(paths.registry, next);
  return next;
}

function getRecord(registry, id) {
  return registry.components[id] || null;
}

function upsertRecord(registry, record) {
  const normalized = normalizeRecord(record);
  registry.components[normalized.id] = normalized;
  return normalized;
}

function removeRecord(registry, id) {
  delete registry.components[id];
}

function listRecords(registry) {
  return Object.values(registry.components).sort((a, b) => (a.id < b.id ? -1 : 1));
}

module.exports = {
  REGISTRY_FORMAT,
  assertStateSafe,
  STATE_DIR,
  statePaths,
  emptyRegistry,
  loadRegistry,
  saveRegistry,
  getRecord,
  upsertRecord,
  removeRecord,
  listRecords,
  normalizeRecord,
};
