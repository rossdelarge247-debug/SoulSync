/**
 * /automix-lab: the stage B harness (admins; a development build or `?lab=1`).
 * Not a SYNCHRO.S screen: a bench to hear the two-deck engine with real
 * plans before stage C builds the chips, Mix now and the handover view.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { AnalysisEntry } from '@/features/dj/analysis.api';
import type { DjBrowseResponse, DjTrack } from '@/features/dj/dj.api';

import { apiClient, readJson } from '@/app/api-client';
import { AnalysisProgress, useAnalysis, useAutoAnalyse } from '@/features/dj/analysis-progress';

import { fetchGrids, fetchPlan, fetchWindow, type Plan } from '../loader';
import {
  CueRouter,
  cueDevices,
  cueEnv,
  cueSupport,
  readCuePrefs,
  saveCuePrefs,
  type CuePrefs,
} from '../outputs';
import { STYLE_WORDS, type Style } from '../score';
import workletUrl from '../worklet/deck-processor.js?url';
import styles from './automix-lab.module.css';
import { LabSession, waitingWords, type LabDeps } from './lab-session';

interface PlayerHooks {
  audioGraph?: () => { context: AudioContext; analyser: AnalyserNode } | null;
  state?: () => { playing?: boolean } | null;
  toggle?: () => void;
}

const player = () => (window as unknown as { SoulSyncPlayer?: PlayerHooks }).SoulSyncPlayer;

let ownContext: AudioContext | null = null;

/** This browser's storage, or none where reading it throws (blocked site data, some private windows). */
export function browserStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const deps: LabDeps = {
  fetchPlan,
  fetchGrids,
  fetchWindow,
  workletUrl,
  graph() {
    const g = player()?.audioGraph?.();
    if (g) return { context: g.context, analyser: g.analyser };
    ownContext ??= new AudioContext();
    return { context: ownContext, analyser: null };
  },
  pausePlayer() {
    const p = player();
    if (p?.state?.()?.playing) p.toggle?.();
  },
};

const STYLE_CHOICES: (Style | 'auto')[] = [
  'auto',
  'long_blend',
  'short_blend',
  'bass_swap',
  'cut',
  'echo_out',
  'filter_sweep',
  'drop_swap',
];

