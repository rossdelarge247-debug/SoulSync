/**
 * The drives routes (api/drives.py, CONTRACTS.md "Your music's drives").
 * Plain fetch through appURL, so the pieces work inside the React app and
 * in the islands mounted into the legacy Settings page alike.
 */

import { appURL } from '@/platform/url-base';

export type Role = 'library' | 'downloads' | 'staging';
export const ROLES: Role[] = ['library', 'downloads', 'staging'];
export type Platform = 'mac' | 'linux' | 'windows';
export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

/**
 * The computer's own name for a folder (125, 160), for admins: from the drives
 * helper's host hint (`hint`, trusted only while its marker matches) or a
 * drives folder mounted at the same path (`same`). Display text only; null
 * when SYNCHRO.S doesn't know it (show the container's path).
 */
export interface HostFields {
  host_path?: string | null;
  volume?: string | null;
  host_source?: 'hint' | 'same' | null;
}

export interface FolderState extends HostFields {
  role: Role;
  label: string;
  connected: boolean;
  last_seen: number | null;
  drive: string | null;
  path?: string;
  reason?: string;
}

export interface DriveStatus {
  success: boolean;
  checked_at: number;
  interval: number;
  library_away: boolean;
  away: Role[];
  folders: Record<Role, FolderState>;
  can_check: boolean;
  boot_id: string;
  move?: { id: number; status: MoveStatus; promise: PromiseLine };
  reminder?: Reminder | null;
}

export interface Reminder {
  move_id: number;
  source_label: string;
  target_label: string;
  bytes: number;
  files: number;
  switched_at: number;
}

export interface FolderRow extends HostFields {
  role: Role;
  label: string;
  path: string;
  drive: string;
  holds: string;
  files: number | null;
  bytes: number | null;
  albums?: number;
}

export interface FoldersPayload {
  success: boolean;
  folders: FolderRow[];
  drive: {
    label: string;
    free: number | null;
    total: number | null;
    percent: number | null;
    tone: 'warning' | 'danger' | null;
  };
  move: { id: number; status: MoveStatus } | null;
  platform: Platform;
  compose_folder?: string;
}

export interface Drive {
  name: string;
  path: string;
  total: number | null;
  free: number | null;
  format: string | null;
  backup: boolean;
  read_only: boolean;
  offered: boolean;
}

export interface DockerPayload {
  success: boolean;
  platform: Platform;
  guessed: Platform;
  compose_folder: string;
  roots: string[];
  visible_roots: string[];
  drives: Drive[];
  boot_id: string;
  lines: { mounts: string[]; slskd_config: string };
  token: { state: 'none' | 'live' | 'used' | 'expired'; expires_at?: number };
  undo: string;
  windows_ready: boolean;
}

export interface DockerCommand {
  success: boolean;
  command: string;
  undo: string;
  expires_at: number;
  platform: Platform;
  lines: { mounts: string[]; slskd_config: string };
  compose_folder: string;
  error?: string;
  field?: string;
}

export interface DockerCheck {
  success: boolean;
  boot_id: string;
  drives: Drive[];
  visible: boolean;
  roots: string[];
  token: DockerPayload['token'];
  platform: Platform;
}

export type MoveStatus =
  | 'draft'
  | 'copying'
  | 'verifying'
  | 'switching'
  | 'switched'
  | 'failed'
  | 'stopped'
  | 'removed'
  | 'switched_back';

export interface PromiseLine {
  tone: Tone;
  words: string;
}

export interface Choice {
  roles: Record<Role, boolean>;
  target: string;
  separate: boolean;
  per_role: Partial<Record<Role, string>>;
  exfat: 'carry_on' | 'erase' | null;
  checksum: boolean;
  /** Check's slskd row: Downloads stays where it is, out of this move (19a) */
  downloads_left?: boolean;
}

export interface SlskdSignIn {
  username: string;
  password: string;
}

