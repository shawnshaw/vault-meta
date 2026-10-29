'use strict';

/**
 * 组件类型处理器注册表。
 * 首版实现：obsidian-plugin（完整）与 files（简单文件组件）。
 * 其他类型通过 register() 扩展，未注册类型一律拒绝安装，不做"尽力而为"。
 */
const { CODES, fail } = require('../errors');
const pluginType = require('./obsidian-plugin');
const filesType = require('./files');

const { isPrivateFile, assertNoPrivateFiles } = require('./private-data');

class TypeRegistry {
  constructor() {
    this.handlers = new Map();
  }

  /**
   * 注册组件类型处理器。
   * 处理器契约（扩展点）：
   * {
   *   id: string, label: string,
   *   validateSpec(spec, ctx): void,            // 类型特有校验
   *   selectFiles(absDir): string[],            // 打包时选取哪些文件（相对路径）
   *   verifyInstalled({targetAbs, spec}): object // 安装后真实校验
   * }
   */
  register(handler) {
    if (!handler || typeof handler.id !== 'string' || typeof handler.label !== 'string') {
      fail(CODES.INVALID_SPEC, '类型处理器必须包含 id 与 label', {});
    }
    if (this.handlers.has(handler.id)) {
      fail(CODES.INVALID_SPEC, `类型处理器重复注册：${handler.id}`, { id: handler.id });
    }
    for (const method of ['validateSpec', 'selectFiles', 'verifyInstalled']) {
      if (typeof handler[method] !== 'function') {
        fail(CODES.INVALID_SPEC, `类型处理器 ${handler.id} 缺少 ${method}()`, { id: handler.id });
      }
    }
    this.handlers.set(handler.id, handler);
    return this;
  }

  has(id) {
    return this.handlers.has(id);
  }

  get(id) {
    const handler = this.handlers.get(id);
    if (!handler) {
      fail(CODES.UNSUPPORTED_TYPE, `组件类型“${id}”尚未实现`, {
        type: id,
        registered: this.list().map((item) => item.id),
      });
    }
    return handler;
  }

  list() {
    return Array.from(this.handlers.values()).map((handler) => ({ id: handler.id, label: handler.label }));
  }
}

function createDefaultTypeRegistry() {
  return new TypeRegistry().register(pluginType).register(filesType);
}

module.exports = {
  TypeRegistry,
  createDefaultTypeRegistry,
  isPrivateFile,
  assertNoPrivateFiles,
};
