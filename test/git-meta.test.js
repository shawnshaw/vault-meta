'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readGitMeta } = require('../src/core/git-meta');
const { tempDir, writeFile, hashTree } = require('./helpers/vault');

const HEAD_SHA = '1111111111111111111111111111111111111111';
const REMOTE_SHA = '2222222222222222222222222222222222222222';
const OTHER_SHA = '3333333333333333333333333333333333333333';

function makeRepo(files) {
  const root = tempDir('repo-');
  const base = {
    '.git/config': [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://github.com/example/demo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]',
      '\tremote = origin',
      '\tmerge = refs/heads/main',
      '',
    ].join('\n'),
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/refs/heads/main': `${HEAD_SHA}\n`,
    '.git/refs/remotes/origin/main': `${REMOTE_SHA}\n`,
  };
  for (const [rel, content] of Object.entries({ ...base, ...(files || {}) })) {
    writeFile(root, rel, content);
  }
  return root;
}

test('读取普通仓库的远端、分支、提交与远端跟踪提交', () => {
  const meta = readGitMeta(makeRepo());
  assert.equal(meta.isRepo, true);
  assert.equal(meta.remoteName, 'origin');
  assert.equal(meta.remoteUrl, 'https://github.com/example/demo.git');
  assert.equal(meta.branch, 'main');
  assert.equal(meta.mergeRef, 'refs/heads/main');
  assert.equal(meta.commit, HEAD_SHA);
  assert.equal(meta.detached, false);
  assert.equal(meta.remoteTrackingCommit, REMOTE_SHA);
});

test('提交只存在于 packed-refs 时仍能解析', () => {
  const root = makeRepo({
    '.git/refs/heads/main': '',
    '.git/refs/remotes/origin/main': '',
    '.git/packed-refs': [
      '# pack-refs with: peeled fully-peeled sorted',
      `${HEAD_SHA} refs/heads/main`,
      `${REMOTE_SHA} refs/remotes/origin/main`,
      '',
    ].join('\n'),
  });
  const meta = readGitMeta(root);
  assert.equal(meta.commit, HEAD_SHA);
  assert.equal(meta.remoteTrackingCommit, REMOTE_SHA);
});

test('支持 .git 文件间接到实际 git 目录', () => {
  const real = makeRepo();
  const worktree = tempDir('wt-');
  writeFile(worktree, '.git', `gitdir: ${real}/.git\n`);
  const meta = readGitMeta(worktree);
  assert.equal(meta.isRepo, true);
  assert.equal(meta.branch, 'main');
  assert.equal(meta.commit, HEAD_SHA);
  assert.equal(meta.remoteUrl, 'https://github.com/example/demo.git');
});

test('支持 commondir 间接（worktree 布局）', () => {
  const real = makeRepo();
  const worktreeGit = path.join(real, '.git', 'worktrees', 'demo');
  writeFile(worktreeGit, 'HEAD', `ref: refs/heads/main\n`);
  writeFile(worktreeGit, 'commondir', '../..\n');
  const worktree = tempDir('wt-');
  writeFile(worktree, '.git', `gitdir: ${worktreeGit}\n`);
  const meta = readGitMeta(worktree);
  assert.equal(meta.isRepo, true);
  assert.equal(meta.branch, 'main');
  assert.equal(meta.commit, HEAD_SHA);
  assert.equal(meta.remoteUrl, 'https://github.com/example/demo.git');
});

test('detached HEAD 直接返回提交且不认定分支', () => {
  const root = makeRepo({ '.git/HEAD': `${OTHER_SHA}\n` });
  const meta = readGitMeta(root);
  assert.equal(meta.isRepo, true);
  assert.equal(meta.detached, true);
  assert.equal(meta.commit, OTHER_SHA);
  assert.equal(meta.branch, '');
  assert.equal(meta.remoteTrackingCommit, '');
});

test('非仓库目录返回 isRepo=false', () => {
  const meta = readGitMeta(tempDir('plain-'));
  assert.equal(meta.isRepo, false);
  assert.equal(meta.commit, '');
});

test('读取过程不修改任何 git 文件', () => {
  const root = makeRepo();
  const before = hashTree(root);
  readGitMeta(root);
  assert.deepEqual(hashTree(root), before);
});
