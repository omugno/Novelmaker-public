// Codex proposals ("Proponer fichas"): the AI reads a scene and proposes codex entries for the named
// characters, places, objects and concepts that are not in the codex yet. The app drops what is not in
// the text, what the codex already knows (by name or alias, with the novel's language rules), what the
// author ignored before, and duplicates. Each proposal becomes an entry only when the author accepts it.
//
// Idea from the "MPC" of LoneWriter by Sergio Sánchez (MIT, see THIRD_PARTY_NOTICES.md); the prompt,
// the JSON format and the code here are new.
import { CodexMatcher, type MatchableEntry } from './codex/matcher';
import { novelLangCode } from './i18n';
import type { L } from './promptlang';
import type { CodexType } from './types';

export const CODEX_PROPOSAL_TYPE = 'codex-proposals';

export interface CodexProposal {
  name: string;
  type: CodexType;
  /** Other names used in the text (nickname, surname …) */
  aliases: string[];
  /** Only what the text says */
  description: string;
  /** Exact words from the text where it appears */
  quote: string;
}

const PROPOSAL_TYPES = ['character', 'location', 'object', 'lore', 'subplot', 'other'] as const;

export const CODEX_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: [...PROPOSAL_TYPES] },
          aliases: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['name', 'type', 'aliases', 'description', 'quote'],
      },
    },
  },
  required: ['entries'],
} as const;

export const CODEX_PROPOSAL_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'codex_proposals', strict: true, schema: CODEX_PROPOSAL_SCHEMA },
} as const;

// ---------------------------------------------------------------- Reading the answer

const TYPE_WORDS: [RegExp, CodexType][] = [
  [/^(character|person|personaje|persona|figur|personnage|personaggio|персонаж)/i, 'character'],
  [/^(location|place|lugar|sitio|ort|lieu|luogo|місце)/i, 'location'],
  [/^(object|item|objeto|gegenstand|objet|oggetto|предмет)/i, 'object'],
  [/^(lore|concept|concepto|trasfondo|hintergrund|organi[sz]|group|grupo)/i, 'lore'],
  [/^(subplot|subtrama|nebenhandlung)/i, 'subplot'],
];

function toType(v: unknown): CodexType {
  const s = typeof v === 'string' ? v.trim() : '';
  return TYPE_WORDS.find(([re]) => re.test(s))?.[1] ?? 'other';
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
}

function toAliases(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : [];
  return [...new Set(list.map(str).filter(Boolean))];
}

export type CodexProposalParse = { ok: true; proposals: CodexProposal[] } | { ok: false; error: string };

/** Plain JSON, JSON in a ``` block or with text around it; {"entries": [...]}, another single array, or a bare array. */
export function parseCodexProposals(text: string): CodexProposalParse {
  let s = text.trim();
  if (!s) return { ok: false, error: 'empty' };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  let data: unknown;
  for (const cand of [s, s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1), s.slice(s.indexOf('['), s.lastIndexOf(']') + 1)]) {
    if (!cand) continue;
    try {
      data = JSON.parse(cand);
      break;
    } catch {
      /* next */
    }
  }
  if (data === undefined) return { ok: false, error: 'not-json' };
  let list: unknown = Array.isArray(data) ? data : (data as Record<string, unknown>)?.entries;
  if (list === undefined && data && typeof data === 'object') {
    const arrays = Object.values(data as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) list = arrays[0];
  }
  if (!Array.isArray(list)) return { ok: false, error: 'no-entries-array' };
  const proposals: CodexProposal[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const name = str(pick(o, 'name', 'nombre', 'nom', 'nome'));
    if (!name) continue;
    proposals.push({
      name,
      type: toType(pick(o, 'type', 'tipo')),
      aliases: toAliases(pick(o, 'aliases', 'alias', 'alias_list')).filter((a) => a.toLowerCase() !== name.toLowerCase()),
      description: str(pick(o, 'description', 'descripcion', 'descripción')),
      quote: str(pick(o, 'quote', 'cita')),
    });
  }
  return { ok: true, proposals };
}

// ---------------------------------------------------------------- Filtering

/** Key for comparing names: lower case, single spaces; Spanish also without vowel accents. */
export function proposalKey(name: string, language?: string | null): string {
  let s = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (novelLangCode(language).startsWith('es')) s = s.normalize('NFD').replace(/[̀́̈]/g, '').normalize('NFC');
  return s;
}

export interface ProposalFilterInput {
  /** The text that was read (scene or selection) */
  text: string;
  /** Codex entries of the novel (series entries included) */
  entries: MatchableEntry[];
  language?: string | null;
  /** Names the author ignored before (proposalKey) */
  ignored?: string[];
}

export interface ProposalFilterResult {
  proposals: CodexProposal[];
  dropped: { notInText: number; known: number; ignored: number };
}

