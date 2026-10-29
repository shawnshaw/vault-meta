'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  loadProjects,
  saveProjects,
  upsertProject,
  removeProject,
  listProjects,
  getProject,
  findBySourcePath,
  createProjectId,
  normalizeProject,
  emptyProjects,
} = require('../src/core/projects');
const { tempDir, makeVault, hashTree } = require('./helpers/vault');

function makeProject(overrides) {
  const source = (overrides && overrides.sourcePath) || tempDir('src-');
  return {
    id: createProjectId('demo', source),
    name: 'Demo 插件',
    purpose: '演示项目',
    pluginId: 'demo',
    sourcePath: source,
    remote: { url: 'https://github.com/example/demo', branch: 'main' },
    installLocation: '.obsidian/plugins/demo',
    ...(overrides || {}),
  };
}

test('没有项目文件时返回空记录', () => {
  const vault = makeVault();
  const { store, exists } = loadProjects(vault);
  assert.equal(exists, false);
  assert.equal(store.format, 'vault-meta/projects@1');
  assert.deepEqual(store.projects, []);
});

test('保存后可以原样读回，并且只新增 projects.json', () => {
  const vault = makeVault();
  const before = hashTree(vault);
  const project = makeProject();
  const store = emptyProjects();
  upsertProject(store, project);
  saveProjects(vault, store);

  const after = hashTree(vault);
  const added = Object.keys(after).filter((key) => !(key in before));
  assert.deepEqual(added, ['.obsidian/vault-meta/projects.json']);

  const loaded = loadProjects(vault);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.store.projects.length, 1);
  assert.equal(loaded.store.projects[0].name, 'Demo 插件');
  assert.equal(loaded.store.projects[0].sourcePath, project.sourcePath);
});

test('格式不认识时报 E_INVALID_SPEC', () => {
  const vault = makeVault();
  const file = path.join(vault, '.obsidian', 'vault-meta', 'projects.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ format: 'other@1', projects: [] }));
  assert.throws(() => loadProjects(vault), (err) => err.code === 'E_INVALID_SPEC');
});

test('源码目录必须是绝对路径', () => {
  assert.throws(
    () => normalizeProject({ ...makeProject(), sourcePath: 'relative/dir' }),
    (err) => err.code === 'E_PROJECT_INVALID',
  );
});

test('源码路径带尾斜杠时规范化为同一路径', () => {
  const project = makeProject();
  const normalized = normalizeProject({ ...project, sourcePath: `${project.sourcePath}/` });
  assert.equal(normalized.sourcePath, project.sourcePath);
});

test('安装位置必须位于插件目录', () => {
  assert.throws(
    () => normalizeProject({ ...makeProject(), installLocation: 'Notes/demo' }),
    (err) => err.code === 'E_PROJECT_INVALID',
  );
});

test('项目 id 不合法时拒绝', () => {
  assert.throws(
    () => normalizeProject({ ...makeProject(), id: 'Demo Project' }),
    (err) => err.code === 'E_PROJECT_INVALID',
  );
});

test('两个项目不能占用同一安装位置', () => {
  const vault = makeVault();
  const store = emptyProjects();
  upsertProject(store, makeProject());
  assert.throws(
    () => upsertProject(store, makeProject({ id: 'other-123456', sourcePath: tempDir('src2-') })),
    (err) => err.code === 'E_PROJECT_INVALID',
  );
});

test('两个项目不能关联同一源码目录', () => {
  const source = tempDir('src-');
  const store = emptyProjects();
  upsertProject(store, makeProject({ id: 'one-123456', sourcePath: source }));
  assert.throws(
    () => upsertProject(store, makeProject({ id: 'two-123456', sourcePath: source, installLocation: '.obsidian/plugins/two' })),
    (err) => err.code === 'E_PROJECT_INVALID',
  );
});

test('更新同 id 项目保留 createdAt 并刷新 updatedAt', async () => {
  const store = emptyProjects();
  const project = makeProject();
  project.createdAt = '2026-01-01T00:00:00.000Z';
  project.updatedAt = '2026-01-01T00:00:00.000Z';
  upsertProject(store, project);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = upsertProject(store, { ...project, name: '改名' });
  assert.equal(store.projects.length, 1);
  assert.equal(updated.createdAt, '2026-01-01T00:00:00.000Z');
  assert.notEqual(updated.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(store.projects[0].name, '改名');
});

test('按 id 与源码路径查找、移除', () => {
  const store = emptyProjects();
  const project = makeProject();
  upsertProject(store, project);
  assert.equal(getProject(store, project.id).id, project.id);
  assert.equal(findBySourcePath(store, project.sourcePath).id, project.id);
  assert.equal(listProjects(store)[0].name, 'Demo 插件');
  assert.equal(removeProject(store, project.id), true);
  assert.equal(removeProject(store, project.id), false);
  assert.equal(store.projects.length, 0);
});

test('projects.json 被符号链接到 vault 外时拒绝读写', () => {
  const vault = makeVault();
  const outside = path.join(tempDir('outside-'), 'projects.json');
  fs.writeFileSync(outside, '{}');
  const stateRoot = path.join(vault, '.obsidian', 'vault-meta');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(stateRoot, 'projects.json'));
  assert.throws(() => loadProjects(vault), (err) => err.code === 'E_SYMLINK_ESCAPE');
  assert.throws(() => saveProjects(vault, emptyProjects()), (err) => err.code === 'E_SYMLINK_ESCAPE');
});
