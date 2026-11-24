import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const PNG_MAGIC = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PNG_CAPTURE_LIMITS = Object.freeze({
  maxFiles: 16,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => Object.assign(new Error(reason), { reason });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function ascii(bytes, at, length) {
  return bytes.subarray(at, at + length).toString('ascii');
}

// Strict structural PNG validation: magic bytes are necessary but not enough.
// Every chunk is bounded and CRC-checked; IHDR/IDAT/IEND must be present and
// IEND must be the exact final chunk. This keeps truncated or polyglot files
// out of the model snapshot without introducing an image dependency.
export function validatePngBytes(bytes, { maxBytes = PNG_CAPTURE_LIMITS.maxFileBytes } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw fail('png_invalid:too_short');
  if (bytes.length > maxBytes) throw fail('png_invalid:byte_limit');
  if (!PNG_MAGIC.every((byte, index) => bytes[index] === byte)) throw fail('png_invalid:magic');
  let at = 8;
  let first = true;
  let width = 0;
  let height = 0;
  let idat = 0;
  let iend = false;
  while (at < bytes.length) {
    if (bytes.length - at < 12) throw fail('png_invalid:truncated_chunk');
    const length = bytes.readUInt32BE(at);
    if (length > maxBytes) throw fail('png_invalid:chunk_limit');
    const type = ascii(bytes, at + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw fail('png_invalid:chunk_type');
    const dataStart = at + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > bytes.length) throw fail('png_invalid:truncated_chunk');
    const actualCrc = bytes.readUInt32BE(dataEnd);
    const covered = bytes.subarray(at + 4, dataEnd);
    if (crc32(covered) !== actualCrc) throw fail('png_invalid:chunk_crc');
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw fail('png_invalid:ihdr');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      if (width === 0 || height === 0 || width > 16384 || height > 16384) throw fail('png_invalid:dimensions');
    }
    if (type === 'IDAT') idat++;
    if (type === 'IEND') {
      if (length !== 0 || crcEnd !== bytes.length) throw fail('png_invalid:iend');
      iend = true;
    } else if (iend) {
      throw fail('png_invalid:trailing_chunk');
    }
    first = false;
    at = crcEnd;
  }
  if (!width || !height || idat === 0 || !iend) throw fail('png_invalid:structure');
  return { width, height, bytes: bytes.length, sha256: sha256(bytes) };
}

async function canonicalDirectory(path, reason) {
  if (!isAbsolute(path ?? '')) throw fail(reason);
  const info = await lstat(path).catch(() => { throw fail(reason); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail(reason);
  const canonical = await realpath(path).catch(() => { throw fail(reason); });
  if (canonical !== resolve(path)) throw fail(reason);
  return canonical;
}

export async function validatePngFile(path, options = {}) {
  if (!isAbsolute(path ?? '')) throw fail('png_capture_unsafe_path');
  const info = await lstat(path).catch(() => { throw fail('png_capture_unsafe_path'); });
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw fail('png_capture_unsafe_file');
  if (await realpath(path) !== path) throw fail('png_capture_unsafe_path');
  if (info.size > (options.maxFileBytes ?? PNG_CAPTURE_LIMITS.maxFileBytes)) throw fail('png_invalid:byte_limit');
  const bytes = await readFile(path);
  if (bytes.length !== info.size) throw fail('png_capture_mutated');
  return { ...validatePngBytes(bytes, { maxBytes: options.maxFileBytes }), data: bytes };
}

// Collect only direct captures/*.png entries from a canonical directory. Any
// symlink or non-regular entry is fail-closed: a capture package must never be
// a path traversal primitive into host files.
export async function collectValidatedPngs(capturesDir, options = {}) {
  const limits = { ...PNG_CAPTURE_LIMITS, ...options };
  const dir = await canonicalDirectory(capturesDir, 'png_capture_dir_invalid');
  const names = (await readdir(dir)).sort();
  const captures = [];
  let totalBytes = 0;
  for (const name of names) {
    if (name !== basename(name) || name.includes('\0')) throw fail('png_capture_unsafe_name');
    const path = join(dir, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw fail('png_capture_unsafe_file');
    if (!name.endsWith('.png')) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.png$/.test(name)) throw fail('png_capture_unsafe_name');
    if (captures.length >= limits.maxFiles) throw fail('png_capture_count_limit');
    const validated = await validatePngFile(path, limits);
    totalBytes += validated.bytes;
    if (totalBytes > limits.maxTotalBytes) throw fail('png_capture_total_limit');
    captures.push({ name, path, ...validated });
  }
  return Object.freeze(captures);
}

function packageDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.file ?? file.name}\0${file.sha256}\0${file.bytes}\0`);
  return hash.digest('hex');
}

// Copy validated PNG bytes into the review snapshot. Names are retained only
// when they are simple basenames; bytes are written read-only and the digest is
// calculated from the validated source bytes before publication.
export async function stageVisualCaptures({ capturesDir, targetDir, limits } = {}) {
  if (!isAbsolute(targetDir ?? '') || targetDir.includes('..')) throw fail('png_capture_target_invalid');
  const files = await collectValidatedPngs(capturesDir, limits);
  const parentInput = resolve(join(targetDir, '..'));
  const parent = await realpath(parentInput);
  if (!isAbsolute(parent) || parent !== parentInput) throw fail('png_capture_target_invalid');
  await mkdir(targetDir, { mode: 0o700 });
  const staged = [];
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.png$/.test(file.name)) throw fail('png_capture_unsafe_name');
    const target = join(targetDir, file.name);
    await writeFile(target, file.data, { mode: 0o400, flag: 'wx' });
    staged.push(Object.freeze({ file: `captures/${file.name}`, sha256: file.sha256,
      bytes: file.bytes, width: file.width, height: file.height }));
  }
  return Object.freeze({ files: Object.freeze(staged), count: staged.length,
    totalBytes: staged.reduce((sum, file) => sum + file.bytes, 0), digest: packageDigest(staged) });
}

// Defense in depth at the model transport boundary: after publication, a
// captures/ directory may contain only the same constrained PNG package form.
export async function assertPackagedCaptures(snapshotDir, options = {}) {
  const dir = join(snapshotDir, 'captures');
  const present = await lstat(dir).then(() => true, cause => {
    if (cause?.code === 'ENOENT') return false;
    throw cause;
  });
  if (!present) return { present: false, count: 0 };
  const captures = await collectValidatedPngs(dir, options);
  const names = await readdir(dir);
  if (names.some(name => !name.endsWith('.png'))) throw fail('png_capture_unexpected_file');
  if (!captures.length) throw fail('png_capture_missing');
  return { present: true, count: captures.length };
}
