'use strict';

const fs = require('fs');
const path = require('path');
const { CODES, fail } = require('../errors');
const { normalizeRelPath, assertInside } = require('../paths');
const { sha256File } = require('../fs-utils');

const ID = 'obsidian-plugin';
const PLUGIN_ROOT = '.obsidian/plugins';
const CORE_FILES = ['manifest.json', 'main.js', 'styles.css'];

function validateSpec(spec, ctx) {
  const vaultRoot = ctx && ctx.vaultRoot;
  const location = normalizeRelPath(spec.install.location, '安装位置');
  if (vaultRoot) {
    assertInside(path.join(vaultRoot, PLUGIN_ROOT), path.join(vaultRoot, location), {
      label: '插件安装位置',
    });
  } else if (!location.startsWith(`${PLUGIN_ROOT}/`)) {
    fail(CODES.INVALID_SPEC, `插件必须安装到 ${PLUGIN_ROOT}/<id> 下`, { location });
  }
  const paths = spec.files.map((file) => file.path);
  if (!paths.includes('manifest.json') || !paths.includes('main.js')) {
    fail(CODES.INVALID_SPEC, '插件组件必须包含 manifest.json 与 main.js', { files: paths });
  }
}

/**
 * 选取插件目录中可分发的文件。
 * 排除：data.json（用户配置）、sourcemap、node_modules、构建残留。
 */
function selectFiles(absDir) {
  const picked = [];
  for (const name of CORE_FILES) {
    const abs = path.join(absDir, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) picked.push(name);
  }
  if (picked.length === 0) {
    fail(CODES.NOT_FOUND, `插件目录中没有可打包文件：${absDir}`, { dir: absDir });
  }
  return picked;
}

async function verifyInstalled({ targetAbs, spec }) {
  const manifestPath = path.join(targetAbs, 'manifest.json');
  const mainPath = path.join(targetAbs, 'main.js');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(mainPath)) {
    fail(CODES.NOT_FOUND, '插件安装后缺少 manifest.json 或 main.js', { target: targetAbs });
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(CODES.INVALID_SPEC, 'manifest.json 不是合法 JSON', { path: manifestPath });
  }
  if (!manifest.id || !manifest.version) {
    fail(CODES.INVALID_SPEC, 'manifest.json 缺少 id 或 version', { path: manifestPath });
  }
  if (manifest.id !== spec.id) {
    fail(CODES.INVALID_SPEC, `manifest.id（${manifest.id}）与组件 id（${spec.id}）不一致`, {
      manifestId: manifest.id,
      specId: spec.id,
    });
  }
  if (manifest.version !== spec.version) {
    fail(CODES.INVALID_SPEC, `manifest.version（${manifest.version}）与组件版本（${spec.version}）不一致`, {
      manifestVersion: manifest.version,
      specVersion: spec.version,
    });
  }
  const mainStat = fs.statSync(mainPath);
  if (mainStat.size === 0) fail(CODES.INVALID_SPEC, 'main.js 为空文件', { path: mainPath });

  const hashes = {};
  for (const file of spec.files) {
    hashes[file.path] = await sha256File(path.join(targetAbs, file.path));
    if (hashes[file.path] !== file.sha256) {
      fail(CODES.CHECKSUM_MISMATCH, `安装后校验不一致：${file.path}`, { path: file.path });
    }
  }
  return { id: manifest.id, version: manifest.version, name: manifest.name || manifest.id, files: hashes };
}

module.exports = { id: ID, label: 'Obsidian 插件', validateSpec, selectFiles, verifyInstalled, CORE_FILES };
