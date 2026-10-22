import type { ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { Checkbox } from '@/components/form/form';

import type { ArtistInfo } from '../-artist-detail.types';
import type { ContentOptions } from '../-artist.helpers';

import { buildGenreChips, cleanArtistBio, formatHeroNumber } from '../-artist-detail.hero-stats';
import styles from './artist-page.module.css';
import { EnrichmentCoverage } from './enrichment-coverage';

/**
 * Ask first, the design system's way: a title that names the action, plain
 * sentences on what happens and what doesn't, then the way back and a button
 * that names the action. `tone="danger"` is the danger-filled confirm (dark
 * text on #f87171) for removing something.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  extra,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  busy?: boolean;
  /** A secondary way on, at the start of the footer ("Choose releases…"). */
  extra?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      className={styles.dialog}
    >
      <DialogHeader title={title} />
      <DialogBody>
        <div className={styles.dialogStack}>{children}</div>
      </DialogBody>
      <DialogFooter>
        {extra}
        {extra ? <span className={styles.footerSpacer} /> : null}
        <Button size="lg" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          size="lg"
          variant="primary"
          className={tone === 'danger' ? styles.danger : undefined}
          disabled={busy}
          focusableWhenDisabled
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={styles.checkRow}>
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(Boolean(next))} />
      {label}
    </label>
  );
}

/**
 * The old page's filter bar beyond the board's three filters: which release
 * types to list, live (non-studio on MusicBrainz), compilations and
 * featured-on releases, and the releases only your other sources list.
 */
export function MoreFiltersDialog({
  open,
  options,
  otherSources,
  onChange,
  onToggleOtherSources,
  onClose,
}: {
  open: boolean;
  options: ContentOptions;
  otherSources: boolean;
  onChange: (next: ContentOptions) => void;
  onToggleOtherSources: () => void;
  onClose: () => void;
}) {
  const setCategory = (bucket: 'albums' | 'eps' | 'singles', on: boolean) =>
    onChange({ ...options, categories: { ...options.categories, [bucket]: on } });
  const setContent = (key: 'live' | 'compilations' | 'featured', on: boolean) =>
    onChange({ ...options, content: { ...options.content, [key]: on } });
  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.dialog}
    >
      <DialogHeader title="More filters" />
      <DialogBody>
        <div className={styles.dialogStack}>
          <p className={styles.dialogText}>
            Choose what this page lists. All, Albums and Missing work within these.
          </p>
          <fieldset className={styles.fieldset}>
            <legend>Release types</legend>
            <CheckRow
              label="Albums"
              checked={options.categories.albums}
              onChange={(on) => setCategory('albums', on)}
            />
            <CheckRow
              label="EPs"
              checked={options.categories.eps}
              onChange={(on) => setCategory('eps', on)}
            />
            <CheckRow
              label="Singles"
              checked={options.categories.singles}
              onChange={(on) => setCategory('singles', on)}
            />
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend>Include</legend>
            <CheckRow
              label={
                options.mbDeclutter
                  ? 'Live, soundtrack and other non-studio releases'
                  : 'Live releases'
              }
              checked={options.content.live}
              onChange={(on) => setContent('live', on)}
            />
            <CheckRow
              label="Compilations"
              checked={options.content.compilations}
              onChange={(on) => setContent('compilations', on)}
            />
            <CheckRow
              label="Releases they're featured on"
              checked={options.content.featured}
              onChange={(on) => setContent('featured', on)}
            />
            <CheckRow
              label="Releases only your other metadata sources list"
              checked={otherSources}
              onChange={() => onToggleOtherSources()}
            />
          </fieldset>
          {options.mbDeclutter ? (
            <p className={styles.dialogNote}>
              MusicBrainz lists everything an artist put out, so non-studio releases start hidden.
              Anything you own always shows.
            </p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

export interface AboutFacts {
  /** "Albums: 3 of 5 in your library" and so on; library artists only. */
  collection: { label: string; owned: number; total: number }[];
  /** The library's formats for this artist, once the check has finished. */
  formats: string[];
  links: { key: string; label: string; url: string }[];
  following: { since: string; lastChecked: string } | null;
  /** What the followed-artist check knows (the old Wanted panel): followers, popularity, style, mood, label. */
  followedFacts?: { label: string; value: string }[];
}

/**
 * Everything the old hero said about the artist that the board has no room
 * for: the Last.fm bio and tags, listeners and plays, what you have of each
 * release type, the formats on disk, where SoulSync matched them, and how
 * well your metadata sources know their tracks.
 */
export function AboutDialog({
  open,
  artist,
  facts,
  sourceOnly,
  enrichment,
  children,
  onClose,
}: {
  open: boolean;
  artist: ArtistInfo;
  facts: AboutFacts;
  sourceOnly: boolean;
  /** Per-service match coverage of the artist's library tracks (the old hero's rings). */
  enrichment?: Record<string, unknown>;
  /** More sections (live dates). */
  children?: ReactNode;
  onClose: () => void;
}) {
  const name = String(artist.name || 'this artist');
  const bio = cleanArtistBio(artist.lastfm_bio);
  const chips = buildGenreChips(artist);
  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.dialog}
    >
      <DialogHeader title={`About ${name}`} />
      <DialogBody>
        <div className={styles.dialogStack}>
          {bio ? <p className={styles.bio}>{bio}</p> : null}
          {chips.length > 0 ? (
            <div className={styles.tags} aria-label="Genres and tags">
              {chips.map((chip) => (
                <span
                  key={`${chip.fromLastfm ? 'lfm' : 'g'}-${chip.label}`}
                  className={styles.chip}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          ) : null}
          <dl className={styles.facts}>
            {artist.lastfm_listeners ? (
              <>
                <dt>Listeners on Last.fm</dt>
                <dd>{formatHeroNumber(artist.lastfm_listeners)}</dd>
              </>
            ) : null}
            {artist.lastfm_playcount ? (
              <>
                <dt>Plays on Last.fm</dt>
                <dd>{formatHeroNumber(artist.lastfm_playcount)}</dd>
              </>
            ) : null}
            {!sourceOnly
              ? facts.collection.map((row) => (
                  <span key={row.label} style={{ display: 'contents' }}>
                    <dt>{row.label}</dt>
                    <dd>
                      {row.owned} of {row.total} in your library
                    </dd>
                  </span>
                ))
              : null}
            {facts.formats.length > 0 ? (
              <>
                <dt>Formats you have</dt>
                <dd>{facts.formats.join(', ')}</dd>
              </>
            ) : null}
            {facts.following ? (
              <>
                <dt>Following</dt>
                <dd>
                  {facts.following.since}
                  {facts.following.lastChecked ? ` · ${facts.following.lastChecked}` : ''}
                </dd>
              </>
            ) : null}
            {(facts.followedFacts ?? []).map((fact) => (
              <span key={fact.label} style={{ display: 'contents' }}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </span>
            ))}
            {facts.links.length > 0 ? (
              <>
                <dt>Matched on</dt>
                <dd>
                  {facts.links.map((link, i) => (
                    <span key={link.key}>
                      {i > 0 ? ' · ' : ''}
                      <a
                        className={styles.link}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {link.label}
                      </a>
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
          {!bio && chips.length === 0 && !artist.lastfm_listeners ? (
            <p className={styles.dialogNote}>
              Last.fm has no biography or tags for {name} yet, or SoulSync hasn&apos;t matched them
              there.
            </p>
          ) : null}
          {!sourceOnly ? (
            <div className={styles.legacy}>
              <EnrichmentCoverage enrichment={enrichment} />
            </div>
          ) : null}
          {children}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
