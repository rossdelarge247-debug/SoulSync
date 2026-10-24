/**
 * "Remove the old copies…" (14i) through the Safe action: the preview lists
 * exactly the files this move copied and checked; tiles Files / Frees /
 * Deleted for good; the list; "I checked the list"; then the danger button
 * "Delete N files". The recycle bin would keep the space on the same disk,
 * so this one says plainly that it can't be undone.
 *
 * The list heads with the old folder as the computer names it ("On
 * Macintosh HD, in /Users/ross/SoulSync/music"; 19c, 125) and its rows are
 * relative to it; a list over several folders has a head per folder. Without
 * the computer's names it heads with the container's path and offers the
 * helper's `--names` in one line. The names are only words: what's deleted
 * is the preview's own list.
 */

import { useEffect, useState } from 'react';

import type { SafeActionPhase } from '@/features/safe-action/safe-action-dialog';
import type { SafeActionRow } from '@/features/safe-action/safe-action-dialog';

import { ListHead, SafeActionDialog } from '@/features/safe-action/safe-action-dialog';

import type { Move, MovePayload, RemovePreview, RemoveRoot, Role } from './drives.api';

import { drivesApi, DrivesError, planListURL } from './drives.api';
import { count, relativeTo, shownPath, sizeWords, wantsNames } from './drives.format';
import { HostNamesLine } from './host-names';

/** The head's words for one old folder: "On Macintosh HD, in" and the path. */
export function rootHead(root: RemoveRoot, fallbackDrive: string): { label: string; path: string } {
  const drive = (root.host_path && root.volume) || root.drive || fallbackDrive;
  return { label: `On ${drive}, in`, path: shownPath(root) };
}

/** The sample as the list shows it: rows relative to their old folder,
 *  grouped by folder in the preview's order, with a head row per folder
 *  when there's more than one. */
export function removeRows(
  preview: Pick<RemovePreview, 'sample' | 'roots'>,
  fallbackDrive: string,
): { head: { label: string; path: string } | null; rows: SafeActionRow[] } {
  const roots = preview.roots ?? {};
  const groups: Array<{ role: Role | null; items: RemovePreview['sample'] }> = [];
  for (const item of preview.sample) {
    const role = item.role && roots[item.role] ? item.role : null;
    const last = groups[groups.length - 1];
    if (last && last.role === role) last.items.push(item);
    else groups.push({ role, items: [item] });
  }
  const roles = new Set(groups.map((g) => g.role));
  const single = roles.size === 1 && !roles.has(null);
  const cells = (item: RemovePreview['sample'][number], role: Role | null) => {
    const rel = role ? (item.rel ?? relativeTo(item.path, roots[role]?.path)) : item.path;
    return [<code key="p">{rel}</code>, sizeWords(item.size)];
  };
  if (single) {
    const role = groups[0].role as Role;
    return {
      head: rootHead(roots[role] as RemoveRoot, fallbackDrive),
      rows: groups.flatMap((g) =>
        g.items.map((item) => ({ key: item.path, cells: cells(item, role) })),
      ),
    };
  }
  const rows: SafeActionRow[] = [];
  groups.forEach((g, i) => {
    if (g.role) {
      const head = rootHead(roots[g.role] as RemoveRoot, fallbackDrive);
      rows.push({
        key: `head-${g.role}-${i}`,
        cells: [],
        heading: <ListHead label={head.label} path={head.path} />,
      });
    }
    for (const item of g.items) rows.push({ key: item.path, cells: cells(item, g.role) });
  });
  return { head: null, rows };
}

export function RemoveOldCopies({
  move,
  onClose,
  onDone,
}: {
  move: Move;
  onClose: () => void;
  onDone: (payload: MovePayload) => void;
}) {
  const [preview, setPreview] = useState<RemovePreview | null>(null);
  const [phase, setPhase] = useState<SafeActionPhase>({
    kind: 'working',
    message: 'Listing the old copies…',
  });
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const source = move.plan?.source_label ?? 'the old drive';
  const target = move.plan?.target_label ?? 'the new drive';

  const load = async () => {
    setPhase({ kind: 'working', message: 'Listing the old copies…' });
    setTicked(false);
    try {
      setPreview(await drivesApi.removePreview(move.id));
      setPhase({ kind: 'review' });
    } catch (e) {
      setPhase({
        kind: 'refused',
        message: e instanceof Error ? e.message : 'That didn’t go through.',
        previewAgain: false,
      });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const out = await drivesApi.remove(move.id, preview.plan_id);
      onDone(out);
    } catch (e) {
      const code = e instanceof DrivesError ? e.code : undefined;
      setPhase({
        kind: 'refused',
        message: e instanceof Error ? e.message : 'That didn’t go through.',
        previewAgain: Boolean(code),
        code,
      });
    } finally {
      setBusy(false);
    }
  };

  const total = preview?.total ?? 0;
  const list = preview ? removeRows(preview, source) : null;
  const shownRoots = Object.values(preview?.roots ?? {}) as RemoveRoot[];
  return (
    <SafeActionDialog
      open
      onClose={onClose}
      phase={phase}
      title="Permanently delete the old copies?"
      stats={
        preview
          ? [
              { label: 'Files', value: total.toLocaleString('en-GB') },
              { label: 'Frees', value: sizeWords(preview.total_bytes) },
              { label: 'Deleted', value: 'For good' },
            ]
          : undefined
      }
      lead={
        <p>
          Only the files SYNCHRO.S copied to {target} and checked are deleted, and each one only
          while its copy is still there. This can’t be undone: the recycle bin would keep the space
          on {source}.
        </p>
      }
      guard={{
        message: `${count(total, 'file')} on ${source} will be deleted for good.`,
        checked: ticked,
        onChange: setTicked,
        label: 'I checked the list',
      }}
      columns={
        list?.head || list?.rows.some((r) => r.heading)
          ? ['File', 'Size']
          : ['File on ' + source, 'Size']
      }
      rows={list?.rows ?? []}
      listHead={list?.head ? <ListHead label={list.head.label} path={list.head.path} /> : undefined}
      listNote={
        preview && shownRoots.length && wantsNames(shownRoots, preview.platform) ? (
          <HostNamesLine platform={preview.platform} />
        ) : undefined
      }
      shownLabel={
        preview
          ? `${Math.min(preview.sample.length, total).toLocaleString('en-GB')} of ${count(total, 'file')} shown`
          : undefined
      }
      fullList={
        preview
          ? {
              label: 'Download the full list',
              onClick: () => window.open(planListURL(preview.plan_id), '_blank'),
            }
          : undefined
      }
      createdAt={preview?.created_at}
      expiresAt={preview?.expires_at}
      confirmLabel={`Delete ${count(total, 'file')}`}
      confirmTone="danger"
      confirmDisabled={!ticked}
      confirmDisabledReason="Tick “I checked the list” to delete the files."
      confirmBusy={busy}
      onConfirm={() => void confirm()}
      onPreviewAgain={() => void load()}
    />
  );
}
