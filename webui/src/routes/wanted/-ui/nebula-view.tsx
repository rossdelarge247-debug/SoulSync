import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { DialogFrame } from '@/components/dialog';
import { Button } from '@/components/form';
import { StatusTag } from '@/components/primitives';

import type { FoundItem, WantedFilter, WantedItem, WantedTrack } from '../-wanted.types';

import { libraryArtistQueryOptions } from '../-wanted.api';
import { foundWhen, plural, serverTime, wantedStatus } from '../-wanted.helpers';
import { useRefreshWanted } from '../-wanted.hooks';
import {
  COLUMN_PREVIEW,
  circleSize,
  nebulaColumns,
  panelItemMeta,
  removeAllLabel,
  searchAllLabel,
  stuckItem,
  stuckSentence,
  wantOthersLabel,
  type NebulaArtist,
  type NebulaColumn,
} from '../-wanted.nebula';
import { useMediaQuery } from '../../automations/-ui/use-narrow';
import { addToWanted } from '../../library/-library.api';
import { addedSentence } from '../../library/-library.grid';
import { AddConfirm, useRefreshLibrary, type AddRequest } from '../../library/-ui/add-confirm';
import { wishlistArtistPhotosQueryOptions } from '../../wishlist/-wishlist.api';
import { buildArtistImageMap } from '../../wishlist/-wishlist.helpers';
import styles from './nebula.module.css';

/** The phone layout of this page (wanted-page.module.css switches at 640). */
const PHONE = '(max-width: 640px)';

export interface NebulaHandlers {
  onOpenArtist: (artist: string) => void;
  /** Search now for these (the list's grab, with its toasts). */
  onSearchNow: (items: WantedItem[], label: string) => void;
  /** Remove these from Wanted (the list's confirm when it's more than one track). */
  onRemove: (items: WantedItem[]) => void;
  /** Search by hand, where a file below the target can be taken anyway. */
  onSearchByHand: (track: WantedTrack) => void;
}

function Circle({
  artist,
  image,
  size,
  tone,
}: {
  artist: NebulaArtist;
  image: string;
  size: 56 | 72 | 96;
  tone: NebulaColumn['tone'];
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.circleWrap} data-size={size}>
      {image && !failed ? (
        <img
          className={styles.circle}
          src={image}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={styles.circle} aria-hidden="true" />
      )}
      <span className={styles.count} data-tone={tone} aria-hidden="true">
        {artist.count}
      </span>
    </span>
  );
}

