'use strict';

/**
 * 离线读取 .git 元数据（不执行任何 git 命令、不 fetch、不写入）。
 * 支持普通仓库、.git 文件间接（worktree/submodule）、commondir 与 packed-refs。
 */
const fs = require('fs');
const path = require('path');

function readTextSafe(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return '';
  }
}

function statSafe(abs) {
  try {
    return fs.statSync(abs);
  } catch (err) {
    return null;
  }
}

function resolveGitDir(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  const stat = statSafe(dotGit);
  if (!stat) return '';
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return '';
  const text = readTextSafe(dotGit).trim();
  const match = /^gitdir:\s*(.+)$/.exec(text);
  if (!match) return '';
  return path.resolve(repoRoot, match[1].trim());
}

function parseConfig(text) {
  const remotes = {};
  const branches = {};
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header) {
      const type = header[1].toLowerCase();
      const name = header[2] || '';
      if (type === 'remote') {
        section = { type, name };
        if (!remotes[name]) remotes[name] = {};
      } else if (type === 'branch') {
        section = { type, name };
        if (!branches[name]) branches[name] = {};
      } else {
        section = { type, name };
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !section) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (section.type === 'remote' && remotes[section.name]) {
      remotes[section.name][key] = value;
    } else if (section.type === 'branch' && branches[section.name]) {
      branches[section.name][key] = value;
    }
  }
  return { remotes, branches };
}

function parsePackedRefs(text) {
  const refs = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const sha = line.slice(0, space);
    const ref = line.slice(space + 1).trim();
    if (ref) refs.set(ref, sha);
  }
  return refs;
}

function resolveRef(commonDir, ref, packed) {
  const loose = readTextSafe(path.join(commonDir, ref)).trim();
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(loose)) return loose;
  if (packed && packed.has(ref)) return packed.get(ref);
  return '';
}

/**
 * @param {string} repoRoot 本地源码目录
 * @returns {{
 *   isRepo: boolean,
 *   gitDir: string,
 *   remoteName: string,
 *   remoteUrl: string,
 *   branch: string,
 *   mergeRef: string,
 *   commit: string,
 *   detached: boolean,
 *   remoteTrackingCommit: string
 * }}
 */
function readGitMeta(repoRoot) {
  const empty = {
    isRepo: false,
    gitDir: '',
    remoteName: '',
    remoteUrl: '',
    branch: '',
    mergeRef: '',
    commit: '',
    detached: false,
    remoteTrackingCommit: '',
  };
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir || !statSafe(gitDir)) return empty;

  const commonDirFile = readTextSafe(path.join(gitDir, 'commondir')).trim();
  const commonDir = commonDirFile ? path.resolve(gitDir, commonDirFile) : gitDir;

  const { remotes, branches } = parseConfig(readTextSafe(path.join(commonDir, 'config')));
  const packed = parsePackedRefs(readTextSafe(path.join(commonDir, 'packed-refs')));

  const head = readTextSafe(path.join(gitDir, 'HEAD')).trim();
  let branch = '';
  let commit = '';
  let detached = false;
  const refMatch = /^ref:\s*(.+)$/.exec(head);
  if (refMatch) {
    const headRef = refMatch[1].trim();
    if (headRef.startsWith('refs/heads/')) branch = headRef.slice('refs/heads/'.length);
    commit = resolveRef(commonDir, headRef, packed);
  } else if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head)) {
    commit = head;
    detached = true;
  }

  const branchConfig = (branch && branches[branch]) || {};
  const remoteName = branchConfig.remote && branchConfig.remote !== '.'
    ? branchConfig.remote
    : remotes.origin
      ? 'origin'
      : Object.keys(remotes)[0] || '';
  const remote = remoteName ? remotes[remoteName] || {} : {};
  const mergeRef = branchConfig.merge || '';

  let remoteTrackingCommit = '';
  if (remoteName && branch) {
    remoteTrackingCommit = resolveRef(commonDir, `refs/remotes/${remoteName}/${branch}`, packed);
  }

  return {
    isRepo: true,
    gitDir,
    remoteName,
    remoteUrl: remote.url || '',
    branch,
    mergeRef,
    commit,
    detached,
    remoteTrackingCommit,
  };
}

module.exports = { readGitMeta, parseConfig, parsePackedRefs };
