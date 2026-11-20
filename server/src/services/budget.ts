// Fitting a prompt into the model's context window. The parts that grow with the novel are trimmed,
// least important first; the codex, the text being written or checked and the instructions are never
// touched (the idea of LoneWriter's token budget: the compendium is never cut).
//   1. related passages (semantic search), least similar first
//   2. the story so far, keeping the most recent part
// Room is left for the answer: max_tokens if set, otherwise DEFAULT_ANSWER_RESERVE.
import {
  DEFAULT_ANSWER_RESERVE,
  estimateMessagesTokens,
  estimateTokens,
  formatRelated,
  renderPrompt,
  t,
  tn,
  type GenerateRequest,
  type ModelRef,
  type RefValue,
  type RelatedPassage,
} from '@novelmaker/shared';
import type { DB } from '../db';
import { findModel } from '../repo/llm';
import { prepareRender, type Prepared } from './promptdata';

type Req = GenerateRequest & { chapterId?: string | null; context?: RefValue[] };

/** Tokens the prompt may use with this model, or null when the model's context size is unknown. */
export function promptLimit(db: DB, model: ModelRef | undefined, params: Record<string, unknown>): number | null {
  if (!model?.providerId || !model.modelId) return null;
  const ctx = findModel(db, model.providerId, model.modelId)?.contextLength;
  if (!ctx) return null;
  const maxTokens = Number(params.max_tokens);
  const reserve = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_ANSWER_RESERVE;
  return Math.max(1024, ctx - reserve);
}

/** How many tokens the story so far takes in this prompt's data. */
function storyTokens(prep: Prepared): number {
  const r = renderPrompt({ type: prep.prompt.type, messages: [{ type: 'user', text: '{storySoFar}', format: 'aic2' }], inputs: [] }, prep.data);
  return estimateTokens(r.messages[0]?.content ?? '');
}

export interface FitResult {
  prep: Prepared;
  /** Related passages that stayed in the prompt */
  passages: RelatedPassage[];
  droppedPassages: number;
  storyTrimmed: boolean;
  limit: number | null;
  tokens: number;
}

/**
 * Renders the prompt with the related passages and trims until it fits `limit` (if given).
 * `params` decides the room for the answer and comes from the first render (buildParams).
 */
export function fitPrompt(db: DB, body: Req, passages: RelatedPassage[], limit: number | null): FitResult {
  let kept = passages;
  let story: number | undefined;
  const render = () => prepareRender(db, { ...body, related: kept.length ? formatRelated(kept) : '', storySoFarMaxTokens: story } as Req);
  let prep = render();
  let tokens = estimateMessagesTokens(prep.result.messages);
  if (limit == null || tokens <= limit) return { prep, passages: kept, droppedPassages: 0, storyTrimmed: false, limit, tokens };

  while (tokens > limit && kept.length) {
    kept = kept.slice(0, -1);
    prep = render();
    tokens = estimateMessagesTokens(prep.result.messages);
  }
  let storyTrimmed = false;
  if (tokens > limit) {
    const have = storyTokens(prep);
    if (have > 0) {
      story = Math.max(0, have - (tokens - limit) - 50);
      prep = render();
      tokens = estimateMessagesTokens(prep.result.messages);
      storyTrimmed = true;
    }
  }
  return { prep, passages: kept, droppedPassages: passages.length - kept.length, storyTrimmed, limit, tokens };
}

/** Info lines for the warnings list: what was trimmed, or that it still does not fit. */
export function fitNotes(f: FitResult): { level: 'info' | 'warning'; message: string }[] {
  const out: { level: 'info' | 'warning'; message: string }[] = [];
  if (f.droppedPassages)
    out.push({
      level: 'info',
      message: tn(f.droppedPassages, 'To fit the context window, {n} related passage was left out.', 'To fit the context window, {n} related passages were left out.'),
    });
  if (f.storyTrimmed) out.push({ level: 'info', message: t('To fit the context window, the story so far keeps only the most recent part.') });
  if (f.limit != null && f.tokens > f.limit)
    out.push({ level: 'warning', message: t('Even after trimming, the prompt (≈{tokens} tokens) is larger than the room the model has ({limit}).', { tokens: f.tokens, limit: f.limit }) });
  return out;
}