/**
 * Keeps only proposals that appear in the text and are new: not a name or alias of an existing entry
 * (nor contain one: "Hannes Berger" when "Hannes" exists), not ignored, not twice. Aliases the text
 * does not use are dropped; aliases that belong to existing entries too.
 */
export function filterProposals(list: CodexProposal[], input: ProposalFilterInput): ProposalFilterResult {
  const language = input.language ?? null;
  const known = new CodexMatcher(input.entries, { language, includeNever: true, minLength: 2 });
  const ignored = new Set((input.ignored ?? []).map((n) => proposalKey(n, language)));
  const inText = (term: string) =>
    new CodexMatcher([{ id: 'x', name: term, aliases: [], caseSensitive: false, inclusion: 'auto' }], { language }).mentionedIds(input.text).size > 0;
  const out = new Map<string, CodexProposal>();
  const dropped = { notInText: 0, known: 0, ignored: 0 };
  for (const p of list) {
    const key = proposalKey(p.name, language);
    if (key.length < 2) continue;
    if (ignored.has(key)) {
      dropped.ignored++;
      continue;
    }
    if (known.findMentions(p.name).length) {
      dropped.known++;
      continue;
    }
    const aliases = p.aliases.filter((a) => a.length >= 2 && !known.findMentions(a).length && inText(a));
    if (!inText(p.name) && !aliases.length) {
      dropped.notInText++;
      continue;
    }
    const prev = out.get(key);
    if (prev) {
      prev.aliases = [...new Set([...prev.aliases, ...aliases])];
      if (!prev.description && p.description) prev.description = p.description;
      continue;
    }
    out.set(key, { ...p, aliases });
  }
  return { proposals: [...out.values()], dropped };
}

// ---------------------------------------------------------------- Prompt texts (sent to the AI)

export const ROLE_PROPOSALS: L<string> = {
  en: `You help keep a novel's codex (characters, places, objects, lore) up to date. You read a passage and propose entries for what has a name in it and is not in the codex yet.
- Only things with a proper name or a unique identity (e.g. "Hannes", "the lighthouse of Cabo Mayor", "grandmother's ring"). Not generic people or things ("a waiter", "the rain").
- Skip whatever is already in the codex below, under its name or an alias.
- The description says only what the passage says, in 1 to 3 sentences, in {{Novel language}}. Invent nothing.
- At most 10 entries, the most important first.`,
  es: `Ayudas a mantener al día el códice de una novela (personajes, lugares, objetos, trasfondo). Lees un fragmento y propones fichas para lo que tiene nombre en él y todavía no está en el códice.
- Solo cosas con nombre propio o identidad única (p. ej. "Hannes", "el faro de Cabo Mayor", "el anillo de la abuela"). No personas ni cosas genéricas ("un camarero", "la lluvia").
- Omite lo que ya está en el códice de abajo, por su nombre o por un alias.
- La descripción dice solo lo que dice el fragmento, en 1 a 3 frases, en {{Idioma de la novela}}. No inventes nada.
- Como mucho 10 fichas, las más importantes primero.`,
  de: `Du hilfst, den Kodex eines Romans (Figuren, Orte, Gegenstände, Hintergrund) aktuell zu halten. Du liest eine Textstelle und schlägst Einträge für das vor, was darin einen Namen hat und noch nicht im Kodex steht.
- Nur Dinge mit Eigennamen oder eindeutiger Identität (z. B. „Hannes“, „der Leuchtturm von Cabo Mayor“, „Großmutters Ring“). Keine allgemeinen Personen oder Dinge („ein Kellner“, „der Regen“).
- Lass weg, was schon im Kodex unten steht, unter seinem Namen oder einem Alias.
- Die Beschreibung sagt nur, was die Textstelle sagt, in 1 bis 3 Sätzen, auf {{Romansprache}}. Erfinde nichts.
- Höchstens 10 Einträge, die wichtigsten zuerst.`,
  uk: `Ти допомагаєш підтримувати кодекс роману (персонажі, місця, предмети, передісторія) в актуальному стані. Ти читаєш фрагмент і пропонуєш записи для того, що має в ньому назву й ще не є в кодексі.
- Лише те, що має власну назву або унікальну ідентичність (напр. «Ганнес», «маяк на Кабо-Майор», «бабусина каблучка»). Не загальні люди чи речі («офіціант», «дощ»).
- Пропускай те, що вже є в кодексі нижче, під своєю назвою або псевдонімом.
- Опис містить лише те, що каже фрагмент, 1–3 речення, мовою: {{Мова роману}}. Нічого не вигадуй.
- Щонайбільше 10 записів, найважливіші першими.`,
  it: `Aiuti a tenere aggiornato il codex di un romanzo (personaggi, luoghi, oggetti, retroscena). Leggi un passaggio e proponi voci per ciò che vi ha un nome e non è ancora nel codex.
- Solo cose con un nome proprio o un'identità unica (ad es. "Hannes", "il faro di Cabo Mayor", "l'anello della nonna"). Non persone o cose generiche ("un cameriere", "la pioggia").
- Tralascia ciò che è già nel codex qui sotto, con il suo nome o un alias.
- La descrizione dice solo ciò che dice il passaggio, in 1-3 frasi, in {{Lingua del romanzo}}. Non inventare nulla.
- Al massimo 10 voci, le più importanti per prime.`,
  fr: `Tu aides à tenir à jour le codex d'un roman (personnages, lieux, objets, univers). Tu lis un passage et proposes des fiches pour ce qui y porte un nom et n'est pas encore dans le codex.
- Seulement ce qui a un nom propre ou une identité unique (p. ex. « Hannes », « le phare de Cabo Mayor », « la bague de grand-mère »). Pas de personnes ni de choses génériques (« un serveur », « la pluie »).
- Laisse de côté ce qui est déjà dans le codex ci-dessous, sous son nom ou un alias.
- La description dit seulement ce que dit le passage, en 1 à 3 phrases, en {{Langue du roman}}. N'invente rien.
- 10 fiches au plus, les plus importantes d'abord.`,
};

