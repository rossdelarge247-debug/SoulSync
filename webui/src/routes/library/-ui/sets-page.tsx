import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/form';
import { Notice, Skeleton, StatusTag } from '@/components/primitives';
/**
 * Library → Sets (/library?view=sets; boards 22a–22i, states 22r–22s): the
 * set planner. Its two ways in are tabs, "Suggest a set" (the AI's, Sets 2:
 * shown, not yet usable, and says why) and "Famous mix"; "New empty set"
 * starts one by hand; Your sets lists what's saved. `set` in the URL picks
 * the page: a saved set's id, `draft`, `famous` or `paste`.
 */
import { useWorkingSet } from '@/features/mix/mix.api';
import { readDraft, useDraft, writeDraft } from '@/features/sets/draft-store';
import { Sparkline } from '@/features/sets/energy-graph';
import { FamousSearch, PasteTracklist } from '@/features/sets/famous-mix';
import { RemoveSetDialog, WorkingSetToggle } from '@/features/sets/set-actions';
import { SetEditor } from '@/features/sets/set-editor';
import {
  deleteSet,
  setQueryOptions,
  setsListQueryOptions,
  type SetListItem,
} from '@/features/sets/sets.api';
import { KIND_TAGS, newSetName, setRowMeta, whenWords } from '@/features/sets/sets.format';
import styles from '@/features/sets/sets.module.css';
import { useProfile } from '@/platform/shell/route-controllers';

import type { LibrarySearch } from '../-library.types';
import type { Go } from './albums-page';

import hs from './history.module.css';
import { MoreMenu } from './parts';

