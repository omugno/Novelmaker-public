import { describe, expect, it } from 'vitest';
import { estimateTokens, keepLatest } from '../src/tokens';

const chapter = (n: number, words: number) => `## Capítulo ${n}\n${Array.from({ length: words }, () => `palabra${n}`).join(' ')}`;

describe('keepLatest (story so far within a token limit)', () => {
  const text = [chapter(1, 100), chapter(2, 100), chapter(3, 100)].join('\n\n');

  it('unchanged when it fits', () => {
    expect(keepLatest(text, 10_000)).toEqual({ text, trimmed: false });
  });

  it('drops the oldest chapters, keeps the latest, marks the cut', () => {
    const r = keepLatest(text, estimateTokens(chapter(3, 100)) * 2 + 20);
    expect(r.trimmed).toBe(true);
    expect(r.text.startsWith('[…]\n\n## Capítulo 2')).toBe(true);
    expect(r.text).toContain('## Capítulo 3');
    expect(r.text).not.toContain('Capítulo 1');
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(estimateTokens(chapter(3, 100)) * 2 + 20);
  });

  it('a latest chapter that alone is too long keeps its last paragraphs', () => {
    const long = `## Capítulo 9\n${['primero', 'segundo', 'tercero', 'último'].map((w) => Array.from({ length: 50 }, () => w).join(' ')).join('\n')}`;
    const r = keepLatest(long, estimateTokens(long) / 2);
    expect(r.text).toContain('último');
    expect(r.text).not.toContain('primero');
    expect(r.text.startsWith('[…]')).toBe(true);
  });

  it('a limit below the mark gives nothing', () => {
    expect(keepLatest(text, 1)).toEqual({ text: '', trimmed: true });
  });
});
