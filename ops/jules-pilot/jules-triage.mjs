// Offline candidate selection only. No GitHub, Jules, git or Board client.
import { readFileSync } from 'node:fs';

// A closed vocabulary (not a classifier for arbitrary issue prose). The only
// variable text in a recipe is an independently enrolled path and a line number.
const recipes = new Map([
  ['Fix a documentation typo', 'docs'],
  ['Clarify a documentation example', 'docs'],
  ['Test the empty input case', 'unit-test'],
  ['Test the single item case', 'unit-test'],
  ['Extract a repeated literal into a local constant', 'isolated-refactor'],
]);
const sensitive = [
  /trustkernel|boardpipeline|opslocal|momlcourse/,
  /secret|credential|password|passwd|token|apikey|privatekey|accesskey|ssh|keyring|dotenv|certificate/,
  /pii|personal(data|info)|personallyidentifiable|email|phone|ssn|socialsecurity|passport|address|birthdate/,
  /auth|rls|rowlevelsecurity|login|signin|session|permission|accesscontrol|rbac|identity|cookie|jwt/,
  /billing|payment|stripe|invoice|creditcard|checkout|subscription|pricing/,
  /deploy|release|terraform|docker|kubernetes|k8s|helm|ansible|cloudformation|workflow|cicd|infrastructure/,
];
function sensitiveName(name) {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return sensitive.some(pattern => pattern.test(compact));
}

function fileKind(path) {
  if (typeof path !== 'string' || path.length > 200 || sensitiveName(path)) return null;
  // Relative ASCII literal files only: no dot segments, hidden files, globs,
  // escapes, alternate separators or arbitrary extensions disguised as docs.
  if (!/^(?:[a-z0-9][a-z0-9_-]*\/)+[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9]+){1,2}$/i.test(path)) return null;
  if (path.startsWith('docs/') && /\/[\w-]+\.md$/.test(path)) return 'docs';
  if (path.startsWith('tests/unit/') && /\.test\.(?:[cm]?js|ts)$/.test(path)) return 'unit-test';
  if (path.startsWith('examples/') && /\/[\w-]+\.(?:[cm]?js|ts)$/.test(path)) return 'isolated-refactor';
  return null;
}

function hasFields(record, keys) {
  return record !== null && typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key));
}
const deny = reason => ({ eligible: false, reason });

export function triageIssue(issue, policy) {
  if (!hasFields(policy, ['repository', 'files']) || typeof policy.repository !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(policy.repository) || sensitiveName(policy.repository) ||
      !Array.isArray(policy.files) || !policy.files.length || !Array.from(policy.files).every(fileKind)) {
    return deny('invalid-enrollment');
  }
  if (!hasFields(issue, ['repository', 'number', 'state', 'title', 'body', 'labels']) ||
      issue.repository !== policy.repository || !Number.isSafeInteger(issue.number) || issue.number < 1 ||
      issue.state !== 'OPEN' || typeof issue.body !== 'string' || !Array.isArray(issue.labels)) {
    return deny('invalid-issue');
  }
  const kind = recipes.get(issue.title);
  if (!kind || !(issue.labels.length === 0 || (issue.labels.length === 1 && issue.labels[0] === kind))) {
    return deny('unsupported-task');
  }
  const match = /^File: ([^\s]+)(?:\nLine: [1-9][0-9]{0,6})?$/.exec(issue.body);
  const path = match?.[1];
  if (fileKind(path) !== kind || !policy.files.includes(path)) return deny('out-of-scope');
  return { eligible: true, kind, path };
}

if (import.meta.main) {
  let result = deny('invalid-input');
  if (process.argv.length === 3) {
    try {
      const policy = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      result = triageIssue(JSON.parse(readFileSync(0, 'utf8')), policy);
    } catch { /* Never print the source document or a parser error containing it. */ }
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.eligible ? 0 : 1;
}
