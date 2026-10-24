/**
 * "Let SYNCHRO.S see your drives" (14c), its four Check again answers (14d)
 * and the phone's version (14m). Once per install: one pasted command that
 * shows its lines and asks first, keeps a copy of the set-up file, restarts,
 * and undoes in one line. The page reconnects by itself after the restart
 * and looks for the drive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, OptionButton, OptionButtonGroup, Select } from '@/components/form';
import { Notice } from '@/components/primitives';

import type { DockerCommand, DockerPayload, Platform, PromiseLine } from './drives.api';

import { drivesApi, DrivesError } from './drives.api';
import { FlowShell, copyText } from './move-shell';
import styles from './move.module.css';

const BOOT_KEY = 'soulsync.driveMove.dockerBoot';

export type CheckState =
  | { kind: 'idle' }
  | { kind: 'restarting'; since: number }
  | { kind: 'worked'; drive: string }
  | { kind: 'still' }
  | { kind: 'not_yet' };

/** The boot id this tab saw when the step opened, kept through a reload
 *  during the restart, forgotten after half an hour. */
function readBoot(): string | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(BOOT_KEY) || 'null') as {
      boot: string;
      at: number;
    } | null;
    return raw && Date.now() - raw.at < 30 * 60 * 1000 ? raw.boot : null;
  } catch {
    return null;
  }
}

function saveBoot(value: string): void {
  try {
    sessionStorage.setItem(BOOT_KEY, JSON.stringify({ boot: value, at: Date.now() }));
  } catch {
    /* private window: the step still works, it just can't tell a restart after a reload */
  }
}

/** The lines the helper adds, as the person will see them in the file. */
export function linesSnippet(
  _platform: Platform,
  mounts: string[],
  slskdConfig: string,
): Array<{ text: string; added: boolean }> {
  const add = (line: string) => ({ text: `+     - ${line}`, added: true });
  const keep = (line: string) => ({ text: line, added: false });
  const out = [
    keep('services:'),
    keep('  soulsync:'),
    keep('    volumes:'),
    keep('      - ./music:/app/Transfer'),
  ];
  for (const m of mounts) out.push(add(m));
  out.push(add(slskdConfig));
  out.push(keep('  slskd:'), keep('    volumes:'), keep('      - ./music:/music:ro'));
  for (const m of mounts) out.push(add(m));
  out.push(keep('  plex:'), keep('    volumes:'));
  for (const m of mounts) out.push(add(m));
  return out;
}

// ── Windows, by hand (19b) ───────────────────────────────────────────────────

/** Where a Windows install usually lives, when the saved folder isn't a Windows path. */
export const WINDOWS_FOLDER = 'C:\\SoulSync';
/** The drive letters a person can pick (C is the computer's own disk). */
export const DRIVE_LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** The install folder as Windows writes it: the saved one if it's a Windows path. */
export function windowsFolder(folder: string): string {
  const f = folder.trim();
  return /^[A-Za-z]:[\\/]/.test(f) ? f : WINDOWS_FOLDER;
}

/** The volume line for a drive letter: `D:\:/drives/d`. */
export function windowsDriveLine(letter: string): string {
  const l = (letter || 'D').slice(0, 1).toUpperCase();
  return `${l}:\\:/drives/${l.toLowerCase()}`;
}

/**
 * Step 2's lines as they sit in docker-compose.yml: SYNCHRO.S's volumes with
 * the drive's line and slskd's settings folder added, then slskd's with the
 * drive's line. Added lines are green; the spaces in front are the file's.
 */
export function windowsComposeLines(
  letter: string,
  slskdConfig: string,
): Array<{ text: string; added: boolean }> {
  const drive = `      - ${windowsDriveLine(letter)}`;
  return [
    { text: '  soulsync:', added: false },
    { text: '    volumes:', added: false },
    { text: '      - ./music:/app/Transfer', added: false },
    { text: drive, added: true },
    { text: `      - ${slskdConfig}`, added: true },
    { text: '  slskd:', added: false },
    { text: '    volumes:', added: false },
    { text: drive, added: true },
  ];
}

