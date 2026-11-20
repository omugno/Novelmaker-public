import { describe, expect, it } from 'vitest';
import { compileBlockPrompt, newBlockSpec } from '../src/blocks';
import { builtinPrompt } from '../src/builtin';
import { filterProposals, parseCodexProposals, proposalKey, type CodexProposal } from '../src/codexProposals';
import { LANGS } from '../src/i18n';
import { renderPrompt } from '../src/template/engine';
import { codex, testData } from './fixtures';

const p = (name: string, over: Partial<CodexProposal> = {}): CodexProposal => ({ name, type: 'character', aliases: [], description: '', quote: '', ...over });

describe('codex proposals: reading the answer', () => {
  it('schema shape', () => {
    const r = parseCodexProposals('{"entries":[{"name":"Faro de Cabo Mayor","type":"location","aliases":["el faro"],"description":"d","quote":"q"}]}');
    expect(r).toEqual({ ok: true, proposals: [{ name: 'Faro de Cabo Mayor', type: 'location', aliases: ['el faro'], description: 'd', quote: 'q' }] });
  });

  it('Spanish keys and type words, aliases as text, code block', () => {
    const r = parseCodexProposals('```json\n[{"nombre":"Lucía","tipo":"personaje","alias":"Luci, la pequeña","descripción":"Hermana de Marta."}]\n```');
    expect(r.ok && r.proposals[0]).toEqual({ name: 'Lucía', type: 'character', aliases: ['Luci', 'la pequeña'], description: 'Hermana de Marta.', quote: '' });
  });

  it('unknown type → other; alias equal to the name is dropped; no name → skipped', () => {
    const r = parseCodexProposals('{"entries":[{"name":"X","type":"weird","aliases":["x","Y"]},{"type":"object"}]}');
    expect(r.ok && r.proposals).toEqual([{ name: 'X', type: 'other', aliases: ['Y'], description: '', quote: '' }]);
  });

  it('errors', () => {
    expect(parseCodexProposals('')).toEqual({ ok: false, error: 'empty' });
    expect(parseCodexProposals('Nada nuevo.')).toEqual({ ok: false, error: 'not-json' });
  });
});

describe('codex proposals: filtering', () => {
  const text =
    'Lucía esperaba en el Faro de Cabo Mayor. Hannes Berger llegó tarde con el anillo de la abuela. —Luci, ven —dijo Ángel. Lucia sonrió.';
  const entries = [codex({ id: 'hannes', name: 'Hannes' }), codex({ id: 'angel', name: 'Ángel' }), codex({ id: 'ai', name: 'AI-isms', inclusion: 'never', aliases: ['de repente'] })];

  it('drops known names (also variants and accent-free spellings), keeps new ones', () => {
    const r = filterProposals([p('Lucía'), p('Hannes Berger'), p('Angel'), p('Faro de Cabo Mayor', { type: 'location' })], { text, entries, language: 'Spanish' });
    expect(r.proposals.map((x) => x.name)).toEqual(['Lucía', 'Faro de Cabo Mayor']);
    expect(r.dropped.known).toBe(2);
  });

  it('drops names that are not in the text and aliases the text does not use', () => {
    const r = filterProposals([p('Lucía', { aliases: ['Luci', 'Lu'] }), p('Pedro')], { text, entries, language: 'Spanish' });
    expect(r.proposals).toEqual([p('Lucía', { aliases: ['Luci'] })]);
    expect(r.dropped.notInText).toBe(1);
  });

  it('ignored names (accent-insensitive in Spanish) and duplicates', () => {
    const r = filterProposals([p('Lucía', { description: '' }), p('Lucia', { description: 'Hermana.', aliases: ['Luci'] }), p('Faro de Cabo Mayor')], {
      text,
      entries,
      language: 'Spanish',
      ignored: ['faro de cabo mayor'],
    });
    expect(r.proposals).toEqual([p('Lucía', { description: 'Hermana.', aliases: ['Luci'] })]);
    expect(r.dropped.ignored).toBe(1);
  });

  it('proposalKey: Spanish folds accents, German does not', () => {
    expect(proposalKey('  Lucía   Pérez ', 'Spanish')).toBe('lucia perez');
    expect(proposalKey('Jörg', 'German')).toBe('jörg');
  });
});

describe('codex proposals: built-in prompt', () => {
  it('exists in every language', () => {
    for (const lang of LANGS) expect(builtinPrompt('codex-proposals', lang)?.blocks?.task).toContain('"entries"');
  });

  it('blocks: novel info, codex, the passage; no story so far, no instructions', () => {
    const spec = newBlockSpec('codex-proposals', 'es');
    expect(spec.blocks.codex?.on).toBe(true);
    expect(spec.blocks.novelInfo?.on).toBe(true);
    expect(spec.blocks.selection?.on).toBe(true);
    expect(spec.blocks.storySoFar?.on).toBe(false);
    expect(spec.blocks.novelInstructions?.on).toBe(false);
  });

  it('renders without warnings, passage last', () => {
    const c = compileBlockPrompt(newBlockSpec('codex-proposals', 'es'), 'codex-proposals', 'es');
    expect(c.warnings).toEqual([]);
    const r = renderPrompt({ type: 'codex-proposals', messages: c.messages, inputs: c.inputs }, testData({ textBefore: null, textAfter: null, selection: 'Das Café Luna war voll.' }));
    expect(r.warnings).toEqual([]);
    const last = r.messages[r.messages.length - 1];
    expect(last.content).toContain('<passage>\nDas Café Luna war voll.');
    expect(r.messages.map((m) => m.content).join('\n')).toContain('Kleines Café in Kreuzberg'); // codex entry mentioned → the AI sees it is known
  });
});
