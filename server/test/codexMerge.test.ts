// Merging duplicate codex entries: references move to the kept entry, the others are deleted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDb, type DB } from '../src/db';
import { seedBuiltins } from '../src/repo/prompts';
import { mergedEntry, type CodexEntry, type Novel, type Outline } from '@novelmaker/shared';

let db: DB;
let app: FastifyInstance;
async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method: method as any, url, payload: body as any });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

beforeAll(async () => {
  db = openDb(':memory:');
  seedBuiltins(db);
  app = await buildApp(db, { serveWeb: false });
});
afterAll(async () => {
  await app.close();
  db.close();
});

describe('merge codex entries', () => {
  it('moves POV, relations and pins to the kept entry and deletes the others', async () => {
    const novel = await api<Novel>('POST', '/api/novels', { title: 'T', language: 'Spanish' });
    const keep = await api<CodexEntry>('POST', `/api/novels/${novel.id}/codex`, { type: 'character', name: 'Hannes', description: 'Amigo.' });
    const dup = await api<CodexEntry>('POST', `/api/novels/${novel.id}/codex`, { type: 'character', name: 'Hannes Berger', aliases: ['Berger'], description: 'Pescador.' });
    const marta = await api<CodexEntry>('POST', `/api/novels/${novel.id}/codex`, { type: 'character', name: 'Marta' });
    await api('POST', `/api/codex/${dup.id}/relations`, { otherId: marta.id, label: 'amigo' });
    await api('POST', `/api/codex/${keep.id}/relations`, { otherId: marta.id, label: 'amigo' });
    const outline = await api<Outline>('GET', `/api/novels/${novel.id}/outline`);
    const sceneId = outline.acts[0].chapters[0].scenes[0].id;
    await api('PATCH', `/api/scenes/${sceneId}`, { povCharacterId: dup.id });
    await api('PATCH', `/api/novels/${novel.id}`, { settings: { pins: [{ kind: 'codex', id: dup.id }] } });

    const patch = mergedEntry(keep, [dup], 'Spanish');
    const merged = await api<CodexEntry>('POST', `/api/codex/${keep.id}/merge`, { otherIds: [dup.id], patch });
    expect(merged).toMatchObject({ id: keep.id, name: 'Hannes', aliases: ['Hannes Berger', 'Berger'], description: 'Amigo.\n\nPescador.' });

    const { entries, relations } = await api<{ entries: CodexEntry[]; relations: { aId: string; bId: string }[] }>('GET', `/api/novels/${novel.id}/codex`);
    expect(entries.map((e) => e.id).sort()).toEqual([keep.id, marta.id].sort());
    expect(relations).toHaveLength(1); // the two "amigo" relations became one
    const scene = await api('GET', `/api/scenes/${sceneId}`);
    expect(scene.povCharacterId).toBe(keep.id);
    const n = await api<Novel>('GET', `/api/novels/${novel.id}`);
    expect(n.settings.pins).toEqual([{ kind: 'codex', id: keep.id }]);
  });

  it('refuses entries of another level and empty merges', async () => {
    const novel = await api<Novel>('POST', '/api/novels', { title: 'U' });
    const a = await api<CodexEntry>('POST', `/api/novels/${novel.id}/codex`, { name: 'A' });
    await expect(api('POST', `/api/codex/${a.id}/merge`, { otherIds: [a.id], patch: {} })).rejects.toThrow(/400/);
  });
});