/** Step 3's command: restart from the install folder in PowerShell. */
export function windowsRestartCommand(folder: string): string {
  return `cd ${windowsFolder(folder)}; docker compose up -d`;
}

/** "What it does, in order": the helper's steps, slskd's config line its own (121). */
export function HelperSteps({ slskdLine }: { slskdLine: string }) {
  return (
    <ol className={styles.steps4}>
      <li>Shows you the lines it will add and asks “Go ahead? (y/n)”.</li>
      <li>
        Keeps a copy of your set-up file as{' '}
        <span className={styles.mono}>docker-compose.before-drives.yml</span>.
      </li>
      <li>
        Adds one line to SYNCHRO.S, slskd and Plex, so all three see your drives at the same place.
      </li>
      <li>
        Gives SYNCHRO.S slskd’s own settings folder (
        <span className={styles.mono}>{slskdLine}</span>), so it can change what slskd shares when
        your music moves.
      </li>
      <li>Restarts them (about a minute) and ends with “Done. Go back to SYNCHRO.S.”</li>
    </ol>
  );
}

export function DockerStep({
  promise,
  onBack,
  onLeave,
  phone = false,
}: {
  promise: PromiseLine;
  onBack: () => void;
  onLeave: () => void;
  /** a phone: say to do this on the computer first (14m) */
  phone?: boolean;
}) {
  const [info, setInfo] = useState<DockerPayload | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [folder, setFolder] = useState('');
  const [command, setCommand] = useState<DockerCommand | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [state, setState] = useState<CheckState>({ kind: 'idle' });
  const [showSteps, setShowSteps] = useState(!phone);
  const [now, setNow] = useState(() => Date.now());
  const stepBoot = useRef<string | null>(readBoot());
  // drives already visible when the step opened aren't news ("it worked")
  // until SYNCHRO.S restarts or Check again is pressed
  const seenAtStart = useRef<boolean | null>(null);
  const minting = useRef(false);

  useEffect(() => {
    let live = true;
    void drivesApi
      .docker()
      .then((d) => {
        if (!live) return;
        setInfo(d);
        if (seenAtStart.current === null) seenAtStart.current = d.drives.some((x) => x.offered);
        setPlatform((p) => p ?? d.platform);
        setFolder((f) => f || d.compose_folder);
        if (!stepBoot.current) {
          stepBoot.current = d.boot_id;
          saveBoot(d.boot_id);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const mint = useCallback(async (nextFolder: string, nextPlatform: Platform) => {
    if (minting.current || nextPlatform === 'windows') return;
    minting.current = true;
    try {
      const made = await drivesApi.dockerCommand(nextFolder, nextPlatform);
      setCommand(made);
      setFolderError(null);
    } catch (e) {
      if (e instanceof DrivesError && e.field === 'folder') setFolderError(e.message);
    } finally {
      minting.current = false;
    }
  }, []);

  // the command follows the folder and the computer; a new one-use link each time
  useEffect(() => {
    if (!info || !platform || !folder) return;
    const t = setTimeout(() => void mint(folder, platform), 400);
    return () => clearTimeout(t);
  }, [info, platform, folder, mint]);

  // looks by itself: a failed request is the restart; when it answers again,
  // a new boot id with drives is "it worked", without is "still can't see"
  const look = useCallback(async (manual: boolean) => {
    try {
      const check = await drivesApi.dockerCheck();
      const restarted = stepBoot.current !== null && check.boot_id !== stepBoot.current;
      const offered = check.drives.filter((d) => d.offered);
      if (offered.length && (manual || restarted || seenAtStart.current === false)) {
        setState({ kind: 'worked', drive: offered[0].name });
      } else if (offered.length) {
        // nothing new: the drives were there when the step opened
      } else if (restarted) {
        setState({ kind: 'still' });
      } else if (manual) {
        setState({ kind: 'not_yet' });
      } else {
        setState((s) => (s.kind === 'restarting' ? { kind: 'still' } : s));
      }
      if (check.token.state === 'used' || check.token.state === 'expired') {
        // the link was used (the helper ran) or ran out: the page shows a fresh one
        setCommand(null);
      }
    } catch {
      setState((s) => (s.kind === 'restarting' ? s : { kind: 'restarting', since: Date.now() }));
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => void look(false), 3000);
    return () => clearInterval(t);
  }, [look]);

  useEffect(() => {
    if (state.kind !== 'restarting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.kind]);

  useEffect(() => {
    if (command === null && info && platform && folder && platform !== 'windows')
      void mint(folder, platform);
  }, [command, info, platform, folder, mint]);

  const copy = async (what: string, text: string) => {
    if (await copyText(text)) {
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const plat = platform ?? info?.platform ?? 'mac';
  const mounts = command?.lines.mounts ?? info?.lines.mounts ?? ['/Volumes:/Volumes'];
  const slskdLine = info?.lines.slskd_config ?? './slskd:/slskd-config';
  const roots = info?.roots ?? ['/Volumes'];
  const rootWords = roots.join(' and ');
  const computer = plat === 'mac' ? 'Mac' : 'computer';
  const link =
    `${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, '')}/move`.replace(
      /([^:])\/\//g,
      '$1/',
    );
  const undo = command?.undo ?? info?.undo ?? '';

  const helpText = [
    'SYNCHRO.S can’t see the drives folder after a restart.',
    `Computer: ${plat}. Folder: ${folder}. Looked in: ${rootWords}.`,
    'The helper’s last line names the file it changed.',
  ].join('\n');

  return (
    <FlowShell
      step={null}
      promise={promise}
      leaveLabel="Leave"
      onLeave={onLeave}
      onBack={onBack}
      phoneTitle="See your drives"
      footer={
        <>
          <p className={styles.footNote}>
            <span className={styles.wide}>
              {plat === 'windows'
                ? 'Looking every 3 s for SYNCHRO.S to restart'
                : `SYNCHRO.S can’t see ${rootWords} yet · it looks again by itself after a restart`}
            </span>
            <span className={styles.phoneOnly}>
              It also looks by itself after SYNCHRO.S restarts.
            </span>
          </p>
          <div className={styles.footEnd}>
            <Button size="lg" variant="primary" onClick={() => void look(true)}>
              Check again
            </Button>
          </div>
        </>
      }
    >
      <button type="button" className={`${styles.backLink} ${styles.hidePhone}`} onClick={onBack}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to choosing
      </button>
      <h2 className={styles.title}>Let SYNCHRO.S see your drives</h2>
      <p className={styles.lead}>
        <span className={styles.wide}>
          {plat === 'windows' && showSteps
            ? 'Once, on this computer. Three short steps in File Explorer, Notepad and PowerShell.'
            : 'SYNCHRO.S runs inside Docker, which only lets it see the folders it was given when it was set up. One small change gives it your drives as well. You do this once; moves after it won’t need it.'}
        </span>
        <span className={styles.phoneOnly}>
          SYNCHRO.S runs inside Docker, which only lets it see the folders it was given. One change,
          once, gives it your drives too.
        </span>
      </p>

      <CheckAgainAnswer
        state={state}
        now={now}
        roots={rootWords}
        onBack={onBack}
        onCheck={() => void look(true)}
        onCopyHelp={() => void copy('help', helpText)}
        copiedHelp={copied === 'help'}
      />

      {phone ? (
        <div className={styles.dockerCard} style={{ gridTemplateColumns: '1fr' }}>
          <div className={styles.dockerBody}>
            <p className={styles.dockerTitle}>Do this on the {computer} SYNCHRO.S runs on</p>
            <p className={styles.dockerText}>
              It needs that computer’s Terminal. Open this step there and it picks up where you are:
            </p>
            <p className={`${styles.commandBox} ${styles.mono}`} style={{ padding: '12px 16px' }}>
              {link.replace(/^https?:\/\//, '')}
            </p>
            <Button size="lg" variant="secondary" onClick={() => void copy('link', link)}>
              {copied === 'link' ? 'Copied' : 'Copy the link'}
            </Button>
          </div>
        </div>
      ) : null}

      {plat === 'windows' && showSteps ? null : (
        <p className={styles.tintBox} data-tone="success">
          <span className={styles.dot} aria-hidden="true" />
          <span>
            <strong>Your music isn’t touched by this.</strong>{' '}
            {phone
              ? 'The helper keeps a copy of the set-up file, and one command puts it back.'
              : 'Nothing moves until SYNCHRO.S can see the drive and you’ve seen the plan. The helper keeps a copy of your set-up file before it changes a line, and one command puts it back.'}
          </span>
        </p>
      )}

      {phone && !showSteps ? (
        <button
          type="button"
          className={styles.disclosure}
          style={{ textAlign: 'left', color: 'inherit', font: 'inherit' }}
          onClick={() => setShowSteps(true)}
        >
          <span style={{ display: 'flex', alignItems: 'center', minHeight: 44, padding: '0 16px' }}>
            Show the steps anyway
          </span>
        </button>
      ) : null}

      {showSteps ? (
        <>
          <div className={styles.platformRow}>
            <p className={styles.label}>Your computer</p>
            <OptionButtonGroup>
              {(['mac', 'linux', 'windows'] as Platform[]).map((p) => (
                <OptionButton key={p} selected={plat === p} onClick={() => setPlatform(p)}>
                  {p === 'mac' ? 'Mac' : p === 'linux' ? 'Linux' : 'Windows'}
                </OptionButton>
              ))}
            </OptionButtonGroup>
            <span className={styles.note}>Guessed from your folders; change it if it’s wrong.</span>
          </div>

          {plat === 'windows' ? (
            <WindowsSteps
              folder={folder}
              slskdLine={slskdLine}
              copied={copied}
              onCopy={(what, text) => void copy(what, text)}
            />
          ) : (
            <>
              <div className={styles.dockerCard}>
                <span className={styles.bigChip}>1</span>
                <div className={styles.dockerBody}>
                  <p className={styles.dockerTitle}>
                    {plat === 'mac'
                      ? 'On the Mac SYNCHRO.S runs on, open Terminal'
                      : 'On the computer SYNCHRO.S runs on, open a terminal'}
                  </p>
                  <p className={styles.dockerText}>
                    {plat === 'mac' ? (
                      <>
                        Press <span className={styles.kbd}>⌘ Space</span>, type{' '}
                        <strong>Terminal</strong> and press Return. A plain window with a line of
                        text opens; that’s all it is.
                      </>
                    ) : (
                      'Or connect to it with ssh. It needs the user that runs docker compose.'
                    )}
                  </p>
                </div>
              </div>

              <div className={styles.dockerCard}>
                <span className={styles.bigChip}>2</span>
                <div className={styles.dockerBody}>
                  <p className={styles.dockerTitle}>
                    Copy this, paste it into Terminal and press Return
                  </p>
                  <div className={styles.field} style={{ marginTop: 0, maxWidth: 420 }}>
                    <label className={styles.fieldLabel} htmlFor="drive-move-compose-folder">
                      The folder SYNCHRO.S was installed in
                    </label>
                    <input
                      id="drive-move-compose-folder"
                      className={`${styles.input} ${styles.mono}`}
                      value={folder}
                      spellCheck={false}
                      aria-invalid={folderError ? true : undefined}
                      onChange={(e) => setFolder(e.target.value)}
                    />
                    {folderError ? (
                      <p className={styles.fieldError} role="alert">
                        {folderError}
                      </p>
                    ) : (
                      <p className={styles.help}>
                        The one with docker-compose.yml in it. Filled in from the install; the
                        command below follows it.
                      </p>
                    )}
                  </div>
                  <div className={styles.commandBox}>
                    <p className={`${styles.commandText} ${styles.mono}`} data-command="">
                      {command?.command ?? 'Making the command…'}
                    </p>
                    <Button
                      size="lg"
                      variant="secondary"
                      disabled={!command}
                      onClick={() => command && void copy('command', command.command)}
                    >
                      {copied === 'command' ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                  <p className={styles.note}>
                    The command works once, for the next ten minutes; this page makes a new one when
                    it needs to.
                  </p>
                  <p className={styles.fieldLabel} style={{ margin: 0 }}>
                    What it does, in order
                  </p>
                  <HelperSteps slskdLine={slskdLine} />
                  <details className={styles.disclosure}>
                    <summary>See the lines it adds</summary>
                    <div className={styles.disclosureBody}>
                      <pre className={`${styles.code} ${styles.mono}`}>
                        {linesSnippet(plat, mounts, slskdLine).map((l, i) => (
                          <span key={i} className={l.added ? styles.added : undefined}>
                            {l.text}
                          </span>
                        ))}
                      </pre>
                      <p className={styles.note}>
                        Rather do it by hand? Add these lines in any text editor, save, then run{' '}
                        <span className={styles.mono}>docker compose up -d</span> in the same
                        folder.
                      </p>
                    </div>
                  </details>
                </div>
              </div>

              <div className={styles.dockerCard}>
                <span className={styles.bigChip}>3</span>
                <div className={styles.dockerBody}>
                  <p className={styles.dockerTitle}>Come back here</p>
                  <p className={styles.dockerText}>
                    While SYNCHRO.S restarts this page loses its connection for about a minute. It
                    reconnects by itself and looks for your drive; you’ll be at this step, nothing
                    lost.
                  </p>
                </div>
              </div>
              {undo ? (
                <p className={styles.note}>
                  Changed your mind afterwards? <span className={styles.mono}>{undo}</span> puts the
                  copy back and restarts.{' '}
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => void copy('undo', undo)}
                  >
                    {copied === 'undo' ? 'Copied' : 'Copy the undo command'}
                  </button>
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </FlowShell>
  );
}

/**
 * The Docker step on Windows (19b): three steps by hand, in the apps a
 * Windows person already has, until the PowerShell helper is tested. A copy
 * first, only lines added (green), one command; then Check again.
 */
export function WindowsSteps({
  folder,
  slskdLine,
  copied,
  onCopy,
}: {
  /** the saved install folder; used when it's a Windows path */
  folder: string;
  slskdLine: string;
  copied: string | null;
  onCopy: (what: string, text: string) => void;
}) {
  const [letter, setLetter] = useState('D');
  const [typed, setTyped] = useState(() =>
    windowsFolder(folder) === folder.trim() ? folder.trim() : '',
  );
  const where = windowsFolder(typed);
  const lines = windowsComposeLines(letter, slskdLine);
  const command = windowsRestartCommand(typed);
  return (
    <>
      <div className={styles.dockerCard}>
        <span className={styles.bigChip}>1</span>
        <div className={styles.dockerBody}>
          <p className={styles.dockerTitle}>Keep a copy of your set-up file</p>
          <p className={styles.dockerText}>
            In File Explorer, open the folder SYNCHRO.S was installed in (
            <span className={styles.mono}>{where}</span>), copy{' '}
            <span className={styles.mono}>docker-compose.yml</span> and paste it in the same folder.
            That copy is your way back.
          </p>
          <div className={styles.field} style={{ marginTop: 0, maxWidth: 420 }}>
            <label className={styles.fieldLabel} htmlFor="drive-move-windows-folder">
              The folder SYNCHRO.S was installed in
            </label>
            <input
              id="drive-move-windows-folder"
              className={`${styles.input} ${styles.mono}`}
              value={typed}
              placeholder={WINDOWS_FOLDER}
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        </div>
      </div>
      <div className={styles.dockerCard}>
        <span className={styles.bigChip}>2</span>
        <div className={styles.dockerBody}>
          <p className={styles.dockerTitle}>Add the lines in Notepad</p>
          <p className={styles.dockerText}>
            Open <span className={styles.mono}>docker-compose.yml</span> with Notepad. Find{' '}
            <span className={styles.mono}>volumes:</span> under{' '}
            <span className={styles.mono}>soulsync:</span> and add the green lines under the others,
            with the same spaces in front. Do the same under{' '}
            <span className={styles.mono}>slskd:</span>, then save.
          </p>
          <div className={styles.commandBox}>
            <pre className={`${styles.code} ${styles.mono} ${styles.commandText}`}>
              {lines.map((l, i) => (
                <span key={i} className={l.added ? styles.added : undefined}>
                  {l.text}
                </span>
              ))}
            </pre>
            <Button
              size="lg"
              variant="secondary"
              onClick={() => onCopy('line', `      - ${windowsDriveLine(letter)}`)}
            >
              {copied === 'line' ? 'Copied' : 'Copy the line'}
            </Button>
          </div>
          <div className={styles.letterRow}>
            <Select
              size="lg"
              aria-label="The drive’s letter"
              value={letter}
              onChange={(e) => setLetter(e.target.value)}
            >
              {DRIVE_LETTERS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
            <p className={styles.note}>
              is your drive’s letter in This PC; change it if it isn’t. Spaces matter; tabs don’t
              work.
            </p>
          </div>
        </div>
      </div>
      <div className={styles.dockerCard}>
        <span className={styles.bigChip}>3</span>
        <div className={styles.dockerBody}>
          <p className={styles.dockerTitle}>Restart SYNCHRO.S from PowerShell</p>
          <p className={styles.dockerText}>
            Start → type <strong>PowerShell</strong> → open it, paste this and press Enter. Then
            come back here: this page notices by itself.
          </p>
          <div className={styles.commandBox}>
            <p className={`${styles.commandText} ${styles.mono}`} data-command="">
              {command}
            </p>
            <Button size="lg" variant="secondary" onClick={() => onCopy('restart', command)}>
              {copied === 'restart' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </div>
      <p className={styles.note}>
        Changed your mind? Put the copy from step 1 back and run step 3 again. A one-paste helper
        for Windows is on its way.
      </p>
    </>
  );
}

export function CheckAgainAnswer({
  state,
  now,
  roots,
  onBack,
  onCheck,
  onCopyHelp,
  copiedHelp,
}: {
  state: CheckState;
  now: number;
  roots: string;
  onBack: () => void;
  onCheck: () => void;
  onCopyHelp: () => void;
  copiedHelp: boolean;
}) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'restarting') {
    const secs = Math.max(0, Math.round((now - state.since) / 1000));
    return (
      <div className={styles.restarting} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        <div>
          <p className={styles.rowName}>SYNCHRO.S is restarting</p>
          <p className={styles.rowMeta}>This page reconnects by itself · {secs} s so far</p>
        </div>
      </div>
    );
  }
  if (state.kind === 'worked') {
    return (
      <Notice
        tone="success"
        layout="stacked"
        role="status"
        title={`SYNCHRO.S can see ${state.drive} now`}
        actions={
          <Button size="lg" variant="primary" onClick={onBack}>
            Back to choosing
          </Button>
        }
      >
        <p>
          So can slskd and Plex. Your music is still playing from where it was. Next, pick the
          folder on {state.drive}.
        </p>
      </Notice>
    );
  }
  if (state.kind === 'still') {
    return (
      <Notice
        tone="warning"
        layout="stacked"
        role="alert"
        title={`SYNCHRO.S restarted, but still can’t see ${roots}`}
        actions={
          <>
            <Button size="lg" variant="secondary" onClick={onCheck}>
              Check again
            </Button>
            <Button size="lg" variant="secondary" onClick={onCopyHelp}>
              {copiedHelp ? 'Copied' : 'Copy what to send for help'}
            </Button>
          </>
        }
      >
        <ul className={styles.failureList}>
          <li>
            <strong>The command ran in another folder.</strong> Its last line names the file it
            changed; if that isn’t the one SYNCHRO.S uses, change the folder above and paste again.
          </li>
          <li>
            <strong>Docker Desktop doesn’t share {roots}.</strong> Docker Desktop → Settings →
            Resources → File sharing: add {roots}, then Apply and restart.
          </li>
          <li>
            <strong>The drive isn’t plugged in.</strong> It has to be connected when SYNCHRO.S
            starts.
          </li>
        </ul>
      </Notice>
    );
  }
  return (
    <Notice
      tone="neutral"
      layout="stacked"
      role="status"
      title="SYNCHRO.S hasn’t restarted since you opened this step"
    >
      <p>
        So the helper hasn’t run yet, or stopped at its question. Nothing changed. Paste the command
        in step 2 and answer y.
      </p>
    </Notice>
  );
}
