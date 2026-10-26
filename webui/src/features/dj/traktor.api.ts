/**
 * Export to Traktor (stage 2a, board 21a) and the Settings → Library →
 * Traktor Pro 3 card (21b): api/dj.py's `/api/library/dj/traktor/*`
 * (CONTRACTS.md "DJ data").
 */
import { apiClient } from '@/app/api-client';

/** Where the tracks come from: one of the three doors. */
export type TraktorSource =
  | { source: 'playlist'; playlist_id: number }
  | { source: 'tracks'; track_ids: string[] }
  | { source: 'mixes'; track_id: string; within?: number };

export type LeftOutReason =
  | 'not_in_library'
  | 'no_mac_path'
  | 'outside'
  | 'bad_path'
  | 'too_many'
  | 'lookup_limit';

export interface TraktorLeftOut {
  title: string;
  artist: string;
  reason: LeftOutReason;
  words: string;
}

export type FolderState = 'ok' | 'unset' | 'invalid' | 'outside' | 'missing' | 'not_writable';

export interface TraktorPreview {
  success: true;
  name: string;
  filename: string;
  counts: { tracks: number; found: number; left_out: number };
  /** the first track's path as the Mac sees it */
  example_path: string | null;
  /** the Mac's name for the library folder, when known */
  /** admins only: the Mac's name for the library folder, when known */
  mac_path?: string | null;
  /** admins only */
  library_folder?: string;
  left_out: TraktorLeftOut[];
  reasons: Partial<Record<LeftOutReason, number>>;
  /** tracks whose key goes in the file */
  keys: number;
  /** an admin: may change the card's settings */
  can_edit: boolean;
  folder: {
    state: FolderState;
    shown: string | null;
    can_save: boolean;
    /** admins: when a file of this export's name in the folder was written (234) */
    exists_at?: number | null;
  };
}

export interface TraktorSettings {
  success: true;
  /** the folder fields go to admins only; members get the two `_set` flags */
  mac_path?: string;
  mac_path_from_helper?: string | null;
  library_folder?: string;
  export_folder?: string;
  export_folder_state: FolderState;
  export_folder_on_mac?: string | null;
  mac_path_set?: boolean;
  mac_path_from_helper_set?: boolean;
  collection: string;
  can_edit: boolean;
}

export class TraktorError extends Error {
  status: number;
  exists: boolean;
  /** with `exists`: when the file already there was written */
  existsAt: number | null;
  field?: string;
  constructor(
    message: string,
    status: number,
    extra: { exists?: boolean; exists_at?: number | null; field?: string } = {},
  ) {
    super(message);
    this.status = status;
    this.exists = Boolean(extra.exists);
    this.existsAt = typeof extra.exists_at === 'number' ? extra.exists_at : null;
    this.field = extra.field;
  }
}

type Payload = {
  success?: boolean;
  error?: string;
  exists?: boolean;
  exists_at?: number | null;
  field?: string;
};

async function post(body: Record<string, unknown>): Promise<Response> {
  return apiClient.post('library/dj/traktor/export', { json: body, throwHttpErrors: false });
}

async function failure(response: Response): Promise<TraktorError> {
  const payload = (await response.json().catch(() => ({}))) as Payload;
  return new TraktorError(
    payload.error || "That didn't work. Try again in a moment.",
    response.status,
    payload,
  );
}

export async function previewTraktor(from: TraktorSource): Promise<TraktorPreview> {
  const response = await post({ action: 'preview', ...from });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as TraktorPreview;
}

/** The file through the browser: fetched, then handed to a download link. */
export async function downloadTraktor(from: TraktorSource, filename: string): Promise<void> {
  const response = await post({ action: 'download', ...from });
  if (!response.ok) throw await failure(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function saveTraktor(
  from: TraktorSource,
  overwrite = false,
): Promise<{ filename: string; folder: string }> {
  const response = await post({ action: 'save', overwrite, ...from });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as { filename: string; folder: string };
}

export async function getTraktorSettings(): Promise<TraktorSettings> {
  const response = await apiClient.get('library/dj/traktor/settings', { throwHttpErrors: false });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as TraktorSettings;
}

export async function putTraktorSettings(
  body: Partial<{ mac_path: string; export_folder: string }>,
): Promise<TraktorSettings> {
  const response = await apiClient.put('library/dj/traktor/settings', {
    json: body,
    throwHttpErrors: false,
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as TraktorSettings;
}
