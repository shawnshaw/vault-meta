'use strict';

/**
 * 三位置只读检查：本地源码、云端仓库、当前库运行切片。
 * inspectProject 只读；网络仅在 checkRemoteNow=true 时发生。
 */
const fs = require('fs');
const path = require('path');
const { CODES } = require('./errors');
const { readGitMeta } = require('./git-meta');
const { sourceIdentity, artifactDigest, runtimeSlice } = require('./identity');
const { compareVersions } = require('./component-spec');
const { checkRemote } = require('./remote');

const STATES = Object.freeze({
  UNLINKED: 'unlinked',
  MISSING_SOURCE: 'missing-source',
  SOURCE_TOO_LARGE: 'source-too-large',
  NOT_INSTALLED: 'not-installed',
  RUNTIME_MODIFIED: 'runtime-modified',
  UNREGISTERED: 'unregistered',
  BASELINE_MISSING: 'baseline-missing',
  SAME_VERSION_DIFFERENT_CODE: 'same-version-different-code',
  VERSION_DIFFERS: 'version-differs',
  SOURCE_CHANGED: 'source-changed',
  REMOTE_UNLINKED: 'remote-unlinked',
  NO_RELEASE: 'no-release',
  UPDATE_AVAILABLE: 'update-available',
  RUNTIME_AHEAD: 'runtime-ahead',
  REMOTE_UNKNOWN: 'remote-unknown',
  SYNCED: 'synced',
});

const STATE_TEXT = Object.freeze({
  [STATES.UNLINKED]: { label: '源码未关联', tone: 'warn' },
  [STATES.MISSING_SOURCE]: { label: '源码目录缺失', tone: 'error' },
  [STATES.SOURCE_TOO_LARGE]: { label: '源码目录过大', tone: 'warn' },
  [STATES.NOT_INSTALLED]: { label: '当前库未安装', tone: 'warn' },
  [STATES.RUNTIME_MODIFIED]: { label: '运行文件已改动', tone: 'error' },
  [STATES.UNREGISTERED]: { label: '当前库无来源记录', tone: 'warn' },
  [STATES.BASELINE_MISSING]: { label: '尚未记录基线', tone: 'warn' },
  [STATES.SAME_VERSION_DIFFERENT_CODE]: { label: '同版本不同代码', tone: 'error' },
  [STATES.VERSION_DIFFERS]: { label: '版本不一致', tone: 'warn' },
  [STATES.SOURCE_CHANGED]: { label: '源码有修改尚未保存', tone: 'warn' },
  [STATES.REMOTE_UNLINKED]: { label: '云端未关联', tone: 'warn' },
  [STATES.NO_RELEASE]: { label: '云端尚无正式发布版', tone: 'warn' },
  [STATES.UPDATE_AVAILABLE]: { label: '有更新', tone: 'warn' },
  [STATES.RUNTIME_AHEAD]: { label: '当前库高于发布版', tone: 'warn' },
  [STATES.REMOTE_UNKNOWN]: { label: '无法确认最新', tone: 'warn' },
  [STATES.SYNCED]: { label: '已同步', tone: 'ok' },
});

const REMOTE_STATUS_BY_CODE = Object.freeze({
  E_REMOTE_RATE_LIMIT: 'rate-limited',
  E_NOT_FOUND: 'not-found',
  E_REMOTE_UNSUPPORTED: 'unsupported',
  E_NETWORK: 'offline',
});

function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 8) : sha || '';
}

function safeCompare(a, b) {
  try {
    return compareVersions(a, b);
  } catch (err) {
    return 0;
  }
}

