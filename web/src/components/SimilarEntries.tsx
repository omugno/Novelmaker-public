// "Possible duplicates" in the codex sidebar: entries that look like the same thing under two names.
// The author picks the entry that stays; the others are merged into it (their names become aliases,
// their texts are added, every reference moves over, a backup is made first) — or marks the group as
// different, so it is not suggested again.
import { useMemo, useState } from 'react';
import { Copy, Merge } from 'lucide-react';
import { codexTypeLabel, findDuplicateGroups, mergedEntry, N_, pairKey, type CodexEntry, type DuplicateGroup, type Novel } from '@novelmaker/shared';
import { api } from '../lib/api';
import { keys, queryClient } from '../lib/queries';
import { toast } from '../lib/store';
import { Badge, Button, cn, Modal } from './ui';
import { t, tn } from '../lib/i18n';

const REASON: Record<DuplicateGroup['reason'], string> = {
  'same-name': N_('Same name or alias'),
  contained: N_('One name contains the other'),
  similar: N_('Almost the same name'),
};

/** The entry with the most content stays by default. */
const weight = (e: CodexEntry) => e.description.length + e.notes.length + e.aliases.length * 20 + e.fields.length * 20;

export function SimilarEntriesBanner({ novel, entries }: { novel: Novel; entries: CodexEntry[] }) {
  const groups = useMemo(
    () => findDuplicateGroups(entries, { language: novel.language, notDuplicates: novel.settings.notDuplicateCodexPairs }),
    [entries, novel.language, novel.settings.notDuplicateCodexPairs],
  );
  const [open, setOpen] = useState(false);
  if (!groups.length) return null;
  return (
    <div className="mb-2 rounded-md border border-sky-300 bg-sky-50 p-2 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
      {tn(groups.length, '{n} possible duplicate: entries that look like the same thing under two names.', '{n} possible duplicates: entries that look like the same thing under two names.')}
      <Button size="xs" className="mt-1.5 w-full" icon={<Copy className="size-3.5" />} onClick={() => setOpen(true)}>
        {t('Review')}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('Possible duplicates')} width="max-w-2xl">
        <div className="space-y-4">
          {groups.map((g) => (
            <GroupCard key={g.ids.join()} group={g} entries={entries} novel={novel} />
          ))}
        </div>
      </Modal>
    </div>
  );
}

function GroupCard({ group, entries, novel }: { group: DuplicateGroup; entries: CodexEntry[]; novel: Novel }) {
  const members = group.ids.map((id) => entries.find((e) => e.id === id)).filter((e): e is CodexEntry => !!e);
  const [keepId, setKeepId] = useState(() => [...members].sort((a, b) => weight(b) - weight(a))[0]?.id);
  const [busy, setBusy] = useState(false);
  const keep = members.find((e) => e.id === keepId) ?? members[0];
  const others = members.filter((e) => e.id !== keep.id);
  const preview = mergedEntry(keep, others, novel.language);

  const merge = async () => {
    setBusy(true);
    try {
      await api.post(`/api/codex/${keep.id}/merge`, { otherIds: others.map((o) => o.id), patch: preview });
      await queryClient.invalidateQueries({ queryKey: keys.codex(novel.id) });
      await queryClient.invalidateQueries({ queryKey: keys.novel(novel.id) });
      toast.success(t('Merged into “{name}”. A backup was made first.', { name: keep.name }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const different = async () => {
    const pairs = members.flatMap((a, i) => members.slice(i + 1).map((b) => pairKey(a.id, b.id)));
    const notDuplicateCodexPairs = [...new Set([...(novel.settings.notDuplicateCodexPairs ?? []), ...pairs])];
    try {
      const updated = await api.patch<Novel>(`/api/novels/${novel.id}`, { settings: { notDuplicateCodexPairs } });
      queryClient.setQueryData(keys.novel(novel.id), updated);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-stone-200 p-3 text-sm dark:border-stone-700">
      <div className="text-xs text-stone-500">{t(REASON[group.reason])}</div>
      <div className="space-y-1">
        {members.map((e) => (
          <label
            key={e.id}
            className={cn('flex cursor-pointer items-start gap-2 rounded px-2 py-1.5', e.id === keep.id ? 'bg-amber-50 dark:bg-amber-950/30' : 'hover:bg-stone-50 dark:hover:bg-stone-800')}
          >
            <input type="radio" className="mt-1" checked={e.id === keep.id} onChange={() => setKeepId(e.id)} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="font-medium">{e.name}</span>
                <Badge>{codexTypeLabel(e.type)}</Badge>
                {e.id === keep.id && <span className="text-xs text-amber-700 dark:text-amber-400">{t('stays')}</span>}
              </span>
              {e.aliases.length > 0 && <span className="block text-xs text-stone-500">{e.aliases.join(', ')}</span>}
              {e.description && <span className="block truncate text-xs text-stone-500">{e.description}</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="rounded bg-stone-50 p-2 text-xs dark:bg-stone-800/60">
        <div className="mb-1 font-medium">{t('After merging')}</div>
        <div>
          <span className="text-stone-500">{t('Aliases')}: </span>
          {preview.aliases.join(', ') || '—'}
        </div>
        {preview.description && <div className="mt-1 whitespace-pre-line text-stone-600 dark:text-stone-300">{preview.description}</div>}
        <div className="mt-1 text-stone-500">
          {tn(others.length, 'POV, relationships, pins and chat context of the other entry will point to “{name}”; the other entry is deleted.', 'POV, relationships, pins and chat context of the other entries will point to “{name}”; the other entries are deleted.', {
            name: keep.name,
          })}
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" icon={<Merge className="size-3.5" />} loading={busy} onClick={() => void merge()}>
          {t('Merge into “{name}”', { name: keep.name })}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void different()}>
          {t('They are different')}
        </Button>
      </div>
    </div>
  );
}
