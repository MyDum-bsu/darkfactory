import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, appendFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { accept, acceptHeld } from './acceptance.mjs';
import { NEON_ISOLATION } from './review-policy.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_BASE = '0'.repeat(40);

const POLICY = {
  version: '1',
  profiles: {
    default: {
      commands: ['npm test'],
      review: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
    },
  },
};

function makeHandoff(over = {}) {
  return {
    task_id: '129',
    worker_thread_id: 'thr_1',
    base_sha: SHA_BASE,
    candidate_sha: SHA_A,
    worktree: '/tmp/wt',
    check_profile: 'default',
    ...over,
  };
}

function makePorts(over = {}) {
  const calls = { lookup: 0, claim: 0, complete: 0, block: 0, inspect: 0, local: 0, review: 0 };
  const ports = {
    inspect: async (handoff) => {
      calls.inspect++;
      return { head: handoff.candidate_sha, clean: true, baseAncestor: true };
    },
    local: async (handoff) => {
      calls.local++;
      return { sha: handoff.candidate_sha, ok: true, evidence: 'ev.json' };
    },
    tamper: async (handoff) => ({
      ok: true, sha: handoff.candidate_sha, base_sha: handoff.base_sha,
      violations: [], digest: 't'.repeat(64),
    }),
    review: async (handoff) => {
      calls.review++;
      return {
        task: handoff.task_id,
        sha: handoff.candidate_sha,
        actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
        verdict: 'REVIEW_OK',
        checkpoint: 'feed8cab',
      };
    },
    board: {
      lookup: async () => {
        calls.lookup++;
        return { state: 'ready', epoch: 1 };
      },
      claim: async () => {
        calls.claim++;
        return { epoch: 7 };
      },
      complete: async () => {
        calls.complete++;
      },
      block: async () => {
        calls.block++;
      },
    },
    ...over,
  };
  return { ports, calls };
}

const testRoot = await mkdtemp(path.join(tmpdir(), 'board-pipeline-tests-'));
after(() => rm(testRoot, { recursive: true, force: true }));
function tmpJournal() {
  return mkdtemp(path.join(testRoot, 'attempt-'));
}

async function readRunFile(journal) {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(journal);
  assert.equal(files.length, 1);
  return (await readFile(path.join(journal, files[0]), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

test('happy path: зелёная сдача завершает карточку', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'completed');
  assert.equal(res.epoch, 7);
  assert.equal(res.evidence, 'ev.json');
  assert.deepEqual(calls, { lookup: 1, claim: 1, complete: 1, block: 0, inspect: 2, local: 1, review: 1 });
  const entries = await readRunFile(journal);
  const intents = entries.filter((e) => e.kind === 'intent').map((e) => e.phase);
  assert.deepEqual(intents, ['claim', 'inspect', 'local', 'tamper', 'review', 'seal', 'complete']);
});

test('грязный снимок и дрейф SHA не запускают ревью', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.inspect = async () => ({ head: SHA_B, clean: true, baseAncestor: true });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.match(res.reason, /head_mismatch/);
  assert.equal(calls.local, 0);
  assert.equal(calls.review, 0);
  assert.equal(calls.complete, 0);
  assert.equal(calls.block, 1);
});

test('нечистый worktree блокируется', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.inspect = async (h) => ({ head: h.candidate_sha, clean: false, baseAncestor: true });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.reason, 'dirty_worktree');
  assert.equal(calls.local, 0);
  assert.equal(calls.review, 0);
});

test('красные локальные проверки: ревью не запускается, карточка blocked', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.local = async (h) => ({ sha: h.candidate_sha, ok: false, evidence: 'ev.json' });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.reason, 'local_checks_failed');
  assert.equal(calls.review, 0);
  assert.equal(calls.complete, 0);
  assert.equal(calls.block, 1);
});

test('ревью другой модели не принимается', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.review = async (h) => ({
    task: h.task_id,
    sha: h.candidate_sha,
    actual: { provider: 'anthropic', model: 'other', reasoningLevel: 'medium' },
    verdict: 'REVIEW_OK',
    checkpoint: 'feed8cab',
  });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.match(res.reason, /provider_mismatch/);
  assert.equal(calls.complete, 0);
});

