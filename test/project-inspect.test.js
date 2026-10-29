'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { compareProject, inspectProject, STATES } = require('../src/core/project-inspect');
const { sourceIdentity } = require('../src/core/identity');
const { sha256File } = require('../src/core/fs-utils');
const { tempDir, writeFile, makeVault, makePlugin, hashTree } = require('./helpers/vault');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_ART = 'c'.repeat(64);
const HASH_OTHER = 'd'.repeat(64);
const COMMIT_1 = '1'.repeat(40);
const COMMIT_2 = '2'.repeat(40);

function makeProject(overrides) {
  return {
    id: 'demo-123456',
    name: 'Demo',
    pluginId: 'demo',
    sourcePath: '/tmp/demo-source',
    remote: { url: 'https://github.com/example/demo', branch: 'main' },
    installLocation: '.obsidian/plugins/demo',
    baseline: {
      sourceIdentity: HASH_A,
      sourceVersion: '1.0.0',
      commit: COMMIT_1,
      artifactSha256: HASH_ART,
      recordedAt: '2026-10-01T00:00:00.000Z',
    },
    lastCheck: null,
    ...(overrides || {}),
  };
}

function makeSource(overrides) {
  return {
    status: 'ok',
    path: '/tmp/demo-source',
    version: '1.0.0',
    versionKind: 'manifest.json',
    commit: COMMIT_1,
    identity: HASH_A,
    artifactSha256: HASH_ART,
    ...(overrides || {}),
  };
}

function makeRuntime(overrides) {
  return {
    status: 'ok',
    location: '.obsidian/plugins/demo',
    version: '1.0.0',
    files: ['manifest.json', 'main.js', 'styles.css'],
    modified: [],
    missing: [],
    hashes: { 'main.js': HASH_ART },
    ...(overrides || {}),
  };
}

function makeRemote(overrides) {
  return {
    status: 'ok',
    release: { tag: 'v1.0.0', version: '1.0.0' },
    commit: COMMIT_1,
    developmentVersion: '1.0.0',
    ...(overrides || {}),
  };
}

function state(overrides) {
  return compareProject(makeProject(overrides.project), makeSource(overrides.source), makeRuntime(overrides.runtime), makeRemote(overrides.remote)).state;
}

test('三个位置一致时为 synced', () => {
  assert.equal(state({}), STATES.SYNCED);
});

test('未关联源码时为 unlinked', () => {
  assert.equal(
    state({ project: { sourcePath: '' }, source: { status: 'unlinked' } }),
    STATES.UNLINKED,
  );
});

test('源码目录缺失时为 missing-source', () => {
  assert.equal(state({ source: { status: 'missing' } }), STATES.MISSING_SOURCE);
});

test('源码目录过大时为 source-too-large', () => {
  assert.equal(state({ source: { status: 'too-large', identity: '' } }), STATES.SOURCE_TOO_LARGE);
});

test('当前库未安装时为 not-installed', () => {
  assert.equal(state({ runtime: { status: 'not-installed', version: '' } }), STATES.NOT_INSTALLED);
});

test('运行文件改动优先于版本差异', () => {
  const runtime = { status: 'runtime-modified', modified: [{ path: 'main.js' }], missing: [] };
  assert.equal(state({ runtime, source: { version: '1.1.0' } }), STATES.RUNTIME_MODIFIED);
});

test('无登记记录时为 unregistered', () => {
  assert.equal(state({ runtime: { status: 'unregistered', files: [], hashes: {} } }), STATES.UNREGISTERED);
});

test('缺少基线时为 baseline-missing', () => {
  assert.equal(state({ project: { baseline: null } }), STATES.BASELINE_MISSING);
});

test('同版本但构建产物不同 → same-version-different-code', () => {
  assert.equal(
    state({ runtime: { hashes: { 'main.js': HASH_OTHER } } }),
    STATES.SAME_VERSION_DIFFERENT_CODE,
  );
});

test('同版本但提交不同 → same-version-different-code', () => {
  assert.equal(state({ remote: { commit: COMMIT_2 } }), STATES.SAME_VERSION_DIFFERENT_CODE);
});

