#!/usr/bin/env node
'use strict';

/**
 * 发布前检查：版本一致性、私有数据、构建产物、Skill 完整性。
 * 退出码非 0 表示存在阻断问题。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];
const passed = [];

function check(name, fn) {
  try {
    fn();
    passed.push(name);
  } catch (err) {
    errors.push(`${name}：${err.message}`);
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

check('manifest.json 字段完整', () => {
  const manifest = readJson('manifest.json');
  for (const key of ['id', 'name', 'version', 'minAppVersion', 'description']) {
    if (!manifest[key]) throw new Error(`缺少 ${key}`);
  }
  if (manifest.id !== 'vault-meta') throw new Error('id 必须是 vault-meta');
  if ((manifest.main || 'main.js') !== 'main.js') throw new Error('main 必须是 main.js');
  if (manifest.isDesktopOnly !== true) throw new Error('必须声明 isDesktopOnly: true');
});

check('版本号在 manifest/package/versions 中一致', () => {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  const versions = readJson('versions.json');
  if (pkg.version !== manifest.version) throw new Error(`package ${pkg.version} ≠ manifest ${manifest.version}`);
  if (!versions[manifest.version]) throw new Error(`versions.json 缺少 ${manifest.version}`);
});

check('README 存在且覆盖关键章节', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const keyword of ['安装', '备份', '组件', '测试', '安全']) {
    if (!readme.includes(keyword)) throw new Error(`README 缺少章节关键词：${keyword}`);
  }
});

check('源码不包含个人绝对路径或云盘硬编码', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'), [])) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\/Users\/[A-Za-z0-9._-]+/.test(text)) offenders.push(`${path.relative(ROOT, file)}: /Users/...`);
    if (/Mobile Documents|com~apple~CloudDocs/.test(text)) offenders.push(`${path.relative(ROOT, file)}: iCloud 路径`);
    if (/OneDrive[\\/]/.test(text)) offenders.push(`${path.relative(ROOT, file)}: OneDrive 路径`);
  }
  if (offenders.length > 0) throw new Error(offenders.join('；'));
});

check('目录中没有用户配置 data.json', () => {
  if (fs.existsSync(path.join(ROOT, 'data.json'))) throw new Error('发现 data.json（插件用户配置）');
});

check('不携带 node_modules 或备份归档', () => {
  for (const name of ['node_modules', 'tmp']) {
    if (fs.existsSync(path.join(ROOT, name))) warnings.push(`存在 ${name}/，发布时请勿打包`);
  }
  const archives = fs.readdirSync(ROOT).filter((name) => /\.(vmpkg|vmbak|vmsuite)$/.test(name));
  if (archives.length > 0) throw new Error(`目录内存在归档文件：${archives.join('、')}`);
});

check('源码语法检查（node --check）', () => {
  for (const file of walk(path.join(ROOT, 'src'), [])) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
});

check('构建产物 main.js 存在', () => {
  const main = path.join(ROOT, 'main.js');
  if (!fs.existsSync(main)) throw new Error('缺少 main.js，请运行 npm run build');
  if (fs.statSync(main).size === 0) throw new Error('main.js 为空');
});

check('发布 Skill 存在且覆盖关键步骤', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'vault-plugin-release', 'SKILL.md'), 'utf8');
  for (const keyword of ['README', '版本', '构建', '独立安装验证', '私有数据']) {
    if (!skill.includes(keyword)) throw new Error(`Skill 缺少：${keyword}`);
  }
});

for (const name of passed) console.log(`[PASS] ${name}`);
for (const warning of warnings) console.log(`[WARN] ${warning}`);
for (const error of errors) console.error(`[FAIL] ${error}`);

if (errors.length > 0) {
  console.error(`\n检查未通过：${errors.length} 项失败`);
  process.exit(1);
}
console.log(`\n检查通过：${passed.length} 项`);
