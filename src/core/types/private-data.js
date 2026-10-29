'use strict';

const { CODES, fail } = require('../errors');

/** 私有数据/配置特征：插件设置、密钥、Cookie、凭据、仓库与依赖目录。 */
const PRIVATE_PATTERNS = [
  /(^|\/)data\.json$/i,
  /(^|\/)\.env(\.|$)/i,
  /\.(cookie|key|pem|p12|pfx|kdbx)$/i,
  /(^|\/)(credentials?|secrets?|tokens?|passwords?)(\.|\/|$)/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)Thumbs\.db$/i,
];

function isPrivateFile(relPath) {
  return PRIVATE_PATTERNS.some((pattern) => pattern.test(String(relPath)));
}

function assertNoPrivateFiles(paths) {
  const hits = paths.filter(isPrivateFile);
  if (hits.length > 0) {
    fail(CODES.PRIVATE_DATA, `检测到私有数据/配置，已阻止导出：${hits.join('、')}`, { paths: hits });
  }
  return true;
}

module.exports = { PRIVATE_PATTERNS, isPrivateFile, assertNoPrivateFiles };
