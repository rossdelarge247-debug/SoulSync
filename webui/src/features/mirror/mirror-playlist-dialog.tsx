/**
 * "Mirror a playlist" (boards 2o, 2p): pick one of your Spotify playlists or
 * paste a link, see how much of it you already have and what mirroring it
 * means, then one primary that names the playlist.
 *
 * Built on today's mirroring routes (mirror.api.ts). Mirroring saves the
 * playlist to Mirrored playlists. "Keep it in sync" (on by default) also gives
 * it the Auto-Sync schedule the Auto-Sync board makes (every 24 hours) and runs
 * its first check now, which adds the tracks you don't have to Wanted and
 * starts the Wanted search. A first check refused because another playlist is
 * being checked (409) is the dialog failure pattern of board 2s: the mirror is
 * kept, a warning Notice says why, and the primary tries the check again.
 *
 * Phones get a full-screen sheet with stacked buttons (board 2p).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, OptionButton } from '@/components/form';
import { Switch } from '@/components/form/form';
import { LoadingState, Notice, SkeletonList, StatusTag } from '@/components/primitives';
import { qualityPresetsQueryOptions } from '@/features/quality/quality.api';

import type { LoadedPlaylist } from './mirror.api';
import type { MirrorCandidate } from './mirror.model';

import styles from './mirror-dialog.module.css';
import {
  checkOwnership,
  KEEP_IN_SYNC_HOURS,
  loadPlaylist,
  mirroredRowsQueryOptions,
  MirrorStepError,
  runFirstCheck,
  saveMirror,
  scheduleMirror,
  spotifyAccountQueryOptions,
} from './mirror.api';
import {
  consequenceText,
  filterCandidates,
  isAlreadyMirrored,
  ownershipCounts,
  readLink,
  rowMeta,
  shortConsequence,
  shortMeta,
} from './mirror.model';

export interface MirrorPlaylistDialogProps {
  open: boolean;
  onClose: () => void;
  /** A playlist to start on (Search's "Mirror this playlist"). */
  initial?: MirrorCandidate | null;
  /** After a mirror is saved, with its id. */
  onMirrored?: (playlistId: number) => void;
}

type Mode = 'account' | 'link';

/** Where a submit stopped, so a retry picks up from there. */
interface Progress {
  playlistId: number | null;
  scheduled: boolean;
}

type StepFailure =
  | { step: 'mirror'; message: string }
  | { step: 'schedule'; message: string }
  | { step: 'check'; busy: boolean; message: string };

class StepError extends Error {
  failure: StepFailure;
  constructor(failure: StepFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

function Art({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    <img className={styles.art} src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className={styles.art} aria-hidden="true" />
  );
}

export function MirrorPlaylistDialog({
  open,
  onClose,
  initial,
  onMirrored,
}: MirrorPlaylistDialogProps) {
  const queryClient = useQueryClient();
  const account = useQuery({ ...spotifyAccountQueryOptions(), enabled: open });
  const mirrored = useQuery({ ...mirroredRowsQueryOptions(), enabled: open });
  const presets = useQuery({ ...qualityPresetsQueryOptions(), enabled: open });

  const [mode, setMode] = useState<Mode>(initial ? 'link' : 'account');
  const [filter, setFilter] = useState('');
  const [link, setLink] = useState(initial?.link ?? '');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linked, setLinked] = useState<MirrorCandidate | null>(initial ?? null);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initial ? `${initial.source}:${initial.id}` : null,
  );
  const [keepInSync, setKeepInSync] = useState(true);
  const [failure, setFailure] = useState<StepFailure | null>(null);
  const progress = useRef<Progress>({ playlistId: null, scheduled: false });
  const keepId = useId();
  const keepDesc = useId();
  const linkId = useId();

