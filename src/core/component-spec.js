'use strict';

/**
 * 组件与套装描述格式（v1）。
 * 这两个格式由本任务定义，只描述"如何安装与校验"，不改变任何业务插件自身的数据格式。
 */
const { CODES, fail } = require('./errors');
const { normalizeRelPath } = require('./paths');

const COMPONENT_FORMAT = 'vault-meta/component@1';
const SUITE_FORMAT = 'vault-meta/suite@1';
const KNOWN_TYPES = Object.freeze(['obsidian-plugin', 'files']);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    raw: version.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function assertVersion(version, label) {
  const parsed = parseVersion(version);
  if (!parsed) {
    fail(CODES.INVALID_VERSION, `${label}不是合法的语义化版本：${String(version)}`, { version });
  }
  return parsed;
}

function compareVersions(a, b) {
  const pa = typeof a === 'string' ? parseVersion(a) : a;
  const pb = typeof b === 'string' ? parseVersion(b) : b;
  if (!pa || !pb) fail(CODES.INVALID_VERSION, '版本比较时遇到非法版本号', { a, b });
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * 最小 semver 范围：* / 精确 / ^ / ~ / >=。
 * @param {string} version
 * @param {string} range
 */
function satisfies(version, range) {
  const parsed = assertVersion(version, '组件版本');
  const text = String(range || '*').trim();
  if (text === '' || text === '*' || text === 'latest') return true;

  if (text.startsWith('^')) {
    const base = assertVersion(text.slice(1), '依赖范围');
    if (compareVersions(parsed, base) < 0) return false;
    if (base.major > 0) return parsed.major === base.major;
    if (base.minor > 0) return parsed.major === 0 && parsed.minor === base.minor;
    return parsed.major === 0 && parsed.minor === 0 && parsed.patch === base.patch;
  }
  if (text.startsWith('~')) {
    const base = assertVersion(text.slice(1), '依赖范围');
    if (compareVersions(parsed, base) < 0) return false;
    return parsed.major === base.major && parsed.minor === base.minor;
  }
  if (text.startsWith('>=')) {
    return compareVersions(parsed, assertVersion(text.slice(2), '依赖范围')) >= 0;
  }
  return compareVersions(parsed, assertVersion(text, '依赖范围')) === 0;
}

function requireString(value, label, opts) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(CODES.INVALID_SPEC, `${label}不能为空`, { field: label, value });
  }
  if (opts && opts.maxLength && value.length > opts.maxLength) {
    fail(CODES.INVALID_SPEC, `${label}过长（>${opts.maxLength}）`, { field: label });
  }
  return value.trim();
}

function normalizeDependencies(raw, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail(CODES.INVALID_SPEC, `${label}.dependencies 必须是数组`, { field: `${label}.dependencies` });
  }
  const seen = new Set();
  return raw.map((dep, index) => {
    const id = requireString(dep && dep.id, `${label}.dependencies[${index}].id`);
    if (!ID_PATTERN.test(id)) {
      fail(CODES.INVALID_SPEC, `依赖 ID 不合法：${id}`, { field: `${label}.dependencies[${index}].id`, id });
    }
    if (seen.has(id)) {
      fail(CODES.INVALID_SPEC, `依赖重复：${id}`, { field: `${label}.dependencies`, id });
    }
    seen.add(id);
    // 外部描述用 version，内部归一化为 range；两者都接受，保证归档往返不丢信息
    const source = dep.version === undefined ? dep.range : dep.version;
    const range = source === undefined || source === null || source === '' ? '*' : String(source);
    if (range !== '*') assertVersion(range.replace(/^[\^~]/, '').replace(/^>=/, ''), `${label}.dependencies[${index}].version`);
    return { id, range, optional: Boolean(dep.optional) };
  });
}

/**
 * 规范化并校验组件描述。
 * @param {object} raw
 * @returns {object}
 */
function normalizeComponentSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(CODES.INVALID_SPEC, '组件描述必须是对象', {});
  }
  if (raw.format !== COMPONENT_FORMAT) {
    fail(CODES.INVALID_SPEC, `组件描述 format 必须是 ${COMPONENT_FORMAT}`, { format: raw.format });
  }
  const id = requireString(raw.id, '组件 id', { maxLength: 64 });
  if (!ID_PATTERN.test(id)) {
    fail(CODES.INVALID_SPEC, `组件 id 只能包含小写字母、数字、点、下划线与连字符：${id}`, { id });
  }
  const type = requireString(raw.type, '组件 type', { maxLength: 64 });
  const version = requireString(raw.version, '组件 version', { maxLength: 32 });
  assertVersion(version, '组件 version');

  const installRaw = raw.install && typeof raw.install === 'object' ? raw.install : {};
  const locationText = requireString(installRaw.location, '安装位置 install.location');
  const location = normalizeRelPath(locationText, '安装位置');

  const files = (Array.isArray(raw.files) ? raw.files : []).map((file, index) => {
    const rel = normalizeRelPath(file && file.path, `files[${index}].path`);
    const sha256 = String((file && file.sha256) || '');
    if (!HASH_PATTERN.test(sha256)) {
      fail(CODES.INVALID_SPEC, `文件校验值非法：${rel}`, { path: rel, sha256 });
    }
    const size = Number(file && file.size);
    if (!Number.isFinite(size) || size < 0) {
      fail(CODES.INVALID_SPEC, `文件大小非法：${rel}`, { path: rel });
    }
    return { path: rel, sha256, size };
  });
  if (files.length === 0) {
    fail(CODES.INVALID_SPEC, '组件描述必须包含至少一个文件', { id });
  }
  const filePaths = new Set(files.map((file) => file.path));
  if (filePaths.size !== files.length) {
    fail(CODES.INVALID_SPEC, '组件文件列表存在重复路径', { id });
  }

  const sourceRaw = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const source = {
    kind: typeof sourceRaw.kind === 'string' ? sourceRaw.kind : 'vault',
    origin: typeof sourceRaw.origin === 'string' ? sourceRaw.origin : '',
    path: typeof sourceRaw.path === 'string' ? sourceRaw.path : '',
  };

  return {
    format: COMPONENT_FORMAT,
    id,
    name: requireString(raw.name, '组件 name', { maxLength: 120 }),
    purpose: typeof raw.purpose === 'string' ? raw.purpose.trim() : '',
    version,
    type,
    source,
    install: { location, mode: installRaw.mode === 'files' ? 'files' : 'directory' },
    files,
    dependencies: normalizeDependencies(raw.dependencies, '组件'),
    compatibility: raw.compatibility && typeof raw.compatibility === 'object' ? { ...raw.compatibility } : {},
    metadata: raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {},
    extension: raw.extension && typeof raw.extension === 'object' ? { ...raw.extension } : {},
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

/**
 * 规范化套装描述。
 * components[].version 为空表示"使用登记表中的当前版本"。
 * @param {object} raw
 */
function normalizeSuiteSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(CODES.INVALID_SPEC, '套装描述必须是对象', {});
  }
  if (raw.format !== SUITE_FORMAT) {
    fail(CODES.INVALID_SPEC, `套装描述 format 必须是 ${SUITE_FORMAT}`, { format: raw.format });
  }
  const id = requireString(raw.id, '套装 id', { maxLength: 64 });
  if (!ID_PATTERN.test(id)) {
    fail(CODES.INVALID_SPEC, `套装 id 不合法：${id}`, { id });
  }
  const version = requireString(raw.version, '套装 version', { maxLength: 32 });
  assertVersion(version, '套装 version');

  if (!Array.isArray(raw.components) || raw.components.length === 0) {
    fail(CODES.INVALID_SPEC, '套装必须至少包含一个组件', { id });
  }
  const seen = new Set();
  const components = raw.components.map((item, index) => {
    const componentId = requireString(item && item.id, `components[${index}].id`);
    if (!ID_PATTERN.test(componentId)) {
      fail(CODES.INVALID_SPEC, `组件 ID 不合法：${componentId}`, { id: componentId });
    }
    if (seen.has(componentId)) {
      fail(CODES.INVALID_SPEC, `套装内组件重复：${componentId}`, { id: componentId });
    }
    seen.add(componentId);
    const versionText = item.version === undefined || item.version === null ? '' : String(item.version);
    if (versionText) assertVersion(versionText, `components[${index}].version`);
    return { id: componentId, version: versionText, optional: Boolean(item.optional) };
  });

  return {
    format: SUITE_FORMAT,
    id,
    name: requireString(raw.name, '套装 name', { maxLength: 120 }),
    version,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    components,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

module.exports = {
  COMPONENT_FORMAT,
  SUITE_FORMAT,
  KNOWN_TYPES,
  ID_PATTERN,
  parseVersion,
  assertVersion,
  compareVersions,
  satisfies,
  normalizeComponentSpec,
  normalizeSuiteSpec,
};
