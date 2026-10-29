'use strict';

/**
 * 只读 GitHub 检查：远端发布版、默认分支与开发线版本。
 * 不写入、不上传、不保存凭据；request 可注入，测试永不发起真实网络。
 */
const { CODES, fail } = require('./errors');

const API_ROOT = 'https://api.github.com';
const USER_AGENT = 'vault-meta';
const JSON_ACCEPT = 'application/vnd.github+json';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {string} raw
 * @returns {{provider: string, owner: string, repo: string, webUrl: string}}
 */
function parseRemoteUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) fail(CODES.REMOTE_UNSUPPORTED, '尚未填写远端地址');
  let owner = '';
  let repo = '';
  let match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(value);
  if (match) {
    owner = match[1];
    repo = match[2];
  }
  if (!owner) {
    match = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
    if (match) {
      owner = match[1];
      repo = match[2];
    }
  }
  if (!owner) {
    match = /^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(value);
    if (match) {
      owner = match[1];
      repo = match[2];
    }
  }
  if (!owner || !repo) {
    fail(CODES.REMOTE_UNSUPPORTED, `第一阶段只支持 github.com 仓库：${value}`, { url: value });
  }
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!valid.test(owner) || !valid.test(repo)) {
    fail(CODES.REMOTE_UNSUPPORTED, `仓库地址不合法：${value}`, { url: value });
  }
  return {
    provider: 'github',
    owner,
    repo,
    webUrl: `https://github.com/${owner}/${repo}`,
  };
}

