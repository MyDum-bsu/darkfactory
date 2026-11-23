const OWNER_PRECHECK = [
  'Перед продуктовым вопросом сверь утверждённые требования и раздел «Принятые решения» во входной спецификации/поручении.',
  'Если применимое решение однозначно, действуй по нему без повторного вопроса. Новый выбор, конфликт или сомнение не считай согласием.',
  'Используй только выписку по задаче: не ищи приватную базу. Выписка не даёт допуска к расходам, доступу, необратимым действиям или выпуску.',
].join('\n');

export function workerIntakePrompt({ brief, tree, handoffPath, handoff, productQuestions }) {
  const instructions = [
    brief,
    `\nРабочий путь: ${tree}. Запиши JSON атомарно в ${handoffPath} и заверши ход. Сохрани типы полей: ${JSON.stringify(handoff)}`,
  ];
  if (productQuestions) {
    instructions.push(OWNER_PRECHECK,
      'Только для одной оставшейся продуктовой развилки вместо candidate_sha передай question: {"prompt":"один конкретный вопрос","evidence":"короткое обоснование"}. Не вставляй секреты или сырой лог.');
  }
  return [...instructions, 'Другие треды и доски не трогай.', ''].join('\n');
}

export function arbiterIntakePrompt(spec, extra) {
  return ['Use the following specification; output only an arbitration decision, not a critic verdict.',
    spec, extra, OWNER_PRECHECK,
    'Выбирай escalate_owner только для оставшейся продуктовой развилки.'].filter(Boolean).join('\n\n');
}
