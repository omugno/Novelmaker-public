// "Continuity" tab of the scene panel: checks the scene (or the selected text) against the codex,
// the story so far and the end of the previous scene. Each issue is underlined in the text;
// "Fix…" opens the normal rewrite panel with the proposed fix, so the author accepts or discards it.
import { useEffect, useReducer, useRef, useState } from 'react';
import { Crosshair, ShieldCheck, Square, Wand2, X } from 'lucide-react';
import { CONTINUITY_TYPE, parseContinuityResponse, type ContinuityIssue, type GenerateRequest, type ModelRef } from '@novelmaker/shared';
import { CostLine, ModelPicker, PromptPicker, useLastSelection, useTouched, WarningsList } from '../components/ai';
import { Badge, Button, cn, Spinner } from '../components/ui';
import { patchSettings } from '../lib/queries';
import { toast, useGen } from '../lib/store';
import { useContinuity, type ContinuityResult } from '../lib/continuity';
import { aiPinnedCodexIds } from '../lib/pins';
import { fullText, useActiveEditor } from '../editor/scope';
import { findIssueRange } from '../editor/extensions';
import { useRewrite } from '../editor/RewritePanel';
import { t, tn } from '../lib/i18n';
import type { Editor } from '@tiptap/core';

const SENTENCE_END = /[.!?…]["»”’)]*\s/g;

/** Widens a range to the whole sentence(s) around it, inside one paragraph: a better unit to rewrite. */
function sentenceRange(editor: Editor, from: number, to: number): { from: number; to: number } {
  const $from = editor.state.doc.resolve(from);
  const block = $from.parent;
  if (!block.isTextblock) return { from, to };
  const start = $from.start();
  const text = block.textContent;
  const a = from - start;
  const b = to - start;
  let s = 0;
  let e = text.length;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index! + m[0].length;
    if (end <= a) s = end;
    else if (m.index! + 1 >= b) {
      e = m.index! + m[0].trimEnd().length;
      break;
    }
  }
  return { from: start + s, to: start + Math.max(e, b) };
}

function editorFor(sceneId: string): Editor | null {
  const ed = useActiveEditor.getState();
  return ed.sceneId === sceneId && ed.editor && !ed.editor.isDestroyed ? ed.editor : null;
}