test('отрицательный и неподтверждённый review — blocked', async () => {
  for (const mutate of [
    (r) => ({ ...r, verdict: 'REVIEW_BLOCKED' }),
    (r) => ({ ...r, checkpoint: null }),
    (r) => ({ ...r, sha: SHA_B }),
  ]) {
    const journal = await tmpJournal();
    const { ports, calls } = makePorts();
    const orig = ports.review;
    ports.review = async (h, p) => mutate(await orig(h, p));
    const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
    assert.equal(res.outcome, 'blocked');
    assert.equal(calls.complete, 0);
  }
});

test('потерянный claim на complete: uncertain, без повторного complete', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  let completed = 0;
  ports.board.complete = async () => {
    calls.complete++;
    completed++;
    throw new Error('stale epoch');
  };
  let lookups = 0;
  ports.board.lookup = async () => (lookups++ === 0 ? { state: 'ready', epoch: 1 } : { state: 'claimed', epoch: 9 });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'uncertain');
  assert.equal(completed, 1);
  // Повтор не подхватывает потерянный claim и не дёргает эффекты заново.
  const res2 = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res2.outcome, 'uncertain');
  assert.equal(res2.repeated, true);
  assert.equal(calls.complete, 1);
  assert.equal(calls.claim, 1);
});

test('повтор завершённого запуска возвращает тот же исход без эффектов', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const r1 = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(r1.outcome, 'completed');
  const r2 = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(r2.outcome, 'completed');
  assert.equal(r2.repeated, true);
  assert.deepEqual(calls, { lookup: 1, claim: 1, complete: 1, block: 0, inspect: 2, local: 1, review: 1 });
});

test('авария после intent complete: повтор только сверяет, не retry', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  // Первый запуск «падает» — имитируем запись intent без outcome.
  const runFile = path.join(journal, `run-129-${SHA_A}-v1.jsonl`);
  await writeFile(runFile, JSON.stringify({ seq: 0, kind: 'run' }) + '\n');
  await appendFile(runFile, JSON.stringify({ seq: 1, kind: 'intent', phase: 'complete' }) + '\n');
  ports.board.lookup = async () => ({ state: 'claimed', epoch: 3 });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'uncertain');
  assert.equal(res.reason, 'interrupted_run');
  assert.equal(res.phase, 'complete');
  assert.equal(res.board_state, 'claimed');
  assert.equal(calls.claim, 0);
  assert.equal(calls.local, 0);
  assert.equal(calls.complete, 0);
});

test('строгий контракт: лишние поля и shell из сдачи отклоняются', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const res = await accept({
    handoff: makeHandoff({ commands: 'rm -rf /', extra: 'x' }),
    policy: POLICY,
    journal,
    ports,
  });
  assert.equal(res.outcome, 'denied');
  assert.equal(calls.claim, 0);
  const res2 = await accept({
    handoff: makeHandoff({ candidate_sha: 'abc' }),
    policy: POLICY,
    journal,
    ports,
  });
  assert.equal(res2.outcome, 'denied');
  assert.equal(res2.reason, 'candidate_sha_not_full');
});

test('неизвестный профиль и чужое состояние карточки — denied', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  let r = await accept({ handoff: makeHandoff({ check_profile: 'nope' }), policy: POLICY, journal, ports });
  assert.equal(r.outcome, 'denied');
  assert.match(r.reason, /unknown_profile/);
  ports.board.lookup = async () => ({ state: 'completed', epoch: 2 });
  r = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(r.outcome, 'denied');
  assert.match(r.reason, /unexpected_state/);
  assert.equal(calls.claim, 0);
});

test('отсутствующий профиль reviewer не позволяет принять сдачу', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const policy = { version: '1', profiles: { default: {} } };
  const res = await accept({ handoff: makeHandoff(), policy, journal, ports });
  assert.equal(res.outcome, 'denied');
  assert.equal(calls.claim + calls.complete, 0);
});

test('дрейф при ревью блокирует закрытие уже проверенной версии', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const normal = ports.review;
  ports.review = async (...args) => {
    ports.inspect = async () => ({ head: SHA_B, clean: true, baseAncestor: true });
    return normal(...args);
  };
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(calls.complete, 0);
});

test('нет свидетельства от локального runner — blocked', async () => {
  const journal = await tmpJournal();
  const { ports } = makePorts();
  ports.local = async (h) => ({ sha: h.candidate_sha, ok: true, evidence: null });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.reason, 'missing_evidence');
});