function readVersionFile(fileAbs) {
  try {
    const raw = fs.readFileSync(fileAbs, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.version === 'string') {
      return { version: data.version, name: typeof data.name === 'string' ? data.name : '', id: typeof data.id === 'string' ? data.id : '' };
    }
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * 源码目录的版本：优先 manifest.json（插件），其次 package.json。
 */
function readSourceVersion(sourcePath) {
  const manifest = readVersionFile(path.join(sourcePath, 'manifest.json'));
  if (manifest) return { ...manifest, kind: 'manifest.json' };
  const pkg = readVersionFile(path.join(sourcePath, 'package.json'));
  if (pkg) return { ...pkg, kind: 'package.json' };
  return { version: '', name: '', id: '', kind: '' };
}

function recordForProject(registry, project) {
  if (!registry || !registry.components) return null;
  if (project.pluginId && registry.components[project.pluginId]) {
    const record = registry.components[project.pluginId];
    if (record.installLocation === project.installLocation) return record;
  }
  for (const record of Object.values(registry.components)) {
    if (record.installLocation === project.installLocation) return record;
  }
  return null;
}

function remoteFromCheck(result) {
  if (!result) {
    return { status: 'unchecked', at: '', branch: '', commit: '', developmentVersion: '', release: null, error: '', code: '' };
  }
  if (result.ok) {
    return {
      status: 'ok',
      at: result.at || '',
      branch: result.branch || '',
      commit: result.commit || '',
      developmentVersion: result.developmentVersion || '',
      release: result.release || null,
      error: '',
      code: '',
    };
  }
  return {
    status: REMOTE_STATUS_BY_CODE[result.code] || 'offline',
    at: result.at || '',
    branch: result.branch || '',
    commit: result.commit || '',
    developmentVersion: result.developmentVersion || '',
    release: null,
    error: result.error || '',
    code: result.code || '',
  };
}

function remoteFromLastCheck(lastCheck) {
  if (!lastCheck) return remoteFromCheck(null);
  const base = remoteFromCheck({
    ok: lastCheck.ok,
    at: lastCheck.at,
    branch: lastCheck.branch,
    commit: lastCheck.commit,
    developmentVersion: lastCheck.developmentVersion,
    release: lastCheck.release,
    code: lastCheck.ok ? '' : lastCheck.code || 'E_NETWORK',
    error: lastCheck.error,
  });
  return { ...base, cached: true };
}

function buildDetails(project, source, runtime, remote) {
  const details = [];
  if (source.status === 'ok' || source.status === 'too-large') {
    details.push({ label: '源码目录', value: project.sourcePath });
    details.push({ label: '源码版本', value: source.version ? `${source.version}${source.versionKind ? `（${source.versionKind}）` : ''}` : '未找到版本文件' });
    details.push({ label: '源码身份', value: source.identity ? shortSha(source.identity) : '未计算（目录过大）' });
    details.push({ label: '本地提交', value: source.commit ? shortSha(source.commit) : '无 Git 记录' });
    details.push({ label: '构建产物', value: source.artifactSha256 ? `main.js ${shortSha(source.artifactSha256)}` : '未找到 main.js' });
  }
  if (source.status === 'missing') details.push({ label: '源码目录', value: `${project.sourcePath}（不可访问）` });
  if (runtime.status !== 'not-installed') {
    details.push({ label: '安装位置', value: runtime.location });
    details.push({ label: '当前库版本', value: runtime.version || '未知' });
    if (runtime.status === 'ok' || runtime.status === 'runtime-modified') {
      details.push({ label: '运行文件', value: `${runtime.files.length} 个；改动 ${runtime.modified.length}，缺失 ${runtime.missing.length}` });
    }
    if (runtime.status === 'unregistered') details.push({ label: '登记状态', value: '无登记记录，仅显示发现的版本' });
  }
  if (project.remote.url) {
    details.push({ label: '远端仓库', value: project.remote.url });
    details.push({ label: '检查分支', value: remote.branch || project.remote.branch || '未检查' });
    if (remote.commit) details.push({ label: '云端提交', value: shortSha(remote.commit) });
    if (remote.release) details.push({ label: '最新发布', value: `${remote.release.tag || remote.release.version}（${remote.release.version}）` });
    else if (remote.status === 'ok') details.push({ label: '最新发布', value: '无正式发布' });
    if (remote.developmentVersion) details.push({ label: '开发线版本', value: `${remote.developmentVersion}（未发布）` });
    if (remote.error) details.push({ label: '检查结果', value: remote.error });
  }
  if (project.baseline) {
    details.push({ label: '基线记录', value: `${project.baseline.recordedAt}${project.baseline.sourceVersion ? ` · ${project.baseline.sourceVersion}` : ''}` });
  }
  return details;
}

/**
 * 纯比较：输入三个轴的检查结果，输出单一展示状态。
 */
function compareProject(project, source, runtime, remote) {
  const sourceVersion = source.version || '';
  const runtimeVersion = runtime.status === 'not-installed' ? '' : runtime.version || '';
  const releaseVersion = remote.release ? remote.release.version : '';
  const baseline = project.baseline || null;

  const sourceArtifact = source.artifactSha256 || '';
  const runtimeArtifact = (runtime.hashes && runtime.hashes['main.js']) || '';
  const sameVersionDifferentCode = Boolean(
    source.status === 'ok'
    && sourceVersion
    && sourceVersion === runtimeVersion
    && ((sourceArtifact && runtimeArtifact && sourceArtifact !== runtimeArtifact)
      || (source.commit && remote.commit && source.commit !== remote.commit
        && (!releaseVersion || releaseVersion === sourceVersion))),
  );
  const sourceChanged = Boolean(
    baseline && baseline.sourceIdentity && source.identity && baseline.sourceIdentity !== source.identity,
  );
  const versionDiffers = Boolean(
    sourceVersion && runtimeVersion && safeCompare(sourceVersion, runtimeVersion) !== 0,
  );

  let id = STATES.SYNCED;
  let headline = '三个位置一致';
  if (source.status === 'unlinked') {
    id = STATES.UNLINKED;
    headline = '尚未关联本地源码目录';
  } else if (source.status === 'missing') {
    id = STATES.MISSING_SOURCE;
    headline = '源码目录不存在，请重新关联';
  } else if (source.status === 'too-large') {
    id = STATES.SOURCE_TOO_LARGE;
    headline = '源码目录超过检查上限，未计算源码身份';
  } else if (runtime.status === 'not-installed') {
    id = STATES.NOT_INSTALLED;
    headline = '当前库尚未安装该项目';
  } else if (runtime.status === 'runtime-modified') {
    id = STATES.RUNTIME_MODIFIED;
    headline = `运行文件与登记记录不同（改动 ${runtime.modified.length}，缺失 ${runtime.missing.length}）`;
  } else if (runtime.status === 'unregistered') {
    id = STATES.UNREGISTERED;
    headline = '当前库有安装文件，但没有来源登记，不能认定与云端一致';
  } else if (!baseline) {
    id = STATES.BASELINE_MISSING;
    headline = '接入后尚未记录源码基线，无法判断源码是否有修改';
  } else if (sameVersionDifferentCode) {
    id = STATES.SAME_VERSION_DIFFERENT_CODE;
    headline = `都叫 ${sourceVersion}，但运行文件或提交不同`;
  } else if (versionDiffers) {
    id = STATES.VERSION_DIFFERS;
    headline = `当前使用 ${runtimeVersion}，源码 ${sourceVersion}`;
  } else if (sourceChanged) {
    id = STATES.SOURCE_CHANGED;
    headline = '源码在上次基线之后有修改，尚未记录';
  } else if (remote.status === 'unlinked') {
    id = STATES.REMOTE_UNLINKED;
    headline = '尚未关联云端仓库，无法确认最新版本';
  } else if (remote.status === 'ok' && !remote.release) {
    id = STATES.NO_RELEASE;
    headline = '云端只有开发线，尚无正式发布版';
  } else if (remote.status === 'ok' && releaseVersion && runtimeVersion && safeCompare(releaseVersion, runtimeVersion) > 0) {
    id = STATES.UPDATE_AVAILABLE;
    headline = `当前使用 ${runtimeVersion}，最新可用 ${releaseVersion}`;
  } else if (remote.status === 'ok' && releaseVersion && runtimeVersion && safeCompare(releaseVersion, runtimeVersion) < 0) {
    id = STATES.RUNTIME_AHEAD;
    headline = `当前库 ${runtimeVersion}，高于发布版 ${releaseVersion}（本机试用版）`;
  } else if (remote.status !== 'ok') {
    id = STATES.REMOTE_UNKNOWN;
    if (remote.status === 'unchecked') headline = '尚未检查云端，无法确认最新';
    else if (remote.status === 'rate-limited') headline = '接口限流，无法确认最新';
    else if (remote.status === 'not-found') headline = '仓库或分支不存在，无法确认最新';
    else if (remote.status === 'unsupported') headline = '不支持的远端地址，无法确认最新';
    else headline = '网络不可用，无法确认最新';
  }

  const text = STATE_TEXT[id];
  return {
    state: id,
    label: text.label,
    tone: text.tone,
    headline,
    details: buildDetails(project, source, runtime, remote),
    sourceVersion,
    runtimeVersion,
    releaseVersion,
    developmentVersion: remote.developmentVersion || '',
    sameVersionDifferentCode,
    sourceChanged,
    versionDiffers,
  };
}

/**
 * @param {{
 *   vaultRoot: string,
 *   registry?: object,
 *   project: object,
 *   checkRemoteNow?: boolean,
 *   request?: Function,
 *   timeoutMs?: number,
 *   now?: () => Date,
 * }} options
 */
async function inspectProject(options) {
  const { vaultRoot, registry, project } = options;
  const now = options.now || (() => new Date());
  const checkedAt = now().toISOString();

  let source;
  if (!project.sourcePath) {
    source = { status: 'unlinked', path: '', version: '', commit: '', identity: '', artifactSha256: '' };
  } else {
    const git = readGitMeta(project.sourcePath);
    const versionInfo = readSourceVersion(project.sourcePath);
    let identity = null;
    try {
      identity = await sourceIdentity(project.sourcePath);
    } catch (err) {
      identity = { status: err.code === CODES.SOURCE_MISSING ? 'missing' : 'error', error: err.code || '' };
    }
    const artifact = identity.status === 'ok' || identity.status === 'too-large'
      ? await artifactDigest(project.sourcePath)
      : null;
    source = {
      status: identity.status === 'ok' ? 'ok' : identity.status === 'too-large' ? 'too-large' : 'missing',
      path: project.sourcePath,
      version: versionInfo.version,
      versionKind: versionInfo.kind,
      commit: git.commit,
      branch: git.branch,
      gitRemoteUrl: git.remoteUrl,
      identity: identity.status === 'ok' ? identity.digest : '',
      fileCount: identity.fileCount || 0,
      totalBytes: identity.totalBytes || 0,
      symlinkedRoot: Boolean(identity.symlinkedRoot),
      artifactSha256: artifact ? artifact.sha256 : '',
    };
  }

  const record = recordForProject(registry, project);
  const runtime = await runtimeSlice(vaultRoot, record, { installLocation: project.installLocation });

  let checkResult = null;
  let remote;
  if (!project.remote.url) {
    remote = remoteFromCheck(null);
    remote.status = 'unlinked';
  } else if (options.remoteResult) {
    checkResult = options.remoteResult;
    remote = remoteFromCheck(checkResult);
    remote.cached = false;
  } else if (options.checkRemoteNow) {
    try {
      checkResult = await checkRemote(project.remote, {
        request: options.request,
        timeoutMs: options.timeoutMs,
        now,
      });
    } catch (err) {
      checkResult = {
        ok: false,
        code: err.code === CODES.REMOTE_UNSUPPORTED ? CODES.REMOTE_UNSUPPORTED : CODES.NETWORK,
        error: err.message || '检查失败',
        at: checkedAt,
      };
    }
    remote = remoteFromCheck(checkResult);
    remote.cached = false;
  } else {
    remote = remoteFromLastCheck(project.lastCheck);
  }

  const comparison = compareProject(project, source, runtime, remote);
  return {
    projectId: project.id,
    checkedAt,
    source,
    remote,
    runtime,
    comparison,
    checkResult,
  };
}

/** 把一次检查结果写入项目记录的 lastCheck 形状（不改 baseline）。 */
function lastCheckFromInspection(inspection) {
  const result = inspection.checkResult;
  if (!result) return null;
  return {
    at: result.at || inspection.checkedAt,
    ok: result.ok === true,
    code: result.code || '',
    error: result.error || '',
    branch: result.branch || '',
    commit: result.commit || '',
    developmentVersion: result.developmentVersion || '',
    release: result.release || null,
  };
}

module.exports = {
  STATES,
  STATE_TEXT,
  inspectProject,
  compareProject,
  readSourceVersion,
  recordForProject,
  lastCheckFromInspection,
  shortSha,
};