export function ContinuityPanel({ novelId, sceneId }: { novelId: string; sceneId: string }) {
  const last = useLastSelection('continuity', [CONTINUITY_TYPE], 'continuity-check');
  const [promptId, setPromptId] = useTouched<string | null>(last.promptId ?? null);
  const [model, setModel] = useTouched<ModelRef | null>(last.model);
  const genKey = `continuity:${sceneId}`;
  const gen = useGen((s) => s.gens[genKey]);
  const start = useGen((s) => s.start);
  const abort = useGen((s) => s.abort);
  const result = useContinuity((s) => s.results[sceneId]);
  const setResult = useContinuity((s) => s.setResult);
  const dismiss = useContinuity((s) => s.dismiss);
  const clear = useContinuity((s) => s.clear);
  const [hasSelection, setHasSelection] = useState(false);
  const scopeRef = useRef<ContinuityResult['scope']>('scene');
  const handled = useRef<unknown>(null);

  // Follow this scene's editor: a selection switches to "check selection"; edits can make a quote disappear
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const activeEditor = useActiveEditor((s) => (s.sceneId === sceneId ? s.editor : null));
  useEffect(() => {
    const ed = activeEditor;
    if (!ed || ed.isDestroyed) return;
    const onSelection = () => setHasSelection(!ed.state.selection.empty);
    onSelection();
    ed.on('selectionUpdate', onSelection);
    ed.on('update', rerender);
    return () => {
      ed.off('selectionUpdate', onSelection);
      ed.off('update', rerender);
    };
  }, [activeEditor]);

  // Read the answer once the generation is finished
  useEffect(() => {
    if (!gen || gen.status === 'streaming' || handled.current === gen) return;
    handled.current = gen;
    if (gen.status !== 'done') return;
    const parsed = parseContinuityResponse(gen.text);
    const checkedAt = new Date().toISOString();
    if (parsed.ok) setResult(sceneId, { issues: parsed.issues, scope: scopeRef.current, checkedAt });
    else setResult(sceneId, { issues: [], scope: scopeRef.current, checkedAt, raw: gen.text, error: parsed.error });
  }, [gen, sceneId, setResult]);

  const run = () => {
    const ed = editorFor(sceneId);
    if (!ed) return toast.error(t('Open the scene in the editor first.'));
    if (!promptId || !model) return toast.error(t('Please choose a prompt and a model.'));
    const { from, to, empty } = ed.state.selection;
    const scene = fullText(ed);
    const text = empty ? scene : ed.state.doc.textBetween(from, to, '\n\n');
    if (!text.trim()) return toast.error(t('There is no text to check.'));
    scopeRef.current = empty ? 'scene' : 'selection';
    const req: GenerateRequest = {
      kind: 'continuity',
      promptId,
      model,
      novelId,
      sceneId,
      selection: text,
      sceneText: scene,
      pinnedCodexIds: aiPinnedCodexIds(novelId),
    };
    void patchSettings({ lastSelections: { continuity: { promptId, model } } }).catch(() => undefined);
    void start(genKey, req);
  };

  const goTo = (issue: ContinuityIssue) => {
    const ed = editorFor(sceneId);
    const r = ed && findIssueRange(ed.state.doc, issue.quote);
    if (!ed || !r) return;
    ed.chain().focus().setTextSelection(r).scrollIntoView().run();
  };

  const fix = (issue: ContinuityIssue) => {
    const ed = editorFor(sceneId);
    const r = ed && findIssueRange(ed.state.doc, issue.quote);
    if (!ed || !r) return;
    const range = sentenceRange(ed, r.from, r.to);
    useRewrite.getState().open({
      editor: ed,
      sceneId,
      novelId,
      from: range.from,
      to: range.to,
      original: ed.state.doc.textBetween(range.from, range.to, '\n\n'),
      builtinKey: 'custom-edit',
      instruction: issue.suggestion || issue.problem,
    });
  };

  const streaming = gen?.status === 'streaming';
  const doc = editorFor(sceneId)?.state.doc;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-stone-500">
        {t('Compares this scene with the codex, the story so far and the end of the previous scene, and underlines contradictions in the text. Select text first to check only that part.')}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <PromptPicker types={[CONTINUITY_TYPE]} value={promptId} onChange={setPromptId} />
        <ModelPicker value={model} onChange={setModel} />
      </div>
      <div className="flex items-center gap-2">
        {streaming ? (
          <Button size="sm" icon={<Square className="size-3.5" />} onClick={() => abort(genKey)}>
            {t('Stop')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<ShieldCheck className="size-3.5" />} onClick={run}>
            {hasSelection ? t('Check selection') : t('Check scene')}
          </Button>
        )}
        {result && !streaming && (
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => clear(sceneId)}>
            {t('Clear')}
          </Button>
        )}
      </div>

      {streaming && (
        <div className="flex items-center gap-2 text-xs text-stone-500">
          <Spinner className="size-3.5" />
          {gen.text ? t('Writing the answer…') : gen.reasoning ? t('The model is thinking…') : t('Waiting for the model…')}
        </div>
      )}
      {gen && gen.status === 'error' && <div className="text-xs text-red-600">{gen.error}</div>}
      {gen && !streaming && gen.warnings.length > 0 && <WarningsList warnings={gen.warnings} />}
      {gen && !streaming && <CostLine cost={gen.cost} promptTokens={gen.promptTokens} completionTokens={gen.completionTokens} />}

      {result && !streaming && (
        <div className="space-y-2">
          {result.error ? (
            <div className="space-y-1 text-xs">
              <div className="text-red-600">{t('The answer could not be read as a list of issues. Try again or choose another model.')}</div>
              {result.raw && <pre className="max-h-40 overflow-auto rounded bg-stone-100 p-2 whitespace-pre-wrap dark:bg-stone-800">{result.raw}</pre>}
            </div>
          ) : result.issues.length === 0 ? (
            <div className="text-green-700 dark:text-green-400">{result.scope === 'selection' ? t('No contradictions found in the selection.') : t('No contradictions found in this scene.')}</div>
          ) : (
            <div className="text-xs text-stone-500">{tn(result.issues.length, '{n} possible contradiction', '{n} possible contradictions')}</div>
          )}
          {result.issues.map((issue, i) => {
            const found = !!(doc && findIssueRange(doc, issue.quote));
            return (
              <div key={i} className={cn('space-y-1.5 rounded-md border p-2', issue.severity === 'doubt' ? 'border-amber-300 dark:border-amber-800' : 'border-red-300 dark:border-red-900')}>
                <div className="flex items-start gap-2">
                  <Badge tone={issue.severity === 'doubt' ? 'amber' : 'red'}>{issue.severity === 'doubt' ? t('Doubt') : t('Contradiction')}</Badge>
                  <button
                    type="button"
                    disabled={!found}
                    onClick={() => goTo(issue)}
                    className={cn('min-w-0 flex-1 text-left italic', found ? 'hover:underline' : 'text-stone-400 line-through')}
                    title={found ? t('Show in the text') : t('No longer in the text')}
                  >
                    “{issue.quote}”
                  </button>
                </div>
                {issue.problem && <div>{issue.problem}</div>}
                {(issue.evidence || issue.source) && (
                  <div className="text-xs text-stone-500">
                    {issue.evidence}
                    {issue.source && <span className="text-stone-400"> — {issue.source}</span>}
                  </div>
                )}
                {issue.suggestion && <div className="text-xs text-stone-600 dark:text-stone-300">→ {issue.suggestion}</div>}
                <div className="flex gap-1.5 pt-0.5">
                  {found ? (
                    <>
                      <Button size="xs" icon={<Wand2 className="size-3" />} onClick={() => fix(issue)}>
                        {t('Fix…')}
                      </Button>
                      <Button size="xs" variant="ghost" icon={<Crosshair className="size-3" />} onClick={() => goTo(issue)}>
                        {t('Show')}
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-stone-400">{t('No longer in the text (changed, or the quote was inexact).')}</span>
                  )}
                  <Button size="xs" variant="ghost" className="ml-auto" onClick={() => dismiss(sceneId, issue)}>
                    {t('Dismiss')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
