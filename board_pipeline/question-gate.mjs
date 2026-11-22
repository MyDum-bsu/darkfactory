import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from './subject.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const QUESTION = 'darkfactory.question.v1';
const ANSWER = 'darkfactory.owner-answer.v1';
export const MAX_QUESTION_TTL_MS = 86_400_000;

export function createQuestion({ attempt, kind, principal, ttlMs, now, checkpoint, prompt, evidence }) {
  const { task_id, epoch, attempt_id } = attempt;
  if (!['product', 'release'].includes(kind) || !/^[1-9][0-9]{0,14}$/.test(task_id) ||
      !Number.isSafeInteger(epoch) || epoch < 1 || !/^[a-z0-9-]{1,64}$/.test(attempt_id) ||
      typeof principal !== 'string' || !principal || principal.length > 96 ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_QUESTION_TTL_MS ||
      !Number.isSafeInteger(now) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 260 ||
      typeof evidence !== 'string' || evidence.length > 160 || !SHA.test(checkpoint?.sha ?? '') ||
      !Number.isSafeInteger(checkpoint.turn_seq) || checkpoint.turn_seq < 1 ||
      (kind === 'release' && !DIGEST.test(checkpoint?.subject_digest ?? ''))) {
    throw new Error('Invalid question envelope');
  }
  const question = { schema: QUESTION, question_id: randomUUID(), task_id, epoch, attempt_id, kind,
    respondent: principal, created_at: now, expires_at: now + ttlMs, prompt: prompt.trim(), evidence,
    decisions: [kind === 'product' ? 'resolve' : 'approve', 'decline'], recommend: 'decline',
    ...(kind === 'release' && checkpoint.release ? {
      consequence: 'Deploy; restore previous on red smoke.',
    } : {}),
    checkpoint: { sha: checkpoint.sha, turn_seq: checkpoint.turn_seq,
      ...(kind === 'release' ? { subject_digest: checkpoint.subject_digest,
        ...(checkpoint.release ? { release: checkpoint.release } : {}) } : {}) } };
  questionBlockText(question);
  return question;
}

export function questionBlockText(question) {
  const text = JSON.stringify(question);
  if (text.length > 1000) throw new RangeError('Question exceeds native Board block limit');
  return text;
}

export function answerBytes(question, { decision, answer }) {
  const question_digest = createHash('sha256').update(canonicalJson(question)).digest('hex');
  return Buffer.from(canonicalJson({ schema: ANSWER, question_digest, decision, answer }));
}

export function signedAnswerVerifier({ principal, publicKey }) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || typeof principal !== 'string' || !principal) {
    throw new Error('Owner answers require a pinned Ed25519 public key and principal');
  }
  return (question, reply, now) => {
    if (question?.schema !== QUESTION || question.respondent !== principal ||
        now < question.created_at || now >= question.expires_at ||
        reply === null || typeof reply !== 'object' || Array.isArray(reply)) return null;
    const { decision, answer, signature } = reply;
    if (Object.keys(reply).length !== 3 || typeof answer !== 'string' || answer.length > 512 ||
        typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const resolves = question.kind === 'product' ? decision === 'resolve' && answer.trim() !== ''
      : question.kind === 'release' && decision === 'approve' && answer === '';
    if (!resolves && (decision !== 'decline' || answer !== '')) return null;
    const detached = Buffer.from(signature, 'base64url');
    if (detached.toString('base64url') !== signature ||
        !verify(null, answerBytes(question, { decision, answer }), key, detached)) return null;
    return { principal, decision, answer, signature, verified_at: now };
  };
}

export async function readSignedAnswer(dir, questionId) {
  if (!UUID.test(questionId)) throw new Error('Invalid question ID');
  let file;
  try {
    file = await open(join(dir, `${questionId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
  try {
    const info = await file.stat();
    const { size } = info;
    if (!info.isFile() || size < 1 || size > 8192) return null;
    const bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== size) return null;
    try { return JSON.parse(bytes.toString('utf8', 0, bytesRead)); } catch { return null; }
  } finally {
    await file.close();
  }
}