  // every open starts fresh, on the playlist it was opened with
  const initialKey = initial ? `${initial.source}:${initial.id}` : '';
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    const initial = initialRef.current;
    if (!open) return;
    setMode(initial ? 'link' : 'account');
    setFilter('');
    setLink(initial?.link ?? '');
    setLinkError(null);
    setLinked(initial ?? null);
    setSelectedKey(initial ? `${initial.source}:${initial.id}` : null);
    setKeepInSync(true);
    setFailure(null);
    progress.current = { playlistId: null, scheduled: false };
  }, [open, initialKey]);

  const connected = account.data?.connected === true;
  // without Spotify there's only the link
  useEffect(() => {
    if (open && account.data && !account.data.connected && mode === 'account') setMode('link');
  }, [open, account.data, mode]);

  const accountRows = account.data?.playlists ?? [];
  const list: MirrorCandidate[] =
    mode === 'account' ? filterCandidates(accountRows, filter) : linked ? [linked] : [];
  const all = mode === 'account' ? accountRows : linked ? [linked] : [];
  const selected = all.find((c) => `${c.source}:${c.id}` === selectedKey) ?? null;

  const tracks = useQuery({
    queryKey: ['mirror', 'tracks', selected?.source, selected?.id],
    queryFn: () => loadPlaylist(selected as MirrorCandidate),
    enabled: open && Boolean(selected),
    staleTime: 60_000,
  });
  const loaded: LoadedPlaylist | undefined = tracks.data;
  const ownership = useQuery({
    queryKey: ['mirror', 'ownership', selected?.source, selected?.id, loaded?.tracks.length],
    queryFn: ({ signal }) => checkOwnership(loaded?.tracks ?? [], signal),
    enabled: open && Boolean(loaded),
    staleTime: 30_000,
  });
  const counts = useMemo(
    () => (loaded && ownership.data ? ownershipCounts(loaded.tracks, ownership.data) : null),
    [loaded, ownership.data],
  );

  const targetName = presets.data?.current?.name ?? null;
  const name = selected?.name ?? '';

  const submit = useMutation({
    mutationFn: async () => {
      if (!selected || !loaded) return;
      setFailure(null);
      if (progress.current.playlistId == null) {
        try {
          progress.current.playlistId = await saveMirror(selected, loaded);
        } catch (error) {
          throw new StepError({ step: 'mirror', message: (error as Error).message });
        }
      }
      const playlistId = progress.current.playlistId;
      if (keepInSync && !progress.current.scheduled) {
        try {
          await scheduleMirror(name, playlistId);
          progress.current.scheduled = true;
        } catch (error) {
          throw new StepError({ step: 'schedule', message: (error as Error).message });
        }
      }
      if (keepInSync) {
        try {
          await runFirstCheck(playlistId);
        } catch (error) {
          const busy = error instanceof MirrorStepError && error.kind === 'busy';
          throw new StepError({ step: 'check', busy, message: (error as Error).message });
        }
      }
    },
    onSuccess: () => {
      const playlistId = progress.current.playlistId;
      void queryClient.invalidateQueries({ queryKey: ['mirror', 'mirrored'] });
      window.showToast?.(
        keepInSync
          ? `Mirrored "${name}". SYNCHRO.S is checking it now.`
          : `Mirrored "${name}". Run it from Mirrored playlists when you're ready.`,
        'success',
      );
      if (playlistId != null) onMirrored?.(playlistId);
      onClose();
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ['mirror', 'mirrored'] });
      setFailure(
        error instanceof StepError
          ? error.failure
          : { step: 'mirror', message: "SYNCHRO.S couldn't mirror the playlist." },
      );
    },
  });

  const saved = progress.current.playlistId != null;
  const afterSave = failure && failure.step !== 'mirror';

  const readPasted = (value: string) => {
    const result = readLink(value, connected);
    if (!result.ok) {
      setLinkError(result.message);
      setLinked(null);
      setSelectedKey(null);
      return;
    }
    setLinkError(null);
    const candidate: MirrorCandidate = {
      ...result.candidate,
      name: result.candidate.source === 'deezer' ? 'Deezer playlist' : 'Spotify playlist',
    };
    setLinked(candidate);
    setSelectedKey(`${candidate.source}:${candidate.id}`);
  };

  // a pasted link's real name arrives with its tracks
  useEffect(() => {
    if (!loaded || !linked || mode !== 'link') return;
    if (selected && `${linked.source}:${linked.id}` === `${selected.source}:${selected.id}`) {
      const next = {
        ...linked,
        name: loaded.name || linked.name,
        owner: loaded.owner || linked.owner,
        imageUrl: loaded.imageUrl || linked.imageUrl,
        trackCount: loaded.tracks.length,
      };
      if (
        next.name !== linked.name ||
        next.trackCount !== linked.trackCount ||
        next.owner !== linked.owner
      ) {
        setLinked(next);
      }
    }
  }, [loaded, linked, mode, selected]);

  // ── the primary ────────────────────────────────────────────────────────
  let primary: React.ReactNode;
  if (afterSave) {
    primary = (
      <Button
        size="lg"
        variant="primary"
        disabled={submit.isPending}
        focusableWhenDisabled
        onClick={() => submit.mutate()}
      >
        {submit.isPending
          ? 'Trying…'
          : failure?.step === 'schedule'
            ? 'Save the schedule again'
            : 'Start the first check again'}
      </Button>
    );
  } else {
    const reason = !selected
      ? 'Pick a playlist to mirror.'
      : tracks.isError
        ? null
        : !loaded
          ? 'Loading its tracks…'
          : null;
    const blocked = !selected || !loaded || tracks.isError;
    primary = (
      <Button
        size="lg"
        variant="primary"
        disabled={blocked || submit.isPending}
        disabledReason={submit.isPending ? null : reason}
        focusableWhenDisabled
        onClick={() => {
          if (!submit.isPending) submit.mutate();
        }}
      >
        {submit.isPending ? 'Mirroring…' : selected ? `Mirror "${name}"` : 'Mirror'}
      </Button>
    );
  }

  const loadingAccount = account.isPending;
  const sourceLine = connected ? (
    <span className={styles.connection}>
      <span className={styles.dot} data-tone="success" aria-hidden="true" />
      Spotify connected
    </span>
  ) : account.data ? (
    <span className={styles.connection}>
      <span className={styles.dot} aria-hidden="true" />
      Spotify isn’t connected
    </span>
  ) : null;

  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.popup}
    >
      <DialogHeader title="Mirror a playlist">
        <p className={styles.subtitle}>
          <span className={styles.wideOnly}>
            SYNCHRO.S finds the tracks you don’t have and keeps up as the playlist changes.
          </span>
          <span className={styles.phoneOnly}>
            Finds what you don’t have and keeps up as it changes.
          </span>
        </p>
      </DialogHeader>
      <DialogBody>
        {failure ? (
          failure.step === 'check' && failure.busy ? (
            <Notice
              tone="warning"
              role="alert"
              title={`"${name}" is mirrored, but its first check is waiting`}
            >
              {failure.message} The mirror and its schedule are saved, so it’s checked within{' '}
              {KEEP_IN_SYNC_HOURS} hours, or try again once the other check finishes.
            </Notice>
          ) : failure.step === 'mirror' ? (
            <Notice tone="danger" role="alert" title="That didn’t go through">
              {failure.message} Nothing was saved.
            </Notice>
          ) : (
            <Notice
              tone="warning"
              role="alert"
              title={
                failure.step === 'schedule'
                  ? `"${name}" is mirrored, but its schedule wasn’t saved`
                  : `"${name}" is mirrored, but its first check didn’t start`
              }
            >
              {failure.message} The mirror is on Mirrored playlists either way.
            </Notice>
          )
        ) : null}

        <div className={styles.faders} data-faded={afterSave ? 'true' : undefined}>
          <div className={styles.from}>
            <div className={styles.fromHead}>
              <span className={`${styles.fromLabel} ${styles.wideOnly}`}>From</span>
              <span className={styles.wideOnly}>{sourceLine}</span>
            </div>
            <div className={styles.sources} role="group" aria-label="Where the playlist comes from">
              {connected ? (
                <OptionButton
                  selected={mode === 'account'}
                  disabled={saved}
                  onClick={() => {
                    setMode('account');
                    setSelectedKey(null);
                  }}
                >
                  <span className={styles.wideOnly}>Your Spotify playlists</span>
                  <span className={styles.phoneOnly}>Spotify</span>
                </OptionButton>
              ) : null}
              <OptionButton
                selected={mode === 'link'}
                disabled={saved}
                onClick={() => {
                  setMode('link');
                  setSelectedKey(linked ? `${linked.source}:${linked.id}` : null);
                }}
              >
                Paste a link
              </OptionButton>
            </div>
            {account.data && !connected ? (
              <p className={styles.note}>
                Connect Spotify in Settings to pick from your playlists. A Deezer playlist link
                works without it.
              </p>
            ) : null}
          </div>

          {mode === 'account' ? (
            <label className={styles.field}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.fieldIcon}>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                type="text"
                className={styles.fieldInput}
                placeholder="Find a playlist"
                aria-label="Find a playlist"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
          ) : (
            <div className={styles.linkBlock}>
              <form
                className={styles.field}
                data-invalid={linkError ? 'true' : undefined}
                onSubmit={(event) => {
                  event.preventDefault();
                  readPasted(link);
                }}
              >
                <label htmlFor={linkId} className={styles.srOnly}>
                  Playlist link
                </label>
                <input
                  id={linkId}
                  type="url"
                  className={styles.fieldInput}
                  placeholder={
                    connected
                      ? 'Paste a Spotify or Deezer playlist link'
                      : 'Paste a Deezer playlist link'
                  }
                  value={link}
                  disabled={saved}
                  aria-invalid={linkError ? true : undefined}
                  aria-describedby={linkError ? `${linkId}-error` : undefined}
                  onChange={(event) => setLink(event.target.value)}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData('text');
                    if (pasted) window.setTimeout(() => readPasted(pasted), 0);
                  }}
                />
                <Button type="submit" size="lg" disabled={!link.trim() || saved}>
                  Read link
                </Button>
              </form>
              {linkError ? (
                <p className={styles.fieldError} id={`${linkId}-error`}>
                  {linkError}
                </p>
              ) : null}
            </div>
          )}

          {mode === 'account' && loadingAccount ? (
            <LoadingState label="Loading your Spotify playlists…">
              <SkeletonList rows={3} art={44} tag={false} />
            </LoadingState>
          ) : mode === 'account' && account.isError ? (
            <Notice
              tone="danger"
              role="alert"
              title="Couldn’t load your Spotify playlists"
              actions={
                <Button size="lg" onClick={() => void account.refetch()}>
                  {account.isFetching ? 'Trying…' : 'Try again'}
                </Button>
              }
            >
              SYNCHRO.S didn’t get an answer from Spotify. Nothing changed; you can paste a link
              instead.
            </Notice>
          ) : list.length ? (
            <div className={styles.list} role="radiogroup" aria-label="Playlist">
              {list.map((candidate) => {
                const key = `${candidate.source}:${candidate.id}`;
                const already =
                  isAlreadyMirrored(mirrored.data, candidate) && !(saved && key === selectedKey);
                const isSelected = key === selectedKey;
                const rowCounts = isSelected ? counts : null;
                return (
                  <label
                    key={key}
                    className={styles.row}
                    data-selected={isSelected ? 'true' : undefined}
                    data-disabled={already ? 'true' : undefined}
                    data-testid="mirror-row"
                  >
                    <input
                      type="radio"
                      name="mirror-playlist"
                      className={styles.radio}
                      checked={isSelected}
                      disabled={already || saved}
                      onChange={() => setSelectedKey(key)}
                    />
                    <Art url={candidate.imageUrl} />
                    <span className={styles.rowText}>
                      <span className={styles.rowTitle}>{candidate.name}</span>
                      <span className={`${styles.rowMeta} ${styles.wideOnly}`}>
                        {rowMeta(candidate)}
                      </span>
                      <span className={`${styles.rowMeta} ${styles.phoneOnly}`}>
                        {already ? (
                          <span className={styles.mirroredWord}>Already mirrored</span>
                        ) : (
                          shortMeta(candidate, rowCounts)
                        )}
                      </span>
                    </span>
                    <span className={styles.rowAside}>
                      {already ? (
                        <StatusTag tone="success" className={styles.wideOnly}>
                          Already mirrored
                        </StatusTag>
                      ) : isSelected && tracks.isError ? (
                        <span className={styles.rowProblem}>Couldn’t read its tracks</span>
                      ) : isSelected && !rowCounts ? (
                        <span className={styles.wideOnly}>Checking…</span>
                      ) : rowCounts ? (
                        <span className={styles.wideOnly}>
                          You have {rowCounts.have.toLocaleString('en-GB')}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : mode === 'account' ? (
            <p className={styles.note}>
              {filter.trim()
                ? `None of your playlists match “${filter.trim()}”.`
                : 'Your Spotify account has no playlists yet. Paste a link instead.'}
            </p>
          ) : null}

          {selected && tracks.isError ? (
            <p className={styles.fieldError} role="alert">
              {(tracks.error as Error)?.message ||
                'SYNCHRO.S couldn’t read this playlist’s tracks.'}{' '}
              Try another playlist, or try again later.
            </p>
          ) : null}

          <div className={styles.options}>
            <div className={styles.option}>
              <span className={styles.optionText}>
                <span id={keepId}>Keep it in sync</span>
                <span id={keepDesc} className={styles.optionHelp}>
                  <span className={styles.wideOnly}>
                    Checks it every {KEEP_IN_SYNC_HOURS} hours. New tracks go to Wanted and the
                    playlist on your media server follows along; removed ones stay in your library.
                  </span>
                  <span className={styles.phoneOnly}>Checked every {KEEP_IN_SYNC_HOURS} hours</span>
                </span>
              </span>
              <Switch
                checked={keepInSync}
                disabled={saved}
                aria-labelledby={keepId}
                aria-describedby={keepDesc}
                onCheckedChange={(next) => setKeepInSync(Boolean(next))}
              />
            </div>
          </div>

          {selected && !tracks.isError ? (
            <p className={styles.consequence} data-testid="mirror-consequence">
              <span className={styles.wideOnly}>
                {consequenceText({ counts, keepInSync, targetName })}
              </span>
              <span className={styles.phoneOnly}>
                {shortConsequence(counts, keepInSync, targetName)}
              </span>
            </p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          {afterSave ? 'Close' : 'Cancel'}
        </Button>
        {primary}
      </DialogFooter>
    </DialogFrame>
  );
}
