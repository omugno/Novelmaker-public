// Continuity checker ("Revisar coherencia"): the AI compares a scene (or a selected passage) with the
// codex, the story so far and the end of the previous scene, and returns contradictions as JSON.
// The editor underlines each quoted passage; a fix goes through the normal rewrite panel, so every
// change is still accepted or discarded by the author.
//
// The rules in ROLE_CONTINUITY (the codex is the truth, no style critique, a sparse entry is not an
// error) follow the "Oracle" of LoneWriter by Sergio Sánchez (MIT licence, see THIRD_PARTY_NOTICES.md).
// The prompt text, the JSON format and the code here are new.
import type { L } from './promptlang';

export const CONTINUITY_TYPE = 'continuity-check';

export type ContinuitySeverity = 'contradiction' | 'doubt';

export interface ContinuityIssue {
  /** Exact words from the checked text (one paragraph) */
  quote: string;
  /** What is wrong, in the novel's language */
  problem: string;
  /** What the codex or the earlier text says */
  evidence: string;
  /** Where that comes from: codex entry name, "previous scene", chapter … */
  source: string;
  severity: ContinuitySeverity;
  /** Short instruction to fix the passage (handed to the rewrite panel) */
  suggestion: string;
}

/** JSON schema of the answer. llama.cpp turns it into a grammar; OpenAI-compatible APIs accept it as structured output. */
export const CONTINUITY_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          problem: { type: 'string' },
          evidence: { type: 'string' },
          source: { type: 'string' },
          severity: { type: 'string', enum: ['contradiction', 'doubt'] },
          suggestion: { type: 'string' },
        },
        required: ['quote', 'problem', 'evidence', 'source', 'severity', 'suggestion'],
      },
    },
  },
  required: ['issues'],
} as const;

export const CONTINUITY_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'continuity_issues', strict: true, schema: CONTINUITY_SCHEMA },
} as const;

// ---------------------------------------------------------------- Reading the answer

export type ContinuityParseResult = { ok: true; issues: ContinuityIssue[] } | { ok: false; error: string };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/** First value among several possible key names (models sometimes translate the keys). */
function pick(o: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) if (o[n] != null && str(o[n])) return str(o[n]);
  return '';
}

/**
 * Reads the model's answer: plain JSON, JSON in a ``` block, or JSON with text around it.
 * Accepts {"issues": [...]} or a bare array. Entries without a quote are dropped.
 */
export function parseContinuityResponse(text: string): ContinuityParseResult {
  let s = text.trim();
  if (!s) return { ok: false, error: 'empty' };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  let data: unknown;
  try {
    data = JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    const c = s.indexOf('[');
    const d = s.lastIndexOf(']');
    const candidates = [a >= 0 && b > a ? s.slice(a, b + 1) : '', c >= 0 && d > c ? s.slice(c, d + 1) : ''].filter(Boolean);
    for (const cand of candidates) {
      try {
        data = JSON.parse(cand);
        break;
      } catch {
        /* next */
      }
    }
    if (data === undefined) return { ok: false, error: 'not-json' };
  }
  let list: unknown = Array.isArray(data) ? data : (data as Record<string, unknown>)?.issues;
  if (list === undefined && data && typeof data === 'object') {
    // {"problemas": [...]} or another single array value
    const arrays = Object.values(data as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) list = arrays[0];
  }
  if (!Array.isArray(list)) return { ok: false, error: 'no-issues-array' };
  const issues: ContinuityIssue[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const quote = pick(o, 'quote', 'cita', 'text', 'texto', 'passage');
    if (!quote) continue;
    const sev = pick(o, 'severity', 'gravedad', 'level').toLowerCase();
    issues.push({
      quote,
      problem: pick(o, 'problem', 'problema', 'issue', 'explanation', 'explicacion', 'explicación'),
      evidence: pick(o, 'evidence', 'evidencia', 'prueba'),
      source: pick(o, 'source', 'fuente', 'origen'),
      severity: sev.startsWith('doubt') || sev.startsWith('duda') || sev === 'warning' ? 'doubt' : 'contradiction',
      suggestion: pick(o, 'suggestion', 'sugerencia', 'fix', 'propuesta'),
    });
  }
  return { ok: true, issues };
}

