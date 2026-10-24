/**
 * Internet radio's words, worked out with no DOM (boards 4a–4k): ages,
 * sources, states, quality and the Heard list's tags. Shared by the Radio
 * page and the player's radio mode.
 */

import type { HeardItem, HeardState, IdSource, NowPlaying, Station } from './radio.types';

/** "12 s ago", "3 min ago", "2 h ago". */
export function agoWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** "About 8 minutes", for an unnamed stretch. */
export function durationWords(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 90) return 'about a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} minutes`;
  const h = Math.round(m / 60);
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}

/** The station name's possessive: "NTS's", "KEXP's". */
export function possessive(name: string): string {
  const short = shortName(name);
  return short.endsWith('s') ? `${short}’` : `${short}’s`;
}

/** "Radio Paradise · Main Mix" → "Radio Paradise"; "NTS 1" → "NTS". */
export function shortName(name: string): string {
  const first = name.split(' · ')[0] ?? name;
  return first.replace(/\s+\d+$/, '').trim() || name;
}

/**
 * Where a name came from, as the meta line says it (HANDOFF 58): "from the
 * station", "from the stream’s names", "fingerprint", "found by AudD" (AudD
 * listening on its own), "found by AudD · Scan now". This phrase is how a
 * scan's answer is told from the station's; there is never a second tag.
 */
export function sourcePhrase(source: IdSource | null | undefined): string {
  switch (source) {
    case 'station_feed':
      return 'from the station';
    case 'stream_titles':
      return 'from the stream’s names';
    case 'fingerprint':
      return 'fingerprint';
    case 'audd':
      // automatic AudD: the station didn't say and AcoustID didn't know it
      return 'found by AudD';
    case 'scan_acoustid':
      return 'found by AcoustID · Scan now';
    case 'scan_audd':
      return 'found by AudD · Scan now';
    case 'scan_acrcloud':
      return 'found by ACRCloud · Scan now';
    default:
      return '';
  }
}

/** The source phrase at the start of a line: "From the station", "Found by AudD · Scan now". */
export function sourceWords(source: IdSource | null | undefined): string {
  const phrase = sourcePhrase(source);
  return phrase ? phrase[0].toUpperCase() + phrase.slice(1) : '';
}

/** Seconds since it was identified, by the server's clock. */
export function secondsSince(np: Pick<NowPlaying, 'identified_at' | 'now'>, skew = 0): number {
  if (!np.identified_at) return 0;
  const serverNow = Date.now() / 1000 - skew;
  return Math.max(0, serverNow - np.identified_at);
}

/** The card's declared quality: "AAC 256 kbps"; FLAC is a tag instead. */
export function qualityText(station: Pick<Station, 'quality'>): string {
  const q = station.quality;
  if (q.lossless) return q.codec || 'FLAC';
  if (q.codec && q.bitrate_kbps) return `${q.codec} ${q.bitrate_kbps} kbps`;
  return q.codec || '';
}

/** The short form the phone list uses: "AAC 256". */
export function qualityShort(station: Pick<Station, 'quality'>): string {
  const q = station.quality;
  if (q.lossless) return q.codec || 'FLAC';
  return [q.codec, q.bitrate_kbps || ''].filter(Boolean).join(' ');
}

/** "Eclectic · London", "Your link · added by ross". */
export function cardSubline(station: Station): string {
  if (station.source === 'your_link') {
    return station.added_by ? `Your link · added by ${station.added_by}` : 'Your link';
  }
  const kind = station.genre || station.kind_label;
  return [kind, station.city || station.country].filter(Boolean).join(' · ');
}

