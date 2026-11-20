// Grobe Token-Schätzung ohne Tokenizer. Für Deutsch etwas konservativer als die übliche 4-Zeichen-Regel.
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/** Tokens pro Wort (Deutsch, grob) – für die erwartete Antwortlänge aus „Wörter“. */
export const TOKENS_PER_WORD = 1.8;

export function wordsToTokens(words: number): number {
  return Math.round(words * TOKENS_PER_WORD);
}

export function estimateMessagesTokens(messages: { content: string }[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export function formatTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '–';
  if (usd === 0) return '0 $';
  // unter 1 $ einheitlich in Cent, damit Beträge nebeneinander vergleichbar bleiben
  if (usd < 1) {
    const ct = usd * 100;
    return `${ct.toFixed(ct < 0.1 ? 3 : ct < 10 ? 2 : 1)} ¢`;
  }
  return `${usd.toFixed(2)} $`;
}

/** Tokens kept free for the answer when fitting a prompt into the model's context (reasoning models think a lot). */
export const DEFAULT_ANSWER_RESERVE = 8192;

/**
 * Keeps the most recent part of an outline ("## Chapter …" blocks, oldest first) within maxTokens:
 * whole chapters are dropped from the start; if the last one alone is too long, its last paragraphs
 * stay. A "[…]" line marks the cut.
 */
export function keepLatest(text: string, maxTokens: number): { text: string; trimmed: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, trimmed: false };
  const mark = '[…]';
  const budget = maxTokens - estimateTokens(mark) - 2;
  if (budget <= 0) return { text: '', trimmed: true };
  const blocks = text.split(/\n\n(?=#{1,2} )/);
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = estimateTokens(blocks[i]) + 1;
    if (used + t > budget) {
      if (!kept.length) {
        // not even the latest chapter fits: keep its last paragraphs
        const paras = blocks[i].split(/\n\n|\n/);
        const tail: string[] = [];
        let u = 0;
        for (let j = paras.length - 1; j >= 0; j--) {
          const pt = estimateTokens(paras[j]) + 1;
          if (u + pt > budget) break;
          tail.unshift(paras[j]);
          u += pt;
        }
        kept.push(tail.join('\n'));
      }
      break;
    }
    kept.unshift(blocks[i]);
    used += t;
  }
  const body = kept.filter(Boolean).join('\n\n');
  return { text: body ? `${mark}\n\n${body}` : '', trimmed: true };
}
