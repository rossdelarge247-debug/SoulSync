/**
 * Internet radio's shapes, from api/radio.py (docs/design/CONTRACTS.md,
 * "Internet radio"). Shared by the Radio page (React) and the player's radio
 * mode (the shell bundle).
 */

export type StationKind = 'electronic' | 'world' | 'eclectic' | 'jazz_soul_funk';
export type StationSource = 'built_in' | 'directory' | 'your_link';

export interface StationStream {
  id: string;
  codec: string;
  bitrate_kbps: number;
  lossless: boolean;
  label: string;
}

export interface Station {
  id: string;
  name: string;
  kind: StationKind;
  kind_label: string;
  genre: string;
  city: string;
  country: string;
  /** our own /api/radio/stations/<id>/logo (the server fetches and caches it), or '' */
  logo_url: string;
  logo_text?: string;
  homepage: string;
  description: string;
  source: StationSource;
  favourite: boolean;
  auto_add: boolean;
  has_now_playing: boolean;
  has_tracklists: boolean;
  quality: { codec: string; bitrate_kbps: number; lossless: boolean; label: string };
  tags: string[];
  sends_titles: boolean | null;
  added_by: string | null;
  streams: StationStream[];
  note?: string;
  link_ok?: boolean;
}

export interface StationKindRow {
  kind: StationKind;
  label: string;
  blurb: string;
  stations: Station[];
}

export interface RadioSessionRef {
  session_id: string;
  station_id: string;
  mode: 'direct' | 'relay';
  stream_id: string;
}

export interface StationsResponse {
  success: boolean;
  favourites: Station[];
  kinds: StationKindRow[];
  heard_count: number;
  session: RadioSessionRef | null;
  identification: boolean;
  is_admin: boolean;
}

export type NowPlayingState = 'identified' | 'listening' | 'not_identified' | 'off' | 'unavailable';
export type IdSource =
  | 'station_feed'
  | 'stream_titles'
  | 'fingerprint'
  | 'scan_acoustid'
  | 'scan_audd'
  | 'scan_acrcloud';

/** Can Scan now run (api/radio.py, in now-playing and a station's answer)? */
export interface ScanAvailability {
  available: boolean;
  reason: string | null;
  services: ScanService[];
}

export type ScanService = 'acoustid' | 'audd' | 'acrcloud';

/** GET /api/radio/scan/<id> (CONTRACTS.md, "Internet radio" → Scan now). */
export interface ScanResult {
  scan_id: string;
  station_id: string;
  state: 'listening' | 'identified' | 'not_found' | 'failed';
  phase: 'capturing' | 'identifying';
  trying: ScanService | null;
  trying_label: string | null;
  progress: number;
  capture_seconds: number;
  seconds_left: number;
  track: { artist: string; title: string; release: string | null } | null;
  source: 'scan_acoustid' | 'scan_audd' | 'scan_acrcloud' | null;
  source_label: string | null;
  heard_id: number | null;
  library: { in_library: boolean; below_target: boolean | null; track_id: string | null } | null;
  on_wanted: boolean;
  reason: string | null;
  provider_error: { provider: ScanService; label: string; kind: string; message: string } | null;
  asked: ScanService[];
  started_at: number;
  finished_at: number | null;
  now: number;
}

export interface NowPlaying {
  station_id: string;
  state: NowPlayingState;
  track: { artist: string; title: string; release: string | null; art_url: string | null } | null;
  source: IdSource | null;
  identified_at: number | null;
  started_at: number | null;
  reason: string | null;
  library: { in_library: boolean; below_target: boolean | null; track_id: string | null } | null;
  on_wanted: boolean;
  previous_title: string | null;
  /** Server time, unix seconds: "identified N s ago" is counted from it. */
  now: number;
  playing: boolean;
  session_active?: boolean;
  heard_id?: number | null;
  added_at?: number | null;
  scan?: ScanAvailability;
}

export interface StationResponse {
  success: boolean;
  station: Station;
  now_playing: NowPlaying;
  session: RadioSessionRef | null;
  heard_today: { identified: number; not_identified: number };
  identification: boolean;
  is_admin: boolean;
  can_download: boolean;
  scan?: ScanAvailability;
}

