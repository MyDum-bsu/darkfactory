const OWNER_PRECHECK = [
  'Перед продуктовым вопросом сверь утверждённые требования и раздел «Принятые решения» во входной спецификации/поручении.',
  'Если применимое решение однозначно, действуй по нему без повторного вопроса. Новый выбор, конфликт или сомнение не считай согласием.',
  'Используй только выписку по задаче: не ищи приватную базу. Выписка не даёт допуска к расходам, доступу, необратимым действиям или выпуску.',
].join('\n');

// Read-only блок активного среза Owner Decision Ledger (Board #1261): решения
// владельца с digest-пиннингом. Воркер получает выписку, но не может менять
// ledger — сам журнал живёт вне его рабочего дерева.
export function decisionsPromptBlock(slice) {
  if (!slice || typeof slice.digest !== 'string' || !/^[a-f0-9]{64}$/.test(slice.digest) ||
      !Array.isArray(slice.ids)) {
    throw new Error('decision_ledger_slice_invalid');
  }
  // Усечённый срез, из которого не влезла ни одна запись, нельзя маскировать под
  // «нет активных решений» — fail-closed, оператор поднимает maxChars.
  if (slice.truncated === true && slice.ids.length === 0 && slice.total > 0) {
    throw new Error('decision_ledger_slice_truncated');
  }
  const header = `Принятые решения владельца (read-only, срез digest ${slice.digest}):`;
  const body = slice.text || '(нет активных решений)';
  const note = slice.truncated ? `\n(срез усечён: показано ${slice.ids.length} из ${slice.total})` : '';
  return `${header}\n${body}${note}`;
}

export function workerIntakePrompt({ brief, tree, handoffPath, handoff, productQuestions, decisions }) {
  const instructions = [
    brief,
    `\nРабочий путь: ${tree}. Запиши JSON атомарно в ${handoffPath} и заверши ход. Сохрани типы полей: ${JSON.stringify(handoff)}`,
  ];
  if (decisions) instructions.push(decisionsPromptBlock(decisions));
  if (productQuestions) {
    instructions.push(OWNER_PRECHECK,
      'Только для одной оставшейся продуктовой развилки вместо candidate_sha передай question: {"prompt":"один конкретный вопрос","evidence":"короткое обоснование"}. Не вставляй секреты или сырой лог.');
  }
  return [...instructions, 'Другие треды и доски не трогай.', ''].join('\n');
}

export function arbiterIntakePrompt(spec, extra, decisions) {
  return ['Use the following specification; output only an arbitration decision, not a critic verdict.',
    spec, extra, decisions && decisionsPromptBlock(decisions), OWNER_PRECHECK,
    'Выбирай escalate_owner только для оставшейся продуктовой развилки.'].filter(Boolean).join('\n\n');
}
