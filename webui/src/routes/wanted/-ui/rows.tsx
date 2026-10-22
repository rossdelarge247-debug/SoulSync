import { Button } from '@/components/form';
import { Checkbox } from '@/components/form/form';
import { StatusTag } from '@/components/primitives';

import type { FoundItem, WantedItem, WantedTrack } from '../-wanted.types';

import {
  addedLabel,
  followedLatest,
  followedMeta,
  followedStatusTag,
  foundMeta,
  foundWhen,
  plural,
  serverTime,
  wantedMeta,
  wantedStatus,
  type FollowedRow,
  type MetaPart,
} from '../-wanted.helpers';
import { ActionMenu, type MenuEntry } from './action-menu';
import { RowArt } from './parts';
import styles from './wanted-page.module.css';

/** The meta line: parts joined by " · ", the artist as a link, a failed try
 *  in the warning colour, the wide-only parts left off on phones. */
function MetaLine({ parts, onOpenArtist }: { parts: MetaPart[]; onOpenArtist: () => void }) {
  return (
    <p className={styles.meta}>
      {parts.map((part, index) => {
        const sep = index > 0 ? ' · ' : '';
        const className =
          [part.wide ? styles.metaWide : '', part.warning ? styles.metaWarning : '']
            .filter(Boolean)
            .join(' ') || undefined;
        if (part.artist) {
          return (
            <span key={part.key} className={className}>
              {sep}
              <button type="button" className={styles.linkButton} onClick={onOpenArtist}>
                {part.text}
              </button>
            </span>
          );
        }
        if (part.key === 'error') {
          return (
            <span key={part.key} className={className}>
              {sep}
              <span className={styles.metaErrorPrefix}>last try: </span>
              {part.text.replace(/^last try: /, '')}
            </span>
          );
        }
        return (
          <span key={part.key} className={className}>
            {sep}
            {part.text}
          </span>
        );
      })}
    </p>
  );
}

function SelectBox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: (range: boolean) => void;
}) {
  return (
    <span className={styles.check}>
      <Checkbox
        checked={checked}
        aria-label={label}
        onClick={(event) => {
          event.preventDefault();
          onToggle(event.shiftKey);
        }}
      />
    </span>
  );
}

export interface WantedRowHandlers {
  onOpenArtist: (artist: string) => void;
  onSearchNow: (item: WantedItem) => void;
  onRetry: (item: WantedItem) => void;
  onRemove: (item: WantedItem) => void;
  onRemoveTrack: (track: WantedTrack) => void;
  onSearchByHand: (track: WantedTrack) => void;
  onToggleTracks: (item: WantedItem) => void;
}

