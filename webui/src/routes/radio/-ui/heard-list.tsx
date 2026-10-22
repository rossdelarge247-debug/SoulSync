/**
 * Heard on radio (4b on a station, 4k across stations): what was identified,
 * newest first, grouped by day, each with its state and the one thing to do.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import type { HeardItem } from '@/features/radio/radio.types';

import { OptionButton, Select } from '@/components/form';
import { EmptyState, Notice, SkeletonList } from '@/components/primitives';
import { dayLabel } from '@/features/radio/radio.format';

import { heardQueryOptions, RADIO_KEY, wantHeard } from '../-radio.api';
import { HeardRow } from './parts';
import styles from './radio.module.css';

function useWant() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const mutation = useMutation({
    mutationFn: (item: HeardItem) => wantHeard(item.id),
    onMutate: (item) => setBusy(item.id),
    onSuccess: (res, item) => {
      window.showToast?.(
        res.skipped
          ? res.message || `${item.title} is already in your library.`
          : `Added ${item.title} to Wanted.`,
        res.skipped ? 'info' : 'success',
      );
      void queryClient.invalidateQueries({ queryKey: RADIO_KEY });
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
    onSettled: () => setBusy(null),
  });
  return { want: (item: HeardItem) => mutation.mutate(item), busy };
}

/** The station page's "Heard on NTS 1": today, five rows, and a link to the rest. */
export function StationHeard({
  stationId,
  stationName,
  homepage,
  identificationOn,
}: {
  stationId: string;
  stationName: string;
  homepage?: string;
  identificationOn: boolean;
}) {
  const query = useQuery(heardQueryOptions(stationId, 1));
  const { want, busy } = useWant();
  const items = query.data?.items ?? [];
  const today = items.filter(
    (i) => new Date(i.heard_at * 1000).toDateString() === new Date().toDateString(),
  );
  const counts = {
    identified: today.filter((i) => i.state !== 'not_identified').length,
    not: today.filter((i) => i.state === 'not_identified').length,
  };
  return (
    <section className={styles.panel} aria-labelledby="radio-heard-station" id="heard">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle} id="radio-heard-station">
          Heard on {stationName}
        </h2>
        <span className={styles.panelMeta}>
          Today · {counts.identified} identified · {counts.not} not identified
        </span>
      </div>
      {query.isPending ? (
        <SkeletonList rows={3} />
      ) : query.isError ? (
        <div className={styles.panelPad}>
          <Notice tone="danger" title="Heard on radio didn’t load">
            {(query.error as Error).message}. Nothing is lost; try again in a moment.
          </Notice>
        </div>
      ) : today.length === 0 ? (
        <div className={styles.panelPad}>
          <p className={styles.howNote}>
            {identificationOn
              ? `Nothing heard on ${stationName} today yet. Tracks show here as they’re identified while you listen.`
              : 'Track identification is off, so nothing is added to Heard.'}
          </p>
        </div>
      ) : (
        <div className={styles.rows}>
          {today.slice(0, 5).map((item) => (
            <HeardRow
              key={item.id}
              item={item}
              homepage={homepage}
              onWant={want}
              busy={busy === item.id}
            />
          ))}
        </div>
      )}
      <div className={styles.panelFoot}>
        <span>
          {Math.min(5, today.length)} of {today.length} today
        </span>
        <Link to="/radio" search={{ tab: 'heard' }}>
          All heard on radio
        </Link>
      </div>
    </section>
  );
}

const DAYS = [1, 7, 30, 90, 365];

/** The Heard on radio tab (4k): every station, filters, grouped by day. */
export function HeardTab({
  missingOnly,
  onMissing,
}: {
  missingOnly: boolean;
  onMissing: (on: boolean) => void;
}) {
  const [days, setDays] = useState(7);
  const query = useQuery(heardQueryOptions(undefined, days));
  const { want, busy } = useWant();
  const all = query.data?.items ?? [];
  const items = missingOnly ? all.filter((i) => i.state === 'not_added') : all;
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: HeardItem[] }[] = [];
    for (const item of items) {
      const key = new Date(item.heard_at * 1000).toDateString();
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(item);
      else out.push({ key, label: dayLabel(item.heard_at), items: [item] });
    }
    return out;
  }, [items]);
  const keep = query.data?.keep_days ?? 90;

  return (
    <div className={styles.stack}>
      <div className={styles.filters} role="group" aria-label="Show">
        <OptionButton selected={!missingOnly} onClick={() => onMissing(false)}>
          All stations
        </OptionButton>
        <OptionButton selected={missingOnly} onClick={() => onMissing(true)}>
          Not in your library{' '}
          {query.data ? (
            <span className={styles.count}>{query.data.counts.not_in_library}</span>
          ) : null}
        </OptionButton>
        <Select
          aria-label="How far back"
          value={String(days)}
          onChange={(event) => setDays(Number(event.target.value))}
        >
          {DAYS.filter((d) => d <= keep).map((d) => (
            <option key={d} value={d}>
              {d === 1 ? 'Today' : `${d} days`}
            </option>
          ))}
        </Select>
      </div>
      {query.isPending ? (
        <SkeletonList rows={5} />
      ) : query.isError ? (
        <Notice tone="danger" title="Heard on radio didn’t load">
          {(query.error as Error).message}. Nothing is lost; try again in a moment.
        </Notice>
      ) : items.length === 0 ? (
        <EmptyState
          variant="panel"
          title={missingOnly ? 'Nothing you don’t have' : 'Nothing heard yet'}
          description={
            missingOnly
              ? 'Every track identified in this time is in your library or on Wanted.'
              : 'Tracks played on the stations you listen to show here once they’re identified, so you can add them later.'
          }
          hint={`Heard on radio keeps ${keep} days (Settings → Radio).`}
        />
      ) : (
        <section className={styles.panel} aria-label="Heard on radio">
          {groups.map((group) => (
            <div key={group.key}>
              <p className={`${styles.label} ${styles.dayHead}`}>{group.label}</p>
              <div className={styles.rows}>
                {group.items.map((item) => (
                  <HeardRow
                    key={item.id}
                    item={item}
                    showStation
                    onWant={want}
                    busy={busy === item.id}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className={styles.panelFoot}>
            <span>
              {items.length} in {days === 1 ? 'today' : `${days} days`}
            </span>
            <span>Kept for {keep} days</span>
          </div>
        </section>
      )}
    </div>
  );
}