// ---------------------------------------------------------------- Finding the quote in the text

const DROP = /[«»“”„"'‘’‚‹›*_]/;
const DASH = /[—–‒―]/;

/** Normalized text and, for every normalized character, its index in the original. */
function normalize(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let space = false;
  const src = s.normalize('NFC');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      space = text.length > 0;
      continue;
    }
    if (DROP.test(ch)) continue;
    if (space) {
      text += ' ';
      map.push(i);
      space = false;
    }
    let out = ch.toLowerCase();
    if (DASH.test(ch)) out = '-';
    else if (ch === '…') out = '...';
    for (const c of out) {
      text += c;
      map.push(i);
    }
  }
  return { text, map };
}

/** Trims "…" and punctuation that models add around a quote. */
function trimQuote(q: string): string {
  return q
    .trim()
    .replace(/^(?:\.\.\.|…|[\s,;:.])+/, '')
    .replace(/(?:\.\.\.|…|[\s,;:-])+$/, '');
}

export interface QuoteMatch {
  start: number;
  end: number;
}

/**
 * Finds a quote in a text, ignoring case, quotation marks, dash variants and spacing.
 * If the whole quote is not there, it tries the first and last few words (models shorten or drift).
 * Returns character offsets in the original text, or null.
 */
export function findQuote(text: string, quote: string): QuoteMatch | null {
  const q = trimQuote(quote);
  if (q.length < 3) return null;
  const hay = normalize(text);
  const needle = normalize(q).text;
  if (!needle) return null;
  const at = (ns: number, ne: number): QuoteMatch => ({ start: hay.map[ns], end: hay.map[ne - 1] + 1 });
  const idx = hay.text.indexOf(needle);
  if (idx >= 0) return at(idx, idx + needle.length);
  const words = needle.split(' ');
  if (words.length < 6) return null;
  const head = words.slice(0, 4).join(' ');
  const tail = words.slice(-4).join(' ');
  const h = hay.text.indexOf(head);
  if (h < 0) return null;
  const t = hay.text.indexOf(tail, h + head.length);
  // the matched span may not be much longer than the quote itself
  if (t >= 0 && t + tail.length - h <= needle.length * 1.5) return at(h, t + tail.length);
  return at(h, h + head.length);
}

// ---------------------------------------------------------------- Prompt texts (sent to the AI)

