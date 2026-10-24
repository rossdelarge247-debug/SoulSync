/**
 * MilkDrop's browser in the Visuals panel (10a, 18a; the phone sheet 10e):
 * search over names and authors, Show All / Favourites / Recent / Yours, the
 * Author select, the count line with Random preset, and the rows. The list is
 * the curated packs and your own unless "Every preset" is on (the panel's
 * foot); Yours shows once an admin has set an own-presets folder. Resting on (or focusing)
 * a row for 400 ms previews it on the stage; leaving goes back after a
 * second; Enter or a click keeps it. No thumbnails: the stage is the preview.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Button, OptionButton, Select } from '@/components/form';
import { LoadingState, Notice, SkeletonList, StatusTag } from '@/components/primitives';

import type { PresetEntry } from './visuals.types';

import { useVisuals, useVisualsController } from './use-visuals';
import { openPlayerSettings } from './visuals-stage-cards';
import { browserSummary, byLine, formatSize, withKept } from './visuals.logic';
import styles from './visuals.module.css';

const ROW_H = 56;
const OVERSCAN = 8;

function StarIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function MilkdropBrowser() {
  const s = useVisuals();
  const c = useVisualsController();

  if (!s.webgl2 || s.engineError) {
    return (
      <Notice
        tone="warning"
        layout="stacked"
        title="MilkDrop needs WebGL 2"
        actions={
          <Button variant="secondary" size="lg" onClick={() => c.setFamily('synchros')}>
            Show SYNCHRO.S’s visuals
          </Button>
        }
      >
        {s.engineError
          ? `${s.engineError} SYNCHRO.S’s visuals and Classic work everywhere; auto-cycle stays inside them here.`
          : 'This browser doesn’t offer it (older Safari and some remote desktops don’t). SYNCHRO.S’s visuals and Classic work everywhere; auto-cycle stays inside them here.'}
      </Notice>
    );
  }
  if (s.index.status === 'error') {
    return (
      <Notice
        tone="danger"
        layout="stacked"
        title="The preset list didn’t load"
        actions={
          <Button variant="secondary" size="lg" onClick={() => void c.ensureIndex()}>
            Try again
          </Button>
        }
      >
        {s.index.error}
      </Notice>
    );
  }
  if (s.index.status !== 'ready') {
    return (
      <div className={styles.browserLoading}>
        <LoadingState label="Loading the preset list…" />
        <SkeletonList rows={6} />
      </div>
    );
  }
  return <Browser />;
}

function Browser() {
  const s = useVisuals();
  const c = useVisualsController();
  const total = s.index.presets.length;
  const known = withKept(s.index.presets, s.index.kept);
  const favCount = known.filter((p) => s.favourites.has(p.key)).length;
  const recentCount = s.recent.filter((k) => known.some((p) => p.key === k)).length;
  const own = s.index.own;
  const yoursCount = s.index.presets.filter((p) => p.source === 'own').length;

  return (
    <div className={styles.browser}>
      <label className={styles.search}>
        <SearchIcon />
        <span className={styles.srOnly}>Search presets by name or author</span>
        <input
          type="search"
          value={s.query}
          placeholder={`Search ${total.toLocaleString('en-GB')} presets`}
          onChange={(e) => c.setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className={styles.showRow} role="group" aria-label="Show">
        <OptionButton selected={s.show === 'all'} onClick={() => c.setShow('all')}>
          All
        </OptionButton>
        <OptionButton selected={s.show === 'favourites'} onClick={() => c.setShow('favourites')}>
          Favourites <span className={styles.count}>{favCount}</span>
        </OptionButton>
        <OptionButton selected={s.show === 'recent'} onClick={() => c.setShow('recent')}>
          Recent <span className={styles.count}>{recentCount}</span>
        </OptionButton>
        {own?.configured ? (
          <OptionButton selected={s.show === 'yours'} onClick={() => c.setShow('yours')}>
            Yours <span className={styles.count}>{yoursCount}</span>
          </OptionButton>
        ) : null}
      </div>
      {s.phone ? null : (
        <div className={styles.authorRow}>
          <Select
            size="lg"
            aria-label="Author"
            value={s.author}
            onChange={(e) => c.setAuthor(e.target.value)}
            className={styles.authorSelect}
          >
            <option value="">Any author</option>
            {s.index.authors.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name} ({a.count})
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className={styles.summary}>
        <span>
          {browserSummary(s.list, {
            show: s.show,
            query: s.query,
            author: s.author,
            everyPreset: s.everyPreset,
          })}
        </span>
        <button type="button" className={styles.linkButton} onClick={() => c.random()}>
          Random preset
        </button>
      </div>
      <PresetRows />
    </div>
  );
}

function emptyWords(
  show: string,
  query: string,
  problem: string | null | undefined,
): { title: string; body: string; settings?: boolean } {
  if (show === 'yours' && !query) {
    // 18b: the folder is empty, or SYNCHRO.S can't open it
    return problem
      ? {
          title: 'None of yours to show',
          body: 'SYNCHRO.S can’t open the folder for your own presets. An admin checks it in',
          settings: true,
        }
      : {
          title: 'None of yours yet',
          body: 'The folder for your own presets is empty. An admin adds .milk files to it;',
          settings: true,
        };
  }
  if (query)
    return {
      title: `Nothing matches “${query}”`,
      body: 'Search looks at preset names and authors.',
    };
  if (show === 'favourites')
    return {
      title: 'No favourites yet',
      body: 'Star a preset in the list, or press L while it plays.',
    };
  if (show === 'recent')
    return {
      title: 'Nothing played yet',
      body: 'Presets you play show here, newest first.',
    };
  return {
    title: 'No presets here',
    body: 'An admin can add your own in Player settings.',
  };
}

function PresetRows() {
  const s = useVisuals();
  const box = useRef<HTMLUListElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight || 600 });
    measure();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => ro?.disconnect();
  }, []);

  // the playing row in view when the list opens
  useEffect(() => {
    const el = box.current;
    if (!el || !s.presetKey) return;
    const at = s.list.findIndex((p) => p.key === s.presetKey);
    if (at < 0) return;
    const y = at * ROW_H;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW_H)
      el.scrollTop = Math.max(0, y - ROW_H * 2);
    // only when the list itself changes, not on every preview
  }, [s.list]);

  if (!s.list.length) {
    const w = emptyWords(s.show, s.query, s.index.own?.problem);
    return (
      <div className={styles.empty} data-show={s.show}>
        <p className={styles.emptyTitle}>{w.title}</p>
        {w.settings ? (
          <p>
            {w.body}{' '}
            <button type="button" className={styles.inlineLink} onClick={openPlayerSettings}>
              Player settings
            </button>
            {s.index.own?.problem ? '.' : ' says where.'}
          </p>
        ) : (
          <p>{w.body}</p>
        )}
      </div>
    );
  }
  const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const last = Math.min(s.list.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
  const rows = s.list.slice(first, last);

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rowsEls = [
      ...(box.current?.querySelectorAll<HTMLButtonElement>('[data-row-main]') ?? []),
    ];
    const at = rowsEls.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = rowsEls[at + (e.key === 'ArrowDown' ? 1 : -1)];
    next?.focus();
    next?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <ul
      ref={box}
      className={styles.rows}
      aria-label="Presets"
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => ({ ...v, top }));
      }}
      onKeyDown={onKey}
    >
      <li aria-hidden="true" style={{ height: first * ROW_H }} className={styles.spacer} />
      {rows.map((p) => (
        <PresetRow
          key={p.key}
          entry={p}
          playing={p.key === s.presetKey}
          previewing={p.key === s.previewKey}
          loading={p.key === s.loadingKey}
          failed={s.failed.has(p.key)}
          fav={s.favourites.has(p.key)}
        />
      ))}
      <li
        aria-hidden="true"
        style={{ height: (s.list.length - last) * ROW_H }}
        className={styles.spacer}
      />
    </ul>
  );
}

interface RowProps {
  entry: PresetEntry;
  playing: boolean;
  previewing: boolean;
  loading: boolean;
  failed: boolean;
  fav: boolean;
}

function PresetRow({ entry, playing, previewing, loading, failed, fav }: RowProps) {
  const c = useVisualsController();
  const size = formatSize(entry.size);
  return (
    <li
      className={styles.row}
      data-playing={playing ? 'true' : undefined}
      data-previewing={previewing ? 'true' : undefined}
    >
      <button
        type="button"
        className={styles.rowMain}
        data-row-main
        aria-current={playing ? 'true' : undefined}
        onClick={() => c.pick(entry.key)}
        onMouseEnter={() => c.hoverRow(entry.key)}
        onMouseLeave={() => c.leaveRow()}
        onFocus={() => c.hoverRow(entry.key)}
        onBlur={() => c.leaveRow()}
      >
        <span className={styles.rowName}>{entry.name}</span>
        <span className={styles.rowMeta}>
          {byLine(entry)}
          {size ? ` · ${size}` : ''}
          {entry.source === 'own' ? ' · yours' : ''}
        </span>
      </button>
      <span className={styles.rowTag}>
        {failed && !loading ? (
          <StatusTag tone="warning">Won’t load</StatusTag>
        ) : loading ? (
          <StatusTag tone="neutral">Loading</StatusTag>
        ) : previewing ? (
          <StatusTag tone="neutral">Previewing</StatusTag>
        ) : playing ? (
          <StatusTag tone="info" live>
            Playing
          </StatusTag>
        ) : null}
      </span>
      <button
        type="button"
        className={styles.star}
        aria-pressed={fav}
        aria-label={
          fav ? `Remove ${entry.name} from favourites` : `Add ${entry.name} to favourites`
        }
        onClick={() => void c.toggleFavourite(entry.key)}
      >
        <StarIcon on={fav} />
      </button>
    </li>
  );
}

export { StarIcon };
