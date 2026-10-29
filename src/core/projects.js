'use strict';

/**
 * 项目关联记录：.obsidian/vault-meta/projects.json
 * 只描述"项目在本机的三个位置"与最后一次只读检查结果，不保存凭据与导出物。
 * baseline 只在接入/编辑/更新基线时写入；lastCheck 只在检查时写入。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CODES, fail } = require('./errors');
const { readJson, writeJsonAtomic, ensureDir } = require('./fs-utils');
const { normalizeRelPath } = require('./paths');
const { assertStateSafe, statePaths } = require('./registry');

const PROJECTS_FORMAT = 'vault-meta/projects@1';
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PLUGIN_ROOT = '.obsidian/plugins/';

function emptyProjects() {
  return { format: PROJECTS_FORMAT, updatedAt: new Date().toISOString(), projects: [] };
}

function isoOrNow(value) {
  return typeof value === 'string' && value ? value : new Date().toISOString();
}

function cleanText(value, label, max) {
  if (typeof value !== 'string') fail(CODES.PROJECT_INVALID, `${label}必须是字符串`);
  const text = value.trim();
  if (text.length > (max || 200)) fail(CODES.PROJECT_INVALID, `${label}过长`);
  return text;
}

function cleanHash(value, label) {
  if (!value) return '';
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(CODES.PROJECT_INVALID, `${label}必须是 sha256 十六进制值`);
  }
  return value;
}

/**
 * 项目 id = 名称/插件 id 的 slug + 源码路径哈希前 6 位。
 * 与组件登记表 id 分属两个命名空间。
 */
function createProjectId(name, sourcePath) {
  const slug = String(name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40) || 'project';
  const normalizedPath = sourcePath ? path.resolve(String(sourcePath)) : '';
  const digest = crypto.createHash('sha256').update(normalizedPath).digest('hex').slice(0, 6);
  return `${slug}-${digest}`;
}

function normalizeRemote(raw) {
  if (!raw || typeof raw !== 'object') return { url: '', branch: '' };
  const url = cleanText(raw.url || '', '远端地址', 300);
  if (url && !/^(https?:\/\/|ssh:\/\/|git@)/.test(url)) {
    fail(CODES.PROJECT_INVALID, '远端地址只能是 https、ssh 或 git@ 形式');
  }
  return { url, branch: cleanText(raw.branch || '', '远端分支', 120) };
}

function normalizeBaseline(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    sourceIdentity: cleanHash(raw.sourceIdentity, '源码身份'),
    sourceVersion: cleanText(raw.sourceVersion || '', '源码版本', 64),
    commit: cleanText(raw.commit || '', '本地提交', 64),
    artifactSha256: cleanHash(raw.artifactSha256, '构建产物校验值'),
    recordedAt: isoOrNow(raw.recordedAt),
  };
}

function normalizeRelease(raw) {
  if (!raw || typeof raw !== 'object' || !raw.version) return null;
  return {
    tag: cleanText(raw.tag || '', '发布标签', 120),
    version: cleanText(raw.version, '发布版本', 64),
  };
}

function normalizeLastCheck(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    at: isoOrNow(raw.at),
    ok: raw.ok === true,
    code: cleanText(raw.code || '', '检查错误码', 64),
    error: cleanText(raw.error || '', '检查错误', 300),
    branch: cleanText(raw.branch || '', '检查分支', 120),
    commit: cleanText(raw.commit || '', '远端提交', 64),
    developmentVersion: cleanText(raw.developmentVersion || '', '开发线版本', 64),
    release: normalizeRelease(raw.release),
  };
}

/**
 * @param {object} raw
 * @returns {object} 规范化后的项目记录
 */
