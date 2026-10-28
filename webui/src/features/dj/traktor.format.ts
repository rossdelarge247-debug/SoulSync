/**
 * The words of "Export to Traktor…" (21a) and the Traktor card (21b).
 */
import type { FolderState, LeftOutReason, TraktorPreview } from './traktor.api';

function quoted(title: string): string {
  return `“${title || 'Untitled'}”`;
}

/** “A”, “B” and 3 more (the first two named). */
function names(titles: string[], total: number): string {
  const shown = titles.filter(Boolean).slice(0, 2).map(quoted);
  const rest = total - shown.length;
  if (!shown.length) return '';
  if (rest <= 0) return shown.join(' and ');
  return `${shown.join(', ')} and ${rest.toLocaleString()} more`;
}

type Named = Exclude<LeftOutReason, 'no_mac_path' | 'too_many' | 'lookup_limit'>;

const ONE: Record<Named, string> = {
  not_in_library: "isn't a file in your library",
  outside: "is in a folder the Mac path doesn't cover",
  bad_path: "has a path Traktor can't read",
};

const MANY: Record<Named, string> = {
  not_in_library: "aren't files in your library",
  outside: "are in folders the Mac path doesn't cover",
  bad_path: "have paths Traktor can't read",
};

const ORDER: LeftOutReason[] = [
  'no_mac_path',
  'not_in_library',
  'outside',
  'bad_path',
  'lookup_limit',
  'too_many',
];

/**
 * One sentence per reason anything was left out, in a fixed order: "“Copper
 * Sky” isn't a file in your library." or "3 tracks are in folders the Mac
 * path doesn't cover: “A”, “B” and 1 more."
 */
export function leftOutLines(
  preview: Pick<TraktorPreview, 'left_out' | 'reasons'>,
  admin: boolean,
): string[] {
  const lines: string[] = [];
  for (const reason of ORDER) {
    const count = preview.reasons[reason] ?? 0;
    if (!count) continue;
    if (reason === 'no_mac_path') {
      lines.push(
        admin
          ? "SYNCHRO.S doesn't know where your music is on the Mac yet. Set it in Settings → Library → DJ."
          : "SYNCHRO.S doesn't know where your music is on the Mac yet. An admin sets it in Settings → Library → DJ.",
      );
      continue;
    }
    if (reason === 'lookup_limit') {
      lines.push(
        `${count.toLocaleString()} ${count === 1 ? "track wasn't" : "tracks weren't"} looked for on disk: too many to look up in one export. Export them in smaller sets.`,
      );
      continue;
    }
    if (reason === 'too_many') {
      lines.push(
        `${count.toLocaleString()} ${count === 1 ? 'track is' : 'tracks are'} past the 1,000 one export takes.`,
      );
      continue;
    }
    const titles = preview.left_out.filter((l) => l.reason === reason).map((l) => l.title);
    if (count === 1) {
      lines.push(`${quoted(titles[0] ?? '')} ${ONE[reason]}.`);
    } else {
      const listed = names(titles, count);
      lines.push(`${count.toLocaleString()} tracks ${MANY[reason]}${listed ? `: ${listed}` : ''}.`);
    }
  }
  return lines;
}

/** The dialog's title: "Export “Sunday Set” to Traktor?" or "Export 12 tracks to Traktor?". */
export function exportTitle(name: string | null, count: number | null): string {
  if (name) return `Export ${quoted(name)} to Traktor?`;
  return `Export ${count === null ? 'these tracks' : `${count.toLocaleString()} ${count === 1 ? 'track' : 'tracks'}`} to Traktor?`;
}

/** The primary: "Export 23 tracks". */
export function exportLabel(found: number): string {
  return `Export ${found.toLocaleString()} ${found === 1 ? 'track' : 'tracks'}`;
}

/** The primary with an export folder set (234, 23d): "Save 23 tracks". */
export function saveLabel(found: number): string {
  return `Save ${found.toLocaleString()} ${found === 1 ? 'track' : 'tracks'}`;
}

/** The export folder as the sentence names it: its last part ("Traktor exports"). */
export function folderName(shown: string | null | undefined): string {
  const parts = (shown ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : 'the export folder';
}

/** "22 October" (with the year when it isn't this one). */
export function dayWords(at: number, now = Date.now()): string {
  const when = new Date(at * 1000);
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return when.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A name already in the export folder (234, 23d): the warning's sentence,
 *  and the phone's shorter one. */
export function takenWords(
  filename: string,
  folder: string,
  at: number | null | undefined,
  now = Date.now(),
): { wide: string; phone: string } {
  const from = at ? `, from ${dayWords(at, now)}` : '';
  return {
    wide: `${filename} is already in ${folder}${from}. Replacing it doesn’t change what Traktor imported then.`,
    phone: `${filename} is already there${from}.`,
  };
}

/** The Traktor card's line under the export folder, by its state. */
export function folderLine(state: FolderState): string {
  switch (state) {
    case 'ok':
      return 'Exports are saved here. Traktor imports them from the same folder on the Mac.';
    case 'missing':
      return "SYNCHRO.S can't find this folder now, so exports download in the browser.";
    case 'not_writable':
      return "SYNCHRO.S can't write in this folder now, so exports download in the browser.";
    case 'outside':
    case 'invalid':
      return 'This folder is outside your music folders, so exports download in the browser.';
    default:
      return 'Optional. Otherwise exports download in the browser.';
  }
}
