'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'vault-meta-'));
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function makePlugin(dir, id, options) {
  const opts = options || {};
  const version = opts.version || '1.0.0';
  const body = opts.main || `module.exports = { id: '${id}', version: '${version}' };\n`;
  writeFile(dir, `.obsidian/plugins/${id}/manifest.json`, JSON.stringify({ id, name: opts.name || id, version, minAppVersion: '1.5.0' }, null, 2));
  writeFile(dir, `.obsidian/plugins/${id}/main.js`, body);
  writeFile(dir, `.obsidian/plugins/${id}/styles.css`, opts.styles || `.${id} { color: var(--text-normal); }\n`);
  if (opts.data !== false) {
    writeFile(dir, `.obsidian/plugins/${id}/data.json`, JSON.stringify({ token: 'should-not-be-packaged', path: '/Users/someone/private' }, null, 2));
  }
  return path.join(dir, '.obsidian', 'plugins', id);
}

function makeVault(options) {
  const opts = options || {};
  const root = tempDir(opts.prefix || 'vault-');
  writeFile(root, 'note.md', '# 测试笔记\n\n内容\n');
  writeFile(root, '.obsidian/app.json', '{"attachmentFolderPath":"images"}\n');
  writeFile(root, '.obsidian/community-plugins.json', '["demo"]\n');
  writeFile(root, '.obsidian/workspace.json', '{"layout":"mock"}\n');
  writeFile(root, 'attachments/image.bin', Buffer.from([0, 1, 2, 3, 250, 251, 252]));
  if (opts.plugins !== false) {
    makePlugin(root, opts.pluginId || 'demo', opts.plugin);
  }
  return root;
}

function hashTree(root, options) {
  const opts = options || {};
  const out = {};
  const walk = (dir, relDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (opts.ignore && opts.ignore.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`))) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(root, '');
  return out;
}

module.exports = { tempDir, writeFile, readFile, makePlugin, makeVault, hashTree };
