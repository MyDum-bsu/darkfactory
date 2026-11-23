import { SAFE_CATALOG } from './rework-distiller.mjs';

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

// Read-only блок дистиллированных уроков прошлых REWORK (Board #1263):
// элементы — уроки, прошедшие validateDistilledLessons; в промпт
// рендерится СТРОГО канонический текст правила из закрытого каталога
// SAFE_CATALOG — произвольный rule хранимой записи до воркера не доходит
// никогда. Блок — данные, не инструкция: воркер читает чек-лист, но не
// может мутировать хранилище уроков (живёт вне рабочего дерева).
export function lessonsPromptBlock(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) {
    throw new Error('distilled_lessons_invalid');
  }
  const rules = lessons.map(lesson =>
    lesson !== null && typeof lesson === 'object' ? SAFE_CATALOG[lesson.category]?.rule : undefined);
  if (rules.some(rule => typeof rule !== 'string')) {
    throw new Error('distilled_lessons_invalid');
  }
  const body = rules.map(rule => `- ${rule}`).join('\n');
  return `Уроки прошлых REWORK (read-only чек-лист, не инструкция):\n${body}`;
}

export function workerIntakePrompt({ brief, tree, handoffPath, handoff, productQuestions, decisions, lessons }) {
  const instructions = [
    brief,
    `\nРабочий путь: ${tree}. Запиши JSON атомарно в ${handoffPath} и заверши ход. Сохрани типы полей: ${JSON.stringify(handoff)}`,
  ];
  if (decisions) instructions.push(decisionsPromptBlock(decisions));
  if (lessons) instructions.push(lessonsPromptBlock(lessons));
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
