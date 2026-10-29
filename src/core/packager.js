'use strict';

/**
 * 组件打包与套装导出。
 * 打包只取类型处理器声明的文件，并在写入前硬拒绝私有数据。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CODES, fail } = require('./errors');
const { resolveWithin } = require('./paths');
const { normalizeComponentSpec, normalizeSuiteSpec, satisfies, COMPONENT_FORMAT, SUITE_FORMAT } = require('./component-spec');
const { writeArchive, readArchiveManifest } = require('./archive');
const { getRecord } = require('./registry');
const { sha256File, exists, isDirectory, readJson, ensureDir, formatBytes } = require('./fs-utils');
const { assertNoPrivateFiles } = require('./types/private-data');

/**
 * 构建组件描述（读取真实文件并计算校验值）。
 * @param {{vaultRoot: string, types: object, id: string, name?: string, purpose?: string, version?: string,
 *          type: string, sourceDirRel: string, installLocation: string, dependencies?: Array, source?: object,
 *          include?: string[]}} input
 */
async function buildComponent(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  const handler = input.types.get(input.type);
  const sourceDir = resolveWithin(vaultRoot, input.sourceDirRel, { label: '组件源目录' });
  if (!isDirectory(sourceDir)) {
    fail(CODES.NOT_FOUND, `组件源目录不存在：${input.sourceDirRel}`, { dir: input.sourceDirRel });
  }

  const relFiles = (handler.selectFiles(sourceDir, { include: input.include }) || []).slice().sort();
  if (relFiles.length === 0) fail(CODES.NOT_FOUND, '没有可打包的文件', { dir: input.sourceDirRel });
  assertNoPrivateFiles(relFiles);

  let version = input.version;
  let name = input.name;
  if (input.type === 'obsidian-plugin') {
    const manifest = readJson(path.join(sourceDir, 'manifest.json'), null);
    if (!manifest) fail(CODES.INVALID_SPEC, '插件目录缺少 manifest.json', { dir: input.sourceDirRel });
    if (manifest.id !== input.id) {
      fail(CODES.INVALID_SPEC, `manifest.id（${manifest.id}）与组件 id（${input.id}）不一致`, {
        manifestId: manifest.id,
        specId: input.id,
      });
    }
    // manifest.json 是插件版本的唯一真源
    version = manifest.version;
    name = name || manifest.name || input.id;
  }
  if (!version) fail(CODES.INVALID_SPEC, '无法确定组件版本，请在描述中提供 version', { id: input.id });

  const files = [];
  for (const rel of relFiles) {
    const abs = path.join(sourceDir, rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) fail(CODES.INVALID_SPEC, `组件文件不是普通文件：${rel}`, { path: rel });
    files.push({ path: rel, sha256: await sha256File(abs), size: stat.size });
  }

  const spec = normalizeComponentSpec({
    format: COMPONENT_FORMAT,
    id: input.id,
    name: name || input.id,
    purpose: input.purpose || '',
    version,
    type: input.type,
    source: {
      kind: 'vault',
      path: input.sourceDirRel,
      ...(input.source || {}),
    },
    install: { location: input.installLocation },
    files,
    dependencies: input.dependencies || [],
  });
  handler.validateSpec(spec, { vaultRoot });

  return {
    spec,
    sourceDir,
    files: relFiles.map((rel) => ({ path: rel, abs: path.join(sourceDir, rel) })),
  };
}

/**
 * 导出一个组件为 .vmpkg。
 */
async function exportComponent(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  const registry = input.registry || { components: {} };
  const record = input.id ? getRecord(registry, input.id) : null;
  const type = input.type || (record && record.type) || 'obsidian-plugin';
  const id = input.id || (record && record.id);
  if (!id) fail(CODES.INVALID_SPEC, '导出组件必须提供 id', {});

  const sourceDirRel = input.sourceDirRel || (record && record.installLocation) || `.obsidian/plugins/${id}`;
  const installLocation = input.installLocation || (record && record.installLocation) || sourceDirRel;

  const { spec, files, sourceDir } = await buildComponent({
    vaultRoot,
    types: input.types,
    id,
    name: input.name || (record && record.name),
    purpose: input.purpose || (record && record.purpose),
    version: input.version || (record && record.version),
    type,
    sourceDirRel,
    installLocation,
    dependencies: input.dependencies || (record && record.dependencies) || [],
    source: input.source,
    include: input.include,
  });

  const outDir = path.resolve(input.outDir);
  ensureDir(outDir);
  const outFile = path.join(outDir, `${spec.id}-${spec.version}.vmpkg`);
  if (!input.overwrite && exists(outFile)) {
    fail(CODES.CONFLICT, `导出文件已存在：${path.basename(outFile)}`, { file: outFile });
  }

  const manifest = await writeArchive(outFile, {
    kind: 'component',
    meta: { component: spec },
    files,
  });

  return {
    file: outFile,
    spec,
    manifest,
    sourceDir,
    fileCount: spec.files.length,
    totalBytes: manifest.totalBytes,
    totalText: formatBytes(manifest.totalBytes),
  };
}

