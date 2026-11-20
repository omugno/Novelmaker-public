import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Search, Sparkles } from 'lucide-react';
import { codexTypeLabel, type ModelRef, type RelatedPassage } from '@novelmaker/shared';
import { api } from '../lib/api';
import { useSettings } from '../lib/queries';
import { toast } from '../lib/store';
import { Badge, Button, Empty, Input, Spinner, Tabs } from '../components/ui';
import { t, tn } from '../lib/i18n';

interface Result {
  scenes: { sceneId: string; label: string; count: number; excerpts: string[] }[];
  codex: { id: string; name: string; type: string }[];
  snippets: { id: string; title: string }[];
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-amber-200 px-0.5 dark:bg-amber-700/60 dark:text-white">{p}</mark> : p));
}

type Mode = 'exact' | 'meaning';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get('mode') === 'meaning' ? 'meaning' : 'exact';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Tabs
          value={mode}
          onChange={(m) => setParams(m === 'meaning' ? { mode: m } : {}, { replace: true })}
          className="mb-4"
          tabs={[
            { value: 'exact', label: t('Exact text') },
            { value: 'meaning', label: t('By meaning') },
          ]}
        />
        {mode === 'exact' ? <ExactSearch /> : <MeaningSearch />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- By meaning (semantic search)

interface SemanticStatus {
  model: ModelRef | null;
  passages: number;
  scenes: number;
}

function MeaningSearch() {
  const { novelId = '' } = useParams();
  const navigate = useNavigate();
  const { data: settings } = useSettings();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<RelatedPassage[] | null>(null);
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const loadStatus = () => void api.get<SemanticStatus>(`/api/novels/${novelId}/semantic`).then(setStatus).catch(() => undefined);
  useEffect(loadStatus, [novelId]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      setHits(await api.post<RelatedPassage[]>(`/api/novels/${novelId}/semantic/search`, { query: q.trim(), k: 15 }));
      loadStatus();
    } catch (e) {
      toast.error(e);
    } finally {
      setLoading(false);
    }
  };
  if (settings && !settings.embeddingModel)
    return (
      <Empty icon={<Sparkles className="size-8" />} title={t('Semantic search is off')}>
        <Link to="/settings/general" className="text-amber-700 underline underline-offset-2 dark:text-amber-400">
          {t('Choose an embedding model in Settings → General.')}
        </Link>
      </Empty>
    );
  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="relative flex-1">
          <Sparkles className="absolute top-3 left-3 size-4 text-stone-400" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Describe what you are looking for, e.g. “the ring she lost”…')} className="h-10 pl-9 text-base" />
        </div>
        <Button type="submit" variant="primary" className="h-10" loading={loading}>
          {t('Search')}
        </Button>
      </form>
      <p className="text-xs text-stone-500">
        {t('Finds passages that mean something similar, even with other words. The first search indexes the novel (can take a minute); later only changed passages.')}
        {status && status.passages > 0 && ` ${tn(status.passages, '{n} passage indexed.', '{n} passages indexed.')}`}
      </p>
      {hits && !loading && hits.length === 0 && <Empty title={t('Nothing found')} />}
      {hits?.map((h, i) => (
        <button
          key={i}
          type="button"
          onClick={() => navigate(`/novel/${novelId}/write/${h.sceneId}`)}
          className="block w-full rounded-lg border border-stone-200 p-3 text-left hover:bg-white dark:border-stone-800 dark:hover:bg-stone-900"
        >
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            {h.location}
            <Badge>{Math.round(h.score * 100)} %</Badge>
          </div>
          <div className="font-serif text-[15px] whitespace-pre-line text-stone-600 dark:text-stone-300">{h.text}</div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Exact text

function ExactSearch() {
  const { novelId = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const h = setTimeout(async () => {
      setParams(q ? { q } : {}, { replace: true });
      if (q.trim().length < 2) return setRes(null);
      setLoading(true);
      try {
        setRes(await api.get<Result>(`/api/novels/${novelId}/search?q=${encodeURIComponent(q.trim())}`));
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(h);
  }, [q, novelId]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = res ? res.scenes.reduce((n, s) => n + s.count, 0) : 0;
  return (
    <>
      <div className="relative mb-6">
        <Search className="absolute top-3 left-3 size-4 text-stone-400" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search the novel, Codex, and snippets…')} className="h-10 pl-9 text-base" />
      </div>
      {loading && <Spinner />}
      {res && !loading && (
        <div className="space-y-6">
          <div className="text-sm text-stone-500">
            {tn(res.scenes.length, 'Matches: {total} in {n} scene', 'Matches: {total} in {n} scenes', { total })}
          </div>
          {res.scenes.map((s) => (
            <button key={s.sceneId} type="button" onClick={() => navigate(`/novel/${novelId}/write/${s.sceneId}`)} className="block w-full rounded-lg border border-stone-200 p-3 text-left hover:bg-white dark:border-stone-800 dark:hover:bg-stone-900">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                {s.label}
                <Badge>{s.count}×</Badge>
              </div>
              {s.excerpts.map((e, i) => (
                <div key={i} className="font-serif text-[15px] text-stone-600 dark:text-stone-300">
                  {highlight(e, q.trim())}
                </div>
              ))}
            </button>
          ))}
          {res.codex.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">{t('Codex')}</div>
              <div className="flex flex-wrap gap-2">
                {res.codex.map((c) => (
                  <button key={c.id} type="button" onClick={() => navigate(`/novel/${novelId}/codex/${c.id}`)} className="rounded-full border border-stone-200 px-3 py-1 text-sm hover:bg-white dark:border-stone-700 dark:hover:bg-stone-900">
                    {c.name} <span className="text-xs text-stone-400">{codexTypeLabel(c.type)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {res.snippets.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">{t('Snippets')}</div>
              <div className="flex flex-wrap gap-2">
                {res.snippets.map((s) => (
                  <button key={s.id} type="button" onClick={() => navigate(`/novel/${novelId}/snippets/${s.id}`)} className="rounded-full border border-stone-200 px-3 py-1 text-sm hover:bg-white dark:border-stone-700 dark:hover:bg-stone-900">
                    {s.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!res.scenes.length && !res.codex.length && !res.snippets.length && <Empty title={t('Nothing found')} />}
        </div>
      )}
    </>
  );
}
