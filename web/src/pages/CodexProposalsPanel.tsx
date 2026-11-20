// "New entries" in the scene's Codex tab: the AI proposes codex entries for named things in the scene
// (or the selection) that the codex does not have yet. Each proposal can be edited and then created,
// or ignored (it will not be proposed again for this novel).
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { BookPlus, Square, X } from 'lucide-react';
import {
  CODEX_PROPOSAL_TYPE,
  CODEX_TYPES,
  effectiveCodex,
  filterProposals,
  parseCodexProposals,
  proposalKey,
  type CodexProposal,
  type CodexType,
  type GenerateRequest,
  type ModelRef,
  type Novel,
} from '@novelmaker/shared';
import { CostLine, ModelPicker, PromptPicker, useLastSelection, useTouched, WarningsList } from '../components/ai';
import { Button, Input, Select, Spinner, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { keys, patchSettings, queryClient, useCodex, useNovel } from '../lib/queries';
import { aiPinnedCodexIds } from '../lib/pins';
import { toast, useGen } from '../lib/store';
import { fullText, useActiveEditor } from '../editor/scope';
import { t, tn } from '../lib/i18n';

interface ProposalResult {
  proposals: CodexProposal[];
  dropped: number;
  raw?: string;
  error?: string;
}

const useProposals = create<{ results: Record<string, ProposalResult>; set: (sceneId: string, r: ProposalResult | null) => void }>((set) => ({
  results: {},
  set: (sceneId, r) =>
    set((s) => {
      const results = { ...s.results };
      if (r) results[sceneId] = r;
      else delete results[sceneId];
      return { results };
    }),
}));

const TYPES = CODEX_TYPES.filter((c) => c.value !== 'volume');

export function CodexProposalsPanel({ novelId, sceneId }: { novelId: string; sceneId: string }) {
  const { data: codex } = useCodex(novelId);
  const { data: novel } = useNovel(novelId);
  const last = useLastSelection('proposals', [CODEX_PROPOSAL_TYPE], 'codex-proposals');
  const [promptId, setPromptId] = useTouched<string | null>(last.promptId ?? null);
  const [model, setModel] = useTouched<ModelRef | null>(last.model);
  const genKey = `proposals:${sceneId}`;
  const gen = useGen((s) => s.gens[genKey]);
  const start = useGen((s) => s.start);
  const abort = useGen((s) => s.abort);
  const result = useProposals((s) => s.results[sceneId]);
  const setResult = useProposals((s) => s.set);
  const editor = useActiveEditor((s) => (s.sceneId === sceneId ? s.editor : null));
  const [hasSelection, setHasSelection] = useState(false);
  const checked = useRef<{ text: string } | null>(null);
  const handled = useRef<unknown>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const onSel = () => setHasSelection(!editor.state.selection.empty);
    onSel();
    editor.on('selectionUpdate', onSel);
    return () => {
      editor.off('selectionUpdate', onSel);
    };
  }, [editor]);

  // Read and filter the answer once the generation is finished
  useEffect(() => {
    if (!gen || gen.status === 'streaming' || handled.current === gen) return;
    handled.current = gen;
    if (gen.status !== 'done') return;
    const parsed = parseCodexProposals(gen.text);
    if (!parsed.ok) return setResult(sceneId, { proposals: [], dropped: 0, raw: gen.text, error: parsed.error });
    const f = filterProposals(parsed.proposals, {
      text: checked.current?.text ?? '',
      entries: effectiveCodex(codex?.entries ?? []).entries,
      language: novel?.language,
      ignored: novel?.settings.ignoredCodexNames,
    });
    setResult(sceneId, { proposals: f.proposals, dropped: f.dropped.known + f.dropped.notInText + f.dropped.ignored });
  }, [gen, sceneId, setResult, codex, novel]);

  const run = () => {
    if (!editor || editor.isDestroyed) return toast.error(t('Open the scene in the editor first.'));
    if (!promptId || !model) return toast.error(t('Please choose a prompt and a model.'));
    const { from, to, empty } = editor.state.selection;
    const scene = fullText(editor);
    const text = empty ? scene : editor.state.doc.textBetween(from, to, '\n\n');
    if (!text.trim()) return toast.error(t('There is no text to check.'));
    checked.current = { text };
    const req: GenerateRequest = { kind: 'proposals', promptId, model, novelId, sceneId, selection: text, sceneText: scene, pinnedCodexIds: aiPinnedCodexIds(novelId) };
    void patchSettings({ lastSelections: { proposals: { promptId, model } } }).catch(() => undefined);
    void start(genKey, req);
  };

  const remove = (p: CodexProposal) => result && setResult(sceneId, { ...result, proposals: result.proposals.filter((x) => x !== p) });

  const createEntry = async (p: CodexProposal) => {
    try {
      await api.post(`/api/novels/${novelId}/codex`, { type: p.type, name: p.name.trim(), aliases: p.aliases, description: p.description });
      queryClient.invalidateQueries({ queryKey: keys.codex(novelId) });
      remove(p);
      toast.success(t('Codex entry “{name}” created.', { name: p.name.trim() }));
    } catch (e) {
      toast.error(e);
    }
  };

  const ignore = async (p: CodexProposal) => {
    const key = proposalKey(p.name, novel?.language);
    const ignoredCodexNames = [...new Set([...(novel?.settings.ignoredCodexNames ?? []), key])];
    try {
      const updated = await api.patch<Novel>(`/api/novels/${novelId}`, { settings: { ignoredCodexNames } });
      queryClient.setQueryData(keys.novel(novelId), updated);
      remove(p);
    } catch (e) {
      toast.error(e);
    }
  };

  const update = (p: CodexProposal, patch: Partial<CodexProposal>) => {
    if (!result) return;
    setResult(sceneId, { ...result, proposals: result.proposals.map((x) => (x === p ? { ...x, ...patch } : x)) });
  };

  const streaming = gen?.status === 'streaming';
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold tracking-wide text-stone-500 uppercase">{t('New entries')}</div>
      <p className="text-xs text-stone-500">{t('The AI reads the scene (or the selected text) and proposes codex entries for named characters, places and objects that are not in the codex yet.')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <PromptPicker types={[CODEX_PROPOSAL_TYPE]} value={promptId} onChange={setPromptId} />
        <ModelPicker value={model} onChange={setModel} />
      </div>
      <div className="flex items-center gap-2">
        {streaming ? (
          <Button size="sm" icon={<Square className="size-3.5" />} onClick={() => abort(genKey)}>
            {t('Stop')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<BookPlus className="size-3.5" />} onClick={run}>
            {hasSelection ? t('Propose from the selection') : t('Propose entries')}
          </Button>
        )}
        {result && !streaming && (
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => setResult(sceneId, null)}>
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
              <div className="text-red-600">{t('The answer could not be read as a list of entries. Try again or choose another model.')}</div>
              {result.raw && <pre className="max-h-40 overflow-auto rounded bg-stone-100 p-2 whitespace-pre-wrap dark:bg-stone-800">{result.raw}</pre>}
            </div>
          ) : result.proposals.length === 0 ? (
            <div className="text-xs text-stone-500">{t('Nothing new for the codex.')}</div>
          ) : (
            <div className="text-xs text-stone-500">{tn(result.proposals.length, '{n} proposed entry', '{n} proposed entries')}</div>
          )}
          {result.dropped > 0 && !result.error && (
            <div className="text-xs text-stone-400">{tn(result.dropped, '{n} proposal left out (already in the codex, not in the text, or ignored).', '{n} proposals left out (already in the codex, not in the text, or ignored).')}</div>
          )}
          {result.proposals.map((p, i) => (
            <div key={i} className="space-y-1.5 rounded-md border border-stone-200 p-2 dark:border-stone-700">
              <div className="flex gap-1.5">
                <Input value={p.name} onChange={(e) => update(p, { name: e.target.value })} className="h-7 flex-1 text-[13px] font-medium" aria-label={t('Name')} />
                <Select value={p.type} onChange={(e) => update(p, { type: e.target.value as CodexType })} className="h-7 w-32 text-[13px]" aria-label={t('Type')}>
                  {TYPES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {t(c.label)}
                    </option>
                  ))}
                </Select>
              </div>
              <Input
                value={p.aliases.join(', ')}
                onChange={(e) => update(p, { aliases: e.target.value.split(',').map((a) => a.trim()).filter(Boolean) })}
                placeholder={t('Aliases, separated by commas')}
                className="h-7 text-[13px]"
              />
              <Textarea value={p.description} onChange={(e) => update(p, { description: e.target.value })} rows={2} className="text-[13px]" placeholder={t('Description')} />
              {p.quote && <div className="text-xs text-stone-500 italic">“{p.quote}”</div>}
              <div className="flex gap-1.5">
                <Button size="xs" variant="primary" disabled={!p.name.trim()} onClick={() => void createEntry(p)}>
                  {t('Create entry')}
                </Button>
                <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void ignore(p)} title={t('Will not be proposed again for this novel')}>
                  {t('Ignore')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