test('журнал v1 с JSON null вместо записи run даёт uncertain, не TypeError', async () => {
  const journal = await tmpJournal();
  const { ports } = makePorts();
  const first = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(first.outcome, 'completed');
  const runFile = path.join(journal, `run-129-${SHA_A}-v1.jsonl`);
  const lines = (await readFile(runFile, 'utf8')).split('\n').filter(Boolean);
  await writeFile(runFile, ['null', ...lines.filter((line) => !line.includes('"kind":"run"'))].join('\n') + '\n');
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'uncertain');
  assert.equal(res.reason, 'journal_run_entry_missing');
});

// ── acceptHeld: notes сдачи (P1-5) и восстановление после вытеснения (F-02) ──

const HELD_TASK = '555';
const HELD_REVIEW = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

function heldPolicy() {
  return {
    version: '2',
    profiles: {
      pilot: {
        task: HELD_TASK,
        worker: 'thr_fixture',
        worktree: '/tmp/wt',
        base: SHA_BASE,
        review: { ...HELD_REVIEW },
      },
    },
  };
}

function heldAttempt(over = {}) {
  return {
    attempt_id: 'att-1',
    task_id: HELD_TASK,
    epoch: 1,
    bb_thread_id: 'thr_fixture',
    worktree: '/tmp/wt',
    base_sha: SHA_BASE,
    check_profile: 'pilot',
    finish: 'verified',
    ...over,
  };
}

function heldSubmission(over = {}) {
  return {
    task_id: HELD_TASK,
    epoch: 1,
    attempt_id: 'att-1',
    worker_thread_id: 'thr_fixture',
    candidate_sha: SHA_A,
    ...over,
  };
}

function heldPorts(over = {}) {
  const calls = { inspect: 0, local: 0, review: 0, complete: 0, block: 0, verifyHeld: 0, lookup: 0 };
  const ports = {
    inspect: async (binding) => {
      calls.inspect++;
      return { head: binding.candidate_sha, clean: true, baseAncestor: true };
    },
    local: async (binding) => {
      calls.local++;
      return { sha: binding.candidate_sha, ok: true, evidence: 'checks.json', exit: 0 };
    },
    tamper: async (binding) => ({
      ok: true, sha: binding.candidate_sha, base_sha: binding.base_sha,
      violations: [], digest: 't'.repeat(64),
    }),
    review: async (binding) => {
      calls.review++;
      return {
        task: binding.task_id,
        sha: binding.candidate_sha,
        actual: { ...HELD_REVIEW },
        verdict: 'REVIEW_OK',
        checkpoint: 'feed80ab',
      };
    },
    board: {
      verifyHeld: async (taskId, epoch) => {
        calls.verifyHeld++;
        return { epoch, until: '2026-01-01T00:00:00.000Z' };
      },
      lookup: async () => {
        calls.lookup++;
        return { state: 'claimed', epoch: 1 };
      },
      block: async () => {
        calls.block++;
      },
      complete: async () => {
        calls.complete++;
      },
    },
    ...over,
  };
  return { ports, calls };
}

