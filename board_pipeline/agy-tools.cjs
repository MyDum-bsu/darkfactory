'use strict';

const { realpathSync } = require('node:fs');
const { isAbsolute, relative, resolve, sep } = require('node:path');

const schemas = new Map([
  ['view_file', ['AbsolutePath', 'StartLine', 'EndLine', 'IsSkillFile']],
  ['read_file', ['Path', 'StartLine', 'EndLine', 'Offset', 'Limit']],
  ['grep_search', ['SearchPath', 'Query', 'IsRegex', 'CaseInsensitive', 'Includes', 'MatchPerLine']],
  ['grep', ['path', 'query', 'pattern', 'includes']],
  ['find_by_name', ['SearchDirectory', 'Pattern', 'Type', 'Excludes', 'Extensions', 'FullPath', 'MaxDepth']],
  ['find', ['path', 'pattern']],
  ['list_dir', ['DirectoryPath']],
  ['ls', ['path']],
  ['glob', ['path', 'pattern']],
]);
const forbidden = () => Object.assign(new Error('review_tool_use_forbidden'), { reason: 'review_tool_use_forbidden' });

const within = (root, target) => target === root || target.startsWith(`${root}${sep}`);

function checkedPath(root, request) {
  if (typeof request !== 'string' || !request || /[\0\r\n]/.test(request)) throw forbidden();
  const path = resolve(root, request);
  // Check both the spelling and the actual target; neither an escaping path
  // nor a symlink to another part of the host is a snapshot tool input.
  if (!within(root, path) || !within(root, realpathSync(path))) throw forbidden();
  return relative(root, path) || '.';
}

function safePattern(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !value.startsWith('-') && !isAbsolute(value) && !/[\0\r\n\\]/.test(value) && !value.split('/').includes('..');
}

function safeArgument(key, value) {
  if (key === 'Offset') return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  if (['StartLine', 'EndLine', 'Limit', 'MaxDepth'].includes(key)) {
    return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
  }
  if (key === 'IsSkillFile') return value === false;
  if (['IsRegex', 'CaseInsensitive', 'MatchPerLine', 'FullPath'].includes(key)) return typeof value === 'boolean';
  if (['Includes', 'Excludes', 'Extensions', 'includes'].includes(key)) {
    return Array.isArray(value) && value.length <= 20 && value.every(safePattern);
  }
  if (key === 'Type') return ['file', 'directory', 'any'].includes(value);
  if (['Query', 'query'].includes(key)) return typeof value === 'string' && value.length <= 4096 && !value.includes('\0');
  return safePattern(value);
}

function checkSnapshotTool(root, name, args) {
  const keys = schemas.get(name);
  if (!keys || !args || typeof args !== 'object' || Array.isArray(args) ||
      !Object.hasOwn(args, keys[0]) || Object.keys(args).some(key => !keys.includes(key))) throw forbidden();
  let path;
  try { path = checkedPath(root, args[keys[0]]); }
  catch { throw forbidden(); }
  for (const key of keys.slice(1)) {
    if (Object.hasOwn(args, key) && !safeArgument(key, args[key])) throw forbidden();
  }
  return { name, path };
}

module.exports = { checkSnapshotTool, isSnapshotTool: name => schemas.has(name) };