function obsidianRequest(options) {
  const mod = require('obsidian');
  const fn = mod && mod.requestUrl;
  if (typeof fn !== 'function') {
    const err = new Error('当前环境不支持网络请求');
    err.code = 'E_NETWORK';
    throw err;
  }
  return fn(options);
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error('网络请求超时');
      err.code = 'E_NETWORK';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function requestOnce(request, url, accept, timeoutMs) {
  const response = await withTimeout(
    Promise.resolve(request({
      url,
      method: 'GET',
      headers: { Accept: accept || JSON_ACCEPT, 'User-Agent': USER_AGENT },
      throw: false,
    })),
    timeoutMs,
  );
  const status = Number(response && response.status);
  if (status === 403 || status === 429) return { kind: 'rate-limit', status };
  if (status === 404) return { kind: 'not-found', status };
  if (!status || status < 200 || status >= 300) return { kind: 'http', status };
  let text = response && typeof response.text === 'string' ? response.text : null;
  if (text == null && response && response.json && typeof response.json === 'object') {
    return { kind: 'ok', data: response.json };
  }
  if (text == null) return { kind: 'bad-json', status };
  try {
    return { kind: 'ok', data: JSON.parse(text) };
  } catch (err) {
    return { kind: 'bad-json', status };
  }
}

function resultError(code, message, extra) {
  return { ok: false, code, error: message, ...(extra || {}) };
}

/**
 * @param {{url: string, branch?: string}|string} remote
 * @param {{request?: Function, timeoutMs?: number, now?: () => Date}} [opts]
 */
async function checkRemote(remote, opts) {
  const options = opts || {};
  const request = options.request || obsidianRequest;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const now = options.now || (() => new Date());
  const at = now().toISOString();
  const target = parseRemoteUrl(typeof remote === 'string' ? remote : remote && remote.url);
  const requestedBranch = (remote && typeof remote === 'object' && remote.branch) || '';
  const base = `${API_ROOT}/repos/${target.owner}/${target.repo}`;

  let repoInfo;
  try {
    repoInfo = await requestOnce(request, base, JSON_ACCEPT, timeoutMs);
  } catch (err) {
    return resultError(CODES.NETWORK, '网络请求失败或超时，无法确认云端最新版本', { at, cause: err.code || '' });
  }
  if (repoInfo.kind === 'rate-limit') {
    return resultError(CODES.REMOTE_RATE_LIMIT, 'GitHub 接口请求过于频繁，请稍后再检查', { at });
  }
  if (repoInfo.kind === 'not-found') {
    return resultError(CODES.NOT_FOUND, '远端仓库不存在或不可访问', { at });
  }
  if (repoInfo.kind !== 'ok') {
    return resultError(CODES.NETWORK, `远端仓库信息读取失败（${repoInfo.kind}）`, { at });
  }
  const branch = requestedBranch || (repoInfo.data && repoInfo.data.default_branch) || 'main';

  let commit = '';
  try {
    const commitRes = await requestOnce(
      request,
      `${base}/commits/${encodeURIComponent(branch)}`,
      JSON_ACCEPT,
      timeoutMs,
    );
    if (commitRes.kind === 'rate-limit') {
      return resultError(CODES.REMOTE_RATE_LIMIT, 'GitHub 接口请求过于频繁，请稍后再检查', { at, branch });
    }
    if (commitRes.kind === 'not-found') {
      return resultError(CODES.NOT_FOUND, `远端分支不存在：${branch}`, { at, branch });
    }
    if (commitRes.kind !== 'ok') {
      return resultError(CODES.NETWORK, `远端提交读取失败（${commitRes.kind}）`, { at, branch });
    }
    commit = (commitRes.data && commitRes.data.sha) || '';
  } catch (err) {
    return resultError(CODES.NETWORK, '网络请求失败或超时，无法确认云端最新版本', { at, branch, cause: err.code || '' });
  }

  let release = null;
  try {
    const releaseRes = await requestOnce(request, `${base}/releases/latest`, JSON_ACCEPT, timeoutMs);
    if (releaseRes.kind === 'rate-limit') {
      return resultError(CODES.REMOTE_RATE_LIMIT, 'GitHub 接口请求过于频繁，请稍后再检查', { at, branch, commit });
    }
    if (releaseRes.kind !== 'ok' && releaseRes.kind !== 'not-found') {
      return resultError(CODES.NETWORK, `远端发布信息读取失败（${releaseRes.kind}）`, { at, branch, commit });
    }
    if (releaseRes.kind === 'ok' && releaseRes.data && releaseRes.data.draft !== true && releaseRes.data.prerelease !== true) {
      const tag = typeof releaseRes.data.tag_name === 'string' ? releaseRes.data.tag_name : '';
      const version = tag.replace(/^v/i, '');
      if (version) release = { tag, version };
    }
  } catch (err) {
    return resultError(CODES.NETWORK, '网络请求失败或超时，无法确认云端最新版本', { at, branch, commit, cause: err.code || '' });
  }

  let developmentVersion = '';
  try {
    const manifestRes = await requestOnce(
      request,
      `${base}/contents/manifest.json?ref=${encodeURIComponent(branch)}`,
      'application/vnd.github.raw',
      timeoutMs,
    );
    if (manifestRes.kind === 'rate-limit') {
      return resultError(CODES.REMOTE_RATE_LIMIT, 'GitHub 接口请求过于频繁，请稍后再检查', { at, branch, commit });
    }
    if (manifestRes.kind === 'ok' && manifestRes.data && typeof manifestRes.data.version === 'string') {
      developmentVersion = manifestRes.data.version;
    } else if (manifestRes.kind !== 'not-found' && manifestRes.kind !== 'ok') {
      return resultError(CODES.NETWORK, `开发线版本读取失败（${manifestRes.kind}）`, { at, branch, commit });
    }
  } catch (err) {
    return resultError(CODES.NETWORK, '网络请求失败或超时，无法确认云端最新版本', { at, branch, commit, cause: err.code || '' });
  }

  return {
    ok: true,
    code: '',
    error: '',
    at,
    branch,
    commit,
    developmentVersion,
    release,
    webUrl: target.webUrl,
  };
}

module.exports = {
  parseRemoteUrl,
  checkRemote,
  withTimeout,
  DEFAULT_TIMEOUT_MS,
};
