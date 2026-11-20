import { describe, expect, it } from 'vitest';
import { chunkText, cosine, formatRelated, textHash, topPassages } from '../src/semantic';

const words = (n: number, w = 'palabra') => Array.from({ length: n }, () => w).join(' ');

describe('semantic: passages', () => {
  it('joins short paragraphs up to the limit and keeps paragraphs whole', () => {
    const text = [words(60, 'a'), words(60, 'b'), words(60, 'c')].join('\n\n');
    const chunks = chunkText(text, 150);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].split('\n')).toHaveLength(2);
    expect(chunks[1]).toBe(words(60, 'c'));
  });

  it('splits a long paragraph between sentences, never inside one', () => {
    const sentence = (w: string) => `${words(40, w)}.`;
    const para = [sentence('a'), sentence('b'), sentence('c'), sentence('d'), sentence('e')].join(' ');
    const chunks = chunkText(para, 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.endsWith('.')).toBe(true);
    expect(chunks.join(' ').split(/\s+/).length).toBe(200);
  });

  it('empty text gives no passages; spacing does not change the hash', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
    expect(textHash(chunkText('Hola   mundo.')[0])).toBe(textHash(chunkText('Hola mundo.')[0]));
    expect(textHash('a')).not.toBe(textHash('b'));
  });
});

describe('semantic: ranking', () => {
  it('cosine', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('several queries: each candidate keeps its best score; threshold and k apply', () => {
    const cands = [
      { id: 'x', vector: [1, 0, 0] },
      { id: 'y', vector: [0, 1, 0] },
      { id: 'z', vector: [0, 0, 1] },
    ];
    const r = topPassages([[1, 0.1, 0], [0, 1, 0.2]], cands, 5, 0.5);
    expect(r.map((x) => x.item.id)).toEqual(['x', 'y']);
    expect(topPassages([[1, 0.1, 0], [0, 1, 0.2]], cands, 1, 0.5)).toHaveLength(1);
  });

  it('formats passages with their location, escaping quotes', () => {
    const s = formatRelated([{ sceneId: 's', location: 'Capítulo 1: "El río"', text: 'Texto.', score: 0.7 }]);
    expect(s).toBe('<passage from="Capítulo 1: &quot;El río&quot;">\nTexto.\n</passage>');
  });
});
