import { describe, expect, it } from 'vitest';
import { compileBlockPrompt, newBlockSpec } from '../src/blocks';
import { builtinPrompt, builtinPrompts } from '../src/builtin';
import { CONTINUITY_SCHEMA, findQuote, parseContinuityResponse } from '../src/continuity';
import { LANGS } from '../src/i18n';
import { renderPrompt } from '../src/template/engine';
import { testData } from './fixtures';

describe('continuity: reading the answer', () => {
  const issue = { quote: 'Marias Jacke', problem: 'p', evidence: 'e', source: 'Maria', severity: 'doubt', suggestion: 's' };

  it('plain JSON in the schema shape', () => {
    const r = parseContinuityResponse(JSON.stringify({ issues: [issue] }));
    expect(r).toEqual({ ok: true, issues: [issue] });
  });

  it('JSON in a code block with text around it', () => {
    const r = parseContinuityResponse('Here you go:\n```json\n{"issues": []}\n```\nDone.');
    expect(r).toEqual({ ok: true, issues: [] });
  });

  it('JSON after some prose, without a code block', () => {
    const r = parseContinuityResponse(`I found one problem. {"issues": [${JSON.stringify(issue)}]} That is all.`);
    expect(r.ok && r.issues.length).toBe(1);
  });

  it('a bare array and Spanish keys', () => {
    const r = parseContinuityResponse('[{"cita": "ojos azules", "problema": "La ficha dice verdes.", "gravedad": "duda", "sugerencia": "Cambia a verdes."}]');
    expect(r).toEqual({
      ok: true,
      issues: [{ quote: 'ojos azules', problem: 'La ficha dice verdes.', evidence: '', source: '', severity: 'doubt', suggestion: 'Cambia a verdes.' }],
    });
  });

  it('another single array under a different key', () => {
    const r = parseContinuityResponse('{"contradicciones": [{"quote": "anillo"}]}');
    expect(r.ok && r.issues[0]).toMatchObject({ quote: 'anillo', severity: 'contradiction' });
  });

  it('drops entries without a quote; unknown severity counts as contradiction', () => {
    const r = parseContinuityResponse('{"issues": [{"problem": "x"}, {"quote": "y", "severity": "high"}]}');
    expect(r.ok && r.issues).toEqual([{ quote: 'y', problem: '', evidence: '', source: '', severity: 'contradiction', suggestion: '' }]);
  });

  it('errors: empty, not JSON, no list', () => {
    expect(parseContinuityResponse('  ')).toEqual({ ok: false, error: 'empty' });
    expect(parseContinuityResponse('No contradictions found.')).toEqual({ ok: false, error: 'not-json' });
    expect(parseContinuityResponse('{"a": 1, "b": 2}')).toEqual({ ok: false, error: 'no-issues-array' });
  });

  it('the schema requires every field', () => {
    expect(CONTINUITY_SCHEMA.properties.issues.items.required).toHaveLength(6);
  });
});

describe('continuity: finding the quote', () => {
  const text = 'Marta se apartó el pelo de los ojos azules y giró el anillo en su dedo. —¿Vienes? —preguntó Hannes.';
  const span = (q: string) => {
    const m = findQuote(text, q);
    return m ? text.slice(m.start, m.end) : null;
  };

  it('exact text', () => {
    expect(span('los ojos azules')).toBe('los ojos azules');
  });

  it('ignores case, extra spaces, quotation marks and ellipses', () => {
    expect(span('«Los  ojos AZULES»')).toBe('los ojos azules');
    expect(span('…giró el anillo en su dedo…')).toBe('giró el anillo en su dedo');
  });

  it('dash variants: em dash in the text, hyphen in the quote', () => {
    expect(span('-¿Vienes? -preguntó Hannes')).toBe('—¿Vienes? —preguntó Hannes');
  });

  it('a drifting quote: first and last words still match', () => {
    expect(span('Marta se apartó el cabello de los ojos azules')).toBe('Marta se apartó el pelo de los ojos azules');
  });

  it('a long quote whose ending is not there keeps the beginning', () => {
    expect(span('giró el anillo en su mano izquierda con nervios')).toBe('giró el anillo en');
  });

  it('nothing found, or too short', () => {
    expect(findQuote(text, 'ojos verdes')).toBeNull();
    expect(findQuote(text, '..')).toBeNull();
  });
});

describe('continuity: the built-in prompt', () => {
  it('exists in every language with role, task and the JSON shape', () => {
    for (const lang of LANGS) {
      const b = builtinPrompt('continuity-check', lang)!;
      expect(b.type).toBe('continuity-check');
      expect(b.blocks!.task).toContain('"issues"');
      expect(b.blocks!.role.length).toBeGreaterThan(100);
    }
    expect(builtinPrompts('es').filter((b) => b.type === 'continuity-check')).toHaveLength(1);
  });

  it('default blocks: codex, story so far, previous scene end (any POV), selection; no text before/after', () => {
    const spec = newBlockSpec('continuity-check', 'es');
    expect(spec.blocks.codex?.on).toBe(true);
    expect(spec.blocks.storySoFar?.on).toBe(true);
    expect(spec.blocks.novelInfo?.on).toBe(true);
    expect(spec.blocks.novelInstructions?.on).toBe(false);
    expect(spec.blocks.previousSceneEnd).toMatchObject({ on: true, words: 1000, samePov: false });
    expect(spec.blocks.selection?.on).toBe(true);
    expect(spec.blocks.textBefore?.on).toBe(false);
    expect(spec.blocks.textAfter?.on).toBe(false);
  });

  it('renders: passage to check last, previous scene and codex in the context, no compile warnings', () => {
    const spec = newBlockSpec('continuity-check', 'es');
    const c = compileBlockPrompt(spec, 'continuity-check', 'es');
    expect(c.warnings).toEqual([]);
    const result = renderPrompt(
      { type: 'continuity-check', messages: c.messages, inputs: c.inputs },
      testData({ textBefore: null, textAfter: null, selection: 'Das Café Luna war voll. Marias Jacke hing über dem Stuhl.' }),
    );
    const all = result.messages.map((m) => m.content).join('\n');
    const last = result.messages[result.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('<passage>\nDas Café Luna war voll.');
    expect(last.content).toContain('{"issues": []}');
    expect(all).toContain('Hannes wartete am Gleis'); // end of the previous scene
    expect(all).toContain('Kleines Café in Kreuzberg'); // codex entry mentioned in the scene
    expect(all).toContain('Carla kommt in Berlin an'); // story so far
    // {{Idioma de la novela}} filled in with the novel's language
    expect(result.messages[0].content).toMatch(/en \S+\.$/);
    expect(result.messages[0].content).not.toContain('{');
    expect(result.warnings).toEqual([]);
  });
});
