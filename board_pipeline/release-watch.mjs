import { isReleaseTarget, isVersion, ReleaseDenied, sameVersion } from './release-contract.mjs';
import { releaseEndpoint, releaseReader, RELEASE_INSTANCE, RELEASE_OPERATION } from './release-readback.mjs';
import { canonicalDigest } from './subject.mjs';
import { INTAKE_CHANNEL, isMessageId, RELEASE_CHANNEL, watchBoardEndpoint, watchBoardPort } from './release-watch-board.mjs';
const KEYS = ['boardUrl', 'url', 'releaseTask', 'owner', 'repo', 'target', 'instance'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
const MEDIA_TYPE = /^text\/plain\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i;
const OBSERVED = 'Последнее подтверждение: ';
const SYMPTOM = 'static-artifact-media-type.v1';
const matches = (regex, value) => typeof value === 'string' && regex.test(value);

export function watchPolicy(raw) {
  if (!raw || Object.keys(raw).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(raw, key)) ||
      !isMessageId(raw.releaseTask) ||
      !matches(ID, raw.repo) || !matches(ID, raw.owner) || !isReleaseTarget(raw.target) ||
      !matches(RELEASE_INSTANCE, raw.instance)) throw new ReleaseDenied('watch_policy_invalid');
  let boardPort, sourcePort;
  try {
    boardPort = watchBoardEndpoint(raw.boardUrl);
    sourcePort = releaseEndpoint(raw.url);
  } catch (cause) {
    throw new ReleaseDenied('watch_policy_invalid', { cause });
  }
  if (boardPort === sourcePort) throw new ReleaseDenied('watch_policy_invalid');
  return { ...raw };
}

export function confirmedWatchRelease(root, policy) {
  const task = root?.task;
  if (root?.id !== policy.releaseTask || root.channel !== RELEASE_CHANNEL || root.re !== null || root.deleted !== false ||
      root.labels?.repo_id !== policy.repo || root.labels.finish !== 'deployed' ||
      task?.owner !== policy.owner || task.state !== 'completed' || typeof task.result !== 'string') {
    throw new ReleaseDenied('watch_release_unconfirmed');
  }
  let result;
  try { result = JSON.parse(task.result); }
  catch (cause) { throw new ReleaseDenied('watch_release_unconfirmed', { cause }); }
  if (!isVersion(result) || result.schema !== 'darkfactory.release-receipt.v1' || result.finish !== 'deployed' ||
      result.target !== policy.target || result.task_id !== root.id || result.epoch !== task.epoch ||
      !Number.isSafeInteger(result.epoch) || result.epoch < 1 || !matches(/^[a-z0-9-]{1,64}$/, result.attempt_id) ||
      result.smoke !== 'pass' || result.readback !== result.digest ||
      ![result.promotion, result.target_digest, result.subject_digest, result.approval_digest]
        .every(value => matches(RELEASE_OPERATION, value))) throw new ReleaseDenied('watch_release_unconfirmed');
  return { sha: result.sha, digest: result.digest, operation: result.promotion };
}

function incidentText({ policy, version, fingerprint }, at) {
  return [
    `Инцидент после выпуска: ${policy.repo} / ${policy.target}`,
    `Fingerprint: ${fingerprint}`,
    `Версия: SHA ${version.sha}, digest ${version.digest}, promotion ${version.operation}.`,
    `[Квитанция выпуска #${policy.releaseTask}](${policy.boardUrl}/messages/${policy.releaseTask})`,
    'Симптом: артефакт точной версии возвращён с неверным Content-Type (ожидается text/plain; charset=utf-8).',
    `Воспроизведение: GET ${policy.url}/version; GET ${policy.url}/artifact. Сверить экземпляр ${policy.instance}, версию, digest байтов и Content-Type.`,
    'Вход для разбора лида; не готовая задача и не допуск к выпуску.',
    OBSERVED + at,
  ].join('\n');
}

function checkedIncidentId(message) {
  if (!isMessageId(message?.id) || message.channel !== INTAKE_CHANNEL || message.re !== null ||
      message.deleted !== false || message.noSync !== true) throw new ReleaseDenied('watch_incident_conflict');
  return message.id;
}

async function recordIncident(board, incident) {
  const key = `df-p22-${incident.fingerprint}`;
  const text = incidentText(incident, incident.at);
  const existing = await board.posted(key);
  const message = existing === null ? await board.post(key, text) : existing;
  const id = checkedIncidentId(message);
  if (existing === null && message.text === text && !message.task) return { status: 'recorded', id };
  return reviseIncident(board, id, incident, text);
}

async function reviseIncident(board, id, incident, text) {
  const current = await board.read(id);
  if (checkedIncidentId(current) !== id) throw new ReleaseDenied('watch_incident_conflict');
  if (current.task) return { status: 'in_intake', id };
  const last = typeof current.text === 'string' && /^Последнее подтверждение: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/
    .exec(current.text.split('\n').at(-1));
  if (!last || current.text !== incidentText(incident, last[1]) ||
      !Number.isSafeInteger(current.revision) || current.revision < 1) throw new ReleaseDenied('watch_incident_conflict');
  if (incident.at <= last[1]) return { status: 'unchanged', id };
  await board.edit(id, text, current.revision);
  return { status: 'updated', id };
}

export async function watchReleaseTick(raw, token) {
  const policy = watchPolicy(raw);
  const board = watchBoardPort(policy.boardUrl, token);
  const reader = releaseReader(policy.url);
  const expected = confirmedWatchRelease(await board.read(policy.releaseTask), policy);
  const live = await reader.readBack(policy);
  if (!sameVersion(live, expected) || live.operation !== expected.operation) {
    throw new ReleaseDenied('watch_release_version_changed');
  }
  const { contentType } = await reader.readArtifact(expected, policy.instance);
  if (matches(MEDIA_TYPE, contentType)) return { status: 'healthy', sha: expected.sha };

  const fingerprint = canonicalDigest({ repo: policy.repo, target: policy.target, instance: policy.instance,
    ...expected, symptom: SYMPTOM });
  const incident = { policy, version: expected, fingerprint, at: new Date().toISOString() };
  return { ...(await recordIncident(board, incident)), fingerprint };
}
