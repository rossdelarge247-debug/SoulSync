/**
 * The draft half of the flow: Choose (14b, 14l), Check (14e, 14n) and the
 * Plan (14f, 14o). Nothing is copied until "Start copying"; every choice is
 * saved on the server as it's made, so a second device (or this one after a
 * restart) opens at the same place.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Button, LabelledSwitch } from '@/components/form';
import { Notice, StatusTag } from '@/components/primitives';

import type { CheckRow, Choice, Drive, Move, MovePayload, Overview, Role } from './drives.api';

import { drivesApi, ROLES } from './drives.api';
import { count, durationWords, sizeWords } from './drives.format';
import { FlowShell } from './move-shell';
import styles from './move.module.css';

export interface StepProps {
  payload: MovePayload;
  move: Move;
  busy: boolean;
  error: string | null;
  act: (fn: () => Promise<MovePayload>) => Promise<boolean>;
  go: (view: 'choose' | 'docker' | 'check' | 'plan') => void;
  leave: () => void;
}

const NAMES: Record<Role, string> = {
  library: 'Library',
  downloads: 'Downloads',
  staging: 'Staging',
};
const FOLDER_NAMES: Record<Role, string> = {
  library: 'Library',
  downloads: 'Downloads',
  staging: 'Staging',
};

/** The drive a path is on, from the drives SYNCHRO.S can see. */
export function driveFor(path: string, drives: Drive[]): Drive | null {
  const clean = path.replace(/\/+$/, '');
  return (
    drives.find((d) => clean === d.path || clean.startsWith(`${d.path.replace(/\/+$/, '')}/`)) ??
    null
  );
}

export function destinations(choice: Choice): Partial<Record<Role, string>> {
  const out: Partial<Record<Role, string>> = {};
  for (const role of ROLES) {
    if (!choice.roles[role]) continue;
    if (choice.separate) {
      const p = choice.per_role[role];
      if (p) out[role] = p.replace(/\/+$/, '');
    } else if (choice.target) {
      out[role] = `${choice.target.replace(/\/+$/, '')}/${FOLDER_NAMES[role]}`;
    }
  }
  return out;
}

function folderSub(role: Role, files: number | null, albums?: number): string {
  if (files === null) return 'Measuring…';
  if (role === 'library') {
    return albums ? `${count(files, 'file')} in ${count(albums, 'album')}` : count(files, 'file');
  }
  if (role === 'downloads') return `${count(files, 'file')} arriving from Soulseek`;
  return `${count(files, 'file')} waiting to be imported`;
}

function readers(holds: string): string {
  // "Your music. Library and Plex read it; slskd shares it." → "read by Library and Plex, shared by slskd"
  const m = /Your music\. (.+) read it(?:; (slskd) shares it)?/.exec(holds);
  if (!m) return '';
  return `read by ${m[1]}${m[2] ? `, shared by ${m[2]}` : ''}`;
}

function driveMeta(d: Drive): string {
  const parts: string[] = [];
  if (d.total) parts.push(sizeWords(d.total));
  if (d.backup) {
    parts.push('used for backups, not offered');
    return parts.join(' · ');
  }
  if (d.free !== null) parts.push(`${sizeWords(d.free)} free`);
  if (d.format) parts.push(d.format);
  if (d.read_only) parts.push('read-only');
  return parts.join(' · ');
}

// ── Choose (14b) ──────────────────────────────────────────────────────────────

