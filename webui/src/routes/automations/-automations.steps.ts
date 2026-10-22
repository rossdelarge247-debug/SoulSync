/**
 * The design's "steps", read off the engine's real structure.
 *
 * An automation is one trigger (when it runs), one action (what it does) and
 * up to three follow-up steps (`then_actions`: notifications, a signal, a
 * script), run in that order. The trigger is the "Runs" line; the action is
 * step 1; the follow-ups are steps 2 and on. These functions turn each part
 * into the plain sentence the list and the editor show. Nothing here invents
 * a step the engine doesn't have.
 */

import type {
  Automation,
  AutomationBlockDef,
  AutomationBlocks,
  StepCondition,
  ThenAction,
} from './-automations.types';

import { formatAction, humanizeType, parseServerTime } from './-automations.format';

/** A config value as text: strings and numbers as they are, anything else ''. */
export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** How an automation is started, as the editor's Runs choices group them. */
export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'monthly' | 'event';

export const TRIGGER_FOR_KIND: Record<Exclude<ScheduleKind, 'event'>, string> = {
  interval: 'schedule',
  daily: 'daily_time',
  weekly: 'weekly_time',
  monthly: 'monthly_time',
};

export function scheduleKind(triggerType: string | null | undefined): ScheduleKind {
  switch (triggerType) {
    case 'schedule':
      return 'interval';
    case 'daily_time':
      return 'daily';
    case 'weekly_time':
      return 'weekly';
    case 'monthly_time':
      return 'monthly';
    default:
      return 'event';
  }
}

export const WEEKDAYS = [
  { value: 'mon', short: 'Mon', long: 'Monday' },
  { value: 'tue', short: 'Tue', long: 'Tuesday' },
  { value: 'wed', short: 'Wed', long: 'Wednesday' },
  { value: 'thu', short: 'Thu', long: 'Thursday' },
  { value: 'fri', short: 'Fri', long: 'Friday' },
  { value: 'sat', short: 'Sat', long: 'Saturday' },
  { value: 'sun', short: 'Sun', long: 'Sunday' },
] as const;

