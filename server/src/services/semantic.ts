// Semantic search on the server: passages of every scene with their vectors in SQLite (scene_chunks),
// kept up to date incrementally (only changed passages are sent to the model again), and a brute-force
// cosine search — a novel has a few hundred to a few thousand passages, that takes milliseconds.
import {
  chunkText,
  formatRelated,
  RELATED_K,
  t,
  textHash,
  topPassages,
  type GenerateRequest,
  type ModelRef,
  type RelatedPassage,
} from '@novelmaker/shared';
import { HttpError, newId, type DB } from '../db';
import { fetchEmbeddings } from '../llm/client';
import { getProvider } from '../repo/llm';
import { getAppSettings } from '../repo/settings';
import { loadActs } from './promptdata';

/** Passages sent to the embedding model per request */
const BATCH = 32;

interface SceneInfo {
  id: string;
  location: string;
  text: string;
  hidden: boolean;
}

function scenesOf(db: DB, novelId: string, override?: { id: string; text: string }): SceneInfo[] {
  const out: SceneInfo[] = [];
  let chapterNo = 0;
  for (const act of loadActs(db, novelId, override)) {
    for (const ch of act.chapters) {
      chapterNo++;
      const chTitle = ch.title.trim();
      const chLabel = `${t('Chapter')} ${chapterNo}${chTitle ? `: ${chTitle}` : ''}`;
      ch.scenes.forEach((s, i) => {
        const sTitle = s.title.trim();
        const sLabel = ch.scenes.length > 1 || sTitle ? `, ${t('Scene')} ${i + 1}${sTitle ? `: ${sTitle}` : ''}` : '';
        out.push({ id: s.id, location: chLabel + sLabel, text: s.text, hidden: s.hideFromAI });
      });
    }
  }
  return out;
}

export function embeddingModel(db: DB): ModelRef | null {
  const m = getAppSettings(db).embeddingModel;
  return m?.providerId && m.modelId ? m : null;
}

const modelKey = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

async function embed(db: DB, model: ModelRef, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const provider = getProvider(db, model.providerId);
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const vecs = await fetchEmbeddings(provider, model.modelId, texts.slice(i, i + BATCH), signal);
    for (const v of vecs) out.push(Float32Array.from(v));
  }
  return out;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export interface IndexStats {
  scenes: number;
  passages: number;
  embedded: number;
  removed: number;
}

/** One indexing run per novel at a time; a second caller waits for the running one. */
const running = new Map<string, Promise<IndexStats>>();

/**
 * Brings the novel's passages up to date: cuts every scene, embeds passages that are new or changed
 * (or were embedded with another model), removes the rest. Scenes hidden from the AI are left out.
 * `override` = unsaved text of the scene open in the editor.
 */
export function indexNovel(db: DB, novelId: string, override?: { id: string; text: string }, signal?: AbortSignal): Promise<IndexStats> {
  const busy = running.get(novelId);
  if (busy) return busy;
  const job = doIndex(db, novelId, override, signal).finally(() => running.delete(novelId));
  running.set(novelId, job);
  return job;
}

async function doIndex(db: DB, novelId: string, override: { id: string; text: string } | undefined, signal?: AbortSignal): Promise<IndexStats> {
  const model = embeddingModel(db);
  if (!model) throw new HttpError(400, t('Semantic search is off: choose an embedding model in Settings.'));
  const key = modelKey(model);
  type Row = { id: string; scene_id: string; hash: string; model: string };
  const existing = db.prepare('SELECT id, scene_id, hash, model FROM scene_chunks WHERE novel_id = ?').all(novelId) as Row[];
  const keep = new Set<string>();
  const byScene = new Map<string, Map<string, Row>>();
  for (const r of existing) {
    if (r.model !== key) continue;
    if (!byScene.has(r.scene_id)) byScene.set(r.scene_id, new Map());
    byScene.get(r.scene_id)!.set(r.hash, r);
  }
  const todo: { sceneId: string; idx: number; hash: string; text: string }[] = [];
  let passages = 0;
  const scenes = scenesOf(db, novelId, override);
  for (const s of scenes) {
    if (s.hidden) continue;
    const have = byScene.get(s.id);
    chunkText(s.text).forEach((text, idx) => {
      passages++;
      const hash = textHash(text);
      const row = have?.get(hash);
      if (row && !keep.has(row.id)) keep.add(row.id);
      else todo.push({ sceneId: s.id, idx, hash, text });
    });
  }
  const vectors = todo.length ? await embed(db, model, todo.map((x) => x.text), signal) : [];
  const stale = existing.filter((r) => !keep.has(r.id)).map((r) => r.id);
  const ins = db.prepare('INSERT INTO scene_chunks (id, novel_id, scene_id, idx, hash, text, model, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const del = db.prepare('DELETE FROM scene_chunks WHERE id = ?');
  db.transaction(() => {
    for (const id of stale) del.run(id);
    todo.forEach((x, i) => ins.run(newId(), novelId, x.sceneId, x.idx, x.hash, x.text, key, toBlob(vectors[i])));
  })();
  return { scenes: scenes.filter((s) => !s.hidden).length, passages, embedded: todo.length, removed: stale.length };
}

export function indexStatus(db: DB, novelId: string) {
  const model = embeddingModel(db);
  const r = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT scene_id) AS s FROM scene_chunks WHERE novel_id = ? AND model = ?').get(novelId, model ? modelKey(model) : '') as { n: number; s: number };
  return { model, passages: r.n, scenes: r.s };
}