function TrackSearch({
  label,
  chosen,
  onPick,
  progress = null,
}: {
  label: string;
  chosen: DjTrack | null;
  onPick: (t: DjTrack) => void;
  /** the picked track's place in the analysis (analyse on demand) */
  progress?: AnalysisEntry | null;
}) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<DjTrack[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      readJson<DjBrowseResponse>(
        apiClient.get('library/dj/browse', { searchParams: { q, limit: 8, sort: 'title' } }),
      )
        .then((r) => setFound(r.tracks))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <fieldset className={styles.pick}>
      <legend>{label}</legend>
      <p className={styles.chosen}>
        {chosen
          ? `${chosen.title} · ${chosen.artist_name} · ${chosen.dj?.bpm ?? '?'} BPM · ${chosen.dj?.key ?? '?'}`
          : 'None yet'}
      </p>
      {chosen ? (
        <AnalysisProgress entry={progress} block label={`Analysis of ${chosen.title}`} />
      ) : null}
      <input
        className={styles.input}
        aria-label={`Find the ${label.toLowerCase()}`}
        placeholder="Find a track in your library"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className={styles.results}>
        {found.map((t) => (
          <li key={t.id}>
            <button type="button" className={styles.result} onClick={() => onPick(t)}>
              {t.title} · {t.artist_name} · {t.dj?.bpm ?? '?'} · {t.dj?.key ?? '?'}
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

const seconds = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '?';

/**
 * The plan as the server said it. Every status reads safely: a `waiting`
 * plan has no places, a `crossfade` one may have no outgoing start.
 */
export function PlanSummary({
  plan,
  titles = {},
}: {
  plan: Plan;
  titles?: { from?: string; to?: string };
}) {
  const waiting = plan.status === 'waiting';
  return (
    <dl className={styles.plan}>
      <dt>Plan</dt>
      <dd>
        {plan.status === 'ok' ? (plan.label ?? plan.style ?? 'ok') : plan.status}{' '}
        {plan.bars ? `· ${plan.bars} bars` : ''} {plan.chosen_by ? `(${plan.chosen_by})` : ''}
      </dd>
      <dt>Why</dt>
      <dd>{waiting ? waitingWords(plan, titles) : (plan.why ?? '—')}</dd>
      <dt>Out / in</dt>
      <dd>
        {plan.out || plan.in
          ? `${seconds(plan.out?.start)} s (bar ${plan.out?.bar ?? '—'}) → ${seconds(plan.in?.start)} s (bar ${plan.in?.bar ?? '—'})`
          : '—'}
      </dd>
      <dt>Tempo</dt>
      <dd>
        {plan.tempo
          ? `${plan.tempo.relation}, rate ${plan.tempo.rate}, ${plan.tempo.speed_change_ok ? 'a plain speed change' : 'stretched'}`
          : '—'}
      </dd>
      {plan.note ? (
        <>
          <dt>Note</dt>
          <dd>{plan.note}</dd>
        </>
      ) : null}
    </dl>
  );
}

function useTicker(on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((x) => x + 1), 150);
    return () => clearInterval(t);
  }, [on]);
  return n;
}

export default function AutomixLab() {
  const [outTrack, setOut] = useState<DjTrack | null>(null);
  const [inTrack, setIn] = useState<DjTrack | null>(null);
  const [style, setStyle] = useState<Style | 'auto'>('auto');
  const [bars, setBars] = useState<number | ''>('');
  const [preroll, setPreroll] = useState(8);
  const [keyLock, setKeyLock] = useState(false);
  const [correct, setCorrect] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planFor, setPlanFor] = useState('');
  const [error, setError] = useState('');
  const [, force] = useState(0);
  const session = useRef<LabSession | null>(null);
  const cue = useRef<CueRouter | null>(null);
  const support = useMemo(() => cueSupport(cueEnv(window)), []);
  const [prefs, setPrefs] = useState<CuePrefs>(() => readCuePrefs(browserStore(), support.device));
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const live = session.current?.status.stage === 'playing';
  // analyse on demand: a track picked here jumps the queue, and shows its step
  useAutoAnalyse([outTrack?.id, inTrack?.id]);
  const progressOf = useAnalysis([outTrack?.id, inTrack?.id]);
  useTicker(live || session.current?.status.stage === 'loading');

  useEffect(() => {
    if (support.device) void cueDevices(cueEnv(window)).then((d) => setDevices(d.devices));
    return () => {
      cue.current?.dispose();
      session.current?.stop();
    };
  }, [support.device]);

  const request = () => ({
    from: outTrack?.id ?? '',
    to: inTrack?.id ?? '',
    style,
    bars: bars || undefined,
    prerollBars: preroll,
    keyLock,
    correct,
    titles: { from: outTrack?.title, to: inTrack?.title },
  });
  const keyOf = (r: { from: string; to: string; style: string; bars?: number }) =>
    `${r.from}|${r.to}|${r.style}|${r.bars ?? ''}`;

  const askPlan = async () => {
    setError('');
    try {
      const r = request();
      const s = new LabSession(r, deps);
      setPlan(await s.planOnly());
      setPlanFor(keyOf(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const play = async () => {
    setError('');
    session.current?.stop();
    cue.current?.dispose();
    cue.current = null;
    const r = request();
    const s = new LabSession(r, deps, () => force((x) => x + 1));
    session.current = s;
    await s.start();
    setPlan(s.plan);
    setPlanFor(keyOf(r));
    if (s.status.stage === 'error') setError(s.status.words);
  };

  const ensureCue = async (): Promise<CueRouter> => {
    if (cue.current) return cue.current;
    const s = session.current ?? new LabSession(request(), deps, () => force((x) => x + 1));
    session.current = s;
    const engine = await s.ensureEngine();
    const { analyser } = deps.graph();
    const router = new CueRouter({
      context: engine.context as AudioContext,
      mix: engine.graph.out,
      mixTarget: analyser ?? engine.context.destination,
      cueBus: engine.graph.cueBus,
    });
    await router.apply(prefs);
    cue.current = router;
    return router;
  };

  const choosePrefs = async (next: CuePrefs) => {
    setPrefs(next);
    saveCuePrefs(browserStore(), next);
    if (cue.current) await cue.current.apply(next);
  };

  const tr = session.current?.transition ?? null;
  const st = tr?.state();
  const engine = session.current?.engine ?? null;
  const pos = (d: 'A' | 'B') => engine?.position(d)?.toFixed(2) ?? '—';
  const ready = Boolean(outTrack && inTrack && outTrack.id !== inTrack.id);
  // the plan shown is this pair's and it's waiting: nothing to play yet
  const waitingWhy =
    plan?.status === 'waiting' && planFor === keyOf(request())
      ? waitingWords(plan, { from: outTrack?.title, to: inTrack?.title })
      : null;

  return (
    <main className={styles.lab}>
      <h1 className={styles.title}>Auto-mix lab</h1>
      <p className={styles.lead}>
        Stage B&rsquo;s bench: two of your tracks through a style, from the real plan. For hearing
        the engine before it&rsquo;s in Up next; not a page anyone else sees.
      </p>
      <div className={styles.picks}>
        <TrackSearch
          label="Outgoing track"
          chosen={outTrack}
          onPick={setOut}
          progress={outTrack ? progressOf[outTrack.id] : null}
        />
        <TrackSearch
          label="Incoming track"
          chosen={inTrack}
          onPick={setIn}
          progress={inTrack ? progressOf[inTrack.id] : null}
        />
      </div>
      <div className={styles.row}>
        <label>
          Style{' '}
          <select value={style} onChange={(e) => setStyle(e.target.value as Style | 'auto')}>
            {STYLE_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s === 'auto' ? 'Auto' : STYLE_WORDS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bars{' '}
          <select
            value={bars}
            onChange={(e) => setBars(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">the style&rsquo;s own</option>
            {[2, 4, 8, 16, 32].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label>
          Run-up{' '}
          <select value={preroll} onChange={(e) => setPreroll(Number(e.target.value))}>
            {[2, 4, 8, 16].map((b) => (
              <option key={b} value={b}>
                {b} bars
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={keyLock} onChange={(e) => setKeyLock(e.target.checked)} />{' '}
          Key lock (always stretch)
        </label>
        <label>
          <input type="checkbox" checked={correct} onChange={(e) => setCorrect(e.target.checked)} />{' '}
          Line the beats up from the audio
        </label>
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={!ready}
          onClick={() => void askPlan()}
        >
          Show the plan
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={!ready || waitingWhy !== null}
          aria-describedby={waitingWhy !== null ? 'automix-lab-waiting' : undefined}
          onClick={() => void play()}
        >
          Play the mix
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!session.current}
          onClick={() => session.current?.stop()}
        >
          Stop
        </button>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {session.current?.status.stage === 'loading' ? (
        <p className={styles.lead}>{session.current.status.words}</p>
      ) : null}
      {waitingWhy !== null ? (
        <p id="automix-lab-waiting" className={styles.lead}>
          {waitingWhy}: Play the mix waits for it.
        </p>
      ) : null}
      {plan ? (
        <PlanSummary plan={plan} titles={{ from: outTrack?.title, to: inTrack?.title }} />
      ) : null}
      {st ? (
        <section className={styles.live} aria-live="polite">
          <p className={styles.state}>
            {st.label} · {st.phase}
            {st.bar ? ` · bar ${st.bar} of ${st.bars}` : ''} · {st.secondsLeft.toFixed(1)} s{' '}
            {st.phase === 'counting' ? 'to the mix' : 'left'}
            {st.marker ? ` · ${st.marker.label} at bar ${st.marker.beat / 4 + 1}` : ''}
          </p>
          <p className={styles.meta}>
            A {pos('A')} s · B {pos('B')} s · {st.beatmatch ? 'beat-matched' : 'not beat-matched'} ·
            out {st.modes.out}, in {st.modes.in}
            {st.rates ? ` · rates ${st.rates.out.toFixed(4)} / ${st.rates.in.toFixed(4)}` : ''}
            {st.fallback ? ` · fallback: ${st.fallback}` : ''}
            {engine?.interrupted ? ` · interrupted (${engine.interrupted})` : ''}
          </p>
          <div className={styles.row}>
            <button type="button" className={styles.button} onClick={() => tr?.cancel()}>
              Cancel
            </button>
            <button type="button" className={styles.button} onClick={() => tr?.finishNow()}>
              Finish now
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={!st.canGoBack}
              title={
                st.canGoBack ? undefined : 'Too near the outgoing track’s end to go back to it'
              }
              onClick={() => tr?.back()}
            >
              Back
            </button>
            <button type="button" className={styles.button} onClick={() => tr?.takeover()}>
              Take over
            </button>
            <button type="button" className={styles.button} onClick={() => tr?.handBack()}>
              Hand back
            </button>
          </div>
        </section>
      ) : null}
      <fieldset className={styles.outputs}>
        <legend>Headphones (23b)</legend>
        <label>
          <input
            type="radio"
            name="cue"
            checked={prefs.mode === 'device'}
            disabled={!support.device}
            onChange={() => void choosePrefs({ ...prefs, mode: 'device' })}
          />{' '}
          On another output
        </label>
        {support.device ? (
          <select
            aria-label="Headphones output"
            value={prefs.deviceId}
            onChange={(e) => void choosePrefs({ ...prefs, deviceId: e.target.value })}
          >
            <option value="">This device</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <p className={styles.meta}>{support.why}</p>
        )}
        <label>
          <input
            type="radio"
            name="cue"
            checked={prefs.mode === 'split'}
            onChange={() => void choosePrefs({ ...prefs, mode: 'split' })}
          />{' '}
          Split one output: the mix left, the cue right
        </label>
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            onClick={() => void ensureCue().then((c) => c.test('left'))}
          >
            Test: left
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => void ensureCue().then((c) => c.test('right'))}
          >
            Test: right
          </button>
        </div>
        <p className={styles.meta}>Kept for this browser.</p>
      </fieldset>
    </main>
  );
}
