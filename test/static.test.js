'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function walkJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(abs, out);
    else if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

test('manifest / package / versions 版本一致', () => {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  const versions = readJson('versions.json');
  assert.equal(manifest.id, 'vault-meta');
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(manifest.version, pkg.version);
  assert.ok(versions[manifest.version]);
});

test('样式使用主题变量、窄屏适配与可见焦点', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  for (const token of ['var(--background-primary)', 'var(--text-normal)', 'var(--text-muted)', 'var(--interactive-accent)', 'var(--background-modifier-border)']) {
    assert.ok(css.includes(token), `缺少主题变量 ${token}`);
  }
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b/); // 不硬编码颜色
});

test('源码不含个人绝对路径或云盘硬编码', () => {
  const offenders = [];
  for (const file of walkJs(path.join(ROOT, 'src'), [])) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\/Users\/[A-Za-z0-9._-]+/.test(text)) offenders.push(`${file}: /Users/`);
    if (/Mobile Documents|com~apple~CloudDocs/.test(text)) offenders.push(`${file}: iCloud 路径`);
    if (/OneDrive[\\/]/.test(text)) offenders.push(`${file}: OneDrive 路径`);
  }
  assert.deepEqual(offenders, []);
});

test('目录内没有私有配置与归档产物', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'data.json')), false);
  const archives = fs.readdirSync(ROOT).filter((name) => /\.(vmpkg|vmbak|vmsuite)$/.test(name));
  assert.deepEqual(archives, []);
});

test('README 与发布 Skill 覆盖关键章节', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const keyword of ['安装', '备份', '组件', '测试', '安全']) assert.ok(readme.includes(keyword), `README 缺少 ${keyword}`);
  assert.match(readme, /云同步 ≠ 历史备份|不能替代历史备份|不能当历史备份/);

  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'vault-plugin-release', 'SKILL.md'), 'utf8');
  for (const keyword of ['README', '版本', '构建', '独立安装验证', '私有数据']) {
    assert.ok(skill.includes(keyword), `Skill 缺少 ${keyword}`);
  }
});

test('组件与套装示例可被描述校验器接受', () => {
  const { normalizeSuiteSpec, normalizeComponentSpec } = require('../src/core/component-spec');
  const suite = normalizeSuiteSpec(readJson('examples/suite.example.json'));
  assert.equal(suite.id, 'base-suite');
  const component = normalizeComponentSpec(readJson('examples/component.example.json'));
  assert.equal(component.type, 'files');
});
