import { useId, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, FormField, TextInput } from '@/components/form';
import { Checkbox } from '@/components/form/form';
import { Notice } from '@/components/primitives';
import { createUserPlaylist } from '@/features/playlists/user-playlists';

import type { DjTrack } from './dj.api';

import { playlistTrack } from './dj-actions';
import styles from './dj.module.css';

declare global {
  interface Window {
    /** static/stats-automations.js: a playlist's tracks (user playlists are mirrored ones). */
    openMirroredPlaylistModal?: (playlistId: number) => Promise<void> | void;
  }
}

/** The tracks the playlist gets, in order: the seed first when asked, then the matches. */
export function playlistTracks(seed: DjTrack | null, matches: DjTrack[], withSeed: boolean) {
  const list = withSeed && seed ? [seed, ...matches] : matches;
  return list.map(playlistTrack);
}

/**
 * "Make a playlist from these…" (17b): a small dialog with the name
 * ("Mixes with Night Ferry"), "Start with Night Ferry" (on), Cancel and
 * "Make playlist (7)". It makes a playlist of your own through the app's
 * playlist route (`POST /api/user-playlists`, as Add to playlist's "New
 * playlist" does); the toast links to it.
 */
export function MakePlaylistDialog({
  seed,
  matches,
  onClose,
}: {
  seed: DjTrack | null;
  matches: DjTrack[];
  onClose: () => void;
}) {
  const nameId = useId();
  const [name, setName] = useState(seed ? `Mixes with ${seed.title}` : 'Mixes');
  const [withSeed, setWithSeed] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tracks = playlistTracks(seed, matches, withSeed);
  const trimmed = name.trim();

  const make = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const made = await createUserPlaylist(trimmed, tracks);
      onClose();
      const added = made.added ?? tracks.length;
      const open = window.openMirroredPlaylistModal;
      window.showToast?.(
        `Made ${trimmed} with ${added.toLocaleString()} ${added === 1 ? 'track' : 'tracks'}`,
        'success',
        null,
        made.id && open ? { action: { label: 'Open it', run: () => void open(made.id) } } : null,
      );
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "The playlist wasn't made.");
    }
  };

  return (
    <DialogFrame
      open
      onOpenChange={(next) => (next ? null : onClose())}
      className={styles.makeDialog}
    >
      <DialogHeader title="Make a playlist from these" />
      <DialogBody>
        <form
          className={styles.makeForm}
          onSubmit={(event) => {
            event.preventDefault();
            void make();
          }}
        >
          <FormField label="Name" htmlFor={nameId}>
            <TextInput
              id={nameId}
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>
          {seed ? (
            <label className={styles.checkRow}>
              <Checkbox checked={withSeed} onCheckedChange={(on) => setWithSeed(Boolean(on))} />
              <span>Start with {seed.title}</span>
            </label>
          ) : null}
          {error ? (
            <Notice tone="danger" role="alert" title="The playlist wasn't made">
              {error}
            </Notice>
          ) : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={saving || !trimmed}
          disabledReason={trimmed ? undefined : 'Give it a name first'}
          onClick={() => void make()}
        >
          {saving ? 'Making it…' : `Make playlist (${tracks.length.toLocaleString()})`}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
