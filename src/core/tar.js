'use strict';

/**
 * 极简 ustar + PAX 流式读写（gzip 容器）。
 * - 路径能放进 ustar（base≤100B、prefix≤155B）时保持 ustar，兼容旧归档与旧读取器；
 * - 放不下（中文长文件名、深层目录）时写 PAX 扩展头（typeflag 'x'），路径按 UTF-8 原样保存；
 * - 读取同时支持两种形式，其他类型（含 'g'）一律明确报错，避免静默丢信息。
 */
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { finished } = require('stream/promises');
const { CODES, fail, isVaultMetaError } = require('./errors');

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const PAX_TYPE = 'x';
const PAX_NAME = '././@PaxHeader';
const PAX_MAX_BYTES = 1024 * 1024;
const PAX_PATH_MAX_BYTES = 64 * 1024;
const PAX_FALLBACK_DIR = 'pax-fallback';

function encodeOctal(value, width) {
  const max = 8 ** (width - 1) - 1;
  const n = Math.max(0, Math.min(Math.floor(value), max));
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function decodeOctal(buffer) {
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    fail(CODES.ARCHIVE_CORRUPT, 'tar 数字字段非法', { field: text });
  }
  return parseInt(text, 8);
}

function readText(buffer, offset, length) {
  return buffer.toString('utf8', offset, offset + length).replace(/\0.*$/s, '');
}

/**
 * 尝试把路径放进 ustar 的 name(100B)/prefix(155B)。
 * @returns {{prefix: string, base: string}|null}
 */
function trySplitName(name) {
  if (Buffer.byteLength(name, 'utf8') <= 100) return { prefix: '', base: name };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const base = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(base, 'utf8') <= 100) {
      return { prefix, base };
    }
  }
  return null;
}

/** PAX 记录：`<长度> <key>=<value>\n`，长度包含自身数字、空格与换行。 */
function buildPaxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body, 'utf8') + 1;
  for (;;) {
    const total = Buffer.byteLength(String(length), 'ascii') + Buffer.byteLength(body, 'utf8');
    if (total === length) break;
    length = total;
  }
  return Buffer.from(`${length}${body}`, 'utf8');
}

function parsePaxRecords(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) break;
    const lengthText = buffer.toString('ascii', offset, space);
    if (!/^\d+$/.test(lengthText)) {
      fail(CODES.ARCHIVE_CORRUPT, 'PAX 记录长度非法', { value: lengthText });
    }
    const length = Number(lengthText);
    if (length <= 0 || offset + length > buffer.length) {
      fail(CODES.ARCHIVE_CORRUPT, 'PAX 记录越界', { offset, length });
    }
    const record = buffer.toString('utf8', space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) {
      const key = record.slice(0, eq);
      if (key === 'path' || key === 'size' || key === 'mode' || key === 'mtime') {
        records[key] = record.slice(eq + 1);
      }
    }
    offset += length;
  }
  return records;
}

