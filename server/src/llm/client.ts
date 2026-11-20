// Ein Client für alle OpenAI-kompatiblen APIs (/v1/chat/completions mit Streaming).
import { t, type Provider, type ProviderModel, type RenderedMessage } from '@novelmaker/shared';
import { Agent, fetch, type Response } from 'undici';

// Lokale Modelle (LM Studio, Ollama) verarbeiten lange Prompts oft viele Minuten, bevor das erste Token kommt.
// Das eingebaute fetch bricht nach 5 Minuten ohne Daten ab („terminated“), daher hier ohne Zeitlimit.
// Abbrechen geht weiterhin über das AbortSignal (Stopp-Knopf, Job abbrechen).
const llmAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

function headers(p: Provider): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  if (p.kind === 'openrouter') {
    h['HTTP-Referer'] = 'http://localhost:3000';
    h['X-Title'] = 'Novelmaker';
  }
  return h;
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const j = JSON.parse(body);
    const msg = j?.error?.message ?? j?.message ?? j?.error ?? body;
    const raw = j?.error?.metadata?.raw;
    return `${typeof msg === 'string' ? msg : JSON.stringify(msg)}${raw ? ` (${String(raw).slice(0, 300)})` : ''}`;
  } catch {
    return body.slice(0, 500) || res.statusText;
  }
}

/**
 * Netzwerkfehler lesbar machen: fetch meldet nur „fetch failed“ bzw. „terminated“, der eigentliche Grund
 * (z. B. „connect ECONNREFUSED …“, „other side closed“) steht in `cause`.
 * `connected`: Die Verbindung stand schon (Antwort lief bereits), die Gegenseite hat sie beendet.
 */
function networkError(p: Provider, e: Error, connected = false): LlmError {
  const cause = (e as { cause?: Error & { code?: string } }).cause;
  const error = cause?.message || cause?.code || e.message;
  const vars = { name: p.name, error };
  if (connected || cause?.code === 'UND_ERR_SOCKET') return new LlmError(t('The connection to {name} was interrupted ({error})', vars));
  return new LlmError(t('{name} is unreachable ({error})', vars));
}

export async function fetchModels(p: Provider): Promise<ProviderModel[]> {
  let res: Response;
  try {
    res = await fetch(`${p.baseUrl}/models`, { headers: headers(p), signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw networkError(p, e as Error);
  }
  if (!res.ok) throw new LlmError(`${p.name}: ${res.status} ${await errorText(res)}`, res.status);
  const j = (await res.json()) as { data?: any[]; models?: any[] };
  const list = j.data ?? j.models ?? [];
  return list
    .map((m: any): ProviderModel => {
      const pricing =
        m.pricing && (m.pricing.prompt != null || m.pricing.completion != null)
          ? { prompt: Number(m.pricing.prompt) || 0, completion: Number(m.pricing.completion) || 0 }
          : undefined;
      return {
        id: String(m.id ?? m.name ?? m.model),
        name: m.name && m.name !== m.id ? String(m.name) : undefined,
        contextLength: m.context_length ?? m.top_provider?.context_length ?? m.max_context_length ?? undefined,
        pricing,
      };
    })
    .filter((m: ProviderModel) => m.id && m.id !== 'undefined')
    .sort((a: ProviderModel, b: ProviderModel) => a.id.localeCompare(b.id));
}

/** Vectors for several texts from an OpenAI-compatible /embeddings endpoint, in input order. */
export async function fetchEmbeddings(p: Provider, model: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
  let res: Response;
  try {
    res = await fetch(`${p.baseUrl}/embeddings`, {
      method: 'POST',
      headers: headers(p),
      body: JSON.stringify({ model, input }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw networkError(p, e as Error);
  }
  if (!res.ok) throw new LlmError(`${p.name}: ${res.status} ${await errorText(res)}`, res.status);
  const j = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
  const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== input.length || data.some((d) => !Array.isArray(d.embedding)))
    throw new LlmError(t('{name}: the answer has {got} vectors for {want} texts', { name: p.name, got: data.length, want: input.length }));
  return data.map((d) => d.embedding!);
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null; cost: number | null }
  | { type: 'finish'; reason: string };

export interface ChatRequest {
  provider: Provider;
  model: string;
  messages: RenderedMessage[];
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Streamt eine Chat-Completion. Wirft LlmError bei HTTP- oder API-Fehlern. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const { provider, model, messages, params, signal } = req;
  const body: Record<string, unknown> = { ...(params ?? {}), model, messages, stream: true };
  if (provider.kind === 'openrouter') {
    body.usage = { include: true };
    body.stream_options = { include_usage: true };
  }
  let res: Response;
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify(body),
      signal,
      dispatcher: llmAgent,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw networkError(provider, e as Error);
  }
  if (!res.ok || !res.body) throw new LlmError(`${provider.name}: ${res.status} ${await errorText(res)}`, res.status);

  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('event-stream') && ctype.includes('json')) {
    // Server ignoriert stream=true
    const j = (await res.json()) as any;
    if (j.error) throw new LlmError(String(j.error.message ?? j.error));
    const text = j.choices?.[0]?.message?.content ?? '';
    if (text) yield { type: 'delta', text };
    if (j.usage) yield { type: 'usage', promptTokens: j.usage.prompt_tokens ?? null, completionTokens: j.usage.completion_tokens ?? null, cost: j.usage.cost ?? null };
    return;
  }

  const reader = res.body.getReader();
  const read = () =>
    reader.read().catch((e: Error) => {
      if (e.name === 'AbortError') throw e;
      throw networkError(provider, e, true);
    });
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new LlmError(String(j.error.message ?? JSON.stringify(j.error)));
        const choice = j.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) yield { type: 'delta', text: delta.content };
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
        if (choice?.text && typeof choice.text === 'string') yield { type: 'delta', text: choice.text };
        if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
        if (j.usage)
          yield {
            type: 'usage',
            promptTokens: j.usage.prompt_tokens ?? null,
            completionTokens: j.usage.completion_tokens ?? null,
            cost: typeof j.usage.cost === 'number' ? j.usage.cost : null,
          };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Nicht streamend (für Hintergrund-Jobs): sammelt den Stream ein. */
export async function completeChat(req: ChatRequest): Promise<{ text: string; promptTokens: number | null; completionTokens: number | null; cost: number | null; finish: string | null }> {
  let text = '';
  let usage = { promptTokens: null as number | null, completionTokens: null as number | null, cost: null as number | null };
  let finish: string | null = null;
  for await (const ev of streamChat(req)) {
    if (ev.type === 'delta') text += ev.text;
    else if (ev.type === 'usage') usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, cost: ev.cost };
    else if (ev.type === 'finish') finish = ev.reason;
  }
  return { text, ...usage, finish };
}
