'use strict';

const fs = require('fs');
const path = require('path');
const { CODES, fail } = require('../errors');
const { normalizeRelPath } = require('../paths');
const { walkFiles, sha256File } = require('../fs-utils');
const { isPrivateFile } = require('./private-data');

const ID = 'files';

function validateSpec(spec) {
  const location = normalizeRelPath(spec.install.location, '安装位置');
  if (location === '.obsidian/plugins' || location.startsWith('.obsidian/plugins/')) {
    fail(CODES.INVALID_SPEC, '文件组件不能安装到插件目录，请使用 obsidian-plugin 类型', { location });
  }
  for (const file of spec.files) {
    normalizeRelPath(file.path, '文件路径');
    if (isPrivateFile(file.path)) {
      fail(CODES.PRIVATE_DATA, `文件组件包含私有数据：${file.path}`, { path: file.path });
    }
  }
}

/** 选取目录下所有普通文件（排除私有数据与构建垃圾）。 */
function selectFiles(absDir, ctx) {
  const include = (ctx && ctx.include) || null;
  const { files } = walkFiles(absDir, {
    exclude: (rel) => {
      if (isPrivateFile(rel)) return true;
      if (rel.endsWith('.map')) return true;
      if (include && !include.some((item) => rel === item || rel.startsWith(`${item}/`))) return true;
      return false;
    },
  });
  return files.map((file) => file.path);
}

async function verifyInstalled({ targetAbs, spec }) {
  const hashes = {};
  for (const file of spec.files) {
    const abs = path.join(targetAbs, file.path);
    if (!fs.existsSync(abs)) {
      fail(CODES.NOT_FOUND, `安装后缺少文件：${file.path}`, { path: file.path });
    }
    const digest = await sha256File(abs);
    hashes[file.path] = digest;
    if (digest !== file.sha256) {
      fail(CODES.CHECKSUM_MISMATCH, `安装后校验不一致：${file.path}`, { path: file.path });
    }
  }
  return { files: hashes };
}

module.exports = { id: ID, label: '简单文件组件', validateSpec, selectFiles, verifyInstalled };
