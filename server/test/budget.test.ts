// Fitting prompts into the model's context window: the story so far keeps the latest chapters.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDb, type DB } from '../src/db';
import { seedBuiltins } from '../src/repo/prompts';
import { updateAppSettings } from '../src/repo/settings';
import { estimateMessagesTokens, type Novel, type Outline, type Prompt, type RelatedPassage } from '@novelmaker/shared';
import { fitPrompt } from '../src/services/budget';

let db: DB;
let app: FastifyInstance;
async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method: method as any, url, payload: body as any });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

beforeAll(async () => {
  db = openDb(':memory:');
  updateAppSettings(db, { language: 'es' });
  seedBuiltins(db);
  app = await buildApp(db, { serveWeb: false });
});
afterAll(async () => {
  await app.close();
  db.close();
});

describe('context budget', () => {
  let novel: Novel;
  let lastScene = '';
  let providerId = '';
  let beat: Prompt;

  it('setup: 12 chapters with long summaries, a model with a small context', async () => {
    novel = await api<Novel>('POST', '/api/novels', { title: 'Larga', language: 'Spanish' });
    const outline = await api<Outline>('GET', `/api/novels/${novel.id}/outline`);
    const act = outline.acts[0].id;
    for (let i = 1; i <= 12; i++) {
      const ch = i === 1 ? outline.acts[0].chapters[0] : await api('POST', '/api/chapters', { actId: act, title: `C${i}` });
      const o = await api<Outline>('GET', `/api/novels/${novel.id}/outline`);
      const sceneId = o.acts[0].chapters.find((c) => c.id === ch.id)!.scenes[0].id;
      await api('PATCH', `/api/scenes/${sceneId}`, { summary: `Resumen del capítulo ${i}. ${'Pasan muchas cosas importantes. '.repeat(130)}` });
      lastScene = sceneId;
    }
    providerId = (await api('POST', '/api/providers', { name: 'local', kind: 'custom', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' })).id;
    db.prepare('UPDATE providers SET models = ? WHERE id = ?').run(JSON.stringify([{ id: 'm', contextLength: 10_000 }]), providerId);
    beat = (await api<Prompt[]>('GET', '/api/prompts')).find((p) => p.builtinKey === 'beat')!;
  });

  const preview = (model?: { providerId: string; modelId: string }) =>
    api('POST', '/api/preview', { kind: 'beat', promptId: beat.id, novelId: novel.id, sceneId: lastScene, message: 'Algo pasa.', textBefore: '', textAfter: '', model });

  it('without a model nothing is trimmed', async () => {
    const r = await preview();
    const all = r.messages.map((m: any) => m.content).join('\n');
    expect(all).toContain('Resumen del capítulo 1.');
    expect(r.tokens).toBeGreaterThan(10_000 - 8192);
  });

  it('with a 10K model the oldest chapters go, the latest stay (room kept for the answer)', async () => {
    const r = await preview({ providerId, modelId: 'm' });
    const reserve = Number(r.params?.max_tokens) || 8192; // the beat prompt derives max_tokens from its word count
    const all = r.messages.map((m: any) => m.content).join('\n');
    expect(all).toContain('[…]');
    expect(all).toContain('Resumen del capítulo 11.');
    expect(all).not.toContain('Resumen del capítulo 1.');
    expect(r.tokens).toBeLessThanOrEqual(10_000 - reserve);
    expect(r.warnings.some((w: any) => w.level === 'info' && /resumen|historia/i.test(w.message))).toBe(true);
  });

  it('max_tokens in the request sets the room for the answer instead of 8K', async () => {
    const r = await api('POST', '/api/preview', {
      kind: 'beat', promptId: beat.id, novelId: novel.id, sceneId: lastScene, message: 'Algo pasa.', textBefore: '', textAfter: '',
      model: { providerId, modelId: 'm' }, params: { max_tokens: 2000 },
    });
    expect(r.tokens).toBeLessThanOrEqual(10_000 - 2000);
    expect(r.messages.map((m: any) => m.content).join('\n')).toContain('[…]');
  });

  it('related passages go first, least similar first; the codex and the passage stay', async () => {
    const chk = (await api<Prompt[]>('GET', '/api/prompts')).find((p) => p.type === 'continuity-check')!;
    const passage = 'Marta giró el anillo en el dedo.';
    const body = { kind: 'continuity' as const, promptId: chk.id, novelId: novel.id, sceneId: lastScene, selection: passage, sceneText: passage };
    const passages: RelatedPassage[] = [0.9, 0.8, 0.7, 0.6].map((score, i) => ({ sceneId: `s${i}`, location: `Capítulo ${i}`, text: `pasaje${i} ${'texto '.repeat(600)}`, score }));
    const base = estimateMessagesTokens(fitPrompt(db, body, [], null).prep.result.messages);
    const one = estimateMessagesTokens(fitPrompt(db, body, passages.slice(0, 1), null).prep.result.messages) - base;
    // room for the prompt with two passages, not more
    const f = fitPrompt(db, body, passages, base + one * 2 + 50);
    expect(f.passages.map((p) => p.score)).toEqual([0.9, 0.8]);
    expect(f.droppedPassages).toBe(2);
    expect(f.storyTrimmed).toBe(false);
    const all = f.prep.result.messages.map((m) => m.content).join('\n');
    expect(all).toContain(passage);
    expect(all).toContain('pasaje0');
    expect(all).not.toContain('pasaje3');
  });
});