export const TASK_PROPOSALS: L<string> = {
  en: `Propose codex entries for the passage below. Answer ONLY with JSON in this form:
{"entries": [{"name": "...", "type": "character", "aliases": ["..."], "description": "...", "quote": "..."}]}
- type: "character", "location", "object", "lore" (groups, institutions, concepts), "subplot" or "other".
- aliases: other names the passage uses for it (nickname, surname); empty if none.
- quote: 3 to 15 words copied exactly from the passage where it appears.
If there is nothing new, answer {"entries": []}.`,
  es: `Propón fichas del códice para el fragmento de abajo. Responde SOLO con JSON de esta forma:
{"entries": [{"name": "...", "type": "character", "aliases": ["..."], "description": "...", "quote": "..."}]}
- type: "character" (personaje), "location" (lugar), "object" (objeto), "lore" (grupos, instituciones, conceptos), "subplot" (subtrama) u "other".
- aliases: otros nombres que el fragmento usa para lo mismo (apodo, apellido); vacío si no hay.
- quote: de 3 a 15 palabras copiadas exactamente del fragmento donde aparece.
Si no hay nada nuevo, responde {"entries": []}.`,
  de: `Schlage Kodex-Einträge für die Textstelle unten vor. Antworte NUR mit JSON in dieser Form:
{"entries": [{"name": "...", "type": "character", "aliases": ["..."], "description": "...", "quote": "..."}]}
- type: "character" (Figur), "location" (Ort), "object" (Gegenstand), "lore" (Gruppen, Institutionen, Begriffe), "subplot" (Nebenhandlung) oder "other".
- aliases: andere Namen, die die Textstelle dafür verwendet (Spitzname, Nachname); leer, wenn keine.
- quote: 3 bis 15 Wörter, exakt aus der Textstelle kopiert, wo es vorkommt.
Gibt es nichts Neues, antworte {"entries": []}.`,
  uk: `Запропонуй записи кодексу для фрагмента нижче. Відповідай ЛИШЕ JSON у такій формі:
{"entries": [{"name": "...", "type": "character", "aliases": ["..."], "description": "...", "quote": "..."}]}
- type: "character" (персонаж), "location" (місце), "object" (предмет), "lore" (групи, установи, поняття), "subplot" (побічна лінія) або "other".
- aliases: інші назви, які фрагмент використовує для цього (прізвисько, прізвище); порожньо, якщо немає.
- quote: від 3 до 15 слів, скопійованих точно з фрагмента, де це згадано.
Якщо нічого нового немає, відповідай {"entries": []}.`,
  it: `Proponi voci del codex per il passaggio qui sotto. Rispondi SOLO con JSON in questa forma:
{"entries": [{"name": "...", "type": "character", "aliases": ["..."], "description": "...", "quote": "..."}]}
- type: "character" (personaggio), "location" (luogo), "object" (oggetto), "lore" (gruppi, istituzioni, concetti), "subplot" (sottotrama) o "other".
- aliases: altri nomi che il passaggio usa per la stessa cosa (soprannome, cognome); vuoto se non ce ne sono.
- quote: da 3 a 15 parole copiate esattamente dal passaggio dove compare.
Se non c'è nulla di nuovo, rispondi {"entries": []}.`,
  fr: `Propose des fiches du codex pour le passage ci-dessous. Réponds UNIQUEMENT en JSON sous cette forme :
{"entries": [{"name": "...", "type": "character", "aliases": ["..."], "description": "...", "quote": "..."}]}
- type : "character" (personnage), "location" (lieu), "object" (objet), "lore" (groupes, institutions, concepts), "subplot" (intrigue secondaire) ou "other".
- aliases : autres noms que le passage utilise pour la même chose (surnom, nom de famille) ; vide s'il n'y en a pas.
- quote : de 3 à 15 mots copiés exactement du passage où il apparaît.
S'il n'y a rien de nouveau, réponds {"entries": []}.`,
};