export interface CheckRow {
  key: string;
  title: string;
  tone: Tone;
  tag: string;
  detail: string;
  stop?: boolean;
  needs_choice?: boolean;
  choice?: string | null;
  sign_in?: boolean;
  /** slskd's row (19a): which option card is picked */
  slskd_choice?: 'move' | 'leave';
  signed_in?: boolean;
  /** where Downloads is now ("Macintosh HD") and where the move goes ("Music HD") */
  home_label?: string;
  target_label?: string;
}

export interface Checks {
  rows: CheckRow[];
  at: number;
  speed: number | null;
  format: string | null;
  need: number;
  ok: boolean;
  summary: string;
  dests: Partial<Record<Role, string>>;
  /** the checks run on the server; the page reads the move again until done */
  running?: boolean;
}

export interface Plan {
  order: Role[];
  dests: Partial<Record<Role, string>>;
  sources: Partial<Record<Role, string>>;
  total_bytes: number;
  total_files: number;
  estimate_seconds: number;
  checksum_seconds: number;
  target_label: string;
  source_label: string;
  automations: string[];
  speed: number;
  library_paths: number;
  media_label?: string;
}

export interface MoveFolder {
  role: Role;
  label: string;
  source?: string;
  dest?: string;
  files: number;
  bytes: number;
  copied_files: number;
  copied_bytes: number;
  verified: number;
  source_host_path?: string | null;
  source_volume?: string | null;
  dest_host_path?: string | null;
  dest_volume?: string | null;
}

export interface AfterCheck {
  key: string;
  ok: boolean;
  title: string;
  detail: string;
  mono?: boolean;
  /** the computer's name for a mono path, when known */
  detail_host?: string | null;
}

export interface Failure {
  kind:
    | 'drive_away'
    | 'full'
    | 'write'
    | 'mismatch'
    | 'unreadable'
    | 'refused'
    | 'stuck'
    | 'restart'
    | 'error';
  words: string;
  at: number;
  source_label?: string;
  target_label?: string;
  files?: Array<{ role: Role; rel: string; why: string; size?: number }>;
  count?: number;
  copied?: number;
  total?: number;
  matching_files?: number;
}

export interface Move {
  id: number;
  status: MoveStatus;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  switched_at: number | null;
  finished_at: number | null;
  promise: PromiseLine;
  choice: Choice;
  checks: Checks | null;
  plan: Plan | null;
  failure: Failure | null;
  result: {
    checks?: AfterCheck[];
    media?: {
      name: string;
      label: string;
      state: string;
      folder?: string;
      old_location?: string | null;
    };
    removed?: { files: number; bytes: number; skipped: number };
    slskd?: Record<string, unknown>;
  };
  has_slskd_session: boolean;
  folders: MoveFolder[];
  progress: {
    phase?: string;
    role?: Role | null;
    current?: string | null;
    copied_bytes: number;
    total_bytes: number;
    speed?: number | null;
    eta_seconds: number | null;
    checked?: number;
    total?: number;
    different?: number;
    step?: string;
    waiting_for?: string[];
  };
}

export interface Overview {
  folders: FolderRow[];
  drives: Drive[];
  home_label: string;
  home_free: number | null;
  platform: Platform;
  visible: boolean;
  roots: string[];
  /** folder sizes are still being measured; read the move again */
  measuring?: boolean;
}

export interface MovePayload {
  success: boolean;
  move: Move | null;
  overview?: Overview;
  boot_id: string;
  running: boolean;
  error?: string;
}

export interface RemovePreview {
  success: boolean;
  plan_id: string;
  total: number;
  total_bytes: number;
  sample: Array<{
    path: string;
    size: number;
    action: string;
    reason: string;
    role?: Role;
    rel?: string;
  }>;
  /** each old folder the list is relative to, with its computer name (19c) */
  roots?: Partial<Record<Role, RemoveRoot>>;
  platform?: Platform;
  truncated: boolean;
  created_at: number;
  expires_at: number;
  error?: string;
  code?: string;
}

export interface RemoveRoot extends HostFields {
  role: Role;
  label: string;
  path: string;
  drive?: string | null;
}