export const ROLE_CONTINUITY: L<string> = {
  en: `You are a continuity editor for novels. You compare a passage with what is already established: the codex, the story so far and the end of the previous scene.
- The codex is the truth. If the passage contradicts it, the passage is wrong.
- Report only contradictions of facts: physical traits, ages, names, family ties, places, objects (who has them, where they are, whether they were lost or broken), injuries, dates and the order of events, who knows what, the state of relationships.
- Do not comment on style, rhythm, grammar or plot quality.
- Something the context does not mention is not a contradiction. If an entry says little, assume the passage is right.
- When you are not sure, report it with severity "doubt".
- Write problem, evidence and suggestion in {{Novel language}}.`,
  es: `Eres un revisor de continuidad de novelas. Comparas un fragmento con lo ya establecido: el códice, la historia hasta ahora y el final de la escena anterior.
- El códice es la verdad. Si el fragmento lo contradice, el error está en el fragmento.
- Señala solo contradicciones de hechos: rasgos físicos, edades, nombres, parentescos, lugares, objetos (quién los tiene, dónde están, si se perdieron o rompieron), heridas, fechas y orden de los hechos, quién sabe qué, el estado de las relaciones.
- No comentes el estilo, el ritmo, la gramática ni la calidad de la trama.
- Lo que el contexto no menciona no es una contradicción. Si una ficha dice poco, da el fragmento por bueno.
- Si no estás seguro, señálalo con gravedad "doubt".
- Escribe problem, evidence y suggestion en {{Idioma de la novela}}.`,
  de: `Du bist Continuity-Lektorin für Romane. Du vergleichst eine Textstelle mit dem, was schon feststeht: dem Kodex, der bisherigen Handlung und dem Ende der vorigen Szene.
- Der Kodex ist die Wahrheit. Widerspricht ihm die Textstelle, ist die Textstelle falsch.
- Melde nur Widersprüche bei Fakten: Aussehen, Alter, Namen, Verwandtschaft, Orte, Gegenstände (wer sie hat, wo sie sind, ob sie verloren oder kaputt sind), Verletzungen, Daten und Reihenfolge der Ereignisse, wer was weiß, der Stand von Beziehungen.
- Kommentiere nicht Stil, Rhythmus, Grammatik oder die Qualität der Handlung.
- Was der Kontext nicht erwähnt, ist kein Widerspruch. Sagt ein Eintrag wenig, gilt die Textstelle als richtig.
- Bist du nicht sicher, melde es mit severity "doubt".
- Schreibe problem, evidence und suggestion auf {{Romansprache}}.`,
  uk: `Ти – редактор безперервності для романів. Ти порівнюєш фрагмент із тим, що вже встановлено: кодексом, попередніми подіями та кінцем попередньої сцени.
- Кодекс – це істина. Якщо фрагмент йому суперечить, помилка у фрагменті.
- Повідомляй лише про суперечності у фактах: зовнішність, вік, імена, родинні зв'язки, місця, предмети (у кого вони, де вони, чи загублені чи зламані), поранення, дати й порядок подій, хто що знає, стан стосунків.
- Не коментуй стиль, ритм, граматику чи якість сюжету.
- Те, чого контекст не згадує, не є суперечністю. Якщо запис мізерний, вважай фрагмент правильним.
- Якщо не впевнений, познач це з severity "doubt".
- Пиши problem, evidence і suggestion мовою: {{Мова роману}}.`,
  it: `Sei un revisore di continuità per romanzi. Confronti un passaggio con ciò che è già stabilito: il codex, la storia finora e la fine della scena precedente.
- Il codex è la verità. Se il passaggio lo contraddice, l'errore è nel passaggio.
- Segnala solo contraddizioni nei fatti: tratti fisici, età, nomi, parentele, luoghi, oggetti (chi li ha, dove sono, se sono stati persi o rotti), ferite, date e ordine degli eventi, chi sa cosa, lo stato delle relazioni.
- Non commentare stile, ritmo, grammatica o qualità della trama.
- Ciò che il contesto non menziona non è una contraddizione. Se una voce dice poco, considera giusto il passaggio.
- Se non sei sicuro, segnalalo con severity "doubt".
- Scrivi problem, evidence e suggestion in {{Lingua del romanzo}}.`,
  fr: `Tu es un correcteur de continuité pour romans. Tu compares un passage avec ce qui est déjà établi : le codex, l'histoire jusqu'ici et la fin de la scène précédente.
- Le codex fait foi. Si le passage le contredit, c'est le passage qui a tort.
- Signale seulement les contradictions de faits : traits physiques, âges, noms, liens de parenté, lieux, objets (qui les a, où ils sont, s'ils ont été perdus ou cassés), blessures, dates et ordre des événements, qui sait quoi, l'état des relations.
- Ne commente ni le style, ni le rythme, ni la grammaire, ni la qualité de l'intrigue.
- Ce que le contexte ne mentionne pas n'est pas une contradiction. Si une fiche dit peu, considère le passage comme juste.
- Si tu n'es pas sûr, signale-le avec severity "doubt".
- Écris problem, evidence et suggestion en {{Langue du roman}}.`,
};