function ColumnView({
  column,
  hiddenBy,
  images,
  selected,
  onPick,
}: {
  column: NebulaColumn;
  /** The Show filter that hides this column's artists, if one does. */
  hiddenBy: string | null;
  images: Map<string, string>;
  selected: string | null;
  onPick: (artist: NebulaArtist) => void;
}) {
  const [all, setAll] = useState(false);
  const headId = useId();
  const shown = all ? column.artists : column.artists.slice(0, COLUMN_PREVIEW);
  const more = column.artists.length > COLUMN_PREVIEW;
  return (
    <section className={styles.column} data-group={column.group} aria-labelledby={headId}>
      <h3 className={styles.columnHead} id={headId} data-tone={column.tone}>
        <span className={styles.dot} aria-hidden="true" />
        {column.label} · {column.count}
      </h3>
      {hiddenBy ? (
        <p className={styles.columnNote}>Not shown while Show is on {hiddenBy}.</p>
      ) : column.artists.length === 0 ? (
        <p className={styles.columnNote}>
          {column.group === 'found'
            ? 'Nothing was found in the last 7 days.'
            : column.group === 'not-found'
              ? 'Nothing has gone unfound for three tries or more.'
              : 'Nothing is in its first searches.'}
        </p>
      ) : (
        <>
          <ul className={styles.artists}>
            {shown.map((artist) => {
              const size = circleSize(artist.count);
              const what =
                artist.items.length > 0
                  ? `${plural(artist.items.length, 'thing')} on Wanted`
                  : `${plural(artist.found.length, 'thing')} found this week`;
              return (
                <li key={artist.key}>
                  <button
                    type="button"
                    className={styles.artist}
                    data-artist={artist.key}
                    aria-pressed={selected === artist.key}
                    aria-label={`${artist.name}, ${what}`}
                    onClick={() => onPick(artist)}
                  >
                    <Circle
                      artist={artist}
                      image={images.get(artist.key) || artist.image}
                      size={size}
                      tone={column.tone}
                    />
                    <span className={styles.name}>{artist.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {more ? (
            <button
              type="button"
              className={styles.allLink}
              aria-expanded={all}
              onClick={() => setAll((v) => !v)}
            >
              {all ? 'Show fewer' : `All ${column.artists.length} artists`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The stuck things first (most tries first), then the rest in Wanted's order. */
function worstFirst(items: WantedItem[]): WantedItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.status === 'not-found') - Number(a.status === 'not-found') || b.tries - a.tries,
  );
}

function PanelRow({
  art,
  title,
  meta,
  tag,
}: {
  art: string;
  title: string;
  meta: string;
  tag: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <li className={styles.itemRow}>
      {art && !failed ? (
        <img
          className={styles.itemArt}
          src={art}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={styles.itemArt} aria-hidden="true" />
      )}
      <span className={styles.itemText}>
        <span className={styles.itemTitle}>{title}</span>
        <span className={styles.itemMeta}>{meta}</span>
        {tag}
      </span>
    </li>
  );
}

function FoundTag({ item, now }: { item: FoundItem; now: number }) {
  const ms = serverTime(item.foundAt);
  const when = ms ? foundWhen(ms, now) : null;
  return (
    <StatusTag tone="success">
      {when ? `Found ${when.day} ${when.time}` : 'Found this week'}
    </StatusTag>
  );
}

function ArtistPanel({
  artist,
  profileId,
  image,
  following,
  now,
  canSearch,
  qualityName,
  handlers,
  onClose,
  headingRef,
  onWantOthers,
}: {
  artist: NebulaArtist;
  profileId: number;
  image: string;
  following: boolean;
  now: number;
  canSearch: boolean;
  qualityName: (item: WantedItem) => string;
  handlers: NebulaHandlers;
  onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onWantOthers: (request: AddRequest, count: number, artistId: string | number) => void;
}) {
  const library = useQuery(libraryArtistQueryOptions(profileId, artist.name));
  const index = library.data ?? null;
  const [failed, setFailed] = useState(false);
  const why = stuckSentence(artist, now);
  const stuck = stuckItem(artist);
  const wanted = artist.items.length;
  const meta = [
    index ? plural(index.releases, 'release') : '',
    index ? `${index.in_library} in your library` : '',
    wanted ? `${wanted} on Wanted` : `${artist.found.length} found this week`,
    following || index?.following ? 'Following' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const wantable = index?.wantable ?? 0;

  return (
    <>
      <div className={styles.panelHead}>
        {image && !failed ? (
          <img className={styles.avatar} src={image} alt="" onError={() => setFailed(true)} />
        ) : (
          <span className={styles.avatar} aria-hidden="true" />
        )}
        <div className={styles.panelTitleBox}>
          <h2 className={styles.panelTitle} ref={headingRef} tabIndex={-1}>
            <button
              type="button"
              className={styles.panelTitleLink}
              onClick={() => handlers.onOpenArtist(artist.name)}
            >
              {artist.name}
            </button>
          </h2>
          <p className={styles.panelMeta}>{meta}</p>
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label={`Close ${artist.name}`}
          onClick={onClose}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {why ? (
        <p className={styles.why}>
          <strong>Why it’s stuck:</strong> {why}
        </p>
      ) : null}

      <ul className={styles.items} aria-label={`${artist.name} on Wanted`}>
        {worstFirst(artist.items).map((item) => {
          const status = wantedStatus(item);
          return (
            <PanelRow
              key={item.key}
              art={item.image}
              title={item.title}
              meta={panelItemMeta(item, qualityName(item), now)}
              tag={<StatusTag tone={status.tone}>{status.text}</StatusTag>}
            />
          );
        })}
        {artist.found.map((item) => (
          <PanelRow
            key={item.key}
            art={item.image}
            title={item.title}
            meta={[item.album !== item.title ? item.album : '', item.quality]
              .filter(Boolean)
              .join(' · ')}
            tag={<FoundTag item={item} now={now} />}
          />
        ))}
      </ul>

      {canSearch && (wanted > 0 || wantable > 0) ? (
        <div className={styles.actions}>
          {wanted > 0 ? (
            <Button
              size="lg"
              className={styles.wide}
              onClick={() =>
                handlers.onSearchNow(
                  artist.items,
                  wanted === 1
                    ? `“${artist.items[0].title}”`
                    : `${wanted} things by ${artist.name}`,
                )
              }
            >
              {searchAllLabel(wanted)}
            </Button>
          ) : null}
          {stuck && stuck.tracks[0] ? (
            <Button
              size="lg"
              variant="ghost"
              className={styles.wide}
              onClick={() => handlers.onSearchByHand(stuck.tracks[0])}
            >
              Accept any quality for {stuck.title}
            </Button>
          ) : null}
          {index && wantable > 0 ? (
            <Button
              size="lg"
              variant="ghost"
              className={styles.wide}
              onClick={() =>
                onWantOthers(
                  {
                    body: { filter: { artist_ids: [index.id] } },
                    what: `${artist.name}'s releases that aren't in your library or on Wanted.`,
                  },
                  wantable,
                  index.id,
                )
              }
            >
              {wantOthersLabel(wantable)}
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className={styles.links}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => handlers.onOpenArtist(artist.name)}
        >
          Open artist
        </button>
        {wanted > 0 ? (
          <>
            {' · '}
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => handlers.onRemove(artist.items)}
            >
              {removeAllLabel(wanted)}
            </button>
          </>
        ) : null}
      </p>
    </>
  );
}

/**
 * Wanted as a nebula (board 9a): a quiet card with three columns headed in
 * the status colours, each artist a circle sized by how many of theirs you're
 * waiting on, and the open artist in a 440px column beside it (under it when
 * the page is narrow; a sheet on a phone).
 */
export function NebulaView({
  profileId,
  items,
  found,
  query,
  filter,
  imageSources,
  now,
  canSearch,
  qualityName,
  handlers,
}: {
  profileId: number;
  items: WantedItem[];
  found: FoundItem[];
  query: string;
  filter: WantedFilter;
  imageSources: { artist_images?: Record<string, string> }[];
  now: number;
  canSearch: boolean;
  qualityName: (item: WantedItem) => string;
  handlers: NebulaHandlers;
}) {
  const phone = useMediaQuery(PHONE);
  const columns = useMemo(() => nebulaColumns(items, found, query), [items, found, query]);
  const photos = useQuery(wishlistArtistPhotosQueryOptions(profileId));
  const images = useMemo(
    () => buildArtistImageMap(imageSources, photos.data ?? []),
    [imageSources, photos.data],
  );
  const followed = useMemo(
    () =>
      new Set(
        (photos.data ?? []).map((a) => (a.artist_name ?? '').trim().toLowerCase()).filter(Boolean),
      ),
    [photos.data],
  );

  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = openKey
    ? (columns.flatMap((c) => c.artists).find((a) => a.key === openKey) ?? null)
    : null;
  const fieldRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastPicked = useRef<string | null>(null);

  // a removal or a filter that takes the open artist away closes its panel
  useEffect(() => {
    if (openKey && !open) setOpenKey(null);
  }, [openKey, open]);

  // the panel's name takes the focus when it opens (the sheet does its own)
  useEffect(() => {
    if (open && !phone) headingRef.current?.focus({ preventScroll: false });
  }, [open?.key, phone]);

  const close = () => {
    setOpenKey(null);
    const key = lastPicked.current;
    requestAnimationFrame(() =>
      fieldRef.current
        ?.querySelector<HTMLButtonElement>(`button[data-artist="${CSS.escape(key ?? '')}"]`)
        ?.focus(),
    );
  };

  useEffect(() => {
    if (!open || phone) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pick = (artist: NebulaArtist) => {
    lastPicked.current = artist.key;
    setOpenKey((current) => (current === artist.key ? null : artist.key));
  };

  // "Want the N other releases": one adds at once, more asks first (Library's rule)
  const [confirm, setConfirm] = useState<AddRequest | null>(null);
  const refreshLibrary = useRefreshLibrary();
  const refreshWanted = useRefreshWanted();
  const addOne = useMutation({
    mutationFn: (artistId: string | number) =>
      addToWanted({ filter: { artist_ids: [artistId] }, quality: 'target' }),
    onSuccess: (result) => {
      window.showToast?.(
        addedSentence(result),
        result.failed && !result.added ? 'error' : 'success',
      );
      refreshLibrary();
      void refreshWanted();
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });
  const wantOthers = (request: AddRequest, count: number, artistId: string | number) => {
    if (count === 1) addOne.mutate(artistId);
    else setConfirm(request);
  };

  const hiddenLabel =
    filter === 'all' ? null : (columns.find((c) => c.group === filter)?.label ?? null);

  const panel = open ? (
    <ArtistPanel
      key={open.key}
      artist={open}
      profileId={profileId}
      image={images.get(open.key) || open.image}
      following={followed.has(open.key)}
      now={now}
      canSearch={canSearch}
      qualityName={qualityName}
      handlers={handlers}
      onClose={close}
      headingRef={headingRef}
      onWantOthers={wantOthers}
    />
  ) : null;

  return (
    <div className={styles.nebulaBox}>
      <div className={styles.nebula} data-open={open && !phone ? 'true' : undefined}>
        <div className={styles.field} ref={fieldRef} role="group" aria-label="Wanted by artist">
          {columns.map((column) => (
            <ColumnView
              key={column.group}
              column={column}
              hiddenBy={hiddenLabel && column.group !== filter ? hiddenLabel : null}
              images={images}
              selected={openKey}
              onPick={pick}
            />
          ))}
        </div>
        {open && !phone ? (
          <aside className={styles.panel} aria-label={`${open.name} on Wanted`}>
            {panel}
          </aside>
        ) : null}
        {phone ? (
          <DialogFrame
            open={open !== null}
            onOpenChange={(next) => {
              if (!next) close();
            }}
            aria-label={open ? `${open.name} on Wanted` : undefined}
            viewportClassName={styles.sheetViewport}
            className={styles.sheet}
          >
            <span className={styles.grabber} aria-hidden="true" />
            {panel}
          </DialogFrame>
        ) : null}
      </div>
      {confirm ? (
        <AddConfirm
          request={confirm}
          onClose={() => setConfirm(null)}
          onDone={() => void refreshWanted()}
        />
      ) : null}
    </div>
  );
}