// Real Git objects for field-policy tests; only Board and gate execution are fake.
async function fieldFixture({ base = {}, candidate = {} } = {}) {
  const worktree = await tmpJournal();
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: worktree, encoding: 'utf8' }).trim();
  const commit = async files => {
    for (const [name, bytes] of Object.entries(files)) {
      const file = path.join(worktree, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    git('add', '.');
    git('commit', '-qm', 'snapshot', '--allow-empty');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const base_sha = await commit(base), candidate_sha = await commit(candidate);
  return async ({ attempt = {}, overrides = {}, profile = {} } = {}) => {
    const journal = await tmpJournal();
    const policy = heldPolicy();
    Object.assign(policy.profiles.pilot, { base: base_sha, worktree }, profile);
    const { ports, calls } = heldPorts(overrides);
    const result = await acceptHeld({ attempt: heldAttempt({ base_sha, worktree, ...attempt }),
      submission: heldSubmission({ candidate_sha }), policy, ports, journal });
    return { result, calls, journal };
  };
}

const FIELD_PROFILE = '.darkfactory/project-profile.yaml';
test('neither candidate profile edits nor a card override can downgrade the brownfield base policy', async () => {
  for (const base of [{}, { [FIELD_PROFILE]: 'field_mode: brownfield' }]) {
    const verify = await fieldFixture({ base, candidate: { [FIELD_PROFILE]: 'field_mode: greenfield' } });
    const strict = await verify();
    assert.equal(strict.result.outcome, 'verified');
    assert.equal(strict.calls.review, 1);
    const denied = await verify({ attempt: { field_mode: 'greenfield' } });
    assert.equal(denied.result.outcome, 'hold');
    assert.equal(denied.result.reason, 'field_mode_downgrade_denied');
    assert.equal(denied.calls.local, 0);
  }
});

test('invalid base profile holds even if the candidate repairs it', async () => {
  const verify = await fieldFixture({ base: { [FIELD_PROFILE]: 'field_mode: [' },
    candidate: { [FIELD_PROFILE]: 'field_mode: greenfield' } });
  const { result, calls } = await verify();
  assert.equal(result.reason, 'project_profile_invalid');
  assert.equal(result.outcome, 'hold');
  assert.equal(calls.local, 0);
});

test('base greenfield uses mandatory secrets-only tamper, preserves L3 and records its capped policy verdict', async () => {
  const bytes = 'field_mode: greenfield\ndefault_plan: api-change\n';
  const verify = await fieldFixture({ base: { [FIELD_PROFILE]: bytes } });
  let scans = 0;
  const overrides = { tamper: async (_binding, profile) => {
    assert.equal(profile.secretsOnly, true);
    scans++;
    return { ok: true };
  } };
  const { result, calls } = await verify({ overrides, profile: { tamper: false } });
  assert.equal(result.outcome, 'verified');
  assert.equal(scans, 1);
  assert.equal(calls.review, 0);
  assert.deepEqual(result.receipt.review, { status: 'PASS', verdict: 'REVIEW_OK', summary: 'greenfield-fast-track',
    checked_invariants: ['greenfield_fast_track', 'secrets_only_tamper'], findings: [], fast_track: true,
    checkpoint: createHash('sha256').update(bytes).digest('hex'), task_plan: 'api-change', field_mode: 'greenfield',
    grade_cap: 'CHECKED', actual: { provider: 'policy', model: 'greenfield-fast-track', reasoningLevel: null } });
  assert.equal((await verify({ overrides: { tamper: async () => ({ ok: false }) } })).result.reason, 'tamper_gate_failed');
  assert.equal((await verify({ attempt: { has_ui: true }, overrides })).result.reason, 'visual_port_missing');
  assert.equal((await verify({ attempt: { task_plan: 'refactor' } })).result.receipt.review.task_plan, 'refactor');
});

test('high blast radius vetoes otherwise eligible auto-approval', async () => {
  const approval = { enabled: true, allowedCategories: ['docs'], maxChangedFiles: 2, maxChangedLines: 5,
    requireGreenL1: true, requireCleanTamper: true, allowPathPatterns: ['**'], denyPathPatterns: [] };
  const verify = await fieldFixture({ base: { '.darkfactory/approval-policy.yaml': JSON.stringify({ version: 1, autoApprove: approval }) },
    candidate: { 'board_pipeline/controller.mjs': '// changed\n' } });
  const { result, calls, journal } = await verify({ attempt: { category: 'docs' } });
  assert.equal(result.outcome, 'verified');
  assert.equal(calls.review, 1);
  assert.ok((await readRunFile(journal)).some(e => e.detail?.auto_approve?.reason === 'auto_approve_high_blast_radius'));
});

test('ratchet records known failures and rejects new or unidentified red tests before L2', async () => {
  const verify = await fieldFixture();
  for (const [output, preexisting] of [['not ok 1 - old', true], ['not ok 1 - old\nnot ok 2 - new', false], ['', false]]) {
    const { result, calls } = await verify({ overrides: {
      local: async b => ({ sha: b.candidate_sha, ok: false, output, evidence: 'checks.log' }),
      baseline: async () => ({ ok: false, failedTests: ['old'] }),
    } });
    assert.equal(result.outcome, preexisting ? 'verified' : 'rework');
    assert.equal(calls.review, preexisting ? 1 : 0);
    if (preexisting) {
      assert.equal(result.receipt.baseline_status, 'preexisting_red');
      assert.deepEqual(result.receipt.preexisting_failures, ['old']);
    } else assert.equal(result.reason, 'local_checks_failed');
  }
});

async function runFiles(journal) {
  return readdir(journal);
}

// Переписывает журнал запуска, оставляя только выбранные записи: имитация
// вытеснения процесса в произвольной точке протокола приёмки.
async function truncateRun(journal, keep) {
  const files = await runFiles(journal);
  assert.equal(files.length, 1);
  const file = path.join(journal, files[0]);
  const entries = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const kept = keep(entries);
  await writeFile(file, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return entries;
}

test('acceptHeld: валидные notes сдачи санитизируются и записываются в квитанцию', async () => {
  const journal = await tmpJournal();
  const { ports } = heldPorts();
  const res = await acceptHeld({
    attempt: heldAttempt(),
    submission: heldSubmission({ notes: ['incidental defect in ops/ seen\nout of scope', '  another\t note  '] }),
    policy: heldPolicy(),
    journal,
    ports,
  });
  assert.equal(res.outcome, 'verified');
  assert.deepEqual(res.receipt.notes, ['incidental defect in ops/ seen out of scope', 'another note']);
  const entries = await readRunFile(journal);
  const outcome = entries.find((e) => e.kind === 'outcome');
  assert.deepEqual(outcome.receipt.notes, ['incidental defect in ops/ seen out of scope', 'another note']);
});

test('acceptHeld: сдача без notes не несёт ключа notes в квитанции', async () => {
  const journal = await tmpJournal();
  const { ports } = heldPorts();
  const res = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal, ports,
  });
  assert.equal(res.outcome, 'verified');
  assert.equal('notes' in res.receipt, false);
});

test('acceptHeld: невалидные notes отклоняются до любого эффекта', async () => {
  for (const notes of [
    'a plain string',
    ['x'.repeat(201)],
    [''],
    Array.from({ length: 11 }, (_, i) => `note ${i}`),
    [42],
  ]) {
    const journal = await tmpJournal();
    const { ports, calls } = heldPorts();
    const res = await acceptHeld({
      attempt: heldAttempt(), submission: heldSubmission({ notes }), policy: heldPolicy(), journal, ports,
    });
    assert.equal(res.outcome, 'denied', JSON.stringify(notes).slice(0, 60));
    assert.equal(res.reason, 'submission_notes_invalid');
    assert.equal(calls.inspect, 0);
    assert.equal(calls.complete + calls.block, 0);
  }
});

test('acceptHeld: невалидный recoverySeq отклоняется до любого эффекта', async () => {
  for (const recoverySeq of [-1, 1.5, NaN, '1']) {
    const journal = await tmpJournal();
    const { ports, calls } = heldPorts();
    const res = await acceptHeld({
      attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal, ports,
      recoverySeq,
    });
    assert.equal(res.outcome, 'denied', String(recoverySeq));
    assert.equal(res.reason, 'invalid_recovery_seq');
    assert.equal(calls.inspect, 0);
  }
});

test('acceptHeld: recoverySeq без прошлых журналов запускает чистую проверку', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = heldPorts();
  const res = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal, ports,
    recoverySeq: 3,
  });
  assert.equal(res.outcome, 'verified');
  assert.equal(calls.complete, 1);
});