/** Initials for the logo tile: "NTS", "RP", "SF" (SomaFM), "FIP". */
export function logoText(name: string, override?: string): string {
  if (override) return override.slice(0, 4);
  const head = name.split(' · ')[0] ?? name;
  if (/^[A-Z0-9]{2,4}\b/.test(head)) return head.split(/\s+/)[0]!.slice(0, 4);
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const caps = words[0]!.match(/[A-Z]/g);
    if (caps && caps.length >= 2) return caps.slice(0, 2).join('');
    return words[0]!.slice(0, 2);
  }
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export interface HeardTag {
  label: string;
  tone: 'success' | 'info' | 'neutral' | 'warning';
}

export function heardTag(item: Pick<HeardItem, 'state' | 'below_target'>): HeardTag {
  if (item.state === 'in_library' && item.below_target) {
    return { label: 'Below quality target', tone: 'warning' };
  }
  const map: Record<HeardState, HeardTag> = {
    in_library: { label: 'In your library', tone: 'success' },
    on_wanted: { label: 'On Wanted · Searching', tone: 'info' },
    added_by_auto_add: { label: 'On Wanted · Auto-add', tone: 'info' },
    not_added: { label: 'Not in your library', tone: 'neutral' },
    cant_match: { label: 'Can’t be matched', tone: 'neutral' },
    not_identified: { label: 'Not identified', tone: 'neutral' },
  };
  return map[item.state];
}