function usePhone(): boolean {
  const query = '(max-width: 640px)';
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const on = () => setPhone(list.matches);
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** Why "Suggest a set" waits (SafeAction v2: the reason beside the disabled control). */
export const SUGGEST_REASON =
  'Set suggestions come with the next step of Sets. Famous mixes and sets built by hand work now.';

function Tabs({ onFamous }: { onFamous: () => void }) {
  return (
    <div className={styles.tabsRow}>
      <div className={styles.tabs} role="tablist" aria-label="Ways to start a set">
        <button
          type="button"
          role="tab"
          aria-selected="false"
          aria-disabled="true"
          aria-describedby="sets-suggest-reason"
          className={styles.tab}
          data-disabled="true"
        >
          Suggest a set
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          className={styles.tab}
          onClick={onFamous}
        >
          Famous mix
        </button>
      </div>
      <p id="sets-suggest-reason" className={styles.tabReason}>
        <i aria-hidden="true" />
        {SUGGEST_REASON}
      </p>
    </div>
  );
}

function YourSets({
  sets,
  onOpen,
  onDraft,
  onRemove,
}: {
  sets: SetListItem[];
  onOpen: (id: number) => void;
  onDraft: (() => void) | null;
  onRemove: (set: SetListItem) => void;
}) {
  const { profileId } = useProfile();
  const draft = useDraft(profileId);
  const workingId = useWorkingSet(profileId)?.id ?? null;
  return (
    <section className={styles.yourSets} aria-labelledby="your-sets">
      <h2 id="your-sets" className={styles.overline}>
        Your sets
      </h2>
      <ul className={styles.setList}>
        {draft && onDraft ? (
          <li>
            <button type="button" className={styles.setRow} onClick={onDraft} data-set-row="draft">
              <Sparkline energy={[]} />
              <span className={styles.setText}>
                <span className={styles.setName}>{draft.name}</span>
                <span className={styles.setMeta}>
                  {setRowMeta(draft.rows.filter((r) => r.track_id).length, 0)}
                </span>
              </span>
              <StatusTag tone="neutral">{KIND_TAGS[draft.kind]}</StatusTag>
              <span className={styles.setWhen}>Draft · {whenWords(draft.updatedAt / 1000)}</span>
            </button>
          </li>
        ) : null}
        {sets.map((s) => (
          <li key={s.id} className={styles.setItem}>
            <button
              type="button"
              className={styles.setRow}
              onClick={() => onOpen(s.id)}
              data-set-row={s.id}
            >
              <Sparkline energy={s.energy} />
              <span className={styles.setText}>
                <span className={styles.setName}>
                  {s.name}
                  {/* 33e: the working set's tag in Your sets */}
                  {workingId === s.id ? (
                    <span className={styles.headTag} data-tone="accent" data-set-tag="working">
                      Working set
                    </span>
                  ) : null}
                </span>
                <span className={styles.setMeta}>
                  <span className={styles.setKindInline}>{KIND_TAGS[s.kind]} · </span>
                  {s.kind === 'famous' && s.lines > s.tracks
                    ? `${s.tracks} of ${s.lines} · ${setRowMeta(s.tracks, s.seconds).split(' · ')[1] ?? ''}`.replace(
                        / · $/,
                        '',
                      )
                    : setRowMeta(s.tracks, s.seconds)}
                </span>
              </span>
              <StatusTag tone="neutral" className={styles.setKind}>
                {KIND_TAGS[s.kind]}
              </StatusTag>
              <span className={styles.setWhen}>{whenWords(s.updated_at)}</span>
            </button>
            {/* 33e: "✓ Working set" on the working one, "Make this my working set" on the rest */}
            <WorkingSetToggle setId={s.id} name={s.name} compact />
            <MoreMenu
              className={styles.setMore}
              label={`More for ${s.name}`}
              entries={[
                { key: 'open', label: 'Open', onSelect: () => onOpen(s.id) },
                {
                  key: 'remove',
                  label: 'Remove this set…',
                  tone: 'danger',
                  onSelect: () => onRemove(s),
                },
              ]}
            />
          </li>
        ))}
      </ul>
      {!sets.length && !draft ? (
        <p className={styles.stateLine}>
          No sets yet. Start one by hand, from a famous mix, or from tracks you pick on Tracks.
        </p>
      ) : null}
    </section>
  );
}

function SavedSet({ id, go }: { id: number; go: Go }) {
  const { profileId } = useProfile();
  const query = useQuery({ ...setQueryOptions(profileId, id), retry: false });
  if (query.isPending) return <Skeleton className={styles.graphSkeleton} />;
  if (query.isError) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't open that set"
        actions={
          <Button size="lg" variant="secondary" onClick={() => go({ set: '' })}>
            Back to Sets
          </Button>
        }
      >
        {query.error instanceof Error ? query.error.message : 'It may have been removed.'}
      </Notice>
    );
  }
  const { set, rows } = query.data;
  return (
    <SetEditor
      // a newer revision from the server is taken in place by the editor
      // (when nothing there is unsaved), so the editor keeps its edits
      key={set.id}
      source={{
        kind: 'saved',
        id: set.id,
        name: set.name,
        rows: rows.map(({ track: _t, ...row }) => row),
        playlistId: set.playlist_id,
        playlistState: set.playlist_state ?? null,
        revision: set.revision ?? 0,
        base: {
          kind: set.kind,
          source: set.source,
          source_id: set.source_id,
          source_url: set.source_url,
          source_meta: set.source_meta,
          shape: set.shape,
        },
      }}
      onSaved={(next) => go({ set: String(next) })}
      onFamous={() => go({ set: 'famous' })}
      onDeleted={() => go({ set: '' })}
      onBack={() => go({ set: '' })}
    />
  );
}