export class DrivesError extends Error {
  status: number;
  field?: string;
  code?: string;
  constructor(message: string, status: number, field?: string, code?: string) {
    super(message);
    this.status = status;
    this.field = field;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  // every change is sent as JSON: the server refuses anything else
  const payload = body === undefined && method !== 'GET' ? {} : body;
  try {
    response = await fetch(appURL(path), {
      method,
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      credentials: 'same-origin',
    });
  } catch {
    // the server is restarting (the Docker step) or the network dropped
    throw new DrivesError('SYNCHRO.S didn’t answer.', 0);
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const failed = (data ?? {}) as { error?: string; field?: string; code?: string };
    throw new DrivesError(
      failed.error || 'That didn’t go through.',
      response.status,
      failed.field,
      failed.code,
    );
  }
  return data as T;
}

export const drivesApi = {
  status: () => call<DriveStatus>('GET', '/api/drives/status'),
  checkNow: () => call<DriveStatus>('POST', '/api/drives/status/check'),
  folders: () => call<FoldersPayload>('GET', '/api/drives/folders'),
  docker: () => call<DockerPayload>('GET', '/api/drives/docker'),
  dockerCommand: (folder: string, platform: Platform) =>
    call<DockerCommand>('POST', '/api/drives/docker/command', { folder, platform }),
  /** The one-use command that runs the helper's `--names` only, with the
   *  saved install folder (Mac and Linux). */
  namesCommand: () => call<DockerCommand>('POST', '/api/drives/docker/command', { names: true }),
  dockerCheck: () => call<DockerCheck>('GET', '/api/drives/docker/check'),
  browse: (path?: string) =>
    call<{ success: boolean; path: string | null; folders: Array<{ name: string; path: string }> }>(
      'GET',
      `/api/drives/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),
  move: () => call<MovePayload>('GET', '/api/drives/move'),
  draft: () => call<MovePayload>('POST', '/api/drives/move'),
  choose: (id: number, choice: Partial<Choice>) =>
    call<MovePayload>('PUT', `/api/drives/move/${id}/choice`, choice),
  check: (id: number) => call<MovePayload>('POST', `/api/drives/move/${id}/check`),
  slskdSession: (id: number, username: string, password: string) =>
    call<MovePayload>('POST', `/api/drives/move/${id}/slskd-session`, { username, password }),
  plan: (id: number) => call<MovePayload>('POST', `/api/drives/move/${id}/plan`),
  start: (id: number, checksum: boolean) =>
    call<MovePayload>('POST', `/api/drives/move/${id}/start`, { checksum }),
  stop: (id: number) => call<MovePayload>('POST', `/api/drives/move/${id}/stop`),
  /** carrying on after a failure: slskd's sign-in again when Downloads moves */
  resume: (id: number, signIn?: SlskdSignIn) =>
    call<MovePayload>('POST', `/api/drives/move/${id}/resume`, signIn ?? {}),
  recopy: (id: number, signIn?: SlskdSignIn) =>
    call<MovePayload>('POST', `/api/drives/move/${id}/recopy`, signIn ?? {}),
  skipUnreadable: (id: number, signIn?: SlskdSignIn) =>
    call<MovePayload>('POST', `/api/drives/move/${id}/skip-unreadable`, signIn ?? {}),
  removePreview: (id: number) =>
    call<RemovePreview>('POST', `/api/drives/move/${id}/remove-preview`),
  remove: (id: number, planId: string) =>
    call<MovePayload & { deleted: number; freed_bytes: number; skipped: number }>(
      'POST',
      `/api/drives/move/${id}/remove`,
      { plan_id: planId },
    ),
  switchBack: (id: number, slskd?: { username: string; password: string }) =>
    call<MovePayload>('POST', `/api/drives/move/${id}/switch-back`, slskd ?? {}),
  leave: (id: number) => call<MovePayload>('POST', `/api/drives/move/${id}/leave`),
};

/** The full list behind a Remove the old copies… preview. */
export function planListURL(planId: string): string {
  return appURL(`/api/drives/plan-list/${encodeURIComponent(planId)}`);
}