test('acceptHeld: терминальный исход базового журнала переиспользуется при восстановлении', async () => {
  const journal = await tmpJournal();
  const first = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal,
    ports: heldPorts().ports,
  });
  assert.equal(first.outcome, 'verified');
  // Восстановление после вытеснения: исход уже записан — ни один порт не дёргается.
  const { ports, calls } = heldPorts();
  const replay = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal, ports,
    recoverySeq: 1,
  });
  assert.equal(replay.outcome, 'verified');
  assert.equal(replay.repeated, true);
  assert.equal(replay.run, first.run);
  assert.equal(calls.inspect, 0);
  assert.equal(calls.local, 0);
  assert.equal(calls.review, 0);
  assert.equal(calls.complete + calls.block, 0);
});

test('acceptHeld: прерванная проверка перепроверяется под свежим ключом журнала', async t => {
  const journal = await tmpJournal();
  const first = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal,
    ports: heldPorts().ports,
  });
  assert.equal(first.outcome, 'verified');
  // Вытеснение Spot VM до ревью: журнал обрывается на pre-effect записях,
  // ни исхода, ни эффекта Board — та же картина, что у прерванного checking.
  await truncateRun(journal, (entries) => entries.filter((entry) =>
    entry.kind === 'run' ||
    (entry.kind === 'intent' && ['verify_claim', 'inspect', 'local', 'tamper'].includes(entry.phase)) ||
    (entry.kind === 'result' && ['verify_claim', 'inspect', 'local', 'tamper'].includes(entry.phase))));
  const { ports, calls } = heldPorts();
  const recovered = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal, ports,
    recoverySeq: 1,
  });
  assert.equal(recovered.outcome, 'verified');
  assert.notEqual(recovered.run, first.run, 'свежий ключ журнала отличается от вытесненного');
  assert.equal(calls.complete, 1, 'проверка перепроведена до конца, а не uncertain');
  assert.equal((await runFiles(journal)).length, 2, 'два журнала: прерванный и восстановленный');
  // Повтор того же recoverySeq идемпотентен: терминальный исход восстановленного
  // журнала возвращается без единого вызова портов.
  const again = heldPorts();
  const replay = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal,
    ports: again.ports, recoverySeq: 1,
  });
  assert.equal(replay.outcome, 'verified');
  assert.equal(replay.repeated, true);
  assert.equal(again.calls.inspect, 0);
  assert.equal(again.calls.complete + again.calls.block, 0);
});