export function SetsPage({ search, go }: { search: LibrarySearch; go: Go }) {
  const { profileId, isAdmin } = useProfile();
  const phone = usePhone();
  const list = useQuery({ ...setsListQueryOptions(profileId), retry: false });
  const draft = useDraft(profileId);
  const page = search.set;
  const [removing, setRemoving] = useState<SetListItem | null>(null);

  const newSet = () => {
    if (
      readDraft(profileId) &&
      !window.confirm('Start a new set? The draft you have in this browser is replaced.')
    )
      return;
    writeDraft(profileId, { name: newSetName(), kind: 'hand', rows: [] });
    go({ set: 'draft' });
  };

  if (page === 'draft') {
    if (!draft) {
      return (
        <div className={`${hs.page} ${styles.page}`}>
          <Notice
            tone="info"
            title="No draft in this browser"
            actions={
              <Button size="lg" variant="secondary" onClick={() => go({ set: '' })}>
                Back to Sets
              </Button>
            }
          >
            Drafts are kept in the browser that made them until they&apos;re saved as a set.
          </Notice>
        </div>
      );
    }
    return (
      <div className={`${hs.page} ${styles.page}`}>
        <SetEditor
          source={{ kind: 'draft', draft }}
          onFamous={() => go({ set: 'famous' })}
          onSaved={(id) => go({ set: String(id) })}
          onDeleted={() => go({ set: '' })}
          onBack={() => go({ set: '' })}
        />
      </div>
    );
  }
  if (page && /^\d+$/.test(page)) {
    return (
      <div className={`${hs.page} ${styles.page}`}>
        <SavedSet id={Number(page)} go={go} />
      </div>
    );
  }
  if (page === 'famous' || page === 'paste') {
    return (
      <div className={`${hs.page} ${styles.page} ${styles.famousPage}`}>
        <nav className={styles.crumbs} aria-label="Where you are">
          <button type="button" className={styles.crumbLink} onClick={() => go({ set: '', q: '' })}>
            Sets
          </button>
          <span aria-hidden="true">/</span>
          <span className={styles.crumbHere}>Famous mix</span>
        </nav>
        {page === 'famous' ? (
          <FamousSearch
            q={search.q}
            onQuery={(q) => go({ q }, { replace: true })}
            phone={phone}
            isAdmin={Boolean(isAdmin)}
            onPaste={() => go({ set: 'paste' })}
            onSaved={(id) => go({ set: String(id), q: '' })}
            onOpenSaved={(id) => go({ set: String(id), q: '' })}
          />
        ) : (
          <PasteTracklist
            phone={phone}
            onSearch={() => go({ set: 'famous' })}
            onSaved={(id) => go({ set: String(id) })}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`${hs.page} ${styles.page}`} data-sets-page="">
      <header className={hs.header}>
        <div className={hs.headText}>
          <h1 className={hs.heading}>Sets</h1>
          <p className={hs.subtitle}>
            Plan a set from your library: start from a famous mix, or build it by hand.
          </p>
        </div>
        <Button size="lg" variant="secondary" onClick={newSet}>
          New empty set
        </Button>
      </header>
      <Tabs onFamous={() => go({ set: 'famous' })} />
      {list.isError ? (
        <Notice
          tone="danger"
          role="alert"
          title="Couldn't load your sets"
          actions={
            <Button size="lg" variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        >
          SYNCHRO.S didn&apos;t answer. Nothing is lost; this is a display problem.
        </Notice>
      ) : list.isPending ? (
        <Skeleton className={styles.graphSkeleton} />
      ) : (
        <YourSets
          sets={list.data}
          onOpen={(id) => go({ set: String(id) })}
          onDraft={() => go({ set: 'draft' })}
          onRemove={(s) => setRemoving(s)}
        />
      )}
      {/* 267: a proper confirm on 15a's frame, never the browser's own */}
      <RemoveSetDialog
        name={removing?.name ?? ''}
        open={Boolean(removing)}
        onKeep={() => setRemoving(null)}
        onRemove={() => {
          const s = removing;
          setRemoving(null);
          if (!s) return;
          deleteSet(s.id)
            .then(() => {
              window.showToast?.(`Removed ${s.name}. Its playlist stays.`, 'success');
              void list.refetch();
            })
            .catch((err: unknown) =>
              window.showToast?.(
                err instanceof Error ? err.message : "It wasn't removed.",
                'error',
              ),
            );
        }}
      />
    </div>
  );
}
