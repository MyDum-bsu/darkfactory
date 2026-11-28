// Pure proposal port. An owner-facing caller renders the text and evidence as
// data, not Markdown/commands. Only its authenticated approval handler calls
// approveTaste; neither operation opens or writes an owner-taste file.
import { createHash } from 'node:crypto';

const correction = /^(?:no[,!:. ]|never\b|don['’]t\b|do not\b|stop\b|instead\b|please (?:avoid|stop)\b|avoid\b|prefer\b|нет[,!:. ]|не\s|никогда\s|вместо\s|запрещено\s)|\binstead of\b/iu;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function distillTaste(evidence = []) {
  const sources = new Map(), groups = new Map();
  for (const entry of evidence) {
    if (entry?.kind !== 'owner' || typeof entry.id !== 'string' || !entry.id ||
        typeof entry.quote !== 'string' || !entry.quote.trim()) continue;
    if (sources.has(entry.id) && sources.get(entry.id) !== entry.quote) {
      throw new Error('Conflicting quotes for one owner source');
    }
    sources.set(entry.id, entry.quote);
  }
  for (const [sourceId, quote] of sources) {
    // Conservative extractive rule: never generalize negations, identifiers
    // or instructions embedded in a longer transcript into global taste.
    if (quote.length > 500 || /[\x00-\x1f\x7f]/u.test(quote) || !correction.test(quote.trim())) continue;
    const prose = quote.trim();
    if (!/[\p{L}\p{N}]/u.test(prose.replace(correction, ''))) continue; // 'No!' is not a rule.
    // Fold only a leading prohibition, not identifiers, paths, or negations
    // elsewhere. The displayed rule remains an actual cited quotation.
    const key = prose.replace(/^(?:do not|don['’]t)\s+/iu, 'Do not ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ sourceId, quote });
  }
  return [...groups].filter(([, refs]) => refs.length >= 2).sort(([a], [b]) => compare(a, b))
    .map(([, refs]) => {
      refs.sort((a, b) => compare(a.sourceId, b.sourceId));
      const text = refs[0].quote.trim();
      const id = createHash('sha256').update(JSON.stringify(['owner-taste.md', text, refs])).digest('hex');
      return { id, target: 'owner-taste.md', text, evidence: refs, status: 'pending_owner_approval',
        action: { type: 'approveTaste', candidateId: id } };
    });
}

// Resolve a single owner click against current evidence. A stale approval
// cannot select a new rule, even if only its supporting sources changed.
export function approveTaste(evidence, approvedId) {
  const item = distillTaste(evidence).find(candidate => candidate.id === approvedId);
  if (!item) throw new Error('Unknown or stale taste approval');
  return { target: item.target, candidateId: item.id, text: item.text, status: 'approved' };
}