function buildHeader(split, size, mode, mtimeMs, type) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(split.base, 0, 100, 'utf8');
  header.write(encodeOctal(mode & 0o777, 8), 100, 8, 'ascii');
  header.write(encodeOctal(0, 8), 108, 8, 'ascii');
  header.write(encodeOctal(0, 8), 116, 8, 'ascii');
  header.write(encodeOctal(size, 12), 124, 12, 'ascii');
  header.write(encodeOctal(Math.floor(mtimeMs / 1000), 12), 136, 12, 'ascii');
  const typeflag = type === 'dir' ? '5' : type === 'pax' ? PAX_TYPE : '0';
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(split.prefix, 345, 155, 'utf8');

  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function padFor(size) {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/**
 * 写入 .tar.gz。
 * @param {string} destFile
 * @param {Array<{path?: string, type?: 'file'|'dir'|'pax', data?: Buffer, abs?: string,
 *                mode?: number, mtimeMs?: number, sha256?: string}>} entries
 */
async function writeTarGz(destFile, entries) {
  const tmp = `${destFile}.vmtmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const out = fs.createWriteStream(tmp);
  const gz = zlib.createGzip({ level: 6 });
  let failure = null;
  out.on('error', (err) => {
    failure = err;
  });
  gz.on('error', (err) => {
    failure = err;
  });
  gz.pipe(out);

  const write = (buffer) =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      if (gz.write(buffer)) {
        resolve();
        return;
      }
      gz.once('drain', resolve);
    });

  const writePax = async (data, mtimeMs) => {
    await write(buildHeader({ prefix: '', base: PAX_NAME }, data.length, 0o644, mtimeMs, 'pax'));
    if (data.length > 0) await write(data);
    const padding = padFor(data.length);
    if (padding > 0) await write(Buffer.alloc(padding));
  };

  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const type = entry.type || 'file';
      const mode = entry.mode === undefined ? 0o644 : entry.mode;
      const mtimeMs = entry.mtimeMs === undefined ? Date.now() : entry.mtimeMs;

      if (type === 'pax') {
        const data = entry.data || Buffer.alloc(0);
        if (data.length > PAX_MAX_BYTES) fail(CODES.ARCHIVE_FORMAT, 'PAX 头过大', { size: data.length });
        await writePax(data, mtimeMs);
        continue;
      }

      const split = entry.path ? trySplitName(entry.path) : null;
      if (entry.path && !split) {
        // 超出 ustar 长度限制：先写 PAX 扩展头保存原始路径
        await writePax(buildPaxRecord('path', entry.path), mtimeMs);
      }
      const headerSplit = split || { prefix: '', base: `${PAX_FALLBACK_DIR}/${String(index).padStart(8, '0')}` };

      if (type === 'dir') {
        await write(buildHeader(headerSplit, 0, mode, mtimeMs, 'dir'));
        continue;
      }

      if (entry.data) {
        const size = entry.data.length;
        await write(buildHeader(headerSplit, size, mode, mtimeMs, 'file'));
        if (size > 0) await write(entry.data);
        const padding = padFor(size);
        if (padding > 0) await write(Buffer.alloc(padding));
        continue;
      }

      const stat = fs.statSync(entry.abs);
      const size = stat.size;
      await write(buildHeader(headerSplit, size, mode, mtimeMs, 'file'));
      let written = 0;
      const hash = crypto.createHash('sha256');
      const readStream = fs.createReadStream(entry.abs);
      for await (const chunk of readStream) {
        written += chunk.length;
        hash.update(chunk);
        await write(chunk);
      }
      if (written !== size) {
        fail(CODES.CHECKSUM_MISMATCH, `文件在打包过程中大小发生变化：${entry.path}`, {
          path: entry.path,
          expectedSize: size,
          actualSize: written,
        });
      }
      if (entry.sha256) {
        const actual = hash.digest('hex');
        if (actual !== entry.sha256) {
          fail(CODES.CHECKSUM_MISMATCH, `文件在打包过程中内容发生变化：${entry.path}`, {
            path: entry.path,
            expected: entry.sha256,
            actual,
          });
        }
      }
      const padding = padFor(size);
      if (padding > 0) await write(Buffer.alloc(padding));
    }

    await write(ZERO_BLOCK);
    await write(ZERO_BLOCK);
    gz.end();
    await finished(out);
    if (failure) throw failure;
    fs.renameSync(tmp, destFile);
  } catch (err) {
    gz.destroy();
    out.destroy();
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      /* ignore */
    }
    if (isVaultMetaError(err)) throw err;
    fail(CODES.IO, '写入归档失败', { cause: (err && err.code) || String(err) });
  }
}

function parseHeader(block) {
  const stored = decodeOctal(block.subarray(148, 156));
  const copy = Buffer.from(block);
  copy.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of copy) checksum += byte;
  if (stored !== checksum) {
    fail(CODES.ARCHIVE_CORRUPT, 'tar 头校验失败，归档可能损坏', { stored, checksum });
  }

  const name = readText(block, 0, 100);
  const prefix = readText(block, 345, 155);
  const size = decodeOctal(block.subarray(124, 136));
  const mode = decodeOctal(block.subarray(100, 108));
  const mtimeMs = decodeOctal(block.subarray(136, 148)) * 1000;
  const typeflag = String.fromCharCode(block[156]) || '0';

  let type;
  if (typeflag === '5') type = 'dir';
  else if (typeflag === PAX_TYPE) type = 'pax';
  else if (typeflag === '0' || typeflag === '\0') type = 'file';
  else fail(CODES.ARCHIVE_FORMAT, `不支持的 tar 条目类型：${typeflag}`, { typeflag });

  if (size < 0 || size > 1e12) {
    fail(CODES.ARCHIVE_CORRUPT, 'tar 条目大小异常', { size });
  }
  return {
    path: prefix ? `${prefix}/${name}` : name,
    type,
    size,
    mode,
    mtimeMs,
  };
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * 流式遍历 tar.gz；每个条目提供 read(consumer) 消费内容。
 * 调用方不消费时自动跳过，保证流同步。
 * @param {string} file
 */
async function* iterateTarGz(file) {
  const source = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);

  const iterator = gunzip[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);

  const pull = async () => {
    let next;
    try {
      next = await iterator.next();
    } catch (err) {
      fail(CODES.ARCHIVE_CORRUPT, '解压归档失败，文件可能损坏', { cause: err.code || err.message });
    }
    if (next.done) return false;
    buffered = buffered.length === 0 ? next.value : Buffer.concat([buffered, next.value]);
    return true;
  };

  const readExact = async (length, what) => {
    while (buffered.length < length) {
      if (!(await pull())) {
        fail(CODES.ARCHIVE_CORRUPT, `归档提前结束（${what}）`, { missing: length - buffered.length });
      }
    }
    const out = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return out;
  };

  let pendingPax = null;

  while (true) {
    let header;
    try {
      header = await readExact(BLOCK, 'header');
    } catch (err) {
      if (isVaultMetaError(err)) throw err;
      return;
    }
    if (isZeroBlock(header)) return;

    const meta = parseHeader(header);

    if (meta.type === 'pax') {
      if (meta.size > PAX_MAX_BYTES) fail(CODES.ARCHIVE_FORMAT, 'PAX 头过大', { size: meta.size });
      const chunks = [];
      let remaining = meta.size;
      while (remaining > 0) {
        if (buffered.length === 0 && !(await pull())) {
          fail(CODES.ARCHIVE_CORRUPT, 'PAX 头内容不完整', {});
        }
        const take = Math.min(remaining, buffered.length);
        chunks.push(Buffer.from(buffered.subarray(0, take)));
        buffered = buffered.subarray(take);
        remaining -= take;
      }
      const padding = padFor(meta.size);
      if (padding > 0) await readExact(padding, 'padding');
      pendingPax = { ...(pendingPax || {}), ...parsePaxRecords(Buffer.concat(chunks)) };
      continue;
    }

    let entryPath = meta.path;
    let entrySize = meta.size;
    let entryMode = meta.mode;
    let entryMtimeMs = meta.mtimeMs;
    if (pendingPax) {
      if (pendingPax.path !== undefined) {
        if (Buffer.byteLength(pendingPax.path, 'utf8') > PAX_PATH_MAX_BYTES) {
          fail(CODES.PATH_INVALID, '归档路径过长（PAX）', { path: pendingPax.path.slice(0, 120) });
        }
        entryPath = pendingPax.path;
      }
      if (pendingPax.size !== undefined) {
        const size = Number(pendingPax.size);
        if (!Number.isFinite(size) || size < 0) fail(CODES.ARCHIVE_CORRUPT, 'PAX size 非法', { size: pendingPax.size });
        entrySize = size;
      }
      if (pendingPax.mode !== undefined) {
        const mode = parseInt(pendingPax.mode, 8);
        if (Number.isFinite(mode)) entryMode = mode;
      }
      if (pendingPax.mtime !== undefined) {
        const mtime = Number(pendingPax.mtime);
        if (Number.isFinite(mtime)) entryMtimeMs = mtime * 1000;
      }
      pendingPax = null;
    }
    if (typeof entryPath !== 'string' || entryPath === '') {
      fail(CODES.ARCHIVE_CORRUPT, '归档条目路径为空', {});
    }

    let consumed = false;
    const entry = {
      path: entryPath,
      type: meta.type,
      size: entrySize,
      mode: entryMode,
      mtimeMs: entryMtimeMs,
      /**
       * @param {(chunk: Buffer) => void | Promise<void>} consumer
       */
      read: async (consumer) => {
        if (consumed) fail(CODES.ARCHIVE_CORRUPT, '归档条目被重复读取', { path: entryPath });
        consumed = true;
        let remaining = entrySize;
        while (remaining > 0) {
          if (buffered.length === 0 && !(await pull())) {
            fail(CODES.ARCHIVE_CORRUPT, `归档条目内容不完整：${entryPath}`, { path: entryPath });
          }
          const take = Math.min(remaining, buffered.length);
          const chunk = buffered.subarray(0, take);
          buffered = buffered.subarray(take);
          remaining -= take;
          await consumer(chunk);
        }
        const padding = padFor(entrySize);
        if (padding > 0) await readExact(padding, 'padding');
      },
    };

    yield entry;

    if (!consumed && entrySize > 0) {
      await entry.read(() => {});
    }
  }
}

module.exports = { BLOCK, writeTarGz, iterateTarGz, trySplitName, buildPaxRecord, parsePaxRecords };
