// Semantic search end to end against a fake /v1/embeddings server (bag of words → vector).
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDb, type DB } from '../src/db';
import { seedBuiltins } from '../src/repo/prompts';
import { updateAppSettings } from '../src/repo/settings';
import type { Outline, PMDoc, Prompt } from '@novelmaker/shared';

const DIM = 64;
/** Deterministic "embedding": hashed word counts, so texts sharing words are similar. */
function fakeEmbed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (w.length < 4) continue;
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  return v;
}

let db: DB;
let app: FastifyInstance;
let emb: Server;
let embUrl = '';
let embeddedTexts = 0;

async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method: method as any, url, payload: body as any });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

const doc = (...paras: string[]): PMDoc => ({ type: 'doc', content: paras.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

beforeAll(async () => {
  emb = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'bge-m3' }] }));
      const { input } = JSON.parse(body) as { input: string[] };
      embeddedTexts += input.length;
      // out of order on purpose: the client has to sort by index
      res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: fakeEmbed(t) })).reverse() }));
    });
  });
  await new Promise<void>((r) => emb.listen(0, '127.0.0.1', () => r()));
  embUrl = `http://127.0.0.1:${(emb.address() as { port: number }).port}/v1`;
  db = openDb(':memory:');
  updateAppSettings(db, { language: 'es' });
  seedBuiltins(db);
  app = await buildApp(db, { serveWeb: false });
});

afterAll(async () => {
  await app.close();
  emb.close();
  db.close();
});

describe('semantic search', () => {
  let novelId = '';
  let s1 = '';
  let s2 = '';
  let providerId = '';

  it('setup: a novel with a lost ring in scene 1', async () => {
    novelId = (await api('POST', '/api/novels', { title: 'Prueba', language: 'Spanish' })).id;
    const outline = await api<Outline>('GET', `/api/novels/${novelId}/outline`);
    const ch = outline.acts[0].chapters[0];
    s1 = ch.scenes[0].id;
    await api('PATCH', `/api/scenes/${s1}`, {
      title: 'El río',
      content: doc('Marta discutía con Hannes junto al río.', 'El anillo de su abuela resbaló del dedo y desapareció en el agua oscura del río.'),
    });
    s2 = (await api('POST', '/api/scenes', { chapterId: ch.id, title: 'El puerto', content: doc('Marta giró el anillo de su abuela en el dedo mientras esperaba en el puerto.') })).id;
    providerId = (await api('POST', '/api/providers', { name: 'mini-ia', kind: 'custom', baseUrl: embUrl, apiKey: '' })).id;
  });

  it('off without an embedding model: status empty, search refused', async () => {
    expect(await api('GET', `/api/novels/${novelId}/semantic`)).toEqual({ model: null, passages: 0, scenes: 0 });
    await expect(api('POST', `/api/novels/${novelId}/semantic/search`, { query: 'anillo' })).rejects.toThrow(/400/);
  });

  it('indexes incrementally: only new or changed passages go to the model', async () => {
    await api('PATCH', '/api/settings', { embeddingModel: { providerId, modelId: 'bge-m3' } });
    const first = await api('POST', `/api/novels/${novelId}/semantic/index`);
    expect(first).toMatchObject({ scenes: 2, passages: 2, embedded: 2, removed: 0 });
    embeddedTexts = 0;
    expect(await api('POST', `/api/novels/${novelId}/semantic/index`)).toMatchObject({ embedded: 0, removed: 0 });
    expect(embeddedTexts).toBe(0);
    await api('PATCH', `/api/scenes/${s2}`, { content: doc('Marta giró el anillo de su abuela en el dedo mientras esperaba en el muelle.') });
    expect(await api('POST', `/api/novels/${novelId}/semantic/index`)).toMatchObject({ embedded: 1, removed: 1 });
    expect(await api('GET', `/api/novels/${novelId}/semantic`)).toMatchObject({ passages: 2, scenes: 2 });
  });

  it('search finds the passage by its words, excluding a scene', async () => {
    const hits = await api<any[]>('POST', `/api/novels/${novelId}/semantic/search`, { query: 'el anillo de la abuela', excludeSceneIds: [s2] });
    expect(hits[0]).toMatchObject({ sceneId: s1 });
    expect(hits[0].location).toContain('El río');
    expect(hits.every((h) => h.sceneId !== s2)).toBe(true);
  });

  it('the continuity prompt gets related passages from other scenes, not from the checked one', async () => {
    const prompts = await api<Prompt[]>('GET', '/api/prompts');
    const chk = prompts.find((p) => p.type === 'continuity-check')!;
    const text = 'Marta giró el anillo de su abuela en el dedo mientras esperaba en el muelle.';
    const r = await api('POST', '/api/preview', { kind: 'continuity', promptId: chk.id, novelId, sceneId: s2, selection: text, sceneText: text });
    const user = r.messages.find((m: any) => m.role === 'user').content as string;
    expect(user).toContain('<relatedPassages>');
    expect(user).toContain('desapareció en el agua oscura');
    expect(user).not.toMatch(/<relatedPassages>[\s\S]*esperaba en el muelle[\s\S]*<\/relatedPassages>/);
    expect(r.warnings.some((w: any) => w.level === 'info' && /2|1/.test(w.message))).toBe(true);
  });

  it('deleting a scene removes its passages', async () => {
    await api('DELETE', `/api/scenes/${s1}`);
    expect(await api('GET', `/api/novels/${novelId}/semantic`)).toMatchObject({ passages: 1, scenes: 1 });
  });
});