export const TASK_CONTINUITY: L<string> = {
  en: `Check the passage below for contradictions. Answer ONLY with JSON in this form:
{"issues": [{"quote": "...", "problem": "...", "evidence": "...", "source": "...", "severity": "contradiction", "suggestion": "..."}]}
- quote: 3 to 15 consecutive words copied exactly from the passage, from a single paragraph. Never from the codex or the context.
- problem: what contradicts what, in one sentence.
- evidence: what the codex or the earlier text says.
- source: the codex entry, "story so far" or "previous scene".
- severity: "contradiction" if it is clear, "doubt" if it might be intended.
- suggestion: a short instruction to fix the passage, e.g. "Change her eye colour to green."
If there are no contradictions, answer {"issues": []}.`,
  es: `Revisa el fragmento de abajo en busca de contradicciones. Responde SOLO con JSON de esta forma:
{"issues": [{"quote": "...", "problem": "...", "evidence": "...", "source": "...", "severity": "contradiction", "suggestion": "..."}]}
- quote: de 3 a 15 palabras seguidas copiadas exactamente del fragmento, de un solo párrafo. Nunca del códice ni del contexto.
- problem: qué contradice a qué, en una frase.
- evidence: qué dice el códice o el texto anterior.
- source: la ficha del códice, "historia hasta ahora" o "escena anterior".
- severity: "contradiction" si está claro, "doubt" si podría ser intencionado.
- suggestion: una instrucción breve para corregir el fragmento, p. ej. "Cambia el color de sus ojos a verde."
Si no hay contradicciones, responde {"issues": []}.`,
  de: `Prüfe die Textstelle unten auf Widersprüche. Antworte NUR mit JSON in dieser Form:
{"issues": [{"quote": "...", "problem": "...", "evidence": "...", "source": "...", "severity": "contradiction", "suggestion": "..."}]}
- quote: 3 bis 15 aufeinanderfolgende Wörter, exakt aus der Textstelle kopiert, aus einem einzigen Absatz. Nie aus dem Kodex oder dem Kontext.
- problem: was wem widerspricht, in einem Satz.
- evidence: was der Kodex oder der frühere Text sagt.
- source: der Kodex-Eintrag, "bisherige Handlung" oder "vorige Szene".
- severity: "contradiction", wenn es eindeutig ist, "doubt", wenn es Absicht sein könnte.
- suggestion: eine kurze Anweisung zur Korrektur, z. B. "Ändere ihre Augenfarbe in Grün."
Gibt es keine Widersprüche, antworte {"issues": []}.`,
  uk: `Перевір фрагмент нижче на суперечності. Відповідай ЛИШЕ JSON у такій формі:
{"issues": [{"quote": "...", "problem": "...", "evidence": "...", "source": "...", "severity": "contradiction", "suggestion": "..."}]}
- quote: від 3 до 15 слів поспіль, скопійованих точно з фрагмента, з одного абзацу. Ніколи з кодексу чи контексту.
- problem: що чому суперечить, одним реченням.
- evidence: що каже кодекс або попередній текст.
- source: запис кодексу, "попередні події" або "попередня сцена".
- severity: "contradiction", якщо це очевидно, "doubt", якщо це може бути навмисно.
- suggestion: коротка вказівка, як виправити фрагмент, напр. "Зміни колір її очей на зелений."
Якщо суперечностей немає, відповідай {"issues": []}.`,
  it: `Controlla il passaggio qui sotto alla ricerca di contraddizioni. Rispondi SOLO con JSON in questa forma:
{"issues": [{"quote": "...", "problem": "...", "evidence": "...", "source": "...", "severity": "contradiction", "suggestion": "..."}]}
- quote: da 3 a 15 parole consecutive copiate esattamente dal passaggio, da un solo paragrafo. Mai dal codex o dal contesto.
- problem: che cosa contraddice che cosa, in una frase.
- evidence: che cosa dice il codex o il testo precedente.
- source: la voce del codex, "storia finora" o "scena precedente".
- severity: "contradiction" se è chiaro, "doubt" se potrebbe essere voluto.
- suggestion: una breve istruzione per correggere il passaggio, ad es. "Cambia il colore dei suoi occhi in verde."
Se non ci sono contraddizioni, rispondi {"issues": []}.`,
  fr: `Vérifie le passage ci-dessous à la recherche de contradictions. Réponds UNIQUEMENT en JSON sous cette forme :
{"issues": [{"quote": "...", "problem": "...", "evidence": "...", "source": "...", "severity": "contradiction", "suggestion": "..."}]}
- quote : de 3 à 15 mots consécutifs copiés exactement du passage, d'un seul paragraphe. Jamais du codex ni du contexte.
- problem : ce qui contredit quoi, en une phrase.
- evidence : ce que dit le codex ou le texte antérieur.
- source : la fiche du codex, "histoire jusqu'ici" ou "scène précédente".
- severity : "contradiction" si c'est net, "doubt" si cela pourrait être voulu.
- suggestion : une courte instruction pour corriger le passage, p. ex. "Change la couleur de ses yeux en vert."
S'il n'y a aucune contradiction, réponds {"issues": []}.`,
};