/**
 * Passages of other scenes that mean something similar to `text`. The text is cut like a scene, every
 * piece is a query, and each candidate keeps its best score. Indexes first (incremental).
 */
export async function searchNovel(
  db: DB,
  novelId: string,
  text: string,
  opts: { k?: number; minScore?: number; excludeSceneIds?: string[]; override?: { id: string; text: string }; signal?: AbortSignal } = {},
): Promise<RelatedPassage[]> {
  const model = embeddingModel(db);
  if (!model) throw new HttpError(400, t('Semantic search is off: choose an embedding model in Settings.'));
  const queries = chunkText(text).slice(0, 24);
  if (!queries.length) return [];
  await indexNovel(db, novelId, opts.override, opts.signal);
  const exclude = new Set(opts.excludeSceneIds ?? []);
  type Row = { id: string; scene_id: string; text: string; vector: Buffer };
  const rows = (db.prepare('SELECT id, scene_id, text, vector FROM scene_chunks WHERE novel_id = ? AND model = ?').all(novelId, modelKey(model)) as Row[]).filter(
    (r) => !exclude.has(r.scene_id),
  );
  if (!rows.length) return [];
  const qv = await embed(db, model, queries, opts.signal);
  const candidates = rows.map((r) => ({ id: r.id, sceneId: r.scene_id, text: r.text, vector: fromBlob(r.vector) }));
  const best = topPassages(qv, candidates, opts.k ?? RELATED_K, opts.minScore);
  const where = new Map(scenesOf(db, novelId).map((s) => [s.id, s.location]));
  return best.map(({ item, score }) => ({ sceneId: item.sceneId, location: where.get(item.sceneId) ?? '', text: item.text, score: Math.round(score * 1000) / 1000 }));
}

/** Does this request's prompt ask for related passages? (only then is the embedding model called) */
const usesRelated = (messages: { text: string }[]) => messages.some((m) => /relatedPassages/.test(m.text));

/**
 * Related passages for a generation request, as prompt text. Empty when the prompt does not use them;
 * a note instead of an error when semantic search is off or the model cannot be reached.
 */
export async function relatedForRequest(
  db: DB,
  req: GenerateRequest,
  messages: { text: string }[],
  signal?: AbortSignal,
): Promise<{ text: string; count: number; note: string | null }> {
  if (!usesRelated(messages)) return { text: '', count: 0, note: null };
  if (!embeddingModel(db)) return { text: '', count: 0, note: t('Related passages: semantic search is off (Settings → Semantic search).') };
  const query = (req.selection?.trim() || req.message?.trim() || (req.textBefore ?? '').split(/\s+/).slice(-300).join(' ')).trim();
  if (!query) return { text: '', count: 0, note: null };
  try {
    const found = await searchNovel(db, req.novelId, query, {
      excludeSceneIds: req.sceneId ? [req.sceneId] : [],
      override: req.sceneId && req.sceneText != null ? { id: req.sceneId, text: req.sceneText } : undefined,
      signal,
    });
    return { text: formatRelated(found), count: found.length, note: null };
  } catch (e) {
    return { text: '', count: 0, note: t('Related passages left out: {error}', { error: (e as Error).message }) };
  }
}