/**
 * 只读取组件包描述（不校验全部内容，用于 UI 预检展示）。
 */
async function inspectComponentPackage(file) {
  const manifest = await readArchiveManifest(path.resolve(file));
  if (manifest.kind !== 'component') fail(CODES.ARCHIVE_FORMAT, '该文件不是组件包', { kind: manifest.kind });
  const spec = normalizeComponentSpec(manifest.meta && manifest.meta.component);
  return { file, spec, fileCount: manifest.fileCount, totalText: formatBytes(manifest.totalBytes) };
}

/**
 * 套装导出：解析成员版本 → 补齐必需依赖闭包 → 打包成单个 .vmsuite。
 * @param {{vaultRoot: string, registry: object, types: object, outDir: string, suite: object,
 *          includeDependencies?: boolean, overwrite?: boolean}} input
 */
async function exportSuite(input) {
  const vaultRoot = path.resolve(input.vaultRoot);
  const registry = input.registry;
  const suite = normalizeSuiteSpec(input.suite);
  const includeDependencies = input.includeDependencies !== false;
  const resolved = new Map();
  const requested = new Set();

  for (const item of suite.components) {
    const record = getRecord(registry, item.id);
    if (!record) {
      fail(CODES.MISSING_DEPENDENCY, `套装包含未登记的组件：${item.id}`, { id: item.id });
    }
    if (item.version && item.version !== record.version) {
      fail(CODES.MISSING_DEPENDENCY, `套装要求 ${item.id}@${item.version}，当前登记为 ${record.version}`, {
        id: item.id,
        requested: item.version,
        actual: record.version,
      });
    }
    resolved.set(item.id, record);
    requested.add(item.id);
  }

  const autoIncluded = [];
  if (includeDependencies) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of Array.from(resolved.values())) {
        for (const dep of record.dependencies || []) {
          if (dep.optional) continue;
          const member = resolved.get(dep.id);
          if (member) {
            if (!satisfies(member.version, dep.range)) {
              fail(CODES.MISSING_DEPENDENCY, `依赖版本不满足：${record.id} 需要 ${dep.id}@${dep.range}，套装内为 ${member.version}`, {
                requiredBy: record.id,
                id: dep.id,
                range: dep.range,
                actual: member.version,
              });
            }
            continue;
          }
          const installed = getRecord(registry, dep.id);
          if (!installed) {
            fail(CODES.MISSING_DEPENDENCY, `缺少依赖：${record.id} 需要 ${dep.id}@${dep.range}`, {
              requiredBy: record.id,
              id: dep.id,
              range: dep.range,
            });
          }
          if (!satisfies(installed.version, dep.range)) {
            fail(CODES.MISSING_DEPENDENCY, `依赖版本不满足：${record.id} 需要 ${dep.id}@${dep.range}，已安装 ${installed.version}`, {
              requiredBy: record.id,
              id: dep.id,
              range: dep.range,
              actual: installed.version,
            });
          }
          resolved.set(dep.id, installed);
          if (!requested.has(dep.id)) autoIncluded.push(dep.id);
          changed = true;
        }
      }
    }
  }

  const outDir = path.resolve(input.outDir);
  ensureDir(outDir);
  const outFile = path.join(outDir, `${suite.id}-${suite.version}.vmsuite`);
  if (!input.overwrite && exists(outFile)) {
    fail(CODES.CONFLICT, `套装文件已存在：${path.basename(outFile)}`, { file: outFile });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-meta-suite-'));
  try {
    const members = [];
    const payload = [];
    for (const record of resolved.values()) {
      const pkg = await exportComponent({
        vaultRoot,
        registry,
        types: input.types,
        id: record.id,
        outDir: tmpDir,
        overwrite: true,
      });
      const stat = fs.statSync(pkg.file);
      const rel = `components/${record.id}/${path.basename(pkg.file)}`;
      members.push({
        id: record.id,
        name: record.name,
        type: record.type,
        version: pkg.spec.version,
        purpose: record.purpose,
        fileCount: pkg.spec.files.length,
        size: stat.size,
        sha256: await sha256File(pkg.file),
        path: rel,
      });
      payload.push({ path: rel, abs: pkg.file });
    }

    const suiteDoc = {
      format: SUITE_FORMAT,
      id: suite.id,
      name: suite.name,
      version: suite.version,
      description: suite.description,
      createdAt: new Date().toISOString(),
      components: members,
      autoIncluded,
      requested: Array.from(requested),
    };
    const suiteJson = path.join(tmpDir, 'suite.json');
    fs.writeFileSync(suiteJson, `${JSON.stringify(suiteDoc, null, 2)}\n`, 'utf8');
    payload.unshift({ path: 'suite.json', abs: suiteJson });

    const manifest = await writeArchive(outFile, { kind: 'suite', meta: { suite: suiteDoc }, files: payload });
    return {
      file: outFile,
      suite: suiteDoc,
      components: members,
      autoIncluded,
      totalBytes: manifest.totalBytes,
      totalText: formatBytes(manifest.totalBytes),
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }
}

module.exports = {
  buildComponent,
  exportComponent,
  inspectComponentPackage,
  exportSuite,
};