export function ChooseStep(props: StepProps) {
  const { move, payload, busy, error, act, go, leave } = props;
  const overview = payload.overview as Overview;
  const choice = move.choice;
  const [target, setTarget] = useState(choice.target);
  const [perRole, setPerRole] = useState<Partial<Record<Role, string>>>(choice.per_role || {});
  const [browse, setBrowse] = useState<null | {
    path: string | null;
    folders: Array<{ name: string; path: string }>;
  }>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offered = overview.drives.filter((d) => d.offered);
  const selected = driveFor(target, overview.drives);

  // one drive and nothing chosen yet: its SYNCHRO.S folder is the suggestion
  useEffect(() => {
    if (!choice.target && offered.length === 1 && !choice.separate) {
      const next = `${offered[0].path}/SYNCHRO.S`;
      setTarget(next);
      void act(() => drivesApi.choose(move.id, { target: next }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (patch: Partial<Choice>) => act(() => drivesApi.choose(move.id, patch));

  const typeTarget = (value: string) => {
    setTarget(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save({ target: value }), 500);
  };

  const pick = (d: Drive) => {
    if (!d.offered) return;
    const next = `${d.path}/SYNCHRO.S`;
    setTarget(next);
    void save({ target: next });
  };

  const rows = overview.folders;
  const ticked = rows.filter((r) => choice.roles[r.role]);
  const totalBytes = ticked.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const totalFiles = ticked.reduce((n, r) => n + (r.files ?? 0), 0);
  const dests = destinations({ ...choice, target, per_role: perRole });
  const label = selected?.name ?? 'the drive';
  const noDrives = offered.length === 0;
  const ready = Object.keys(dests).length > 0 && ticked.length > 0;

  const check = async () => {
    if (timer.current) clearTimeout(timer.current);
    const patch: Partial<Choice> = choice.separate ? { per_role: perRole } : { target };
    const ok = await act(async () => {
      await drivesApi.choose(move.id, patch);
      return drivesApi.check(move.id);
    });
    if (ok) go('check');
  };

  const openBrowse = async (path?: string) => {
    try {
      setBrowse(await drivesApi.browse(path));
    } catch {
      setBrowse(null);
    }
  };

  return (
    <FlowShell
      step={0}
      promise={move.promise}
      leaveLabel="Leave"
      onLeave={leave}
      footer={
        <>
          <p className={`${styles.footNote} ${styles.hidePhone}`}>
            Next, SYNCHRO.S checks {label}’s space, format and that it can write there. Nothing is
            copied yet.
          </p>
          <div className={styles.footEnd}>
            <Button
              size="lg"
              variant="primary"
              disabled={!ready || busy}
              disabledReason={!ready ? 'Choose where your music goes.' : undefined}
              onClick={() => void check()}
            >
              {busy ? 'Checking…' : `Check ${label === 'the drive' ? 'the drive' : label}`}
            </Button>
          </div>
        </>
      }
    >
      <h2 className={styles.title}>What moves, and where to</h2>
      <p className={styles.lead}>
        SYNCHRO.S copies your folders to the new drive, checks that every file arrived, then
        switches over. Your music stays where it is until you say you’re happy with the new place.
      </p>
      {error ? (
        <Notice tone="danger" title="That didn’t go through" role="alert">
          <p>{error}</p>
        </Notice>
      ) : null}
      <p className={styles.label}>What moves</p>
      <div className={styles.card}>
        {rows.map((r) => (
          <label key={r.role} className={`${styles.row} ${styles.rowWithBox}`}>
            <input
              type="checkbox"
              className={styles.box}
              checked={!!choice.roles[r.role]}
              onChange={(e) =>
                void save({ roles: { ...choice.roles, [r.role]: e.target.checked } })
              }
            />
            <span>
              <span className={styles.rowName} style={{ display: 'block' }}>
                {r.label}
              </span>
              <span className={styles.rowMeta} style={{ display: 'block' }}>
                <span className={styles.wide}>
                  {folderSub(r.role, r.files, r.albums)}
                  {r.role === 'library' && readers(r.holds) ? ` · ${readers(r.holds)}` : ''}
                </span>
                <span className={styles.phoneOnly}>{folderSub(r.role, r.files, r.albums)}</span>
              </span>
            </span>
            <span className={styles.rowSize}>{r.bytes === null ? '' : sizeWords(r.bytes)}</span>
          </label>
        ))}
        <div className={`${styles.totalRow} ${styles.hidePhone}`}>
          <span>
            All on {overview.home_label}
            {overview.home_free !== null ? `, which has ${sizeWords(overview.home_free)} free` : ''}
          </span>
          <strong>
            {sizeWords(totalBytes)} · {count(totalFiles, 'file')}
          </strong>
        </div>
      </div>

      <div className={styles.labelRow}>
        <p className={styles.label}>Where to</p>
        <button type="button" className={styles.linkButton} onClick={() => go('docker')}>
          <span className={styles.wide}>My drive isn’t listed</span>
          <span className={styles.phoneOnly}>Not listed?</span>
        </button>
      </div>
      {noDrives ? (
        <Notice
          tone="neutral"
          title="SYNCHRO.S can’t see any drives yet"
          actions={
            <Button size="lg" variant="secondary" onClick={() => go('docker')}>
              Let SYNCHRO.S see your drives
            </Button>
          }
        >
          <p>
            Docker only lets SYNCHRO.S see the folders it was given. One change, once, adds your
            drives.
          </p>
        </Notice>
      ) : (
        <div className={styles.drives}>
          {overview.drives.map((d) => (
            <button
              key={d.path}
              type="button"
              className={`${styles.driveCard} ${d.offered ? '' : styles.hidePhone}`}
              aria-pressed={selected?.path === d.path}
              aria-disabled={!d.offered || undefined}
              onClick={() => pick(d)}
            >
              <span className={styles.driveName}>{d.name}</span>
              <span className={styles.driveMeta}>{driveMeta(d)}</span>
            </button>
          ))}
        </div>
      )}

      {!choice.separate ? (
        <>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="drive-move-target">
              Folder on {label}
            </label>
            <div className={styles.fieldRow}>
              <input
                id="drive-move-target"
                className={`${styles.input} ${styles.mono}`}
                value={target}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => typeTarget(e.target.value)}
              />
              <Button
                size="lg"
                variant="secondary"
                className={styles.hidePhone}
                onClick={() => void openBrowse(selected?.path)}
              >
                Browse…
              </Button>
            </div>
            <p className={styles.help}>
              <span className={styles.wide}>
                A new folder is made if it isn’t there. It must be empty, or one SYNCHRO.S made
                before.
              </span>
              <span className={styles.phoneOnly}>Library, Downloads and Staging go inside it.</span>
            </p>
          </div>
          {browse ? (
            <div className={styles.card} role="group" aria-label="Folders on the drive">
              {browse.folders.length === 0 ? (
                <p className={styles.note} style={{ padding: '14px 0' }}>
                  No folders here.
                </p>
              ) : (
                browse.folders.map((f) => (
                  <div key={f.path} className={styles.row}>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => void openBrowse(f.path)}
                    >
                      {f.name}
                    </button>
                    <Button
                      size="lg"
                      variant="secondary"
                      onClick={() => {
                        typeTarget(`${f.path}/SYNCHRO.S`);
                        setBrowse(null);
                      }}
                    >
                      Use this folder
                    </Button>
                  </div>
                ))
              )}
            </div>
          ) : null}
          {Object.keys(dests).length ? (
            <dl className={`${styles.goesTo} ${styles.hidePhone}`}>
              <dt>They’ll go to</dt>
              {ROLES.filter((r) => dests[r]).map((r) => (
                <FragmentRow key={r} name={NAMES[r]} path={dests[r] as string} />
              ))}
            </dl>
          ) : null}
        </>
      ) : (
        <div className={styles.card}>
          {ROLES.filter((r) => choice.roles[r]).map((r) => {
            const value = perRole[r] ?? '';
            const libDrive = driveFor(perRole.library ?? '', overview.drives);
            const here = driveFor(value, overview.drives);
            const elsewhere =
              r !== 'library' && value && libDrive && here && libDrive.path !== here.path;
            return (
              <div key={r} className={styles.row} style={{ gridTemplateColumns: '1fr' }}>
                <label className={styles.fieldLabel} htmlFor={`drive-move-${r}`}>
                  {NAMES[r]}
                </label>
                <input
                  id={`drive-move-${r}`}
                  className={`${styles.input} ${styles.mono}`}
                  value={value}
                  placeholder={
                    selected ? `${selected.path}/SYNCHRO.S/${FOLDER_NAMES[r]}` : '/Volumes/…'
                  }
                  spellCheck={false}
                  onChange={(e) => setPerRole({ ...perRole, [r]: e.target.value })}
                  onBlur={() => void save({ per_role: perRole })}
                />
                {elsewhere ? (
                  <p className={styles.help}>
                    Imports will copy rather than move, so they’ll be slower.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.switchRow}>
        <div className={styles.switchText}>
          <p className={styles.switchTitle}>Choose each folder separately</p>
          <p className={`${styles.note} ${styles.hidePhone}`}>
            For a library on one drive and downloads on another.
          </p>
        </div>
        <LabelledSwitch
          checked={choice.separate}
          aria-label="Choose each folder separately"
          onCheckedChange={(next) => void save({ separate: next })}
        />
      </div>
    </FlowShell>
  );
}

function FragmentRow({ name, path }: { name: string; path: string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd className={styles.mono}>{path}</dd>
    </>
  );
}

// ── Check (14e) ───────────────────────────────────────────────────────────────

function tagTone(row: CheckRow): 'success' | 'warning' | 'danger' {
  return row.tone === 'success' ? 'success' : row.tone === 'danger' ? 'danger' : 'warning';
}

export function CheckStep(props: StepProps) {
  const { move, busy, error, act, go, leave } = props;
  const checks = move.checks;
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const api = () => Promise.resolve(drivesApi);
  const label = move.plan?.target_label ?? targetLabel(props.payload, move);

  useEffect(() => {
    if (!checks && !busy) void act(() => api().then((a) => a.check(move.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = () => act(() => api().then((a) => a.check(move.id)));
  const exfat = (value: 'carry_on' | 'erase') =>
    act(() =>
      api().then(async (a) => {
        await a.choose(move.id, { exfat: value });
        return a.check(move.id);
      }),
    );
  const leaveDownloadsOut = () =>
    act(() =>
      api().then(async (a) => {
        await a.choose(move.id, { roles: { ...move.choice.roles, downloads: false } });
        return a.check(move.id);
      }),
    );
  const signIn = () => act(() => api().then((a) => a.slskdSession(move.id, user, password)));
  const toPlan = async () => {
    const ok = await act(() => api().then((a) => a.plan(move.id)));
    if (ok) go('plan');
  };

  const ok = Boolean(checks?.ok);
  const stop = checks?.rows.some((r) => r.stop);
  return (
    <FlowShell
      step={1}
      promise={move.promise}
      leaveLabel="Leave"
      onLeave={leave}
      onBack={() => go('choose')}
      footer={
        <>
          <Button
            size="lg"
            variant="ghost"
            className={styles.backDesktop}
            onClick={() => go('choose')}
          >
            Back
          </Button>
          <Button size="lg" variant="secondary" disabled={busy} onClick={() => void recheck()}>
            {busy ? 'Checking…' : 'Check again'}
          </Button>
          <div className={styles.footEnd}>
            <Button
              size="lg"
              variant="primary"
              disabled={!ok || busy}
              disabledReason={
                !checks
                  ? undefined
                  : stop
                    ? 'Fix what’s marked first.'
                    : !ok
                      ? 'Make the choice above first.'
                      : undefined
              }
              onClick={() => void toPlan()}
            >
              See the plan
            </Button>
          </div>
        </>
      }
    >
      <h2 className={styles.title}>Checking {label}</h2>
      <p className={styles.lead}>{checks ? checks.summary : 'Looking at the drive…'}</p>
      {error ? (
        <Notice tone="danger" title="That didn’t go through" role="alert">
          <p>{error}</p>
        </Notice>
      ) : null}
      {checks ? (
        <div className={styles.card}>
          {checks.rows.map((row) => (
            <div key={row.key} className={styles.row}>
              <div>
                <p className={styles.rowName}>{row.title}</p>
                {row.key !== 'format' && !row.sign_in ? (
                  <p className={styles.rowMeta}>{row.detail}</p>
                ) : null}
              </div>
              <StatusTag tone={tagTone(row)}>{row.tag}</StatusTag>
              {row.key === 'format' &&
              row.tone === 'warning' &&
              row.tag === 'Works, with a catch' ? (
                <>
                  <p className={styles.rowDetail}>{row.detail}</p>
                  <div className={styles.choices}>
                    <button
                      type="button"
                      className={styles.choiceCard}
                      aria-pressed={move.choice.exfat === 'carry_on'}
                      onClick={() => void exfat('carry_on')}
                    >
                      <span className={styles.choiceTitle}>Carry on with exFAT</span>
                      <span className={styles.choiceText}>
                        SYNCHRO.S copies without the “._” files, hides any from Library and tells
                        slskd to skip them.
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.choiceCard}
                      aria-pressed={move.choice.exfat === 'erase'}
                      onClick={() => void exfat('erase')}
                    >
                      <span className={styles.choiceTitle}>Erase it as APFS first</span>
                      <span className={styles.choiceText}>
                        The tidy fix, in Disk Utility. It erases everything on {label}, so only
                        while it’s empty. Then Check again.
                      </span>
                    </button>
                  </div>
                </>
              ) : null}
              {row.key === 'format' && row.tag !== 'Works, with a catch' ? (
                <p className={styles.rowDetail}>{row.detail}</p>
              ) : null}
              {row.sign_in ? (
                <>
                  <p className={styles.rowDetail}>{row.detail}</p>
                  <form
                    className={styles.signIn}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void signIn();
                    }}
                  >
                    <input
                      className={styles.input}
                      aria-label="slskd user name"
                      placeholder="slskd user name"
                      autoComplete="username"
                      value={user}
                      onChange={(e) => setUser(e.target.value)}
                    />
                    <input
                      className={styles.input}
                      aria-label="slskd password"
                      placeholder="Password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <Button size="lg" variant="secondary" type="submit" disabled={busy || !user}>
                      Sign in to slskd
                    </Button>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => void leaveDownloadsOut()}
                    >
                      Leave Downloads out
                    </button>
                  </form>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </FlowShell>
  );
}

function targetLabel(payload: MovePayload, move: Move): string {
  const drives = payload.overview?.drives ?? [];
  const dest = Object.values(destinations(move.choice))[0];
  return (dest && driveFor(dest, drives)?.name) || 'the drive';
}

// ── Plan (14f) ────────────────────────────────────────────────────────────────

export function PlanStep(props: StepProps) {
  const { move, busy, error, act, go, leave } = props;
  const plan = move.plan;
  const [checksum, setChecksum] = useState(move.choice.checksum);
  const api = () => Promise.resolve(drivesApi);
  const folders = useMemo(() => (plan ? plan.order.map((r) => NAMES[r]) : []), [plan]);
  if (!plan) return null;
  const autos = plan.automations;
  const target = plan.target_label;
  const setSum = (next: boolean) => {
    setChecksum(next);
    void act(() => api().then((a) => a.choose(move.id, { checksum: next })));
  };
  const start = () => act(() => api().then((a) => a.start(move.id, checksum)));
  const orderWords =
    folders.length > 1
      ? `${folders.slice(0, -1).join(', ')}, then the ${folders.at(-1)}`
      : `the ${folders[0]}`;
  const est = plan.estimate_seconds + (checksum ? plan.checksum_seconds : 0);
  return (
    <FlowShell
      step={2}
      promise={move.promise}
      leaveLabel="Leave"
      onLeave={leave}
      onBack={() => go('check')}
      footer={
        <>
          <Button
            size="lg"
            variant="ghost"
            className={styles.backDesktop}
            onClick={() => go('check')}
          >
            Back
          </Button>
          <p className={styles.footNote}>
            <span className={styles.wide}>
              You can close this page once it starts; Activity shows it.
            </span>
            <span className={styles.phoneOnly}>You can stop while it copies; nothing is lost.</span>
          </p>
          <div className={styles.footEnd} style={{ marginLeft: 0 }}>
            <Button size="lg" variant="primary" disabled={busy} onClick={() => void start()}>
              {busy ? 'Starting…' : 'Start copying'}
            </Button>
          </div>
        </>
      }
    >
      <h2 className={styles.title}>The plan</h2>
      <p className={styles.lead}>
        From {plan.source_label} to{' '}
        {Object.values(plan.dests).length === 1
          ? Object.values(plan.dests)[0]
          : commonParent(Object.values(plan.dests) as string[])}
        .
      </p>
      {error ? (
        <Notice tone="danger" title="That didn’t go through" role="alert">
          <p>{error}</p>
        </Notice>
      ) : null}
      <dl className={styles.tiles}>
        <div className={styles.tile}>
          <dt>To copy</dt>
          <dd>
            <span className={styles.tileValue}>{sizeWords(plan.total_bytes)}</span>
            <span className={`${styles.tileMeta} ${styles.hidePhone}`}>
              {count(plan.total_files, 'file')} in{' '}
              {folders.length === 3 ? 'three folders' : count(folders.length, 'folder')}
            </span>
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>
            <span className={styles.wide}>About how long</span>
            <span className={styles.phoneOnly}>About</span>
          </dt>
          <dd>
            <span className={styles.tileValue}>{durationWords(est)}</span>
            <span className={`${styles.tileMeta} ${styles.hidePhone}`}>
              at {target}’s speed; firmer after a minute
            </span>
          </dd>
        </div>
        <div className={`${styles.tile} ${styles.hidePhone}`}>
          <dt>The old copies</dt>
          <dd>
            <span className={styles.tileValue}>Kept</span>
            <span className={styles.tileMeta}>until you remove them</span>
          </dd>
        </div>
      </dl>
      <p className={`${styles.label} ${styles.hidePhone}`}>What happens, in order</p>
      <ol className={styles.order}>
        <li>
          Pause what writes to these folders
          <span className={styles.wide}> (below). Downloads in progress finish first</span>.
        </li>
        <li>
          Copy {orderWords} to {target}.
        </li>
        <li>
          Check every file arrived
          <span className={styles.wide}>: the count and each file’s size</span>.
        </li>
        <li>
          Switch SYNCHRO.S, slskd{plan.media_label ? ` and ${plan.media_label}` : ''} to {target}
          <span className={styles.wide}>
            {plan.library_paths
              ? `, update the ${plan.library_paths.toLocaleString('en-GB')} paths SYNCHRO.S keeps,`
              : ''}{' '}
            and ask slskd to rescan what it shares
          </span>
          .
        </li>
        <li>
          Start everything that was paused again.
          <span className={styles.phoneOnly}> The old copies stay.</span>
        </li>
      </ol>
      <div className={`${styles.switchRow} ${styles.switchRowBoxed}`}>
        <div className={styles.switchText}>
          <p className={styles.switchTitle}>
            <span className={styles.wide}>Also compare every file’s contents</span>
            <span className={styles.phoneOnly}>Also compare contents</span>
          </p>
          <p className={styles.note}>
            <span className={styles.wide}>
              Catches a file that arrived the right size but damaged.{' '}
            </span>
            {plan.checksum_seconds < 90
              ? 'Adds less than a minute.'
              : `Adds about ${durationWords(plan.checksum_seconds)}.`}
          </p>
        </div>
        <LabelledSwitch
          checked={checksum}
          aria-label="Also compare every file’s contents"
          onCheckedChange={setSum}
        />
      </div>
      <div className={styles.twoBoxes}>
        <div className={styles.listBox} data-tone="info">
          <h3>Paused while it copies</h3>
          <ul>
            <li>New downloads, and Wanted’s searches (they’d start downloads)</li>
            <li>Auto-import</li>
            {autos.length ? (
              <li>
                {count(autos.length, 'automation')} that move files: {autos.join(', ')}
              </li>
            ) : null}
          </ul>
        </div>
        <div className={`${styles.listBox} ${styles.hidePhone}`}>
          <h3>Carries on</h3>
          <ul>
            <li>Playing music, from the old place</li>
            <li>Browsing, Radio, Stats, Listening history</li>
            <li>slskd sharing the old library</li>
          </ul>
        </div>
      </div>
      <p className={`${styles.note} ${styles.hidePhone}`} style={{ fontSize: 15 }}>
        You can stop while it copies. Stopping deletes the half-made copy on {target} and starts
        everything again, as if this never happened.
      </p>
    </FlowShell>
  );
}

function commonParent(paths: string[]): string {
  if (!paths.length) return '';
  const split = paths.map((p) => p.split('/'));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i += 1) {
    const part = split[0][i];
    if (split.every((s) => s[i] === part)) out.push(part);
    else break;
  }
  return out.join('/') || '/';
}
