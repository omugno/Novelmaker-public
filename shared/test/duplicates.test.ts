import { describe, expect, it } from 'vitest';
import { findDuplicateGroups, jaroWinkler, mergedEntry, pairKey } from '../src/codex/duplicates';
import { codex } from './fixtures';

const ids = (groups: { ids: string[] }[]) => groups.map((g) => [...g.ids].sort());

describe('codex duplicates: detection', () => {
  const entries = [
    codex({ id: 'hannes', name: 'Hannes', description: 'Amigo de Marta.' }),
    codex({ id: 'berger', name: 'Hannes Berger', description: 'Pescador.' }),
    codex({ id: 'marta', name: 'Marta' }),
    codex({ id: 'martha', name: 'Martha' }),
    codex({ id: 'angel', name: 'Ángel' }),
    codex({ id: 'angel2', name: 'Angel', type: 'location' }),
    codex({ id: 'faro', name: 'Faro de Cabo Mayor', type: 'location' }),
    codex({ id: 'cabo', name: 'Cabo Mayor', type: 'location', aliases: ['el cabo'] }),
    codex({ id: 'ana', name: 'Ana' }),
    codex({ id: 'anabel', name: 'Anabel' }),
    codex({ id: 'luis', name: 'Luis' }),
    codex({ id: 'luisa', name: 'Luisa' }),
    codex({ id: 'mario', name: 'Mario' }),
    codex({ id: 'maria', name: 'María' }),
    codex({ id: 'vol', name: 'Hannes', type: 'volume' }),
  ];

  it('finds same name (accent-free in Spanish, any type), contained names and near-equal names', () => {
    const g = findDuplicateGroups(entries, { language: 'Spanish' });
    expect(ids(g)).toEqual(expect.arrayContaining([['angel', 'angel2'], ['berger', 'hannes'], ['cabo', 'faro'], ['marta', 'martha']]));
    expect(g.find((x) => x.ids.includes('angel'))?.reason).toBe('same-name');
    expect(g.find((x) => x.ids.includes('hannes'))?.reason).toBe('contained');
    expect(g.find((x) => x.ids.includes('marta'))?.reason).toBe('similar');
  });

  it('does not flag different names that only look alike, nor volume entries', () => {
    const flat = findDuplicateGroups(entries, { language: 'Spanish' }).flatMap((x) => x.ids);
    for (const id of ['ana', 'anabel', 'luis', 'luisa', 'mario', 'maria', 'vol']) expect(flat).not.toContain(id);
  });

  it('in German, accents count', () => {
    const g = findDuplicateGroups([codex({ id: 'a', name: 'Jörg' }), codex({ id: 'b', name: 'Jorg', type: 'location' })], { language: 'German' });
    expect(g).toEqual([]);
  });

  it('pairs marked as different are not suggested; a shared alias joins a third entry', () => {
    const list = [codex({ id: 'x', name: 'Marta' }), codex({ id: 'y', name: 'Martha' }), codex({ id: 'z', name: 'La pelirroja', aliases: ['Martha'] })];
    expect(ids(findDuplicateGroups(list, { language: 'Spanish' }))).toEqual([['x', 'y', 'z']]);
    expect(ids(findDuplicateGroups(list, { language: 'Spanish', notDuplicates: [pairKey('y', 'x'), pairKey('y', 'z')] }))).toEqual([]);
  });

  it('only entries of the same level', () => {
    const list = [codex({ id: 'n', name: 'Hannes', novelId: 'n1', seriesId: null }), codex({ id: 's', name: 'Hannes', novelId: null, seriesId: 's1' })];
    expect(findDuplicateGroups(list)).toEqual([]);
  });

  it('jaroWinkler', () => {
    expect(jaroWinkler('marta', 'martha')).toBeGreaterThan(0.93);
    expect(jaroWinkler('luis', 'luisa')).toBeGreaterThan(0.9);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('', '')).toBe(0);
  });
});

describe('codex duplicates: merged entry', () => {
  it('keeps the name, turns the other names into aliases, adds texts without repeating', () => {
    const keep = codex({ id: 'h', name: 'Hannes', aliases: ['el alemán'], description: 'Amigo de Marta.', tags: ['puerto'], fields: [{ key: 'Edad', value: '' }] });
    const other = codex({
      id: 'b',
      name: 'Hannes Berger',
      aliases: ['El Alemán', 'Berger'],
      description: 'Amigo de Marta.\n\nPescador en el puerto.',
      tags: ['puerto', 'pesca'],
      fields: [{ key: 'edad', value: '41' }, { key: 'Barco', value: 'Lucía II' }],
    });
    expect(mergedEntry(keep, [other], 'Spanish')).toEqual({
      name: 'Hannes',
      aliases: ['el alemán', 'Hannes Berger', 'Berger'],
      description: 'Amigo de Marta.\n\nPescador en el puerto.',
      notes: '',
      tags: ['puerto', 'pesca'],
      fields: [{ key: 'Edad', value: '41' }, { key: 'Barco', value: 'Lucía II' }],
    });
    expect(keep.fields[0].value).toBe(''); // the kept entry itself is not changed
  });
});