test('acceptHeld: журнал с осевшим эффектом Board не перепроверяется вслепую', async () => {
  const journal = await tmpJournal();
  const first = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal,
    ports: heldPorts().ports,
  });
  assert.equal(first.outcome, 'verified');
  // Вытеснение между подтверждённым complete и записью исхода: эффект Board
  // осел, но терминальной записи нет — повторная проверка была бы вторым эффектом.
  await truncateRun(journal, (entries) => entries.filter((entry) =>
    entry.kind !== 'outcome' &&
    !(entry.kind === 'result' && entry.phase === 'complete' && entry.ok === false)));
  const { ports, calls } = heldPorts();
  const res = await acceptHeld({
    attempt: heldAttempt(), submission: heldSubmission(), policy: heldPolicy(), journal, ports,
    recoverySeq: 1,
  });
  assert.equal(res.outcome, 'uncertain');
  assert.equal(res.reason, 'interrupted_run');
  assert.equal(res.repeated, true);
  assert.equal(res.run, first.run);
  assert.equal(calls.inspect, 0);
  assert.equal(calls.complete + calls.block, 0);
  assert.equal((await runFiles(journal)).length, 1, 'свежий журнал не создаётся');
});

// ── Board #11994: OpenAI/Astra-воркер + Neon-критик + Opus-арбитр ──────────
// Триада pi+openai/gpt-6.2-astra (openai) / gemini-4-neon (google) /
// agy/claude-opus-5.5 (anthropic) — три независимых известных семейства;
// Opus — утверждённый арбитр Neon-маршрута наряду с Sol.
const NEON_REVIEW = { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' };
const OPUS_ARBITER = { provider: 'agy', model: 'claude-opus-5.5', reasoningLevel: 'medium' };
const PI_ASTRA_WORKER = { provider: 'pi', model: 'openai/gpt-6.2-astra' };
const NEON_TREE = 'c'.repeat(40);
const NEON_SPEC_DIGEST = '1'.repeat(64);
const NEON_POLICY_DIGEST = '2'.repeat(64);

function neonPolicy() {
  return {
    version: '2',
    profiles: {
      pilot: {
        task: HELD_TASK,
        worker: 'thr_fixture',
        worktree: '/tmp/wt',
        base: SHA_BASE,
        review: { ...NEON_REVIEW, skills: ['logika'] },
        arbiter: { ...OPUS_ARBITER },
      },
    },
  };
}

function neonAttempt(over = {}) {
  return heldAttempt({
    repo_id: 'repo-neon',
    spec_digest: NEON_SPEC_DIGEST,
    policy_digest: NEON_POLICY_DIGEST,
    executor: { ...PI_ASTRA_WORKER },
    arbiter: { ...OPUS_ARBITER },
    triad: {
      worker: { ...PI_ASTRA_WORKER },
      critic: { ...NEON_REVIEW },
      arbiter: { ...OPUS_ARBITER },
    },
    ...over,
  });
}

function neonPorts(journal, { blocked = false } = {}) {
  const calls = { inspect: 0, local: 0, review: 0, complete: 0, block: 0, verifyHeld: 0, labels: 0 };
  const ports = {
    inspect: async (binding) => {
      calls.inspect++;
      return { head: binding.candidate_sha, clean: true, baseAncestor: true, tree_sha: NEON_TREE };
    },
    local: async (binding) => {
      calls.local++;
      return { sha: binding.candidate_sha, ok: true, evidence: 'checks.json', exit: 0 };
    },
    tamper: async (binding) => ({
      ok: true, sha: binding.candidate_sha, base_sha: binding.base_sha,
      violations: [], digest: 't'.repeat(64),
    }),
    review: async (binding) => {
      calls.review++;
      const verdict = blocked ? 'REVIEW_BLOCKED' : 'REVIEW_OK';
      const transcript = JSON.stringify({ verdict, sha: binding.candidate_sha });
      await writeFile(path.join(journal, 'neon-l2.json'), transcript, { mode: 0o600 });
      return {
        task: binding.task_id,
        sha: binding.candidate_sha,
        actual: { ...NEON_REVIEW },
        verdict,
        checkpoint: 'feed80ab',
        isolation: NEON_ISOLATION,
        transcript_file: 'neon-l2.json',
        transcript_sha256: createHash('sha256').update(transcript).digest('hex'),
        subject_digest: binding.subject_digest,
        ...(blocked
          ? { findings: [{ file: 'a.js', line: 3, expected: 'spec', actual: 'impl', freq: 1 }] }
          : {}),
      };
    },
    board: {
      verifyHeld: async (taskId, epoch) => {
        calls.verifyHeld++;
        return { epoch, until: '2026-01-01T00:00:00.000Z' };
      },
      lookup: async () => ({ state: 'claimed', epoch: 1 }),
      labels: async () => {
        calls.labels++;
        return {
          repo_id: 'repo-neon',
          profile_id: 'pilot',
          finish: 'verified',
          spec_digest: NEON_SPEC_DIGEST,
          policy_digest: NEON_POLICY_DIGEST,
        };
      },
      block: async () => {
        calls.block++;
      },
      complete: async () => {
        calls.complete++;
      },
    },
  };
  return { ports, calls };
}

test('acceptHeld: OpenAI/Astra-воркер + Neon-критик + Opus-арбитр проходит приёмку (#11994)', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = neonPorts(journal);
  const res = await acceptHeld({
    attempt: neonAttempt(),
    submission: heldSubmission(),
    policy: neonPolicy(),
    journal,
    ports,
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  assert.equal(res.receipt.settle, 'completed');
  assert.equal(calls.review, 1);
  assert.equal(calls.complete, 1);
  assert.equal(calls.block, 0);
  // Повторный вызов идемпотентен: терминальный исход переиспользуется без эффектов.
  const replay = await acceptHeld({
    attempt: neonAttempt(),
    submission: heldSubmission(),
    policy: neonPolicy(),
    journal,
    ports: neonPorts(journal).ports,
  });
  assert.equal(replay.outcome, 'verified');
  assert.equal(replay.repeated, true);
});

test('acceptHeld: неутверждённый арбитр Neon-маршрута отклоняется fail-closed (#11994)', async () => {
  for (const arbiter of [
    { provider: 'deepseek', model: 'deepseek-v4', reasoningLevel: 'medium' }, // не Sol и не Opus
    { provider: 'agy', model: 'claude-opus-5.5' }, // Opus без reasoningLevel
    { provider: 'agy', model: 'claude-opus-5.5', reasoningLevel: 'low' }, // недопустимый уровень
    { provider: 'pi', model: 'agy/claude-opus-5.5', reasoningLevel: 'medium' }, // Opus вне agy
  ]) {
    const journal = await tmpJournal();
    const { ports, calls } = neonPorts(journal);
    const res = await acceptHeld({
      attempt: neonAttempt({
        arbiter: { ...arbiter },
        triad: { worker: { ...PI_ASTRA_WORKER }, critic: { ...NEON_REVIEW }, arbiter: { ...arbiter } },
      }),
      submission: heldSubmission(),
      policy: neonPolicy(),
      journal,
      ports,
    });
    assert.equal(res.outcome, 'denied', JSON.stringify(arbiter));
    assert.equal(res.reason, 'vs2_review_triad_not_approved', JSON.stringify(arbiter));
    assert.equal(calls.inspect, 0, 'отказ до любого порта приёмки');
    assert.equal(calls.complete + calls.block, 0);
  }
});

test('acceptHeld: Sol-арбитр с OpenAI-воркером отклоняется строгой триадой (#11994)', async () => {
  // Sol (openai) формально утверждён для Neon-маршрута, но семейство совпадает
  // с исполнителем pi+openai/gpt-6.2-astra: assertTriadIndependent не ослабляется.
  const sol = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
  const journal = await tmpJournal();
  const { ports, calls } = neonPorts(journal);
  const res = await acceptHeld({
    attempt: neonAttempt({
      arbiter: sol,
      triad: { worker: { ...PI_ASTRA_WORKER }, critic: { ...NEON_REVIEW }, arbiter: sol },
    }),
    submission: heldSubmission(),
    policy: neonPolicy(),
    journal,
    ports,
  });
  assert.equal(res.outcome, 'denied');
  assert.equal(res.reason, 'invalid_triad:arbiter_family_not_independent');
  assert.equal(calls.inspect, 0);
  // Контроль: тот же Sol-арбитр с cognition-воркером — строгая триада, допуск
  // сохраняется (прежний маршрут не сломан допуском Opus).
  const devin = { provider: 'acp-devin', model: 'swe-2-1-medium' };
  const controlJournal = await tmpJournal();
  const control = neonPorts(controlJournal);
  const ok = await acceptHeld({
    attempt: neonAttempt({
      executor: devin,
      arbiter: sol,
      triad: { worker: devin, critic: { ...NEON_REVIEW }, arbiter: sol },
    }),
    submission: heldSubmission(),
    policy: neonPolicy(),
    journal: controlJournal,
    ports: control.ports,
  });
  assert.equal(ok.outcome, 'verified', ok.reason ?? '');
});

test('acceptHeld sealAndComplete: квитанция Opus-арбитра принимает Neon-ревью (#11994)', async () => {
  const journal = await tmpJournal();
  const { ports } = neonPorts(journal, { blocked: true });
  const res = await acceptHeld({
    attempt: neonAttempt(),
    submission: heldSubmission(),
    policy: neonPolicy(),
    journal,
    ports,
  });
  assert.equal(res.outcome, 'rework', res.reason ?? '');
  assert.equal(typeof res.sealAndComplete, 'function');
  const sealed = await res.sealAndComplete({
    decision: 'accept_with_notes',
    notes: 'единственная находка — P2 вне scope, принято арбитром',
    max_harm: 1,
    dod_violation: false,
    subject_digest: res.subject_digest,
    arbiter: { provider: 'agy', model: 'claude-opus-5.5', reasoningLevel: 'medium' },
  });
  assert.equal(sealed.outcome, 'verified', sealed.reason ?? '');
  assert.equal(sealed.receipt.settle, 'completed');
});

test('acceptHeld sealAndComplete: неаттестованный арбитр квитанции отклоняется fail-closed (#11994)', async () => {
  for (const arbiter of [
    // Provider/model совпадают с пином Opus, но нет reasoningLevel — аттестации нет.
    { provider: 'agy', model: 'claude-opus-5.5' },
    // Недопустимый уровень reasoning — та же форма обхода.
    { provider: 'agy', model: 'claude-opus-5.5', reasoningLevel: 'low' },
  ]) {
    const journal = await tmpJournal();
    const { ports } = neonPorts(journal, { blocked: true });
    const res = await acceptHeld({
      attempt: neonAttempt(),
      submission: heldSubmission(),
      policy: neonPolicy(),
      journal,
      ports,
    });
    assert.equal(res.outcome, 'rework', res.reason ?? '');
    const sealed = await res.sealAndComplete({
      decision: 'accept_with_notes',
      notes: 'принято арбитром',
      max_harm: 1,
      dod_violation: false,
      subject_digest: res.subject_digest,
      arbiter,
    });
    assert.equal(sealed.outcome, 'hold', JSON.stringify(arbiter));
    assert.equal(sealed.reason, 'arbiter_mismatch', JSON.stringify(arbiter));
  }
});
