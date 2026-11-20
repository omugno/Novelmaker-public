// Codex entries that are probably the same thing under two names ("Hannes" / "Hannes Berger",
// "Marta" / "Martha", "Ángel" / "Angel"). Only a suggestion: the author decides which entry stays,
// the others' names become aliases and their texts are added (mergedEntry), or marks the pair as
// different so it is not suggested again.
//
// Idea from LoneWriter by Sergio Sánchez (MIT, see THIRD_PARTY_NOTICES.md): Jaro-Winkler and grouping
// of similar entries. The code here is new.
import { novelLangCode } from '../i18n';
import type { CodexEntry, CodexField } from '../types';

export type DuplicateReason = 'same-name' | 'contained' | 'similar';

export interface DuplicateGroup {
  ids: string[];
  /** Strongest reason found between two of the entries */
  reason: DuplicateReason;
}

/** Jaro-Winkler similarity of two strings, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Lower case, single spaces, without quotes; Spanish also without vowel accents. */
function folder(language?: string | null) {
  const es = novelLangCode(language).startsWith('es');
  return (s: string) => {
    let x = s.trim().replace(/[«»“”"'’]/g, '').replace(/\s+/g, ' ').toLocaleLowerCase();
    if (es) x = x.normalize('NFD').replace(/[̀́̈]/g, '').normalize('NFC');
    return x;
  };
}

const words = (s: string) => s.split(' ').filter(Boolean);
/** Is `short` a whole-word part of `long` ("hannes" in "hannes berger")? */
const containsWords = (long: string, short: string) => long !== short && ` ${long} `.includes(` ${short} `);

/** Names that differ only in a final vowel are usually two people (Luis/Luisa, Mario/María, Paolo/Paola). */
const genderPair = (a: string, b: string) => a.replace(/[aeo]$/, '') === b.replace(/[aeo]$/, '');

const RANK: Record<DuplicateReason, number> = { 'same-name': 3, contained: 2, similar: 1 };

/** Key for a pair the author marked as different (order does not matter). */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Groups of entries that look like the same thing. Compared only at the same level (novel with novel,
 * series with series); volume entries are left out.
 * - same-name: a name or alias of one is a name or alias of the other (any type)
 * - contained: one name is a whole-word part of the other's name, same type, at least 3 letters
 * - similar: names almost equal (Jaro-Winkler ≥ 0.93), same type, at least 4 letters, same first letter,
 *   and not just another final vowel (Luis/Luisa)
 */
export function findDuplicateGroups(entries: CodexEntry[], opts: { language?: string | null; notDuplicates?: string[] } = {}): DuplicateGroup[] {
  const fold = folder(opts.language);
  const ignored = new Set(opts.notDuplicates ?? []);
  const list = entries.filter((e) => e.type !== 'volume');
  const names = list.map((e) => fold(e.name));
  const terms = list.map((e) => new Set([e.name, ...e.aliases].map(fold).filter((t) => t.length >= 2)));
  const level = (e: CodexEntry) => e.novelId ?? `series:${e.seriesId}`;

  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reasonOf = new Map<number, DuplicateReason>();
  const join = (i: number, j: number, r: DuplicateReason) => {
    const a = find(i);
    const b = find(j);
    const best = [reasonOf.get(a), reasonOf.get(b), r].filter(Boolean).sort((x, y) => RANK[y!] - RANK[x!])[0]!;
    parent[a] = b;
    reasonOf.set(b, best);
  };

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (level(a) !== level(b) || ignored.has(pairKey(a.id, b.id))) continue;
      let r: DuplicateReason | null = null;
      if ([...terms[i]].some((t) => terms[j].has(t))) r = 'same-name';
      else if (a.type === b.type) {
        const [na, nb] = [names[i], names[j]];
        const short = na.length <= nb.length ? na : nb;
        const long = short === na ? nb : na;
        if (short.length >= 3 && containsWords(long, short)) r = 'contained';
        else if (
          Math.min(na.length, nb.length) >= 4 &&
          na[0] === nb[0] &&
          words(na).length === words(nb).length &&
          !genderPair(na, nb) &&
          jaroWinkler(na, nb) >= 0.93
        )
          r = 'similar';
      }
      if (r) join(i, j, r);
    }
  }

  const groups = new Map<number, string[]>();
  list.forEach((e, i) => {
    const root = find(i);
    if (root === i && !reasonOf.has(i)) return;
    groups.set(root, [...(groups.get(root) ?? []), e.id]);
  });
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([root, ids]) => ({ ids, reason: reasonOf.get(root) ?? 'similar' }))
    .sort((x, y) => RANK[y.reason] - RANK[x.reason]);
}

/** Adds texts that are not already contained (same text, other spacing or case). */
function joinTexts(parts: string[]): string {
  const out: string[] = [];
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.some((o) => norm(o).includes(norm(p)))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (norm(p).includes(norm(out[i]))) out.splice(i, 1);
    out.push(p);
  }
  return out.join('\n\n');
}

export type MergePatch = Pick<CodexEntry, 'name' | 'aliases' | 'description' | 'notes' | 'tags' | 'fields'>;

/**
 * What the kept entry looks like after merging the others into it: its name stays; the others' names
 * and aliases become aliases; descriptions and notes are added (without repeating text); tags and
 * fields are joined (on the same field name, the kept entry's value wins).
 */
export function mergedEntry(keep: CodexEntry, others: CodexEntry[], language?: string | null): MergePatch {
  const fold = folder(language);
  const seen = new Set([fold(keep.name)]);
  const aliases: string[] = [];
  for (const a of [...keep.aliases, ...others.flatMap((o) => [o.name, ...o.aliases])]) {
    const k = fold(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    aliases.push(a.trim());
  }
  const fields: CodexField[] = keep.fields.map((f) => ({ ...f }));
  for (const f of others.flatMap((o) => o.fields)) {
    const same = fields.find((x) => x.key.trim().toLowerCase() === f.key.trim().toLowerCase());
    if (!same) fields.push(f);
    else if (!same.value.trim() && f.value.trim()) same.value = f.value;
  }
  return {
    name: keep.name,
    aliases,
    description: joinTexts([keep.description, ...others.map((o) => o.description)]),
    notes: joinTexts([keep.notes, ...others.map((o) => o.notes)]),
    tags: [...new Set([...keep.tags, ...others.flatMap((o) => o.tags)])],
    fields,
  };
}
