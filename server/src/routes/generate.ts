import type { FastifyInstance } from 'fastify';
import { estimateMessagesTokens, t, type EstimateResult, type GenerateRequest, type PreviewResult, type RefValue } from '@novelmaker/shared';
import type { AppContext } from '../app';
import { HttpError } from '../db';
import { listMessages } from '../repo/chat';
import { getProvider } from '../repo/llm';
import { buildParams, estimateGeneration, runGeneration, SseWriter } from '../services/generate';
import { prepareRender, type Prepared } from '../services/promptdata';
import { relatedForRequest } from '../services/semantic';
import { fitNotes, fitPrompt, promptLimit } from '../services/budget';

type Req = GenerateRequest & { chapterId?: string | null; context?: RefValue[] };

function withChatHistory(ctx: AppContext, req: Req): Req {
  if (req.chatThreadId && !req.chatHistory) {
    const history = listMessages(ctx.db, req.chatThreadId).map((m) => ({ role: m.role, content: m.content }));
    return { ...req, chatHistory: history };
  }
  return req;
}

export function registerGenerateRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  /**
   * Renders the prompt; if it asks for related passages (semantic search), looks them up first
   * (`withRelated`; not for the quick estimate). Then fits it into the model's context window,
   * trimming related passages and the story so far (services/budget.ts). Notes become info warnings.
   */
  const preparePrompt = async (body: Req, { withRelated = true, signal }: { withRelated?: boolean; signal?: AbortSignal } = {}): Promise<Prepared> => {
    const first = prepareRender(db, body);
    const rel = withRelated ? await relatedForRequest(db, body, first.prompt.messages, signal) : { passages: [], note: null };
    const limit = body.model ? promptLimit(db, body.model, buildParams(db, body.model, first, body.params)) : null;
    if (!rel.passages.length && !rel.note && limit == null) return first;
    const fit = fitPrompt(db, body, rel.passages, limit);
    const prep = fit.prep;
    if (rel.note) prep.result.warnings.push({ level: 'info', message: rel.note });
    else if (rel.passages.length) prep.result.warnings.push({ level: 'info', message: t('Related passages: {n} from other scenes.', { n: fit.passages.length }) });
    prep.result.warnings.push(...fitNotes(fit));
    return prep;
  };

  /** Fertig gerenderte Nachrichten, Warnungen, Token-Zahl und Kodex-Auswahl – ohne KI-Aufruf. */
  app.post<{ Body: Req }>('/api/preview', async (req): Promise<PreviewResult & { params?: Record<string, unknown> }> => {
    const body = withChatHistory(ctx, req.body);
    const prep = await preparePrompt(body);
    const params = body.model ? buildParams(db, body.model, prep, body.params) : undefined;
    return {
      messages: prep.result.messages,
      warnings: prep.result.warnings,
      tokens: estimateMessagesTokens(prep.result.messages),
      codex: prep.result.codex,
      params,
      estimate: params ? estimateGeneration(db, body, prep, params) : undefined,
    };
  });

  /** Nur Tokens/Kosten schätzen (leichter als die Vorschau, für die Anzeige neben „Generieren“). */
  app.post<{ Body: Req }>('/api/estimate', async (req): Promise<EstimateResult> => {
    const body = withChatHistory(ctx, req.body);
    const prep = await preparePrompt(body, { withRelated: false });
    const params = body.model ? buildParams(db, body.model, prep, body.params) : {};
    return { ...estimateGeneration(db, body, prep, params), warnings: prep.result.warnings };
  });

  /** Generierung mit Streaming (SSE). Abbruch: Verbindung schließen. */
  app.post<{ Body: Req }>('/api/generate', async (req, reply) => {
    const body = withChatHistory(ctx, req.body);
    if (!body.model?.providerId || !body.model.modelId) throw new HttpError(400, t('No model selected.'));
    const provider = getProvider(db, body.model.providerId);
    // the semantic search can take a few seconds (first indexing): open the stream first
    reply.hijack();
    const sse = new SseWriter(reply.raw);
    let prep: Prepared;
    try {
      prep = await preparePrompt(body, { signal: sse.abort.signal });
      if (!prep.result.messages.length) throw new HttpError(400, t('The prompt doesn’t produce any messages.'));
    } catch (e) {
      sse.send('error', { message: (e as Error).message });
      sse.end();
      return;
    }
    const params = buildParams(db, body.model, prep, body.params);

    sse.send('meta', { warnings: prep.result.warnings, promptTokens: estimateMessagesTokens(prep.result.messages), params });
    const result = await runGeneration({
      db,
      provider,
      modelId: body.model.modelId,
      messages: prep.result.messages,
      params,
      log: { novelId: body.novelId, promptId: prep.prompt.id, promptName: prep.prompt.name, kind: body.kind },
      signal: sse.abort.signal,
      onEvent: (ev) => {
        if (ev.type === 'delta') sse.send('delta', { text: ev.text });
        else if (ev.type === 'reasoning') sse.send('reasoning', { text: ev.text });
      },
    });
    if (result.status === 'error') sse.send('error', { message: result.error, logId: result.logId });
    else
      sse.send('done', {
        logId: result.logId,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cost: result.cost,
        finish: result.finish,
        durationMs: result.durationMs,
        status: result.status,
      });
    sse.end();
  });
}
