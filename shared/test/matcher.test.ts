import { describe, expect, it } from 'vitest';
import { CodexMatcher } from '../src/codex/matcher';
import { selectCodexEntries } from '../src/codex/context';
import { codex } from './fixtures';

const entries = [
  codex({ id: 'maria', name: 'Maria' }),
  codex({ id: 'jorg', name: 'Jörg', aliases: ['Jörgi'] }),
  codex({ id: 'luna', name: 'Café Luna', type: 'location' }),
  codex({ id: 'ai', name: 'AI-isms', inclusion: 'never', aliases: ['irgendwie'] }),
  codex({ id: 'ring', name: 'Ring', type: 'object', caseSensitive: true }),
  codex({ id: 'hannes', name: 'Hannes' }),
];
const m = new CodexMatcher(entries);

describe('Kodex-Erkennung', () => {
  it('findet Genitiv: Marias → Maria', () => {
    expect([...m.mentionedIds('Marias Jacke hing da.')]).toEqual(['maria']);
  });
  it('respektiert Wortgrenzen mit Umlauten', () => {
    expect(m.mentionedIds('Mariannes Hund').size).toBe(0);
    expect([...m.mentionedIds('Jörg kam.')]).toEqual(['jorg']);
    expect(m.mentionedIds('Jörgens Auto').size).toBe(0);
    expect(m.mentionedIds('ÜberJörg').size).toBe(0);
    expect([...m.mentionedIds('Das war Jörgis Idee.')]).toEqual(['jorg']);
  });
  it('findet mehrteilige Namen und Endungen', () => {
    expect([...m.mentionedIds('Im Café   Luna war es laut.')]).toEqual(['luna']);
    expect([...m.mentionedIds('Hannes’ Zimmer')]).toEqual(['hannes']);
  });
  it('ignoriert Einträge mit Einbindung „nie“', () => {
    expect(m.mentionedIds('Das war irgendwie seltsam.').size).toBe(0);
  });
  it('beachtet Groß-/Kleinschreibung pro Eintrag', () => {
    expect(m.mentionedIds('Sie trug einen ring.').size).toBe(0);
    expect([...m.mentionedIds('Der Ring glänzte.')]).toEqual(['ring']);
    expect([...m.mentionedIds('MARIA!')]).toEqual(['maria']);
  });
  it('liefert Positionen', () => {
    const ms = m.findMentions('Hallo Maria, hallo Jörg.');
    expect(ms.map((x) => x.text)).toEqual(['Maria', 'Jörg']);
    expect(ms[0].start).toBe(6);
  });
});

describe('Kodex-Auswahl', () => {
  const all = [
    codex({ id: 'style', name: 'Stil', inclusion: 'always', description: 'x'.repeat(100) }),
    codex({ id: 'pov', name: 'Carla', description: 'Erzählerin' }),
    codex({ id: 'maria', name: 'Maria', description: 'Freundin von Jörg' }),
    codex({ id: 'jorg', name: 'Jörg', description: 'y'.repeat(400) }),
  ];
  it('Priorität und Rekursion', () => {
    const sel = selectCodexEntries({
      entries: all,
      currentTexts: ['Maria lacht.'],
      povCharacterId: 'pov',
      recursive: true,
      formatEntry: (e) => e.description,
    });
    expect(sel.items.map((i) => [i.id, i.reason])).toEqual([
      ['style', 'always'],
      ['pov', 'pov'],
      ['maria', 'mentioned'],
      ['jorg', 'recursive'],
    ]);
  });
  it('Token-Budget streicht niedrige Prioritäten', () => {
    const sel = selectCodexEntries({
      entries: all,
      currentTexts: ['Maria lacht.'],
      povCharacterId: 'pov',
      recursive: true,
      budget: 60,
      formatEntry: (e) => e.description,
    });
    expect(sel.included.map((e) => e.id)).toEqual(['style', 'pov', 'maria']);
    expect(sel.items.find((i) => i.id === 'jorg')?.included).toBe(false);
  });
});

describe('Codex mentions by language of the novel', () => {
  const es = new CodexMatcher(
    [
      codex({ id: 'angel', name: 'Ángel' }),
      codex({ id: 'martin', name: 'Martin', aliases: ['el doctor Ruiz'] }),
      codex({ id: 'ana', name: 'Ana' }),
      codex({ id: 'pena', name: 'Peña', type: 'location' }),
      codex({ id: 'anillo', name: 'anillo de la abuela', type: 'object' }),
      codex({ id: 'faro', name: 'Faro', type: 'location', caseSensitive: true }),
      codex({ id: 'ciudad', name: 'Ciudad Vieja', type: 'location' }),
    ],
    { language: 'Spanish' },
  );
  const ids = (text: string) => [...es.mentionedIds(text)].sort();

  it('Spanish: accents on vowels do not matter, in either direction', () => {
    expect(ids('Angel llegó tarde.')).toEqual(['angel']);
    expect(ids('ÁNGEL no contestó.')).toEqual(['angel']);
    expect(ids('Martín abrió la puerta.')).toEqual(['martin']);
    expect(ids('Habló con el doctor Ruíz.')).toEqual(['martin']);
  });

  it('Spanish: the ñ is a different letter', () => {
    expect(ids('Subieron a la Peña.')).toEqual(['pena']);
    expect(ids('Subieron a la Pena.')).toEqual([]); // "pena" is another word
  });

  it('Spanish: plurals -s and -es, but not the German endings', () => {
    expect(ids('los anillos de la abuela')).toEqual([]); // the plural goes at the end of the term, not in the middle
    expect(ids('Las Anas del pueblo')).toEqual(['ana']);
    expect(ids('dos Ciudades Viejas')).toEqual([]);
    expect(ids('la Ciudad Viejas')).toEqual(['ciudad']);
    expect(ids('Anan y Anen')).toEqual([]);
  });

  it('Spanish: word boundaries with accents and ñ', () => {
    expect(ids('Anabel y Ángela')).toEqual([]);
    expect(ids('Peñasco')).toEqual([]);
    expect(ids('—¿Ana? —preguntó.')).toEqual(['ana']);
  });

  it('Spanish: case-sensitive entries keep their case, accents still fold', () => {
    expect(ids('el faro de la costa')).toEqual([]);
    expect(ids('El Faro estaba apagado.')).toEqual(['faro']);
  });

  it('mentions keep the text as written', () => {
    expect(es.findMentions('Vio a Angel.').map((m) => m.text)).toEqual(['Angel']);
  });

  it('English: possessive and plural, no German endings', () => {
    const en = new CodexMatcher([codex({ id: 'maria', name: 'Maria' })], { language: 'English (US)' });
    expect([...en.mentionedIds("Maria's coat")]).toEqual(['maria']);
    expect([...en.mentionedIds('two Marias')]).toEqual(['maria']);
    expect(en.mentionedIds('Marian left').size).toBe(0);
  });

  it('German (and unknown languages) keep the original endings, accents count', () => {
    for (const language of ['German', undefined, 'Klingon']) {
      const de = new CodexMatcher([codex({ id: 'maria', name: 'Maria' }), codex({ id: 'joerg', name: 'Jörg' })], { language });
      expect([...de.mentionedIds('Marias Jacke')]).toEqual(['maria']);
      expect([...de.mentionedIds('Marian')]).toEqual(['maria']); // Maria + n (English and Spanish: no)
      expect(de.mentionedIds('Jorg kam.').size).toBe(0);
    }
  });
});
