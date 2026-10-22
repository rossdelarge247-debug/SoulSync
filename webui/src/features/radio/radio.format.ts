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

export function sourceWords(source: IdSource | null, stationName: string): string {
  switch (source) {
    case 'station_feed':
      return `Identified from ${possessive(stationName)} now-playing feed`;
    case 'stream_titles':
      return 'Identified from the stream’s track names';
    case 'fingerprint':
      return 'Identified by fingerprint';
    default:
      return '';
  }
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

/** Initials for the logo tile: "NTS", "RP", "SF". */
export function logoText(name: string): string {
  const head = name.split(' · ')[0] ?? name;
  if (/^[A-Z0-9]{2,4}\b/.test(head)) return head.split(/\s+/)[0]!.slice(0, 4);
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0]!.slice(0, 2);
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
    return {
      title: np.track.title,
      line: `${np.track.artist} · identified ${agoWords(secondsSince(np, skew))}`,
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