test('源码与当前库版本不同 → version-differs', () => {
  const result = compareProject(
    makeProject(),
    makeSource({ version: '1.1.0' }),
    makeRuntime(),
    makeRemote({ release: { tag: 'v1.0.0', version: '1.0.0' } }),
  );
  assert.equal(result.state, STATES.VERSION_DIFFERS);
  assert.match(result.headline, /当前使用 1\.0\.0，源码 1\.1\.0/);
});

test('源码身份变化 → source-changed', () => {
  assert.equal(state({ source: { identity: HASH_B } }), STATES.SOURCE_CHANGED);
});

test('未关联云端 → remote-unlinked', () => {
  assert.equal(
    state({ project: { remote: { url: '', branch: '' } }, remote: { status: 'unlinked', release: null, commit: '', developmentVersion: '' } }),
    STATES.REMOTE_UNLINKED,
  );
});

test('云端无正式发布 → no-release', () => {
  assert.equal(state({ remote: { release: null } }), STATES.NO_RELEASE);
});

test('云端发布版更新 → update-available', () => {
  const result = compareProject(
    makeProject(),
    makeSource(),
    makeRuntime(),
    makeRemote({ release: { tag: 'v1.1.0', version: '1.1.0' } }),
  );
  assert.equal(result.state, STATES.UPDATE_AVAILABLE);
  assert.match(result.headline, /当前使用 1\.0\.0，最新可用 1\.1\.0/);
});

test('当前库版本高于发布版 → runtime-ahead', () => {
  const result = compareProject(
    makeProject(),
    makeSource(),
    makeRuntime(),
    makeRemote({ release: { tag: 'v0.9.0', version: '0.9.0' } }),
  );
  assert.equal(result.state, STATES.RUNTIME_AHEAD);
});

test('离线时主状态为 remote-unknown，不显示已是最新', () => {
  const result = compareProject(
    makeProject(),
    makeSource(),
    makeRuntime(),
    makeRemote({ status: 'offline', release: null, commit: '' }),
  );
  assert.equal(result.state, STATES.REMOTE_UNKNOWN);
  assert.match(result.headline, /无法确认最新/);
  assert.notEqual(result.label, '已同步');
});

test('限流同样为 remote-unknown 且原因准确', () => {
  const result = compareProject(
    makeProject(),
    makeSource(),
    makeRuntime(),
    makeRemote({ status: 'rate-limited', release: null, commit: '' }),
  );
  assert.equal(result.state, STATES.REMOTE_UNKNOWN);
  assert.match(result.headline, /限流/);
});

test('离线同时存在运行文件改动时仍以 drift 为主状态', () => {
  const result = compareProject(
    makeProject(),
    makeSource(),
    makeRuntime({ status: 'runtime-modified', modified: [{ path: 'main.js' }] }),
    makeRemote({ status: 'offline', release: null, commit: '' }),
  );
  assert.equal(result.state, STATES.RUNTIME_MODIFIED);
});

// ---------- inspectProject 集成 ----------

async function makeSourceTree(options) {
  const opts = options || {};
  const root = tempDir('proj-src-');
  writeFile(root, 'manifest.json', JSON.stringify({ id: opts.id || 'demo', name: 'Demo', version: opts.version || '1.0.0' }, null, 2));
  writeFile(root, 'main.js', opts.main || 'bundle');
  writeFile(root, 'README.md', '# demo\n');
  writeFile(root, '.git/config', '[remote "origin"]\n\turl = https://github.com/example/demo.git\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n');
  writeFile(root, '.git/HEAD', 'ref: refs/heads/main\n');
  writeFile(root, '.git/refs/heads/main', `${COMMIT_1}\n`);
  writeFile(root, '.git/refs/remotes/origin/main', `${COMMIT_1}\n`);
  return root;
}

async function makeInstalled(vault, id, main) {
  const dir = makePlugin(vault, id, { main });
  const location = `.obsidian/plugins/${id}`;
  const files = [];
  for (const name of ['manifest.json', 'main.js', 'styles.css']) {
    const abs = path.join(dir, name);
    files.push({ path: name, sha256: await sha256File(abs), size: fs.statSync(abs).size });
  }
  return { id, name: id, version: '1.0.0', installLocation: location, files };
}

