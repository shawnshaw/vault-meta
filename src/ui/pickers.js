'use strict';

/**
 * 目录/文件选择。
 * 优先使用 Electron 原生对话框；不可用时返回 undefined，由 UI 退回手动输入绝对路径。
 * 不硬编码 iCloud / OneDrive / 个人目录，任何可访问的绝对路径都允许。
 */
const path = require('path');
const { isDirectory, exists } = require('../core/fs-utils');

function loadDialog() {
  const candidates = [];
  try {
    const electron = require('electron');
    if (electron && electron.remote && electron.remote.dialog) candidates.push(electron.remote.dialog);
  } catch (err) {
    /* 非 Electron 环境 */
  }
  try {
    const remote = require('@electron/remote');
    if (remote && remote.dialog) candidates.push(remote.dialog);
  } catch (err) {
    /* 未提供 @electron/remote */
  }
  return candidates.find((dialog) => dialog && typeof dialog.showOpenDialogSync === 'function') || null;
}

/** @returns {string|null|undefined} 选中路径 / 取消 null / 环境不支持 undefined */
function pickDirectory(defaultPath) {
  const dialog = loadDialog();
  if (!dialog) return undefined;
  try {
    const result = dialog.showOpenDialogSync({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || undefined,
    });
    if (Array.isArray(result) && result.length > 0) return result[0];
    return null;
  } catch (err) {
    return undefined;
  }
}

function pickFile(filters, defaultPath) {
  const dialog = loadDialog();
  if (!dialog) return undefined;
  try {
    const result = dialog.showOpenDialogSync({
      properties: ['openFile'],
      filters: filters || [],
      defaultPath: defaultPath || undefined,
    });
    if (Array.isArray(result) && result.length > 0) return result[0];
    return null;
  } catch (err) {
    return undefined;
  }
}

/**
 * 校验路径。目录只要求"绝对且可访问"；文件还要求存在且是文件。
 * 不限制具体云盘位置（iCloud/OneDrive 等一律按普通绝对路径处理）。
 * @param {string} raw
 * @param {{kind?: 'directory'|'file', mustExist?: boolean}} [opts]
 */
function validatePath(raw, opts) {
  const kind = (opts && opts.kind) || 'directory';
  const mustExist = !(opts && opts.mustExist === false);
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (text === '') return { ok: false, message: kind === 'file' ? '请填写文件路径' : '请填写目录路径' };
  if (text.includes('\0')) return { ok: false, message: '路径包含非法字符' };
  if (!path.isAbsolute(text)) {
    return { ok: false, message: '请填写绝对路径（例如 /绝对路径/Backups 或 D:\\Backups）' };
  }
  const resolved = path.resolve(text);
  if (mustExist) {
    if (kind === 'file') {
      if (!exists(resolved)) return { ok: false, message: '文件不存在，请重新选择' };
      try {
        if (!require('fs').statSync(resolved).isFile()) return { ok: false, message: '目标不是文件' };
      } catch (err) {
        return { ok: false, message: '文件无法访问' };
      }
    } else if (!isDirectory(resolved)) {
      return { ok: false, message: '目录不存在或无法访问，请重新选择' };
    }
  }
  return { ok: true, path: resolved };
}

const validateDirectory = (raw, opts) => validatePath(raw, { ...(opts || {}), kind: 'directory' });

module.exports = { pickDirectory, pickFile, validatePath, validateDirectory, loadDialog };
