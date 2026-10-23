/**
 * Add a stream link (4g, admins): paste, Check (the server listens to it for
 * a few seconds), then name it and pick its kind. Add stays disabled with the
 * reason until a check passes.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import type { LinkCheck, StationKind } from '@/features/radio/radio.types';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, Select, TextInput } from '@/components/form';
import { Notice } from '@/components/primitives';

import { addLink, checkLink, RADIO_KEY } from '../-radio.api';
import styles from './radio.module.css';

const KINDS: { value: StationKind; label: string }[] = [
  { value: 'electronic', label: 'Electronic' },
  { value: 'world', label: 'World' },
  { value: 'eclectic', label: 'Eclectic tastemakers' },
  { value: 'jazz_soul_funk', label: 'Jazz, soul and funk' },
];

export function checkSentence(check: LinkCheck): string {
  const parts = [
    [check.codec, check.bitrate_kbps ? `${check.bitrate_kbps} kbps` : ''].filter(Boolean).join(' '),
    check.sends_titles ? 'sends track names with the stream' : 'sends no track names',
    check.answered_in_s != null ? `answered in ${check.answered_in_s} s` : '',
  ].filter(Boolean);
  return `${parts.join(' · ')}. Checked from your server, which is what will relay it.`;
}

export function AddLinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<StationKind | ''>('');
  const [logo, setLogo] = useState('');
  const [checked, setChecked] = useState<{ url: string; result: LinkCheck } | null>(null);
  const urlId = useId();
  const nameId = useId();
  const kindId = useId();
  const logoId = useId();
  const logoHintId = useId();
  useEffect(() => {
    if (!open) {
      setUrl('');
      setName('');
      setKind('');
      setLogo('');
      setChecked(null);
    }
  }, [open]);

  const check = useMutation({
    mutationFn: (u: string) => checkLink(u),
    onSuccess: (result, u) => setChecked({ url: u, result }),
    onError: (error: Error, u) =>
      setChecked({
        url: u,
        result: {
          ok: false,
          error: error.message,
          codec: '',
          bitrate_kbps: 0,
          sends_titles: false,
          allows_direct: false,
          answered_in_s: null,
        },
      }),
  });
  const add = useMutation({
    mutationFn: () => addLink(url.trim(), name.trim(), kind as StationKind, logo.trim()),
    onSuccess: (link) => {
      window.showToast?.(
        `Added ${link.name}. It’s in everyone’s Favourites as “Your link”.`,
        'success',
      );
      void queryClient.invalidateQueries({ queryKey: RADIO_KEY });
      onClose();
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });

  const passed = checked?.result.ok && checked.url === url.trim();
  const failed = checked && !checked.result.ok && checked.url === url.trim();
  const reason = !passed
    ? 'Check a working link to add it.'
    : !name.trim()
      ? 'Give it a name.'
      : !kind
        ? 'Choose a kind.'
        : null;

  return (
    <DialogFrame open={open} onOpenChange={(o) => !o && onClose()} className={styles.confirm}>
      <DialogHeader title="Add a stream link">
        A direct audio stream, the kind a radio app would open. It goes into Favourites for
        everyone.
      </DialogHeader>
      <DialogBody>
        <div className={styles.stack}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={urlId}>
              Stream link
            </label>
            <div className={styles.fieldRow}>
              <TextInput
                id={urlId}
                value={url}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://stream.example.org/live.mp3"
                aria-invalid={failed ? true : undefined}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Button
                size="lg"
                disabled={!url.trim() || check.isPending}
                focusableWhenDisabled
                onClick={() => check.mutate(url.trim())}
              >
                {check.isPending ? 'Checking…' : checked ? 'Check again' : 'Check'}
              </Button>
            </div>
          </div>
          <div aria-live="polite">
            {passed && checked ? (
              <p className={styles.checkOk}>
                <strong>Playing.</strong> {checkSentence(checked.result)}
              </p>
            ) : failed && checked ? (
              <Notice
                tone="danger"
                title={checked.result.error?.split('.')[0] || 'This link didn’t play'}
              >
                {checked.result.error?.includes('web page')
                  ? 'The address answered with a web page. Use the station’s direct stream address, which usually ends in .mp3, .aac, .flac or /stream and is often on the station’s “listen in another app” page.'
                  : checked.result.error}
              </Notice>
            ) : null}
          </div>
          <div className={styles.twoCols}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={nameId}>
                Name
              </label>
              <TextInput
                id={nameId}
                value={name}
                maxLength={80}
                placeholder="What it’s called"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={kindId}>
                Kind
              </label>
              <Select
                id={kindId}
                size="lg"
                value={kind}
                onChange={(e) => setKind(e.target.value as StationKind)}
              >
                <option value="" disabled>
                  Choose…
                </option>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={logoId}>
              Logo address (optional)
            </label>
            <TextInput
              id={logoId}
              value={logo}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://station.example.org/logo.png"
              aria-describedby={logoHintId}
              onChange={(e) => setLogo(e.target.value)}
            />
            <p className={styles.dialogNote} id={logoHintId}>
              A square PNG, JPEG, GIF, WebP or ICO of up to 512 KB (not SVG). Your server fetches it
              once and keeps it; until then, and without one, the tile shows the name’s letters.
            </p>
          </div>
          <p className={styles.dialogNote}>
            Your server relays this stream only while someone is listening, and only audio. Track
            names come from the stream; there’s no tracklist feed for your own links.
          </p>
        </div>
      </DialogBody>
      <DialogFooter>
        {reason ? <span className={styles.footHint}>{reason}</span> : null}
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={Boolean(reason) || add.isPending}
          focusableWhenDisabled
          onClick={() => add.mutate()}
        >
          {name.trim() && passed ? `Add ${name.trim()}` : 'Add station'}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