export type HeardState =
  | 'in_library'
  | 'on_wanted'
  | 'added_by_auto_add'
  | 'not_added'
  | 'cant_match'
  | 'not_identified';

export interface HeardItem {
  id: number;
  heard_at: number;
  station_id: string;
  station_name: string;
  artist: string | null;
  title: string | null;
  release: string | null;
  source: IdSource | null;
  state: HeardState;
  added_at: number | null;
  added_by_auto_add: boolean;
  duration_s: number | null;
  reason: string | null;
  below_target: boolean | null;
  track_id: string | null;
}

export interface HeardResponse {
  success: boolean;
  items: HeardItem[];
  days: number;
  keep_days: number;
  counts: { total: number; not_in_library: number; identified: number; not_identified: number };
}

export interface AutoAddNumbers {
  enabled: boolean;
  identified_yesterday: number;
  already_have: number;
  would_add: number;
  would_add_without_limit: number;
  daily_limit: number;
  added_today: number;
  can_download: boolean;
  has_now_playing: boolean;
}

export interface ShowSummary {
  id: string;
  title: string;
  aired_at: number | null;
  ended_at: number | null;
  track_count: number | null;
  missing_count: number | null;
}

export interface TracklistRow {
  position: number;
  time: number | null;
  artist: string | null;
  title: string | null;
  release: string | null;
  state: 'in_library' | 'on_wanted' | 'not_added' | 'cant_match';
  below_target: boolean | null;
  track_id: string | null;
}

export interface TracklistResponse {
  success: boolean;
  show: {
    id: string;
    title: string;
    aired_at: number | null;
    ended_at: number | null;
    station_id: string;
    station_name: string;
    fetched_at: number | null;
    homepage: string | null;
  };
  tracks: TracklistRow[];
}

export interface DirectoryResponse {
  success: boolean;
  results: Station[];
  more: boolean;
  page: number;
  total: number;
}

export interface LinkCheck {
  ok: boolean;
  codec: string;
  bitrate_kbps: number;
  sends_titles: boolean;
  allows_direct: boolean;
  answered_in_s: number | null;
  error: string | null;
}

export interface RadioLink {
  id: number;
  station_id: string;
  name: string;
  url: string;
  kind: StationKind;
  codec: string;
  bitrate_kbps: number;
  sends_titles: boolean | null;
  check_ok: boolean | null;
  checked_at: number | null;
  check_error: string | null;
  added_by: string | null;
  added_at: number | null;
  /** the logo address the admin gave (fetched and cached by the server) */
  logo_url?: string | null;
}

export interface PlayResponse {
  success: boolean;
  play_url: string;
  mode: 'direct' | 'relay';
  session_id: string;
  station: Station;
  stream: { id: string; label: string; codec: string; bitrate_kbps: number; lossless: boolean };
  error?: string;
  message?: string;
}

/** The player's radio session (src/shell/radio-session.ts), as window.SoulSyncRadio has it. */
export interface RadioSessionState {
  status: 'idle' | 'starting' | 'playing' | 'error';
  station: Station | null;
  sessionId: string | null;
  mode: 'direct' | 'relay' | null;
  stream: PlayResponse['stream'] | null;
  nowPlaying: NowPlaying | null;
  error: { code: string; message: string } | null;
  /** The browser's clock minus the server's, seconds. */
  skew: number;
  adding: boolean;
  /** Scan now: the scan in progress or its answer, until the station names the
   *  next track, the next scan, or Stop. */
  scan?: ScanResult | null;
  /** Scan now refused before it started (no service, busy), in words. */
  scanError?: string | null;
  scanStarting?: boolean;
  /** The per-minute limit: when Scan now can run again (browser ms); null when it can. */
  scanWaitUntil?: number | null;
}

export interface RadioSessionApi {
  state(): RadioSessionState;
  play(stationId: string, options?: { streamId?: string; station?: Station }): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
  addToWanted(): Promise<boolean>;
  refresh(): Promise<void>;
  /** Scan now: listen to about ten seconds on the server and identify it. */
  scanNow?(): Promise<void>;
  /** Add what the scan found to Wanted (its Heard row). */
  addScanToWanted?(): Promise<boolean>;
}

export const RADIO_EVENT = 'ss:radio';
