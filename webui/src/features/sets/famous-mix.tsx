/**
 * Famous mix (22f–22i; states 22r, 22s): search MixesDB, MusicBrainz and
 * Discogs, or paste a tracklist, then the match against the library: "You
 * own 14 of 22", the three-part bar, each line Owned / Another version /
 * Missing (IDs aside), Use yours or Want the Dub on a version, Save as mix,
 * Export to Traktor… and Add N missing to Wanted. Matching and reading a
 * paste are plain code on the server; nothing here asks an AI.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import { Button, TextArea, TextInput } from '@/components/form';
import { LoadingState, Notice, StatusTag } from '@/components/primitives';
import { TraktorExportDialog } from '@/features/dj/traktor-export-dialog';
import { appURL } from '@/platform/url-base';

import type {
  MatchCounts,
  MatchRow,
  MixResult,
  OpenedMix,
  SavedResult,
  SearchAnswer,
  SetSource,
  SourceName,
  UnreadLine,
} from './sets.api';

import {
  SETS_QUERY_KEY,
  SourceDownError,
  addToWanted,
  createSet,
  removeFromWanted,
  matchLines,
  openMix,
  pasteTracklist,
  searchMixes,
} from './sets.api';
import {
  SOURCE_NAMES,
  dateWords,
  downMissing,
  downNames,
  haveLine,
  lengthWords,
  namesList,
  ownLine,
  ownRest,
  resultMeta,
  rowsFromMatch,
  safeSourceLink,
  searchedLine,
  sourceLine,
  wantLabel,
} from './sets.format';
import styles from './sets.module.css';

function openSettingsConnections(): void {
  window.location.assign(appURL('/settings?tab=connections'));
}

/* ── the match (22f, 22g, 22h's right side) ───────────────────────────── */

export interface MatchSource {
  name: string;
  /** the line under the title */
  meta: string;
  source: SetSource;
  source_id?: string | null;
  source_url?: string | null;
  source_meta?: Record<string, unknown>;
  /** the line under the match: "Tracklist from MixesDB · edited 2 weeks ago" */
  from?: string;
}

const TAGS: Record<string, { tone: 'success' | 'info' | 'neutral'; word: string; short: string }> =
  {
    owned: { tone: 'success', word: 'Owned', short: 'Owned' },
    version: { tone: 'info', word: 'Another version', short: 'Other cut' },
    missing: { tone: 'neutral', word: 'Missing', short: 'Missing' },
  };

function lineTitle(row: MatchRow): string {
  return row.state === 'id' ? 'ID – ID' : `${row.artist} – ${row.title}`;
}

function secondLine(row: MatchRow): string {
  if (row.state === 'id') return 'Not identified in the tracklist';
  if (row.state === 'missing') return 'Not in your library';
  if (row.state === 'version') return haveLine(row.have);
  const t = row.track;
  if (row.note) return row.note;
  return [t?.artist_name, t?.album_title].filter(Boolean).join(' · ');
}

export function Bar({ counts }: { counts: MatchCounts }) {
  const of = counts.of || 1;
  return (
    <span
      className={styles.bar}
      role="img"
      aria-label={`${counts.owned} owned, ${counts.version} in another version, ${counts.missing} missing`}
    >
      <span data-part="owned" style={{ width: `${(100 * counts.owned) / of}%` }} />
      <span data-part="version" style={{ width: `${(100 * counts.version) / of}%` }} />
      <span data-part="missing" style={{ width: `${(100 * counts.missing) / of}%` }} />
    </span>
  );
}