/** "10:38" in the browser's time. */
export function clockTime(unix: number | null | undefined, locale?: string): string {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** "Today", "Yesterday", "Wednesday 22 October". */
export function dayLabel(unix: number, now = Date.now(), locale?: string): string {
  const d = new Date(unix * 1000);
  const today = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  const long = d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  if (diff === 0) return `Today · ${long}`;
  if (diff === 1) return `Yesterday · ${long}`;
  return long;
}

/** The player bar's left line: "AAC 256 kbps · Radio". */
export function barMeta(stream: { label?: string } | null, station: Station | null): string {
  const quality =
    stream?.label?.replace(' (best offered)', '') || (station ? qualityText(station) : '');
  return [quality, 'Radio'].filter(Boolean).join(' · ');
}

/** What the player shows for the station now: a title, and the line under it. */
export function nowLines(
  np: NowPlaying | null,
  skew = 0,
): { title: string; line: string; identified: boolean } {
  if (!np)
    return {
      title: 'Listening…',
      line: 'Its name usually arrives within a minute',
      identified: false,
    };
  if (np.state === 'identified' && np.track) {
    // "Pale Harbour · from the station · 40 s ago"
    return {
      title: np.track.title,
      line: [
        np.track.artist,
        np.track.release,
        sourcePhrase(np.source),
        agoWords(secondsSince(np, skew)),
      ]
        .filter(Boolean)
        .join(' · '),
      identified: true,
    };
  }
  if (np.state === 'listening')
    return {
      title: 'Listening…',
      line: 'Its name usually arrives within a minute',
      identified: false,
    };
  if (np.state === 'off')
    return { title: 'Not identified', line: 'Track identification is off', identified: false };
  if (np.state === 'unavailable')
    return {
      title: 'Not identified',
      line: 'Can’t identify tracks on this station',
      identified: false,
    };
  return {
    title: 'Not identified',
    line: 'Mixes, talk and live sessions often can’t be identified',
    identified: false,
  };
}

/** The player's one action: Add to Wanted, In your library, or nothing. */
export function playerAction(
  np: NowPlaying | null,
): 'add' | 'in_library' | 'on_wanted' | 'adding_disabled' | null {
  if (!np || np.state !== 'identified' || !np.track) return null;
  if (np.library?.in_library) return 'in_library';
  if (np.on_wanted) return 'on_wanted';
  return np.heard_id ? 'add' : 'adding_disabled';
}

/** The whole name's possessive, for a link to the station's page: "NTS 1’s", "KEXP’s". */
export function stationPossessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}’` : `${n}’s`;
}

/**
 * The expanded player's mono readout (the tray's radio mode): the stream the
 * player has and the path, "AAC 256 kbps · relayed" or "FLAC · direct".
 */
export function streamReadout(
  stream: { label?: string; codec?: string; bitrate_kbps?: number; lossless?: boolean } | null,
  station: Pick<Station, 'quality'> | null,
  mode: 'direct' | 'relay' | null,
): string {
  let quality = '';
  if (stream?.lossless) quality = stream.codec || 'FLAC';
  else if (stream?.codec && stream.bitrate_kbps)
    quality = `${stream.codec} ${stream.bitrate_kbps} kbps`;
  else if (stream?.label) quality = stream.label.replace(' (best offered)', '');
  else if (station) quality = qualityText(station);
  const path = mode === 'relay' ? 'relayed' : mode === 'direct' ? 'direct' : '';
  return [quality, path].filter(Boolean).join(' · ') || '—';
}

/**
 * The tray's stream picker (16a): the stream in the readout's words, short,
 * "AAC 256 · relayed" for the one playing and "MP3 128" for the others.
 */
export function streamChoice(
  stream: { label?: string; codec?: string; bitrate_kbps?: number; lossless?: boolean },
  mode: 'direct' | 'relay' | null,
): string {
  let quality: string;
  if (stream.lossless) quality = stream.codec || 'FLAC';
  else if (stream.codec && stream.bitrate_kbps) quality = `${stream.codec} ${stream.bitrate_kbps}`;
  else quality = (stream.label ?? '').replace(' (best offered)', '') || 'Stream';
  const path = mode === 'relay' ? 'relayed' : mode === 'direct' ? 'direct' : '';
  return [quality, path].filter(Boolean).join(' · ');
}

/** A station row's line in the tray's Stations (16b): a link is "Your link", no name. */
export function stationRowLine(station: Station): string {
  return station.source === 'your_link' ? 'Your link' : cardSubline(station);
}

/** Heard rows from today in the browser's day, newest first. */
export function heardToday<T extends Pick<HeardItem, 'heard_at'>>(
  items: T[],
  now = Date.now(),
): T[] {
  const today = new Date(now).toDateString();
  return items
    .filter((i) => new Date(i.heard_at * 1000).toDateString() === today)
    .sort((a, b) => b.heard_at - a.heard_at);
}

/**
 * Heard today in the tray (143): the count and the rows are the identified
 * tracks (as the phone sheet's `heard_today.identified`); the rest fold into
 * one meta line at the list's end, "3 more weren't identified · talk or a mix".
 */
export function heardFold<T extends Pick<HeardItem, 'state' | 'title'>>(
  items: T[],
): { rows: T[]; count: number; rest: string } {
  const named = (i: T) => i.state !== 'not_identified' && Boolean(i.title);
  const rows = items.filter(named);
  const left = items.length - rows.length;
  const rest = !left
    ? ''
    : `${left}${rows.length ? ' more' : ''} ${left === 1 ? 'wasn’t' : 'weren’t'} identified · talk or a mix`;
  return { rows, count: rows.length, rest };
}

/**
 * One Heard row in the expanded player's list: the title and the line (the
 * same source phrase as the bar, HANDOFF 58), and either the one thing to do
 * (Add, or Upgrade for a copy below your target) or the state in words.
 */
export function heardRowView(item: HeardItem): {
  title: string;
  line: string;
  action: 'add' | 'upgrade' | null;
  status: HeardTag | null;
} {
  const named = item.state !== 'not_identified' && Boolean(item.title);
  const title = named ? (item.title as string) : 'Not identified';
  const dur = durationWords(item.duration_s);
  const line = named
    ? [item.artist, item.release, sourcePhrase(item.source)].filter(Boolean).join(' · ')
    : `${dur[0]!.toUpperCase()}${dur.slice(1)} · probably a mix or talk`;
  if (item.state === 'not_added') return { title, line, action: 'add', status: null };
  if (item.state === 'in_library' && item.below_target)
    return { title, line, action: 'upgrade', status: null };
  return { title, line, action: null, status: heardTag(item) };
}
