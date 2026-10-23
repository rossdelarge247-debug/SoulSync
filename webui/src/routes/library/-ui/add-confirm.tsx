import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, OptionCard, OptionCardGroup } from '@/components/form';
import { Checkbox } from '@/components/form/form';
import { Notice, Skeleton } from '@/components/primitives';
import { profileAsksFirst } from '@/platform/shell/download-rights';

import type { LibraryRelease, SelectionBody } from '../-library.types';

import { LIBRARY_QUERY_KEY, addToWanted, selectionSummary } from '../-library.api';
import { addedSentence, missingTracks, releaseType } from '../-library.grid';
import { automationsListQueryOptions } from '../../automations/-automations.api';
import { qualityProfilesQueryOptions } from '../../wanted/-wanted.api';
import { findSystemAutomation, intervalText } from '../../wanted/-wanted.helpers';
import styles from './library.module.css';
import { Stat, plural } from './parts';
import { Art } from './release-tile';

export type Quality = 'target' | { id: number; name: string };

export interface AddRequest {
  body: SelectionBody;
  /** What the set is, as the confirm's sentence opens: "Everything tagged Ambient that isn't in your library." */
  what: string;
  quality?: Quality;
}

function qualityValue(quality: Quality | undefined): 'target' | number {
  return quality && quality !== 'target' ? quality.id : 'target';
}

/** After any add: the grid, the genre line and the artists refetch. */
export function useRefreshLibrary() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
    window.updateWishlistCount?.();
  };
}

/**
 * Add one release straight away (a tile's hover action): one album asks
 * nothing (7d's note), the toast says what happened.
 */