export function MatchView({
  rows,
  counts,
  source,
  phone,
  onSaved,
  footNote,
  before,
}: {
  /** what sits between the title and the count (22h: the lines to check) */
  before?: ReactNode;
  rows: MatchRow[];
  counts: MatchCounts;
  source: MatchSource;
  phone: boolean;
  onSaved: (id: number) => void;
  footNote?: string;
}) {
  const queryClient = useQueryClient();
  const [wants, setWants] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    setWants({});
    setWanted(false);
  }, [rows]);
  const used = rows.filter((r) => r.track && r.state !== 'missing');
  const missing = rows.filter((r) => r.state === 'missing');

  const save = async () => {
    setBusy(true);
    try {
      const made = await createSet({
        name: source.name,
        kind: 'famous',
        rows: rowsFromMatch(rows, wants),
        source: source.source,
        source_id: source.source_id ?? null,
        source_url: source.source_url ?? null,
        source_meta: source.source_meta,
      });
      void queryClient.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'list'] });
      window.showToast?.(`Saved ${source.name}: in Your sets and as a playlist`, 'success');
      onSaved(made.id);
    } catch (err) {
      window.showToast?.(err instanceof Error ? err.message : "The mix wasn't saved.", 'error');
    } finally {
      setBusy(false);
    }
  };

  const want = async (items: MatchRow[], what: string) => {
    try {
      const done = await addToWanted(
        items.map((r) => ({ artist: r.artist, title: r.title })),
        source.name,
      );
      const refused = done.refused.length ? ` (${done.refused.length} couldn't go on)` : '';
      window.showToast?.(
        `${what}: ${done.added + done.already} on Wanted${refused}`,
        done.refused.length ? 'warning' : 'success',
      );
      return true;
    } catch (err) {
      window.showToast?.(err instanceof Error ? err.message : "Wanted didn't take them.", 'error');
      return false;
    }
  };

  const pick = (index: number, row: MatchRow, on: boolean) => {
    if (Boolean(wants[index]) === on) return;
    setWants((cur) => ({ ...cur, [index]: on }));
    if (on) void want([row], `${row.title}`);
    else
      // Use yours again: the Wanted row Want the Dub added goes, if it's still waiting
      void removeFromWanted({ artist: row.artist, title: row.title }, source.name)
        .then((done) =>
          window.showToast?.(
            done.removed ? `${row.title} is off Wanted again` : `Using yours for ${row.title}`,
            'success',
          ),
        )
        .catch(() => undefined);
  };

  return (
    <section className={styles.match} aria-label={`The match: ${source.name}`} data-match="">
      <h2 className={styles.matchTitle}>{source.name}</h2>
      {source.meta ? <p className={styles.matchMeta}>{source.meta}</p> : null}
      {before}
      <div className={styles.ownCard}>
        <p className={styles.ownLine}>
          <strong>{ownLine(counts)}</strong>
          {ownRest(counts) ? <span>{ownRest(counts)}</span> : null}
        </p>
        <Bar counts={counts} />
        <div className={styles.ownActions}>
          <Button
            size="lg"
            variant="primary"
            disabled={busy || !used.length}
            onClick={() => void save()}
          >
            Save as mix
          </Button>
          {phone ? null : (
            <Button
              size="lg"
              variant="secondary"
              disabled={!used.length}
              disabledReason={used.length ? undefined : 'None of these are in your library'}
              onClick={() => setExporting(true)}
            >
              Export to Traktor…
            </Button>
          )}
          {missing.length ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={wanted}
              disabledReason={wanted ? 'They’re on Wanted' : undefined}
              onClick={() =>
                void want(missing, `${missing.length} missing`).then((ok) => ok && setWanted(true))
              }
            >
              {phone
                ? `Add ${missing.length} to Wanted`
                : `Add ${missing.length} missing to Wanted`}
            </Button>
          ) : null}
        </div>
        {phone ? null : (
          <p className={styles.ownNote}>
            The mix uses {used.length}: yours{counts.version ? ' and your versions' : ''}.
          </p>
        )}
      </div>
      <ol className={styles.matchRows} aria-label="The tracklist">
        {rows.map((row, i) => {
          const tag = TAGS[row.state];
          return (
            <li key={i} className={styles.matchRow} data-state={row.state}>
              {phone ? null : <span className={styles.at}>{row.at || (row.n ?? '')}</span>}
              <span className={styles.matchText}>
                <span className={styles.matchLine}>{lineTitle(row)}</span>
                <span className={styles.matchSub}>
                  {phone && row.at ? `${row.at} · ` : ''}
                  {secondLine(row)}
                </span>
              </span>
              {tag ? (
                <StatusTag tone={tag.tone} className={styles.matchTag}>
                  {phone ? tag.short : tag.word}
                </StatusTag>
              ) : (
                <span />
              )}
              {row.state === 'version' ? (
                <span
                  className={styles.wantPair}
                  role="radiogroup"
                  aria-label={`Which cut of ${row.title}`}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!wants[i]}
                    onClick={() => pick(i, row, false)}
                  >
                    Use yours
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={Boolean(wants[i])}
                    onClick={() => pick(i, row, true)}
                  >
                    {wantLabel(row.want_version)}
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {source.from || footNote ? (
        <p className={styles.matchFoot}>
          {footNote ?? source.from}
          {safeSourceLink(source.source_url) ? (
            <>
              {' · '}
              <a
                href={safeSourceLink(source.source_url)!}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                open it there
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {exporting ? (
        <TraktorExportDialog
          from={{
            source: 'tracks',
            track_ids: used.map((r) => r.track!.id),
            name: source.name,
            left_out: rows
              .filter((r) => !(r.track && r.state !== 'missing'))
              .map((r) => ({ title: r.title, artist: r.artist })),
          }}
          name={source.name}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </section>
  );
}

/* ── search (22f, 22r, 22s) ───────────────────────────────────────────── */

function offLines(answer: SearchAnswer | undefined, isAdmin: boolean) {
  if (!answer) return null;
  const lines = [];
  if (answer.sources.discogs?.state === 'off') {
    lines.push(
      <p key="discogs" className={styles.offLine}>
        Discogs isn&apos;t searched: it needs a free token in{' '}
        {isAdmin ? (
          <button type="button" className={styles.inlineLink} onClick={openSettingsConnections}>
            Settings → Connections
          </button>
        ) : (
          'Settings → Connections'
        )}
        .
      </p>,
    );
  }
  for (const name of ['discogs', 'mixesdb'] as const) {
    const state = answer.sources[name];
    if (state?.state !== 'limited') continue;
    const label = name === 'discogs' ? 'Discogs' : 'MixesDB';
    lines.push(
      <p key={`${name}-limited`} className={styles.offLine}>
        {state.why === 'profile'
          ? name === 'discogs'
            ? "Discogs isn't searched for a minute: you've searched it often just now, and its key is shared."
            : "MixesDB isn't searched for a minute: you've searched it often just now."
          : state.why === 'busy'
            ? `${label} is busy with other searches just now. Try again in a moment.`
            : `${label} asked SYNCHRO.S to slow down, so it isn’t searched for a minute.`}
      </p>,
    );
  }
  if (answer.sources.mixesdb?.state === 'off') {
    lines.push(
      <p key="mixesdb" className={styles.offLine}>
        MixesDB isn&apos;t searched yet: SYNCHRO.S is still checking its terms of use.
      </p>,
    );
  }
  return lines;
}

function mixMeta(opened: OpenedMix): string {
  const m = opened.mix;
  const tracks = opened.counts.of;
  const ids = opened.counts.ids;
  return [
    m.kind === 'cd' ? `Mix CD${m.date ? `, ${m.date.slice(0, 4)}` : ''}` : dateWords(m.date),
    m.artist && m.kind === 'cd' ? m.artist : '',
    m.seconds ? lengthWords(m.seconds) : '',
    `${tracks} ${tracks === 1 ? 'track' : 'tracks'}${ids ? ` and ${ids} ${ids === 1 ? 'ID' : 'IDs'}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function FamousSearch({
  q,
  onQuery,
  phone,
  isAdmin,
  onPaste,
  onSaved,
  onOpenSaved,
}: {
  q: string;
  onQuery: (q: string) => void;
  phone: boolean;
  isAdmin: boolean;
  onPaste: () => void;
  onSaved: (id: number) => void;
  onOpenSaved: (id: number) => void;
}) {
  const inputId = useId();
  const [text, setText] = useState(q);
  const [picked, setPicked] = useState<MixResult | null>(null);
  useEffect(() => setText(q), [q]);
  const search = useQuery({
    queryKey: [...SETS_QUERY_KEY, 'famous', q],
    queryFn: () => searchMixes(q),
    enabled: q.trim().length > 0,
    retry: false,
    staleTime: 60_000,
  });
  const opened = useQuery({
    queryKey: [...SETS_QUERY_KEY, 'open', picked?.source, picked?.id],
    queryFn: () => openMix(picked!.source, picked!.id),
    enabled: picked !== null,
    retry: false,
  });
  const answer = search.data;
  const down = answer ? downNames(answer.sources) : [];
  const asked = answer
    ? (Object.keys(answer.sources) as SourceName[]).filter((s) => answer.sources[s].state !== 'off')
    : [];
  const allDown = Boolean(answer) && asked.length > 0 && down.length === asked.length;
  const savedFor = (r: MixResult | null): SavedResult | undefined =>
    r ? answer?.saved.find((s) => s.from === r.source && s.source_id === r.id) : undefined;

  const results = (
    <div className={styles.results}>
      <form
        className={styles.searchForm}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setPicked(null);
          onQuery(text.trim());
        }}
      >
        <label className={styles.srOnly} htmlFor={inputId}>
          Find a famous mix
        </label>
        <TextInput
          id={inputId}
          value={text}
          placeholder="A DJ, a mix or a MixesDB link"
          onChange={(event) => setText(event.target.value)}
        />
        <div className={styles.pills}>
          <button type="submit" className={styles.pill} aria-pressed="true">
            Search
          </button>
          <button type="button" className={styles.pill} aria-pressed="false" onClick={onPaste}>
            Paste a tracklist
          </button>
        </div>
      </form>
      {search.isFetching && !answer ? (
        <LoadingState label="Looking in MixesDB, MusicBrainz and Discogs…" />
      ) : null}
      {search.isError ? (
        <Notice tone="danger" role="alert" title="Couldn't search">
          SYNCHRO.S didn&apos;t answer. Try again in a moment.
        </Notice>
      ) : null}
      {allDown ? (
        <div className={styles.downCard} data-all-down="">
          <h3>Can&apos;t search for mixes right now</h3>
          <p>
            {namesList(down)} didn&apos;t answer. Paste the tracklist from anywhere instead;
            it&apos;s matched the same way.
          </p>
          <Button size="lg" variant="primary" onClick={onPaste}>
            Paste a tracklist
          </Button>
          <Button size="lg" variant="secondary" onClick={() => void search.refetch()}>
            Try again
          </Button>
        </div>
      ) : down.length ? (
        <Notice
          tone="warning"
          layout="stacked"
          title={`${namesList(down)} can't be reached`}
          actions={
            <>
              <Button size="lg" variant="secondary" onClick={() => void search.refetch()}>
                Try again
              </Button>
              <Button size="lg" variant="secondary" onClick={onPaste}>
                Paste a tracklist
              </Button>
            </>
          }
        >
          {downMissing(down)}
        </Notice>
      ) : null}
      {answer && !allDown ? (
        <>
          <p className={styles.count}>
            {answer.results.length + answer.saved.length}{' '}
            {answer.results.length + answer.saved.length === 1 ? 'mix' : 'mixes'}
          </p>
          <ul className={styles.resultList} aria-label="Mixes found">
            {answer.saved.map((s) => (
              <li key={`saved-${s.id}`}>
                <button
                  type="button"
                  className={styles.result}
                  onClick={() => onOpenSaved(Number(s.id))}
                >
                  <span className={styles.resultTitle}>{s.title}</span>
                  <span className={styles.resultMeta}>
                    Your saved mix · {s.tracks} tracks
                    {s.from && s.from !== 'paste' ? ` · from ${SOURCE_NAMES[s.from]}` : ''}
                  </span>
                </button>
              </li>
            ))}
            {answer.results.map((r) => (
              <li key={`${r.source}-${r.id}`}>
                <button
                  type="button"
                  className={styles.result}
                  aria-pressed={picked?.source === r.source && picked.id === r.id}
                  onClick={() => setPicked(r)}
                >
                  <span className={styles.resultTitle}>{r.title}</span>
                  <span className={styles.resultMeta}>{resultMeta(r)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className={styles.offLine}>
            {searchedLine(answer.sources)} Not there?{' '}
            <button type="button" className={styles.inlineLink} onClick={onPaste}>
              Paste a tracklist
            </button>
            .
          </p>
        </>
      ) : null}
      {offLines(answer, isAdmin)}
    </div>
  );

  let match = null;
  if (picked) {
    if (opened.isPending)
      match = <LoadingState label={`Reading the tracklist from ${SOURCE_NAMES[picked.source]}…`} />;
    else if (opened.isError) {
      const err = opened.error;
      const saved = savedFor(picked);
      match =
        err instanceof SourceDownError ? (
          <div className={styles.downCard} data-source-down={err.source}>
            <h3>This tracklist is on {SOURCE_NAMES[err.source]}, which can&apos;t be reached</h3>
            <p>
              SYNCHRO.S tried for 10 seconds; {SOURCE_NAMES[err.source]} didn&apos;t answer.
              It&apos;s often back within the hour.
              {saved ? ' You saved it as a mix, so that copy still opens.' : ''}
            </p>
            {saved ? (
              <Button size="lg" variant="primary" onClick={() => onOpenSaved(Number(saved.id))}>
                Open your saved copy
              </Button>
            ) : null}
            <Button size="lg" variant="secondary" onClick={() => void opened.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <Notice tone="danger" role="alert" title="Couldn't open that mix">
            {err instanceof Error ? err.message : 'Try again in a moment.'}
          </Notice>
        );
    } else {
      const o = opened.data;
      match = (
        <MatchView
          rows={o.rows}
          counts={o.counts}
          phone={phone}
          onSaved={onSaved}
          source={{
            name: o.mix.title,
            meta: mixMeta(o),
            source: o.mix.source,
            source_id: o.mix.id,
            source_url: o.mix.url ?? null,
            source_meta: {
              title: o.mix.title,
              artist: o.mix.artist,
              date: o.mix.date,
              edited: o.mix.edited,
              kind: o.mix.kind,
              seconds: o.mix.seconds ?? undefined,
              lines: o.rows.length,
            },
            from: sourceLine(o.mix.source, o.mix.edited),
          }}
        />
      );
    }
  }

  if (phone && picked) {
    return (
      <div className={styles.famous}>
        <button type="button" className={styles.backLink} onClick={() => setPicked(null)}>
          ‹ Back to the results
        </button>
        {match}
      </div>
    );
  }
  return (
    <div className={styles.famous} data-famous="">
      {results}
      {phone ? null : (
        <div className={styles.matchColumn}>
          {match ?? (
            <p className={styles.matchEmpty}>
              {answer
                ? 'Pick a mix to match it against your library.'
                : 'Search for a DJ or a mix, or paste a tracklist from anywhere.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── paste (22h, 22i) ──────────────────────────────────────────────────── */

interface Typed {
  artist: string;
  title: string;
}

function UnreadRow({
  line,
  onType,
  onLeave,
}: {
  line: UnreadLine;
  onType: (typed: Typed) => void;
  onLeave: () => void;
}) {
  const [typing, setTyping] = useState(false);
  const [artist, setArtist] = useState('');
  const [title, setTitle] = useState('');
  const a = useId();
  const t = useId();
  return (
    <li className={styles.unread} data-unread={line.n}>
      <span className={styles.unreadN}>{line.n}</span>
      <span className={styles.unreadText}>
        <code className={styles.raw}>{line.raw}</code>
        <span className={styles.unreadWhy}>{line.why}</span>
        {typing ? (
          <span className={styles.typeIt}>
            <label htmlFor={a} className={styles.srOnly}>
              Artist
            </label>
            <TextInput
              id={a}
              placeholder="Artist"
              value={artist}
              autoFocus
              onChange={(e) => setArtist(e.target.value)}
            />
            <label htmlFor={t} className={styles.srOnly}>
              Title
            </label>
            <TextInput
              id={t}
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button
              size="lg"
              variant="primary"
              disabled={!artist.trim() || !title.trim()}
              disabledReason={!artist.trim() || !title.trim() ? 'Type both' : undefined}
              onClick={() => onType({ artist: artist.trim(), title: title.trim() })}
            >
              Match it
            </Button>
          </span>
        ) : null}
      </span>
      {typing ? null : (
        <span className={styles.unreadActions}>
          <Button size="lg" variant="secondary" onClick={() => setTyping(true)}>
            Type it…
          </Button>
          <Button size="lg" variant="ghost" onClick={onLeave}>
            Leave out
          </Button>
        </span>
      )}
    </li>
  );
}

export function PasteTracklist({
  phone,
  onSearch,
  onSaved,
}: {
  phone: boolean;
  onSearch: () => void;
  onSaved: (id: number) => void;
}) {
  const nameId = useId();
  const textId = useId();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<(MatchRow & { n?: number | null })[] | null>(null);
  const [unread, setUnread] = useState<UnreadLine[]>([]);
  const [lines, setLines] = useState(0);

  const read = async () => {
    setBusy(true);
    setError(null);
    try {
      const got = await pasteTracklist(text);
      setRows(got.rows);
      setUnread(got.unread);
      setLines(got.lines);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The tracklist wasn't read.");
    } finally {
      setBusy(false);
    }
  };

  const typed = async (line: UnreadLine, value: Typed) => {
    try {
      const got = await matchLines([{ ...value, at: line.at }]);
      const row = { ...got.rows[0], n: line.n, raw: line.raw, note: `Typed for line ${line.n}` };
      setRows((cur) => [...(cur ?? []), row].sort((x, y) => (x.n ?? 0) - (y.n ?? 0)));
      setUnread((cur) => cur.filter((u) => u.n !== line.n));
    } catch (err) {
      window.showToast?.(err instanceof Error ? err.message : "That line wasn't matched.", 'error');
    }
  };

  const counts: MatchCounts | null = useMemo(() => {
    if (!rows) return null;
    const c = { owned: 0, version: 0, missing: 0, ids: 0, of: 0 };
    for (const r of rows) {
      if (r.state === 'owned') c.owned++;
      else if (r.state === 'version') c.version++;
      else if (r.state === 'missing') c.missing++;
      else c.ids++;
    }
    c.of = c.owned + c.version + c.missing;
    return c;
  }, [rows]);

  const shown = name.trim() || 'Pasted tracklist';
  const readCount = rows?.length ?? 0;
  const form = (
    <div className={styles.pasteForm}>
      <div className={styles.pills}>
        <button type="button" className={styles.pill} aria-pressed="false" onClick={onSearch}>
          Search
        </button>
        <button type="button" className={styles.pill} aria-pressed="true">
          Paste a tracklist
        </button>
      </div>
      <label className={styles.fieldLabel} htmlFor={nameId}>
        Name
      </label>
      <TextInput
        id={nameId}
        value={name}
        maxLength={200}
        placeholder="Kestrel Row at Sunwaves 2024"
        onChange={(e) => setName(e.target.value)}
      />
      <label className={styles.fieldLabel} htmlFor={textId}>
        The tracklist, as you copied it
      </label>
      <TextArea
        id={textId}
        className={styles.pasteText}
        value={text}
        rows={phone ? 8 : 16}
        maxLength={64 * 1024}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <p className={styles.offLine}>
        Read line by line as Artist – Title, by SYNCHRO.S itself. Times and track numbers are left
        out.
      </p>
      {error ? (
        <Notice tone="danger" role="alert" title="That didn't work">
          {error}
        </Notice>
      ) : null}
      <Button
        size="lg"
        variant={rows ? 'secondary' : 'primary'}
        disabled={busy || !text.trim()}
        disabledReason={!text.trim() ? 'Paste a tracklist first' : undefined}
        onClick={() => void read()}
      >
        {rows ? 'Read it again' : 'Read the tracklist'}
      </Button>
    </div>
  );

  const result =
    rows && counts ? (
      <div className={styles.pasteResult}>
        <MatchView
          rows={rows}
          counts={counts}
          phone={phone}
          onSaved={onSaved}
          source={{
            name: shown,
            meta: `Pasted · ${lines} lines · ${readCount} read${unread.length ? `, ${unread.length} to check` : ''}`,
            source: 'paste',
            source_meta: { title: shown, lines },
          }}
          footNote="Lines you leave out aren’t in the mix or the export."
          before={
            unread.length ? (
              <>
                <Notice
                  tone="warning"
                  title={`${unread.length} ${unread.length === 1 ? 'line' : 'lines'} couldn't be read as a track.`}
                >
                  Type what {unread.length === 1 ? 'it is' : 'they are'}, or leave{' '}
                  {unread.length === 1 ? 'it' : 'them'} out. The rest is matched already: you own{' '}
                  {counts.owned} of {counts.of}.
                </Notice>
                <ul className={styles.unreadList} aria-label="Lines to check">
                  {unread.map((line) => (
                    <UnreadRow
                      key={line.n}
                      line={line}
                      onType={(value) => void typed(line, value)}
                      onLeave={() => setUnread((cur) => cur.filter((u) => u.n !== line.n))}
                    />
                  ))}
                </ul>
              </>
            ) : null
          }
        />
      </div>
    ) : null;

  return (
    <div className={styles.famous} data-paste="">
      {phone && rows ? null : form}
      {phone ? (
        result
      ) : (
        <div className={styles.matchColumn}>
          {result ?? (
            <p className={styles.matchEmpty}>The match shows here, beside what you pasted.</p>
          )}
        </div>
      )}
      {phone && rows ? (
        <button type="button" className={styles.backLink} onClick={() => setRows(null)}>
          ‹ Change the paste
        </button>
      ) : null}
    </div>
  );
}