/** "Mon, Wed and Fri". */
export function listWords(parts: string[], conjunction = 'and'): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} ${conjunction} ${parts[parts.length - 1]}`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "Every 6 hours", "Every hour", "Every 30 minutes", "Every day". */
export function intervalPhrase(interval: unknown, unit: unknown): string {
  const n = Math.max(1, Number.parseInt(text(interval, '1'), 10) || 1);
  const u = ['minutes', 'hours', 'days'].includes(String(unit)) ? String(unit) : 'hours';
  const singular = u.slice(0, -1);
  return n === 1 ? `Every ${singular}` : `Every ${n} ${u}`;
}

function cfgTime(config: Record<string, unknown>): string {
  return typeof config.time === 'string' && config.time ? config.time : '00:00';
}

// What each event says, where the block's own description doesn't read as
// "when …". The rest use the block description from /api/automations/blocks.
const EVENT_PHRASES: Record<string, string> = {
  app_started: 'When SoulSync starts',
  track_downloaded: 'After a track downloads',
  batch_complete: 'After an album or playlist download finishes',
  watchlist_new_release: 'When a followed artist has a new release',
  playlist_synced: 'After a playlist sync',
  playlist_changed: 'When a mirrored playlist changes at its source',
  discovery_completed: "After a playlist's tracks are identified",
  wishlist_processing_completed: 'After the Wanted search finishes',
  watchlist_scan_completed: 'After the followed-artist check finishes',
  database_update_completed: 'After the library database updates',
  library_scan_completed: "After the media server's library scan",
  download_failed: 'When a download fails for good',
  download_quarantined: 'When a file is quarantined',
  wishlist_item_added: 'When something is added to Wanted',
  watchlist_artist_added: 'When you follow an artist',
  watchlist_artist_removed: 'When you unfollow an artist',
  import_completed: 'After an import finishes',
  import_needs_attention: 'When an import needs you',
  webhook_received: 'When a request arrives on the API',
};

const OPERATOR_WORDS: Record<string, string> = {
  contains: 'contains',
  equals: 'is',
  not_equals: "isn't",
  starts_with: 'starts with',
  ends_with: 'ends with',
  not_contains: "doesn't contain",
  greater_than: 'is more than',
  less_than: 'is less than',
};

export const OPERATORS = Object.keys(OPERATOR_WORDS);

export function operatorWords(op: string | undefined): string {
  return OPERATOR_WORDS[op ?? ''] ?? (op || 'contains');
}

function fieldWords(field: string | undefined): string {
  return String(field || 'value').replace(/_/g, ' ');
}

/** "artist contains “Saltmarsh” and title is “Lantern”". */
export function conditionPhrase(
  conditions: StepCondition[] | null | undefined,
  match?: string,
): string {
  const parts = (conditions ?? [])
    .filter((c) => c && c.field && c.operator)
    .map((c) => `${fieldWords(c.field)} ${operatorWords(c.operator)} “${c.value ?? ''}”`);
  return listWords(parts, match === 'any' ? 'or' : 'and');
}

export function findBlock(
  blocks: AutomationBlocks | undefined,
  category: 'triggers' | 'actions' | 'notifications',
  type: string | null | undefined,
): AutomationBlockDef | undefined {
  return blocks?.[category]?.find((b) => b.type === type);
}

/** The block's description, trimmed of its trailing full stop. */
function descriptionPhrase(def: AutomationBlockDef | undefined): string | undefined {
  const text = def?.description?.trim();
  if (!text) return undefined;
  return text.replace(/\.$/, '');
}

/** "After a track downloads (artist contains “Saltmarsh”)". */
export function eventPhrase(
  type: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
  blocks?: AutomationBlocks,
): string {
  const cfg = config ?? {};
  let base: string;
  if (type === 'signal_received') {
    base = `When the signal “${text(cfg.signal_name) || 'unnamed'}” fires`;
  } else {
    const def = findBlock(blocks, 'triggers', type);
    const described = descriptionPhrase(def);
    base =
      EVENT_PHRASES[type ?? ''] ??
      (described && /^(when|after)\b/i.test(described) ? described : undefined) ??
      `When ${(def?.label ?? humanizeType(type)).toLowerCase()} happens`;
  }
  const when = conditionPhrase(
    cfg.conditions as StepCondition[] | undefined,
    text(cfg.match, 'all'),
  );
  return when ? `${base}, if ${when}` : base;
}

/** How an automation runs, in a few words: "Every 6 hours", "Daily at 06:00". */
export function schedulePhrase(
  a: Pick<Automation, 'trigger_type' | 'trigger_config'>,
  blocks?: AutomationBlocks,
): string {
  const cfg = (a.trigger_config ?? {}) as Record<string, unknown>;
  switch (a.trigger_type) {
    case 'schedule':
      return intervalPhrase(cfg.interval, cfg.unit);
    case 'daily_time':
      return `Daily at ${cfgTime(cfg)}`;
    case 'weekly_time': {
      const days = (Array.isArray(cfg.days) ? (cfg.days as string[]) : []).filter((d) =>
        WEEKDAYS.some((w) => w.value === d),
      );
      if (days.length === 0 || days.length === 7) return `Daily at ${cfgTime(cfg)}`;
      const names = WEEKDAYS.filter((w) => days.includes(w.value)).map((w) => w.short);
      return `Weekly on ${listWords(names)} at ${cfgTime(cfg)}`;
    }
    case 'monthly_time': {
      const day = Math.min(31, Math.max(1, Number.parseInt(text(cfg.day_of_month, '1'), 10) || 1));
      return `Monthly on the ${ordinal(day)} at ${cfgTime(cfg)}`;
    }
    default:
      return eventPhrase(a.trigger_type, cfg, blocks);
  }
}

// ── step 1: the action ──────────────────────────────────────────────────────

export interface SentenceContext {
  blocks?: AutomationBlocks;
  /** A mirrored playlist's name by id, when known. */
  playlistName?: (id: string) => string | undefined;
}

function truthy(value: unknown, fallback = false): boolean {
  if (value == null) return fallback;
  if (typeof value === 'string')
    return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
  return Boolean(value);
}

function playlistWords(config: Record<string, unknown>, ctx: SentenceContext): string {
  if (truthy(config.all)) return 'every mirrored playlist';
  const id = text(config.playlist_id);
  if (!id) return 'a mirrored playlist (none chosen yet)';
  const name = ctx.playlistName?.(id);
  return name ? `“${name}”` : 'one mirrored playlist';
}

/**
 * Step 1, in a sentence. Each one says what the handler really does with the
 * options it really reads.
 */
export function actionSentence(
  type: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
  ctx: SentenceContext = {},
): string {
  const cfg = config ?? {};
  let out: string;
  switch (type) {
    case 'process_wishlist':
      out = "Search for what's due on Wanted, albums and singles in turn";
      break;
    case 'scan_watchlist':
      out = 'Check followed artists and labels for new releases, and add them to Wanted';
      break;
    case 'scan_watchlist_podcasts':
      out = 'Check followed podcasts for new episodes';
      break;
    case 'scan_library':
      out = 'Ask your media server to rescan the library';
      break;
    case 'start_database_update':
      out = truthy(cfg.full_refresh)
        ? 'Update the library database from your media server, a full refresh'
        : 'Update the library database from your media server';
      break;
    case 'start_database_update_hourly':
      out = "Read what's new on your media server into the library database";
      break;
    case 'refresh_mirrored':
      out = `Refresh ${playlistWords(cfg, ctx)} from its source`;
      break;
    case 'sync_playlist':
      out = `Sync ${playlistWords(cfg, ctx)} to your media server`;
      break;
    case 'sync_downloaded_playlists':
      out = 'Sync the playlists whose downloads just finished to your media server';
      break;
    case 'discover_playlist':
      out = `Identify the tracks in ${playlistWords(cfg, ctx)}`;
      break;
    case 'playlist_pipeline':
      out = `Refresh, identify, sync and download what's missing for ${playlistWords(cfg, ctx)}`;
      if (truthy(cfg.skip_wishlist)) out += ', without adding to Wanted';
      break;
    case 'personalized_pipeline': {
      const kinds = Array.isArray(cfg.kinds) ? cfg.kinds.length : 0;
      out = `Sync ${kinds === 1 ? '1 personalized playlist' : `${kinds} personalized playlists`} and queue what's missing`;
      break;
    }
    case 'run_duplicate_cleaner':
      out = 'Find duplicate files and move the lower-quality copies to the recycle bin';
      break;
    case 'clear_quarantine':
      out = 'Delete everything in the download quarantine for good';
      break;
    case 'library_cleanup': {
      const q = truthy(cfg.quarantine, true);
      const r = truthy(cfg.recycle_bin, true);
      out =
        q && r
          ? 'Clear the download quarantine and empty the recycle bin, for good'
          : q
            ? 'Clear the download quarantine, for good'
            : r
              ? 'Empty the recycle bin, for good'
              : 'Nothing (both halves are switched off)';
      break;
    }
    case 'full_cleanup':
      out = 'Clear the quarantine, the download queue, empty folders and old searches';
      break;
    case 'deep_scan_library':
      out = 'Compare the whole library with the files on disk';
      break;
    case 'backup_database':
      out = 'Back up the database, keeping the newest 5 backups';
      break;
    case 'cleanup_wishlist':
      out = 'Remove duplicate entries from Wanted';
      break;
    case 'update_discovery_pool':
      out = 'Refresh the Discover pool with new tracks';
      break;
    case 'start_quality_scan':
      out = 'Look for better-quality copies of what you have';
      break;
    case 'apply_quality_upgrades': {
      const limit = Number(cfg.limit ?? 100) || 100;
      out = `Add up to ${limit} quality upgrades to Wanted`;
      break;
    }
    case 'run_repair_job': {
      const job = text(cfg.job_id, 'all');
      const def = findBlock(ctx.blocks, 'actions', 'run_repair_job');
      const option = def?.config_fields
        ?.find((f) => f.key === 'job_id')
        ?.options?.find((o) => o.value === job);
      out =
        job === 'all'
          ? 'Run every maintenance job that’s switched on'
          : `Run the maintenance job “${option?.label ?? humanizeType(job)}”`;
      break;
    }
    case 'complete_incomplete_albums':
      out = `Fill in up to ${Number(cfg.max_albums ?? 3) || 3} incomplete albums`;
      break;
    case 'search_and_download':
      out = cfg.query
        ? `Search for “${text(cfg.query)}” and download the best match`
        : "Search for the trigger's request and download the best match";
      break;
    case 'refresh_beatport_cache':
      out = 'Refresh the Beatport cache';
      break;
    case 'clean_search_history':
      out = 'Remove old searches from Soulseek';
      break;
    case 'clean_completed_downloads':
      out = 'Clear finished downloads and empty folders';
      break;
    case 'seeding_sweep':
      out = 'Remove finished torrents that met their seeding goal';
      break;
    case 'import_lastfm_listening':
      out = 'Import your Last.fm listening history';
      break;
    case 'import_listenbrainz_listening':
      out = 'Import your ListenBrainz listening history';
      break;
    case 'notify_only':
      out = 'Do nothing else; only the follow-up steps run';
      break;
    case 'run_script':
      out = cfg.script_name
        ? `Run the script “${text(cfg.script_name)}”`
        : 'Run a script (none chosen yet)';
      break;
    case undefined:
    case null:
    case '':
      out = 'Choose what this automation does';
      break;
    default: {
      const label = formatAction(type, (t) => findBlock(ctx.blocks, 'actions', t)?.label);
      out = label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
    }
  }
  const delay = Number(cfg.delay ?? 0);
  if (delay > 0) {
    const wait = delay === 1 ? '1 minute' : `${delay} minutes`;
    out = `Wait ${wait}, then ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
  }
  return out;
}

// ── steps 2+: the follow-ups ────────────────────────────────────────────────

export const NOTIFY_TYPES = [
  'discord_webhook',
  'pushbullet',
  'telegram',
  'ntfy',
  'gotify',
  'webhook',
];

export const THEN_LABELS: Record<string, string> = {
  discord_webhook: 'Discord message',
  pushbullet: 'Pushbullet notification',
  telegram: 'Telegram message',
  ntfy: 'ntfy notification',
  gotify: 'Gotify message',
  webhook: 'Webhook (POST)',
  fire_signal: 'Fire a signal',
  run_script: 'Run a script',
};

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/** A follow-up step in a sentence: "Send a Telegram message, only when status is “error”". */
export function thenSentence(item: ThenAction): string {
  const cfg = item.config ?? {};
  let out: string;
  switch (item.type) {
    case 'discord_webhook':
      out = 'Send a Discord message';
      break;
    case 'pushbullet':
      out = 'Send a Pushbullet notification';
      break;
    case 'telegram':
      out = 'Send a Telegram message';
      break;
    case 'ntfy':
      out = cfg.topic
        ? `Send an ntfy notification to “${text(cfg.topic)}”`
        : 'Send an ntfy notification';
      break;
    case 'gotify':
      out = 'Send a Gotify message';
      break;
    case 'webhook': {
      const host = hostOf(cfg.url);
      out = host ? `Send a webhook to ${host}` : 'Send a webhook';
      break;
    }
    case 'fire_signal':
      out = cfg.signal_name
        ? `Fire the signal “${text(cfg.signal_name)}”`
        : 'Fire a signal (none named yet)';
      break;
    case 'run_script':
      out = cfg.script_name
        ? `Run the script “${text(cfg.script_name)}”`
        : 'Run a script (none chosen yet)';
      break;
    default:
      out = `Run “${humanizeType(item.type)}”`;
  }
  const conditions = item.conditions ?? (cfg.conditions as StepCondition[] | undefined);
  const when = conditionPhrase(conditions, item.match ?? (cfg.match as string | undefined));
  return when ? `${out}, only when ${when}` : out;
}

/** Every step's sentence, in the order the engine runs them. */
export function stepSentences(
  a: Pick<Automation, 'action_type' | 'action_config' | 'then_actions'>,
  ctx: SentenceContext = {},
): string[] {
  return [
    actionSentence(a.action_type, a.action_config, ctx),
    ...(a.then_actions ?? []).map((t) => thenSentence(t)),
  ];
}

export function stepCount(a: Pick<Automation, 'then_actions'>): number {
  return 1 + (a.then_actions?.length ?? 0);
}

// ── times ───────────────────────────────────────────────────────────────────

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * When something happened or happens, in the viewer's clock: "today 09:15",
 * "yesterday 06:00", "Tuesday 02:00" (within a week), "12 Oct 09:15".
 */
export function dayAndTime(ms: number, now: number = Date.now(), capital = false): string {
  const date = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const tomorrow = new Date(now + 86_400_000);
  let day: string;
  if (sameDay(date, today)) day = 'today';
  else if (sameDay(date, yesterday)) day = 'yesterday';
  else if (sameDay(date, tomorrow)) day = 'tomorrow';
  else if (Math.abs(ms - now) < 6 * 86_400_000)
    day = date.toLocaleDateString([], { weekday: 'long' });
  else day = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const text = `${day} ${clock(date)}`;
  return capital ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "next at 16:00", "next tomorrow", "next Thursday 02:00". */
export function nextPhrase(
  a: Pick<Automation, 'next_run' | 'trigger_type' | 'trigger_config'>,
  now: number = Date.now(),
): string | null {
  if (!a.next_run) return null;
  const ms = parseServerTime(a.next_run);
  if (!Number.isFinite(ms)) return null;
  if (ms <= now) return 'due now';
  const date = new Date(ms);
  const cfg = (a.trigger_config ?? {}) as Record<string, unknown>;
  const fixedTime = scheduleKind(a.trigger_type) !== 'interval' && cfgTime(cfg) === clock(date);
  if (sameDay(date, new Date(now))) return `next at ${clock(date)}`;
  if (sameDay(date, new Date(now + 86_400_000)))
    return fixedTime ? 'next tomorrow' : `next tomorrow at ${clock(date)}`;
  return `next ${dayAndTime(ms, now)}`;
}
