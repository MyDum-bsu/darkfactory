// Read-only сверка исхода spawn/feedback с фактическим состоянием BB через
// `bb thread list/show/log --json`. Пустая выдача сама по себе НЕ доказывает
// отсутствие эффекта — статусы честно различают empty/ambiguous; ни одна из
// функций не отправляет второй spawn или tell.
//
// Реальная схема CLI:
//   bb thread list --project <id> --json  → массив (или { threads: [...] });
//     элемент может нести environmentPath, иначе путь окружения берётся из
//     bb thread show <id> --json → snapshot.environment?.path.
//   bb thread log <id> --json             → события; ход/сообщение — это
//     e.type === 'client/turn/requested', текст в e.data.input[{type:'text',text}].

const THREAD_ID = /^thr_[a-z0-9]+$/;

const events = stdout => {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.events) ? parsed.events : []);
};

const threadList = stdout => {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.threads) ? parsed.threads : []);
};

// Текстовые части входа хода: именно сюда `bb thread spawn --prompt-file` и
// `bb thread tell --message-file` кладут тело сообщения.
const turnTexts = event => {
  if (event?.type !== 'client/turn/requested') return [];
  const input = event?.data?.input;
  if (!Array.isArray(input)) return [];
  return input.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text);
};

// Ровно один тред в environment `tree`, чей первый ход несёт точный маркер
// `attemptId` и путь хендоффа `handoffFile`, — matched. 0 → empty, >1 →
// ambiguous. Пустой список BB — честный empty (урок Шимы/Iva: это не
// доказательство отсутствия писателя, решение принимает контроллер).
export async function reconcileSpawnFromBb({ execBb, project, tree, attemptId, handoffFile }) {
  const args = ['thread', 'list', '--json'];
  if (typeof project === 'string' && project) args.push('--project', project);
  const listed = await execBb(args, { timeout: 30_000 });
  const matched = [];
  for (const item of threadList(listed.stdout)) {
    if (!THREAD_ID.test(item?.id ?? '')) continue;
    let envPath = item.environmentPath;
    if (envPath === undefined) {
      const show = await execBb(['thread', 'show', item.id, '--json'], { timeout: 15_000 });
      envPath = JSON.parse(show.stdout)?.environment?.path;
    }
    if (envPath !== tree) continue;
    const log = await execBb(['thread', 'log', item.id, '--limit', '20', '--json'],
      { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    // Только стартовое событие запуска: seq 1 от source spawn. Поздняя цитата
    // промпта с теми же маркерами в чужом/старом треде — не наш тред.
    const hit = events(log.stdout).some(event =>
      event?.seq === 1 && (event?.data?.source === undefined || event?.data?.source === 'spawn') &&
      turnTexts(event).some(text => text.includes(attemptId) && text.includes(handoffFile)));
    if (hit) matched.push(item.id);
  }
  if (matched.length === 1) return { status: 'matched', threadId: matched[0] };
  return { status: matched.length === 0 ? 'empty' : 'ambiguous' };
}

// Ровно одно сообщение `Замечание фабрики ${feedbackId}.` в журнале треда —
// delivered; 0 → empty, >1 → ambiguous. `bb thread log --limit N` читает
// ПЕРВЫЕ N событий — журнал после известного хода читается через --after-seq,
// иначе целиком через --all.
export async function reconcileFeedbackFromBb({ execBb, threadId, feedbackId, afterSeq }) {
  if (!THREAD_ID.test(threadId ?? '') || typeof feedbackId !== 'string' || !feedbackId) {
    return { status: 'ambiguous' };
  }
  // --after-seq без --all отдаёт лишь первую страницу (100 событий по
  // умолчанию): --all обязателен, чтобы событие 101+ после afterSeq читалось.
  const args = ['thread', 'log', threadId];
  if (Number.isSafeInteger(afterSeq) && afterSeq > 0) args.push('--after-seq', String(afterSeq));
  args.push('--all', '--json');
  const log = await execBb(args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  const header = `Замечание фабрики ${feedbackId}.`;
  const hits = events(log.stdout).filter(event =>
    (event?.data?.source === undefined || event?.data?.source === 'tell') &&
    turnTexts(event).some(text => text.includes(header)));
  if (hits.length === 1) return { status: 'delivered' };
  return { status: hits.length === 0 ? 'empty' : 'ambiguous' };
}