export function useAddOne() {
  const refresh = useRefreshLibrary();
  return useMutation({
    mutationFn: (release: LibraryRelease) =>
      addToWanted({ release_ids: [release.id], quality: 'target' }),
    onSuccess: (result) => {
      window.showToast?.(
        addedSentence(result),
        result.failed && !result.added ? 'error' : 'success',
      );
      refresh();
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });
}

function ListRow({ release }: { release: LibraryRelease }) {
  const meta = [
    release.artist_name,
    release.year,
    `${missingTracks(release) || release.tracks_total || 0} tracks`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={styles.listRow}>
      <span
        className={styles.listArt}
        data-owned={release.kind === 'library' ? 'true' : undefined}
        aria-hidden="true"
      >
        {release.kind === 'library' ? <Art url={release.art_url} /> : null}
      </span>
      <span className={styles.listText}>
        <strong>{release.title}</strong>
        <span>{meta}</span>
      </span>
      <span className={styles.listType}>{releaseType(release)}</span>
    </li>
  );
}

/**
 * "Add 17 albums to Wanted?" (7d). Not a Safe action: nothing moves or
 * deletes. The numbers come from the server for exactly this selection (so a
 * "Select all" across pages is counted right), the first four are listed with
 * Show all, and following the artists is a separate promise, off by default.
 */
export function AddConfirm({
  request,
  onClose,
  onDone,
}: {
  request: AddRequest;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [follow, setFollow] = useState(false);
  const refresh = useRefreshLibrary();
  const summary = useQuery({
    queryKey: [...LIBRARY_QUERY_KEY, 'summary', request.body, showAll],
    queryFn: () =>
      selectionSummary({ ...request.body, ...(showAll ? { sample: 500 } : {}) } as SelectionBody),
    staleTime: 0,
  });
  const automations = useQuery({ ...automationsListQueryOptions(0), retry: false });
  const schedule = findSystemAutomation(automations.data, 'process_wishlist');
  const every = intervalText(schedule?.trigger_config ?? null);

  const add = useMutation({
    mutationFn: () =>
      addToWanted({
        ...request.body,
        quality: qualityValue(request.quality),
        follow_artists: follow,
      }),
    onSuccess: (result) => {
      let message = addedSentence(result);
      if (result.followed?.followed)
        message += ` · following ${plural(result.followed.followed, 'artist')}`;
      window.showToast?.(message, result.failed && !result.added ? 'error' : 'success');
      refresh();
      onDone?.();
      onClose();
    },
  });

  const data = summary.data;
  const count = data?.count ?? 0;
  const held =
    request.quality && request.quality !== 'target'
      ? request.quality.name
      : data?.target?.name || 'Your quality target';
  const toFollow = data ? data.artists.filter((a) => !data.following.includes(a.id)) : [];
  const asks = profileAsksFirst();
  const lead = [
    request.what,
    asks
      ? 'They go to an admin as requests; once approved, the scheduled search looks for them and what it finds shows up in Activity.'
      : schedule?.name
        ? `${schedule.name} searches for them ${every || 'on its schedule'}; what it finds shows up in Activity.`
        : "Wanted's scheduled search looks for them; what it finds shows up in Activity.",
    'You can take any of them off Wanted later.',
  ].join(' ');
  const skipped = data ? data.already_have + data.already_wanted : 0;

  return (
    <DialogFrame open onOpenChange={(open) => !open && onClose()} className={styles.dialog}>
      <DialogHeader
        title={
          data
            ? count
              ? `Add ${plural(count, 'album')} to Wanted?`
              : 'Nothing to add'
            : 'Add to Wanted?'
        }
      />
      <DialogBody>
        <div className={styles.dialogBody}>
          {summary.isError ? (
            <Notice tone="danger" title="Couldn't count them">
              {(summary.error as Error).message}. Nothing was added.
            </Notice>
          ) : null}
          <div className={styles.tiles}>
            <Stat label="Albums" value={data ? count.toLocaleString() : <Skeleton />} />
            <Stat label="Tracks" value={data ? data.tracks.toLocaleString() : <Skeleton />} />
            <Stat label="Held to" value={held} />
          </div>
          {data && !count ? (
            <p className={styles.lead}>
              You have all of {data.selected === 1 ? 'it' : 'them'}, or{' '}
              {data.selected === 1 ? "it's" : "they're"} on Wanted already.
            </p>
          ) : (
            <p className={styles.lead}>{lead}</p>
          )}
          {data && count ? (
            <div className={styles.list} data-scroll={showAll ? 'true' : undefined}>
              <ul className={styles.listRows}>
                {data.sample.map((release) => (
                  <ListRow key={release.id} release={release} />
                ))}
              </ul>
              <div className={styles.listFoot}>
                <span>
                  {data.sample.length.toLocaleString()} of {count.toLocaleString()}
                  {skipped ? ` · ${skipped} you have or want already` : ''}
                </span>
                {count > data.sample.length ? (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setShowAll(true)}
                  >
                    Show all {count.toLocaleString()}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {data && count && toFollow.length ? (
            <label className={styles.followOption}>
              <Checkbox checked={follow} onCheckedChange={(on) => setFollow(Boolean(on))} />
              <span>
                Also follow{' '}
                {toFollow.length === 1 ? toFollow[0].name : `these ${toFollow.length} artists`}, so
                their next releases go to Wanted as they come out.
              </span>
            </label>
          ) : null}
          {add.isError ? (
            <Notice tone="danger" title="Nothing was added">
              {(add.error as Error).message}
            </Notice>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!count || add.isPending}
          disabledReason={data && !count ? 'Nothing here to add' : undefined}
          onClick={() => add.mutate()}
        >
          {add.isPending
            ? 'Adding…'
            : count
              ? `Add ${count.toLocaleString()} to Wanted`
              : 'Add to Wanted'}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

/**
 * "Hold to a different quality" (the bar's "…"): pick a quality profile, then
 * the same confirm adds them held to it.
 */
export function QualityPicker({
  onPick,
  onClose,
}: {
  onPick: (quality: Quality) => void;
  onClose: () => void;
}) {
  const profiles = useQuery(qualityProfilesQueryOptions());
  const rows = profiles.data?.profiles ?? [];
  const [choice, setChoice] = useState<number | 'target'>('target');
  return (
    <DialogFrame open onOpenChange={(open) => !open && onClose()} className={styles.dialog}>
      <DialogHeader title="Hold them to a different quality" />
      <DialogBody>
        <div className={styles.dialogBody}>
          <p className={styles.lead}>
            The albums go on Wanted held to the quality you pick here instead of your quality
            target. Nothing else changes.
          </p>
          <OptionCardGroup className={styles.qualityList}>
            <OptionCard
              selected={choice === 'target'}
              onClick={() => setChoice('target')}
              title="Your quality target"
              description="What everything else on Wanted is held to."
            />
            {rows
              .filter((p) => !p.is_default)
              .map((p) => (
                <OptionCard
                  key={p.id}
                  selected={choice === p.id}
                  onClick={() => setChoice(p.id)}
                  title={p.name || `Profile ${p.id}`}
                  description="A quality profile from Settings → Quality."
                />
              ))}
          </OptionCardGroup>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          onClick={() => {
            const row = rows.find((p) => p.id === choice);
            onPick(
              choice === 'target' || !row
                ? 'target'
                : { id: row.id, name: row.name || `Profile ${row.id}` },
            );
          }}
        >
          Continue
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