function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') fail(CODES.PROJECT_INVALID, '项目记录必须是对象');
  const id = cleanText(raw.id || '', '项目 id', 80);
  if (!PROJECT_ID_PATTERN.test(id)) {
    fail(CODES.PROJECT_INVALID, `项目 id 不合法：${id || '(空)'}`, { id });
  }
  const sourcePath = cleanText(raw.sourcePath || '', '源码目录', 4096);
  if (!path.isAbsolute(sourcePath)) {
    fail(CODES.PROJECT_INVALID, '源码目录必须是绝对路径', { sourcePath });
  }
  const normalizedSource = path.resolve(sourcePath);
  const installLocation = normalizeRelPath(raw.installLocation || '', '安装位置');
  if (!installLocation.startsWith(PLUGIN_ROOT)) {
    fail(CODES.PROJECT_INVALID, `安装位置必须位于 ${PLUGIN_ROOT}<插件 id>`, { installLocation });
  }
  const pluginId = cleanText(raw.pluginId || '', '插件 id', 64);
  if (pluginId && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pluginId)) {
    fail(CODES.PROJECT_INVALID, `插件 id 不合法：${pluginId}`, { pluginId });
  }
  return {
    id,
    name: cleanText(raw.name || '', '项目名称', 120),
    purpose: cleanText(raw.purpose || '', '项目用途', 400),
    pluginId,
    sourcePath: normalizedSource,
    remote: normalizeRemote(raw.remote),
    installLocation,
    baseline: normalizeBaseline(raw.baseline),
    lastCheck: normalizeLastCheck(raw.lastCheck),
    createdAt: isoOrNow(raw.createdAt),
    updatedAt: isoOrNow(raw.updatedAt),
  };
}

/**
 * @param {string} vaultRoot
 * @returns {{store: object, path: string, exists: boolean}}
 */
function loadProjects(vaultRoot) {
  assertStateSafe(vaultRoot);
  const file = statePaths(vaultRoot).projects;
  if (!fs.existsSync(file)) {
    return { store: emptyProjects(), path: file, exists: false };
  }
  const raw = readJson(file, null);
  if (!raw || raw.format !== PROJECTS_FORMAT) {
    fail(CODES.INVALID_SPEC, `项目记录格式不受支持：${String(raw && raw.format)}`, { path: file });
  }
  return {
    store: {
      format: PROJECTS_FORMAT,
      updatedAt: isoOrNow(raw.updatedAt),
      projects: (raw.projects || []).map((item) => normalizeProject(item)),
    },
    path: file,
    exists: true,
  };
}

function assertNoConflicts(store, project) {
  for (const other of store.projects) {
    if (other.id === project.id) continue;
    if (other.installLocation === project.installLocation) {
      fail(CODES.PROJECT_INVALID, `安装位置已被项目「${other.name}」占用`, {
        installLocation: project.installLocation,
        projectId: other.id,
      });
    }
    if (other.sourcePath === project.sourcePath) {
      fail(CODES.PROJECT_INVALID, `源码目录已关联项目「${other.name}」`, {
        sourcePath: project.sourcePath,
        projectId: other.id,
      });
    }
  }
}

function saveProjects(vaultRoot, store) {
  assertStateSafe(vaultRoot);
  const paths = statePaths(vaultRoot);
  ensureDir(paths.root);
  const projects = (store.projects || []).map((item) => normalizeProject(item));
  const seen = new Set();
  for (const project of projects) {
    if (seen.has(project.id)) fail(CODES.PROJECT_INVALID, `项目 id 重复：${project.id}`);
    seen.add(project.id);
    assertNoConflicts({ projects }, project);
  }
  const next = { format: PROJECTS_FORMAT, updatedAt: new Date().toISOString(), projects };
  writeJsonAtomic(paths.projects, next);
  return next;
}

function upsertProject(store, raw) {
  const project = normalizeProject(raw);
  assertNoConflicts(store, project);
  const existing = store.projects.findIndex((item) => item.id === project.id);
  if (existing >= 0) {
    project.createdAt = store.projects[existing].createdAt;
    project.updatedAt = new Date().toISOString();
    store.projects[existing] = project;
  } else {
    store.projects.push(project);
  }
  return project;
}

function removeProject(store, id) {
  const index = store.projects.findIndex((item) => item.id === id);
  if (index < 0) return false;
  store.projects.splice(index, 1);
  return true;
}

function listProjects(store) {
  return [...store.projects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

function findByPluginId(store, pluginId) {
  return store.projects.find((item) => item.pluginId === pluginId) || null;
}

function findBySourcePath(store, sourcePath) {
  return store.projects.find((item) => item.sourcePath === sourcePath) || null;
}

function getProject(store, id) {
  return store.projects.find((item) => item.id === id) || null;
}

module.exports = {
  PROJECTS_FORMAT,
  PROJECT_ID_PATTERN,
  createProjectId,
  emptyProjects,
  normalizeProject,
  loadProjects,
  saveProjects,
  upsertProject,
  removeProject,
  listProjects,
  findByPluginId,
  findBySourcePath,
  getProject,
};