async function makeLinked(options) {
  const opts = options || {};
  const vault = makeVault({ plugins: false });
  const sourcePath = await makeSourceTree();
  const record = await makeInstalled(vault, 'demo', opts.main || 'bundle');
  const identity = await sourceIdentity(sourcePath);
  const project = makeProject({
    sourcePath,
    baseline: {
      sourceIdentity: identity.digest,
      sourceVersion: '1.0.0',
      commit: COMMIT_1,
      artifactSha256: await sha256File(path.join(sourcePath, 'main.js')),
      recordedAt: '2026-10-01T00:00:00.000Z',
    },
  });
  return { vault, sourcePath, record, project, registry: { components: { demo: record } } };
}

test('inspectProject 展示三位置，未检查云端时为 remote-unknown 且只读', async () => {
  const { vault, sourcePath, project, registry } = await makeLinked();
  const sourceBefore = hashTree(sourcePath);
  const pluginBefore = hashTree(path.join(vault, '.obsidian/plugins/demo'));

  const inspection = await inspectProject({ vaultRoot: vault, registry, project });
  assert.equal(inspection.source.status, 'ok');
  assert.equal(inspection.runtime.status, 'ok');
  assert.equal(inspection.remote.status, 'unchecked');
  assert.equal(inspection.comparison.state, STATES.REMOTE_UNKNOWN);
  assert.equal(inspection.source.commit, COMMIT_1);
  assert.equal(inspection.source.version, '1.0.0');
  assert.equal(inspection.runtime.version, '1.0.0');

  assert.deepEqual(hashTree(sourcePath), sourceBefore);
  assert.deepEqual(hashTree(path.join(vault, '.obsidian/plugins/demo')), pluginBefore);
  assert.equal(fs.existsSync(path.join(vault, '.obsidian/vault-meta/projects.json')), false);
});

test('检查结果成功且一致时为 synced', async () => {
  const { vault, project, registry } = await makeLinked();
  const inspection = await inspectProject({
    vaultRoot: vault,
    registry,
    project,
    remoteResult: {
      ok: true,
      at: '2026-10-28T00:00:00.000Z',
      branch: 'main',
      commit: COMMIT_1,
      developmentVersion: '1.0.0',
      release: { tag: 'v1.0.0', version: '1.0.0' },
    },
  });
  assert.equal(inspection.remote.status, 'ok');
  assert.equal(inspection.comparison.state, STATES.SYNCED);
  assert.equal(inspection.comparison.label, '已同步');
});

test('断网检查后状态为 offline，且源码与插件目录未变', async () => {
  const { vault, sourcePath, project, registry } = await makeLinked();
  const sourceBefore = hashTree(sourcePath);
  const inspection = await inspectProject({
    vaultRoot: vault,
    registry,
    project,
    checkRemoteNow: true,
    request: async () => {
      const err = new Error('offline');
      err.code = 'ENOTFOUND';
      throw err;
    },
  });
  assert.equal(inspection.remote.status, 'offline');
  assert.equal(inspection.comparison.state, STATES.REMOTE_UNKNOWN);
  assert.equal(inspection.checkResult.ok, false);
  assert.equal(inspection.checkResult.code, 'E_NETWORK');
  assert.deepEqual(hashTree(sourcePath), sourceBefore);
});

test('运行文件被改动时 inspectProject 报告 runtime-modified', async () => {
  const { vault, project, registry } = await makeLinked();
  writeFile(vault, '.obsidian/plugins/demo/main.js', 'changed');
  const inspection = await inspectProject({ vaultRoot: vault, registry, project });
  assert.equal(inspection.runtime.status, 'runtime-modified');
  assert.equal(inspection.comparison.state, STATES.RUNTIME_MODIFIED);
});

test('无登记记录时 inspectProject 报告 unregistered', async () => {
  const { vault, project } = await makeLinked();
  const inspection = await inspectProject({ vaultRoot: vault, registry: { components: {} }, project });
  assert.equal(inspection.runtime.status, 'unregistered');
  assert.equal(inspection.comparison.state, STATES.UNREGISTERED);
});