/** One wanted thing (Wanted v3, 2a; phones 2c). */
export function WantedRowView({
  item,
  now,
  qualityName,
  canSearch,
  searching,
  expanded,
  selecting,
  selected,
  onToggleSelect,
  handlers,
}: {
  item: WantedItem;
  now: number;
  qualityName: string;
  /** False for a profile that asks an admin first: no Search now. */
  canSearch: boolean;
  /** A Search now for this row is on its way. */
  searching: boolean;
  expanded: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (range: boolean) => void;
  handlers: WantedRowHandlers;
}) {
  const status = wantedStatus(item);
  const several = item.trackIds.length > 1;
  const single = item.tracks[0];

  const entries = (withSearch: boolean): MenuEntry[] => {
    const list: MenuEntry[] = [];
    if (withSearch && canSearch) {
      list.push({
        key: 'search',
        label: searching ? 'Searching…' : 'Search now',
        disabled: searching,
        onSelect: () => handlers.onSearchNow(item),
      });
    }
    if (several) {
      list.push({
        key: 'tracks',
        label: expanded ? 'Hide the tracks' : `Show the ${item.trackIds.length} tracks`,
        onSelect: () => handlers.onToggleTracks(item),
      });
    } else if (canSearch) {
      list.push({
        key: 'by-hand',
        label: 'Search by hand…',
        onSelect: () => handlers.onSearchByHand(single),
      });
    }
    if (item.tries > 0) {
      list.push({
        key: 'retry',
        label: 'Try again on the next search',
        onSelect: () => handlers.onRetry(item),
      });
    }
    list.push(
      { key: 'artist', label: 'Open artist', onSelect: () => handlers.onOpenArtist(item.artist) },
      { key: 'sep', separator: true },
      {
        key: 'remove',
        label: several ? 'Remove from Wanted…' : 'Remove from Wanted',
        tone: 'danger',
        onSelect: () => handlers.onRemove(item),
      },
    );
    return list;
  };

  return (
    <li className={styles.item}>
      <div
        className={styles.row}
        data-selecting={selecting ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
      >
        {selecting ? (
          <SelectBox checked={selected} label={`Select ${item.title}`} onToggle={onToggleSelect} />
        ) : null}
        <RowArt src={item.image} />
        <div className={styles.main}>
          <p className={styles.rowTitle} title={item.title}>
            {item.title}
          </p>
          <MetaLine
            parts={wantedMeta(item, qualityName)}
            onOpenArtist={() => handlers.onOpenArtist(item.artist)}
          />
        </div>
        <span className={styles.added}>{addedLabel(item.addedAt, now)}</span>
        <span className={styles.status}>
          <StatusTag tone={status.tone}>{status.text}</StatusTag>
        </span>
        {selecting ? null : (
          <>
            <div className={styles.actions}>
              {canSearch ? (
                <Button
                  size="lg"
                  className={styles.rowAction}
                  disabled={searching}
                  focusableWhenDisabled
                  onClick={() => handlers.onSearchNow(item)}
                >
                  {searching ? 'Searching…' : 'Search now'}
                </Button>
              ) : null}
              <ActionMenu label={`More actions for ${item.title}`} entries={entries(false)} />
            </div>
            <div className={styles.phoneMenu}>
              <ActionMenu
                label={`Actions for ${item.title}`}
                entries={entries(true)}
                variant="bare"
              />
            </div>
          </>
        )}
      </div>
      {expanded && several ? (
        <ul className={styles.tracks} aria-label={`Tracks of ${item.title} on Wanted`}>
          {item.tracks.map((track) => (
            <li key={track.id} className={styles.track}>
              <span className={styles.trackText}>
                <span className={styles.trackTitle}>{track.title}</span>
                <span className={styles.trackMeta}>
                  {' · '}
                  {track.tries > 0 ? plural(track.tries, 'try', 'tries') : 'not tried yet'}
                </span>
              </span>
              {canSearch ? (
                <Button size="lg" variant="ghost" onClick={() => handlers.onSearchByHand(track)}>
                  Search by hand
                </Button>
              ) : (
                <span />
              )}
              <Button size="lg" variant="ghost" onClick={() => handlers.onRemoveTrack(track)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Something Wanted found this week; it leaves the list after seven days. */
export function FoundRowView({
  item,
  now,
  selecting,
  onOpenArtist,
}: {
  item: FoundItem;
  now: number;
  selecting: boolean;
  onOpenArtist: (artist: string) => void;
}) {
  const ms = serverTime(item.foundAt);
  const when = ms ? foundWhen(ms, now) : null;
  const entries: MenuEntry[] = item.artist
    ? [{ key: 'artist', label: 'Open artist', onSelect: () => onOpenArtist(item.artist) }]
    : [];
  return (
    <li className={styles.item}>
      <div className={styles.row} data-selecting={selecting ? 'true' : undefined}>
        {selecting ? <span className={styles.check} /> : null}
        <RowArt src={item.image} />
        <div className={styles.main}>
          <p className={styles.rowTitle} title={item.title}>
            {item.title}
          </p>
          <MetaLine parts={foundMeta(item)} onOpenArtist={() => onOpenArtist(item.artist)} />
        </div>
        <span className={styles.added} />
        <span className={styles.status}>
          <StatusTag tone="success">
            {when ? (
              // one flex item, so the day and the time wrap as one line of text
              <span>
                Found {when.day}
                <span className={styles.statusTime}>{` ${when.time}`}</span>
              </span>
            ) : (
              'Found this week'
            )}
          </StatusTag>
        </span>
        {selecting || entries.length === 0 ? null : (
          <>
            <div className={styles.actions}>
              <ActionMenu label={`More actions for ${item.title}`} entries={entries} />
            </div>
            <div className={styles.phoneMenu}>
              <ActionMenu label={`Actions for ${item.title}`} entries={entries} variant="bare" />
            </div>
          </>
        )}
      </div>
    </li>
  );
}

export interface FollowedRowHandlers {
  onOpenArtist: (row: FollowedRow) => void;
  onSettings: (row: FollowedRow) => void;
  onUnfollow: (row: FollowedRow) => void;
}

/** One followed artist (Wanted v3, 2b; phones 2d). */
export function FollowedRowView({
  row,
  now,
  audiobook,
  selecting,
  selected,
  onToggleSelect,
  handlers,
}: {
  row: FollowedRow;
  now: number;
  /** Its downloads are filed in the audiobook library. */
  audiobook: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (range: boolean) => void;
  handlers: FollowedRowHandlers;
}) {
  const tag = followedStatusTag(row.status);
  const latest = followedLatest(row, now);
  const meta = followedMeta(row, audiobook);
  const latestText = latest
    ? `${latest.label}: ${latest.album}${latest.when ? ` · ${latest.when}` : ''}`
    : '';
  const phoneBits = [
    row.summary ? `${row.summary.library_releases} in your library` : '',
    latest ? `${latest.label}: ${latest.album}` : '',
    audiobook ? 'Filed as audiobooks' : '',
  ].filter(Boolean);

  const entries = (withOpen: boolean): MenuEntry[] => {
    const list: MenuEntry[] = [];
    if (withOpen) {
      list.push({ key: 'open', label: 'Open artist', onSelect: () => handlers.onOpenArtist(row) });
    }
    if (row.id) {
      list.push({
        key: 'settings',
        label: 'Settings for this artist…',
        onSelect: () => handlers.onSettings(row),
      });
    }
    list.push(
      { key: 'sep', separator: true },
      {
        key: 'unfollow',
        label: 'Unfollow…',
        tone: 'danger',
        onSelect: () => handlers.onUnfollow(row),
      },
    );
    return list;
  };

  return (
    <li className={styles.item}>
      <div
        className={styles.row}
        data-layout="followed"
        data-selecting={selecting ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
      >
        {selecting ? (
          <SelectBox checked={selected} label={`Select ${row.name}`} onToggle={onToggleSelect} />
        ) : null}
        <RowArt src={row.image} round />
        <div className={styles.main}>
          <p className={styles.rowTitle} title={row.name}>
            {row.name}
          </p>
          {meta || phoneBits.length ? (
            <p className={styles.meta}>
              <span className={styles.metaWide}>{meta}</span>
              <span className={styles.metaPhoneOnly}>{phoneBits.join(' · ')}</span>
            </p>
          ) : null}
        </div>
        <span className={styles.latest} title={latestText || undefined}>
          {latestText}
        </span>
        <span className={styles.status}>
          <StatusTag tone={tag.tone}>{tag.text}</StatusTag>
        </span>
        {selecting ? null : (
          <>
            <div className={styles.actions}>
              <Button
                size="lg"
                className={styles.rowAction}
                onClick={() => handlers.onOpenArtist(row)}
              >
                Open artist
              </Button>
              <ActionMenu label={`More actions for ${row.name}`} entries={entries(false)} />
            </div>
            <div className={styles.phoneMenu}>
              <ActionMenu
                label={`Actions for ${row.name}`}
                entries={entries(true)}
                variant="bare"
              />
            </div>
          </>
        )}
      </div>
    </li>
  );
}
