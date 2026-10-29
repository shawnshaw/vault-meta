'use strict';

/**
 * 统一错误类型：所有失败都带稳定 code，便于 UI 映射中文提示与测试断言。
 */
const CODES = Object.freeze({
  PATH_INVALID: 'E_PATH_INVALID',
  PATH_ABSOLUTE: 'E_PATH_ABSOLUTE',
  PATH_TRAVERSAL: 'E_PATH_TRAVERSAL',
  PATH_ESCAPE: 'E_PATH_ESCAPE',
  PATH_NOT_DIRECTORY: 'E_PATH_NOT_DIRECTORY',
  SYMLINK_ESCAPE: 'E_SYMLINK_ESCAPE',
  ARCHIVE_CORRUPT: 'E_ARCHIVE_CORRUPT',
  ARCHIVE_FORMAT: 'E_ARCHIVE_FORMAT',
  CHECKSUM_MISMATCH: 'E_CHECKSUM_MISMATCH',
  CONFLICT: 'E_CONFLICT',
  MISSING_DEPENDENCY: 'E_MISSING_DEPENDENCY',
  UNSUPPORTED_TYPE: 'E_UNSUPPORTED_TYPE',
  INVALID_SPEC: 'E_INVALID_SPEC',
  INVALID_VERSION: 'E_INVALID_VERSION',
  NOT_OWNED: 'E_NOT_OWNED',
  TARGET_NOT_EMPTY: 'E_TARGET_NOT_EMPTY',
  TARGET_INSIDE_SOURCE: 'E_TARGET_INSIDE_SOURCE',
  PRIVATE_DATA: 'E_PRIVATE_DATA',
  PERMISSION: 'E_PERMISSION',
  NOT_FOUND: 'E_NOT_FOUND',
  PROJECT_INVALID: 'E_PROJECT_INVALID',
  SOURCE_MISSING: 'E_SOURCE_MISSING',
  REMOTE_UNSUPPORTED: 'E_REMOTE_UNSUPPORTED',
  REMOTE_RATE_LIMIT: 'E_REMOTE_RATE_LIMIT',
  NETWORK: 'E_NETWORK',
  IO: 'E_IO',
});

class VaultMetaError extends Error {
  /**
   * @param {string} code CODES 之一
   * @param {string} message 面向用户的中文描述
   * @param {object} [details] 结构化细节（路径、冲突列表等）
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'VaultMetaError';
    this.code = code;
    this.details = details || {};
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function fail(code, message, details) {
  throw new VaultMetaError(code, message, details);
}

function isVaultMetaError(err) {
  return Boolean(err && err.name === 'VaultMetaError');
}

const HINTS = {
  E_PATH_INVALID: '路径包含非法字符（空值、NUL 或反斜杠）。',
  E_PATH_ABSOLUTE: '只允许相对路径，禁止绝对路径或盘符。',
  E_PATH_TRAVERSAL: '路径包含 “..”，可能越出目标目录。',
  E_PATH_ESCAPE: '目标路径落在允许目录之外。',
  E_SYMLINK_ESCAPE: '符号链接指向允许目录之外，已拒绝写入。',
  E_ARCHIVE_CORRUPT: '归档文件损坏或不是本工具生成的格式。',
  E_ARCHIVE_FORMAT: '归档格式版本不受支持。',
  E_CHECKSUM_MISMATCH: '文件校验值与记录不一致。',
  E_CONFLICT: '目标位置已有不同内容的文件，请先处理冲突。',
  E_MISSING_DEPENDENCY: '缺少依赖组件，请先安装依赖。',
  E_UNSUPPORTED_TYPE: '该组件类型尚未实现，需要扩展类型处理器。',
  E_INVALID_SPEC: '组件/套装描述字段不合法。',
  E_TARGET_NOT_EMPTY: '目标目录非空，恢复仅写入空目录。',
  E_PRIVATE_DATA: '安装包包含私有数据或配置，已阻止导出。',
  E_PERMISSION: '文件权限设置失败；为避免以错误权限发布，已中止本次操作。',
  E_PROJECT_INVALID: '项目记录字段不合法（标识、路径或安装位置）。',
  E_SOURCE_MISSING: '本地源码目录不存在或不可读，请重新关联。',
  E_REMOTE_UNSUPPORTED: '第一阶段只支持 github.com 的公开仓库。',
  E_REMOTE_RATE_LIMIT: 'GitHub 接口请求过于频繁，请稍后再检查。',
  E_NETWORK: '网络请求失败或超时，无法确认云端最新版本。',
};

/**
 * 把任意异常转成 UI 可展示的中文结构。
 * @param {unknown} err
 */
function describeError(err) {
  if (isVaultMetaError(err)) {
    return {
      code: err.code,
      message: err.message,
      hint: HINTS[err.code] || '',
      details: err.details,
    };
  }
  const message = err && err.message ? String(err.message) : String(err);
  return { code: 'E_UNKNOWN', message, hint: '', details: {} };
}

module.exports = { CODES, VaultMetaError, fail, isVaultMetaError, describeError };
