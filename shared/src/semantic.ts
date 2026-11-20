// Semantic search: the novel is cut into passages, each passage gets a vector from an embedding model
// (OpenAI-compatible /v1/embeddings, e.g. bge-m3 on llama.cpp), and a text finds the passages that mean
// something similar, even with other words. Used for "related passages" in prompts (continuity check)
// and for searching by meaning.
//
// Pure functions here; storage and the model call live on the server (services/semantic.ts).

/** Upper limit of words per passage: about one or two paragraphs, well inside the model's window. */
export const CHUNK_WORDS = 150;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Splits a long paragraph at sentence ends into pieces of at most `max` words (a sentence is never cut). */
function splitParagraph(p: string, max: number): string[] {
  if (words(p) <= max) return [p];
  const sentences = p.match(/[^.!?…]+(?:[.!?…]+["»”’)]*\s*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [p];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && words(cur) + words(s) > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Cuts a scene's plain text into passages: paragraphs are kept whole and joined up to `max` words;
 * a paragraph longer than that is split between sentences. Empty text gives no passages.
 */
export function chunkText(text: string, max = CHUNK_WORDS): string[] {
  const paragraphs = text
    .split(/\n\s*\n|\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((p) => splitParagraph(p, max));
  const out: string[] = [];
  let cur = '';
  for (const p of paragraphs) {
    if (cur && words(cur) + words(p) > max) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

/** Short hash of a passage (FNV-1a), to re-embed only what changed. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface RelatedPassage {
  sceneId: string;
  /** e.g. "Capítulo 3: La boda, Escena 2" */
  location: string;
  text: string;
  score: number;
}

/** Below this similarity a passage is not related (bge-m3, Spanish: related ≈ 0.6–0.7, unrelated ≈ 0.25–0.4). */
export const MIN_SCORE = 0.5;
/** How many related passages go into a prompt. */
export const RELATED_K = 6;

/**
 * Best passages for several query vectors at once (one per piece of the checked text):
 * each candidate keeps its best score, the result is sorted and cut to k.
 */
export function topPassages<T extends { id: string; vector: ArrayLike<number> }>(
  queries: ArrayLike<number>[],
  candidates: T[],
  k = RELATED_K,
  minScore = MIN_SCORE,
): { item: T; score: number }[] {
  const best = new Map<string, { item: T; score: number }>();
  for (const q of queries) {
    for (const c of candidates) {
      const score = cosine(q, c.vector);
      if (score < minScore) continue;
      const prev = best.get(c.id);
      if (!prev || score > prev.score) best.set(c.id, { item: c, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Passages as prompt text, in reading order is not guaranteed: each one says where it comes from. */
export function formatRelated(passages: RelatedPassage[]): string {
  return passages.map((p) => `<passage from="${attr(p.location)}">\n${p.text}\n</passage>`).join('\n\n');
}
