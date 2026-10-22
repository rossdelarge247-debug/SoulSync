/**
 * Automations: the list (boards 2i, 2k). Cards on the left, the selected
 * automation's runs on the right; the selection, filters and search live in
 * the URL. On a phone the runs open under the selected card.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { Button, OptionButton, Select, TextInput } from '@/components/form';
import { EmptyState, LoadingState, Notice, Skeleton } from '@/components/primitives';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import type { SentenceContext } from '../-automations.steps';

import {
  AUTOMATIONS_QUERY_KEY,
  assignAutomationGroup,
  automationBlocksQueryOptions,
  automationHistoryQueryOptions,
  automationsListQueryOptions,
  automationsMasterQueryOptions,
  automationsProgressQueryOptions,
  bulkToggleAutomations,
  deleteAutomation,
  duplicateAutomation,
  mirroredPlaylistsQueryOptions,
  previewAutomation,
  regroupAutomations,
  runAutomation,
  setAutomationsMaster,
  toggleAutomation,
} from '../-automations.api';
import { useVanillaBuilder } from '../-automations.builder';
import { forMusicSide, readAutomationsList } from '../-automations.helpers';
import {
  SHOW_OPTIONS,
  countFor,
  groupNames,
  isEnabled,
  isSystem,
  movesFiles,
  selectedAutomation,
  visibleAutomations,
} from '../-automations.list';
import { useAutomationProgress } from '../-automations.progress';
import { latestRun, runsLine, runsWindow, sortRuns } from '../-automations.runs';
import {
  type Automation,
  type AutomationsListSearch,
  type ListShow,
  NO_GROUP,
} from '../-automations.types';
import { ActionMenu, type MenuEntry } from './action-menu';
import { AutomationCard, type CardHandlers } from './automation-card';
import { AutomationHub } from './automation-hub';
import styles from './automations.module.css';
import { ConfirmDialog } from './confirm-dialog';
import { useFileStepRun } from './file-run';
import { GroupDialog } from './group-dialog';
import { PreviewDialog, type PreviewState } from './preview-panel';
import { RunsPanel, RunsSkeleton } from './runs-panel';
import { useMediaQuery } from './use-narrow';

const routeApi = getRouteApi('/automations/');

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

function CardsSkeleton({ faded = false }: { faded?: boolean }) {
  return (
    <div
      className={styles.cardsSkeleton}
      data-faded={faded ? 'true' : undefined}
      aria-hidden="true"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={styles.card} data-skeleton="true">
          <div className={styles.cardHead}>
            <div className={styles.cardTitleBlock}>
              <Skeleton style={{ width: '45%', height: 18 }} />
              <Skeleton style={{ width: '60%', height: 14, marginTop: 8 }} />
            </div>
            <Skeleton style={{ width: 52, height: 26 }} />
          </div>
          <Skeleton style={{ width: '50%', height: 14 }} />
        </div>
      ))}
    </div>
  );
}

type Dialog =
  | { kind: 'delete'; automation: Automation }
  | { kind: 'group'; automation: Automation }
  | { kind: 'rename-group'; name: string }
  | { kind: 'delete-group'; name: string; ids: number[] }
  | null;

export function AutomationsListPage() {
  useReactPageShell('automations');
  const { profileId, isAdmin } = useProfile();
  const search = routeApi.useSearch();
  const navigate = useNavigate();
  const listNavigate = routeApi.useNavigate();
  const queryClient = useQueryClient();
  const phone = useMediaQuery();

  const listQuery = useQuery(automationsListQueryOptions(profileId));
  const masterQuery = useQuery(automationsMasterQueryOptions());
  const blocksQuery = useQuery(automationBlocksQueryOptions());
  const progressSeed = useQuery(automationsProgressQueryOptions());
  const progress = useAutomationProgress(progressSeed.data);

  const automations = useMemo(
    () => forMusicSide(readAutomationsList(listQuery.data)),
    [listQuery.data],
  );
  const needsPlaylists = automations.some(
    (a) => a.action_config && 'playlist_id' in a.action_config,
  );
  const playlistsQuery = useQuery({ ...mirroredPlaylistsQueryOptions(), enabled: needsPlaylists });
  const ctx: SentenceContext = useMemo(
    () => ({
      blocks: blocksQuery.data,
      playlistName: (id: string) =>
        playlistsQuery.data?.playlists.find((p) => String(p.id) === id)?.name,
    }),
    [blocksQuery.data, playlistsQuery.data],
  );

  const visible = useMemo(
    () => visibleAutomations(automations, search, ctx),
    [automations, search, ctx],
  );
  const selected = selectedAutomation(visible, search.automation);
  const missingLink =
    listQuery.isSuccess &&
    search.automation != null &&
    !automations.some((a) => a.id === search.automation);
  const groups = useMemo(() => groupNames(automations), [automations]);
  const masterOn = masterQuery.data?.music !== false;
  const show: ListShow = search.show ?? 'all';

  const selectedHistory = useQuery({
    ...automationHistoryQueryOptions(selected?.id ?? 0),
    enabled: selected != null,
  });

  const [runsOpen, setRunsOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [preview, setPreview] = useState<{ automation: Automation; state: PreviewState } | null>(
    null,
  );

  const setSearch = useCallback(
    (patch: Partial<AutomationsListSearch>, replace = false) =>
      void listNavigate({
        search: (prev: AutomationsListSearch) => {
          const next: AutomationsListSearch = { ...prev, ...patch };
          for (const key of Object.keys(next) as (keyof AutomationsListSearch)[]) {
            if (next[key] === undefined || next[key] === '') delete next[key];
          }
          return next;
        },
        replace,
      }),
    [listNavigate],
  );

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: AUTOMATIONS_QUERY_KEY }),
    [queryClient],
  );
  const refreshSoon = useCallback(() => window.setTimeout(() => void refresh(), 1500), [refresh]);
  const fail = (error: Error) => toast(error.message, 'error');

  const openBuilder = useVanillaBuilder(() => void refresh(), {
    catchDirectOpens: search.view === 'guides',
  });

  const run = useMutation({
    mutationFn: (a: Automation) => runAutomation(a.id),
    onSuccess: (_v, a) => {
      toast(`“${a.name}” is running. Its run shows under Runs when it finishes.`, 'success');
      refreshSoon();
    },
    onError: fail,
  });
  const runPlain = useCallback((a: Automation) => run.mutate(a), [run]);
  const fileRun = useFileStepRun(runPlain);
  const runNow = useCallback(
    (a: Automation) => {
      if (movesFiles(a)) void fileRun.start(a);
      else run.mutate(a);
    },
    [fileRun, run],
  );

  const toggle = useMutation({
    mutationFn: (a: Automation) => toggleAutomation(a.id),
    onSuccess: (_v, a) => {
      toast(isEnabled(a) ? `“${a.name}” is paused.` : `“${a.name}” is on again.`, 'success');
      void refresh();
    },
    onError: fail,
  });

  const duplicate = useMutation({
    mutationFn: (a: Automation) => duplicateAutomation(a.id),
    onSuccess: async (id, a) => {
      toast(`Made a copy of “${a.name}”.`, 'success');
      await refresh();
      if (id) setSearch({ automation: id }, true);
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (a: Automation) => deleteAutomation(a.id),
    onSuccess: async (_v, a) => {
      toast(`Deleted “${a.name}”.`, 'success');
      setDialog(null);
      setSearch({ automation: undefined }, true);
      await refresh();
    },
    onError: fail,
  });

  const assign = useMutation({
    mutationFn: ({ a, group }: { a: Automation; group: string | null }) =>
      assignAutomationGroup(a.id, group),
    onSuccess: async (_v, { a, group }) => {
      toast(
        group ? `Moved “${a.name}” to ${group}.` : `Took “${a.name}” out of its group.`,
        'success',
      );
      setDialog(null);
      await refresh();
    },
    onError: fail,
  });

  const regroup = useMutation({
    mutationFn: ({ ids, group }: { ids: number[]; group: string | null; done: string }) =>
      regroupAutomations(ids, group),
    onSuccess: async (_v, { done, group }) => {
      toast(done, 'success');
      setDialog(null);
      setSearch({ group: group ?? undefined }, true);
      await refresh();
    },
    onError: fail,
  });

  const bulk = useMutation({
    mutationFn: ({ ids, enabled }: { ids: number[]; enabled: boolean }) =>
      bulkToggleAutomations(ids, enabled),
    onSuccess: async (n, { enabled }) => {
      toast(`${enabled ? 'Turned on' : 'Paused'} ${n} automation${n === 1 ? '' : 's'}.`, 'success');
      await refresh();
    },
    onError: fail,
  });

  const deleteGroup = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) await deleteAutomation(id);
      return ids.length;
    },
    onSuccess: async (n) => {
      toast(`Deleted ${n} automation${n === 1 ? '' : 's'}.`, 'success');
      setDialog(null);
      setSearch({ group: undefined, automation: undefined }, true);
      await refresh();
    },
    onError: fail,
  });

  const master = useMutation({
    mutationFn: (enabled: boolean) => setAutomationsMaster('music', enabled),
    onSuccess: async (_v, enabled) => {
      toast(
        enabled ? 'Automations are back on.' : 'Automations are paused.',
        enabled ? 'success' : 'info',
      );
      await refresh();
    },
    onError: fail,
  });

  const startPreview = useCallback(
    (a: Automation) => {
      setPreview({ automation: a, state: { kind: 'loading' } });
      previewAutomation(a.id)
        .then((result) => {
          setPreview((cur) =>
            cur?.automation.id === a.id ? { automation: a, state: { kind: 'done', result } } : cur,
          );
          void queryClient.invalidateQueries({
            queryKey: automationHistoryQueryOptions(a.id).queryKey,
          });
        })
        .catch((error: Error) =>
          setPreview((cur) =>
            cur?.automation.id === a.id
              ? { automation: a, state: { kind: 'error', message: error.message } }
              : cur,
          ),
        );
    },
    [queryClient],
  );

  const handlers: CardHandlers = {
    onSelect: (a) => {
      setRunsOpen(false);
      setSearch({ automation: a.id }, true);
    },
    onPreview: startPreview,
    onRun: runNow,
    onEdit: (a) =>
      void navigate({
        to: '/automations/$automationId/edit',
        params: { automationId: String(a.id) },
      }),
    onToggle: (a) => toggle.mutate(a),
    onDuplicate: (a) => duplicate.mutate(a),
    onGroup: (a) => setDialog({ kind: 'group', automation: a }),
    onDelete: (a) => setDialog({ kind: 'delete', automation: a }),
    onFullBuilder: (a) => openBuilder(a.id),
  };

  const headerMenu: MenuEntry[] = [
    { key: 'guides', label: 'Recipes and guides', onSelect: () => setSearch({ view: 'guides' }) },
    { key: 'builder', label: 'Build one in the full builder', onSelect: () => openBuilder() },
    ...(isAdmin
      ? [
          { key: 'sep', separator: true as const },
          masterOn
            ? {
                key: 'pause-all',
                label: 'Pause all automations',
                onSelect: () => master.mutate(false),
              }
            : {
                key: 'resume-all',
                label: 'Resume all automations',
                onSelect: () => master.mutate(true),
              },
        ]
      : []),
  ];

  const groupMembers =
    search.group && search.group !== NO_GROUP
      ? automations.filter((a) => !isSystem(a) && a.group_name === search.group)
      : [];
  const groupAllOn = groupMembers.length > 0 && groupMembers.every(isEnabled);
  const groupMenu: MenuEntry[] =
    search.group && search.group !== NO_GROUP
      ? [
          {
            key: 'toggle-all',
            label: groupAllOn
              ? 'Pause everything in this group'
              : 'Turn everything in this group on',
            onSelect: () =>
              bulk.mutate({ ids: groupMembers.map((a) => a.id), enabled: !groupAllOn }),
          },
          {
            key: 'rename',
            label: 'Rename this group…',
            onSelect: () => setDialog({ kind: 'rename-group', name: search.group as string }),
          },
          {
            key: 'ungroup',
            label: 'Ungroup (keep the automations)',
            onSelect: () =>
              regroup.mutate({
                ids: groupMembers.map((a) => a.id),
                group: null,
                done: `Ungrouped ${groupMembers.length} automation${groupMembers.length === 1 ? '' : 's'}.`,
              }),
          },
          { key: 'sep', separator: true },
          {
            key: 'delete-group',
            label: 'Delete the group and its automations…',
            tone: 'danger',
            onSelect: () =>
              setDialog({
                kind: 'delete-group',
                name: search.group as string,
                ids: groupMembers.map((a) => a.id),
              }),
          },
        ]
      : [];

  const header = (
    <header className={styles.header}>
      <div className={styles.headText}>
        <h1 className={styles.title}>Automations</h1>
        <p className={styles.subtitle}>
          <span className={styles.wide}>
            Rules that run on a schedule or after something happens. Each one shows its runs, and
            can preview a run without changing anything.
          </span>
          <span className={styles.narrow}>Rules that run on a schedule.</span>
        </p>
      </div>
      <div className={styles.headActions}>
        <Button
          size="lg"
          variant="primary"
          className={styles.newButton}
          onClick={() => void navigate({ to: '/automations/new' })}
        >
          New automation
        </Button>
        <ActionMenu label="More for Automations" entries={headerMenu} />
      </div>
    </header>
  );

  if (search.view === 'guides') {
    return (
      <div className={styles.page} data-testid="automations-page">
        {header}
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <button
            type="button"
            className={styles.crumbLink}
            onClick={() => {
              setSearch({ view: undefined });
              // A recipe may have set up automations while the guides were open.
              void refresh();
            }}
          >
            Automations
          </button>
          <span aria-hidden="true">›</span>
          <span aria-current="page">Recipes and guides</span>
        </nav>
        <div className={styles.guides}>
          <AutomationHub />
        </div>
      </div>
    );
  }

  const filters = (
    <div className={styles.controls}>
      <div className={styles.filters} role="group" aria-label="Show">
        {SHOW_OPTIONS.map((option) => (
          <OptionButton
            key={option.value}
            selected={show === option.value}
            onClick={() =>
              setSearch({
                show: option.value === 'all' ? undefined : option.value,
                automation: undefined,
              })
            }
          >
            {option.label}
            {option.value === 'attention' &&
            listQuery.isSuccess &&
            countFor(automations, 'attention') > 0 ? (
              <span className={styles.count} data-tone="warning">
                {countFor(automations, 'attention')}
              </span>
            ) : null}
          </OptionButton>
        ))}
      </div>
      <div className={styles.filterTools}>
        {groups.length ? (
          <>
            <Select
              size="lg"
              aria-label="Group"
              value={search.group ?? ''}
              onChange={(event) =>
                setSearch({ group: event.target.value || undefined, automation: undefined })
              }
            >
              <option value="">All groups</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value={NO_GROUP}>Not in a group</option>
            </Select>
            {groupMenu.length ? (
              <ActionMenu label={`More for the group ${search.group}`} entries={groupMenu} />
            ) : null}
          </>
        ) : null}
        <TextInput
          className={styles.search}
          type="search"
          aria-label="Find an automation"
          placeholder="Find an automation"
          defaultValue={search.q ?? ''}
          onKeyDown={(event) => {
            if (event.key === 'Enter')
              setSearch({ q: (event.target as HTMLInputElement).value || undefined }, true);
          }}
          onBlur={(event) => {
            if ((event.target.value || undefined) !== search.q)
              setSearch({ q: event.target.value || undefined }, true);
          }}
        />
      </div>
    </div>
  );

  const typeNote =
    search.trigger || search.action ? (
      <Notice tone="neutral">
        Showing only automations that {search.trigger ? `run on “${search.trigger}”` : ''}
        {search.trigger && search.action ? ' and ' : ''}
        {search.action ? `do “${search.action}”` : ''}.{' '}
        <button
          type="button"
          className={styles.inlineLink}
          onClick={() => setSearch({ trigger: undefined, action: undefined })}
        >
          Show all
        </button>
      </Notice>
    ) : null;

  const masterNotice = !masterOn ? (
    <Notice
      tone="warning"
      title="Automations are paused"
      actions={
        isAdmin ? (
          <Button size="lg" onClick={() => master.mutate(true)}>
            Resume automations
          </Button>
        ) : undefined
      }
    >
      Nothing runs on a schedule or after an event until they’re back on. Each automation keeps its
      own On or Paused setting{isAdmin ? '.' : '; an admin can resume them.'}
    </Notice>
  ) : null;

  let body;
  if (listQuery.isPending) {
    body = (
      <LoadingState label="Loading your automations…">
        <div className={styles.listGrid}>
          <CardsSkeleton />
          {phone ? null : (
            <section className={styles.runsPanel} aria-hidden="true">
              <div className={styles.runsHead}>
                <Skeleton style={{ width: 160, height: 20 }} />
              </div>
              <div className={styles.runsBody}>
                <RunsSkeleton />
              </div>
            </section>
          )}
        </div>
      </LoadingState>
    );
  } else if (listQuery.isError) {
    body = (
      <>
        <Notice
          tone="danger"
          role="alert"
          title="Couldn’t load your automations"
          actions={
            <>
              <Button size="lg" onClick={() => void listQuery.refetch()}>
                Try again
              </Button>
              {isAdmin ? (
                <Button size="lg" onClick={() => void navigate({ to: '/setup-check' })}>
                  Run Setup check
                </Button>
              ) : null}
            </>
          }
        >
          SoulSync didn’t answer. Your automations are safe and keep running as set; this is a
          display problem.
        </Notice>
        <CardsSkeleton faded />
      </>
    );
  } else if (automations.length === 0) {
    body = (
      <EmptyState
        variant="panel"
        title="No automations yet"
        description="Automations do the routine work for you, on a schedule or after something happens: searching for what’s on Wanted, checking followed artists, tidying up."
        hint="Start one from scratch, or from a recipe."
        actions={
          <>
            <Button
              size="lg"
              variant="primary"
              onClick={() => void navigate({ to: '/automations/new' })}
            >
              New automation
            </Button>
            <Button size="lg" onClick={() => setSearch({ view: 'guides' })}>
              Recipes and guides
            </Button>
          </>
        }
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        variant="panel"
        title="Nothing matches"
        description="No automation fits these filters."
        hint="Show them all, or try other words."
        actions={
          <Button
            size="lg"
            onClick={() =>
              setSearch({
                show: undefined,
                group: undefined,
                q: undefined,
                trigger: undefined,
                action: undefined,
              })
            }
          >
            Show all automations
          </Button>
        }
      />
    );
  } else {
    const history = sortRuns(selectedHistory.data?.history ?? []);
    body = (
      <div className={styles.listGrid}>
        <div className={styles.cards}>
          {visible.map((a) => {
            const isSelected = selected?.id === a.id;
            return (
              <AutomationCard
                key={a.id}
                automation={a}
                selected={isSelected}
                ctx={ctx}
                masterOn={masterOn}
                progress={progress[a.id]}
                lastDuration={isSelected ? latestRun(history)?.duration_seconds : undefined}
                runsLink={
                  isSelected && phone
                    ? {
                        label: selectedHistory.isSuccess
                          ? runsLine(runsWindow(history, selectedHistory.data?.total).runs)
                          : 'Runs',
                        expanded: runsOpen,
                        onToggle: () => setRunsOpen((o) => !o),
                      }
                    : undefined
                }
                handlers={handlers}
              >
                {isSelected && phone && runsOpen ? (
                  <RunsPanel automation={a} progress={progress[a.id]} embedded />
                ) : null}
              </AutomationCard>
            );
          })}
        </div>
        {!phone && selected ? (
          <div className={styles.side}>
            <RunsPanel key={selected.id} automation={selected} progress={progress[selected.id]} />
          </div>
        ) : null}
      </div>
    );
  }

  const deleting = dialog?.kind === 'delete' ? dialog.automation : null;
  const grouping = dialog?.kind === 'group' ? dialog.automation : null;

  return (
    <div className={styles.page} data-testid="automations-page">
      {header}
      {masterNotice}
      {missingLink ? (
        <Notice tone="neutral">The automation that link pointed to isn’t here any more.</Notice>
      ) : null}
      {filters}
      {typeNote}
      {body}

      <PreviewDialog
        open={preview != null}
        name={preview?.automation.name ?? ''}
        state={preview?.state ?? { kind: 'idle' }}
        onPreview={() => preview && startPreview(preview.automation)}
        onClose={() => setPreview(null)}
        onRun={
          preview && isEnabled(preview.automation)
            ? () => {
                const a = preview.automation;
                setPreview(null);
                runNow(a);
              }
            : undefined
        }
        runLabel="Run this now"
      />

      <ConfirmDialog
        open={deleting != null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        confirmLabel="Delete automation"
        cancelLabel="Keep it"
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDialog(null)}
      >
        It stops running, and its runs go with it. This can’t be undone. Nothing in your library
        changes.
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === 'delete-group'}
        title={dialog?.kind === 'delete-group' ? `Delete the group “${dialog.name}”?` : ''}
        confirmLabel={
          dialog?.kind === 'delete-group'
            ? `Delete ${dialog.ids.length} automation${dialog.ids.length === 1 ? '' : 's'}`
            : 'Delete'
        }
        cancelLabel="Keep them"
        tone="danger"
        busy={deleteGroup.isPending}
        onConfirm={() => dialog?.kind === 'delete-group' && deleteGroup.mutate(dialog.ids)}
        onCancel={() => setDialog(null)}
      >
        Every automation in it is deleted, with its runs. This can’t be undone. To keep them, choose
        “Ungroup” instead.
      </ConfirmDialog>

      <GroupDialog
        open={grouping != null}
        title={
          grouping?.group_name
            ? `Move “${grouping.name}” to another group`
            : `Put “${grouping?.name ?? ''}” in a group`
        }
        intro="Groups are for your own sorting. Pick one you have, or write a new name. Leave it empty to take the automation out of its group."
        initial={grouping?.group_name ?? ''}
        groups={groups}
        confirmLabel="Save"
        allowEmpty
        onSave={(name) => grouping && assign.mutate({ a: grouping, group: name || null })}
        onCancel={() => setDialog(null)}
      />

      <GroupDialog
        open={dialog?.kind === 'rename-group'}
        title={dialog?.kind === 'rename-group' ? `Rename “${dialog.name}”` : ''}
        intro="Every automation in the group moves to the new name."
        initial={dialog?.kind === 'rename-group' ? dialog.name : ''}
        groups={groups}
        confirmLabel="Rename"
        allowEmpty={false}
        onSave={(name) =>
          dialog?.kind === 'rename-group' &&
          regroup.mutate({
            ids: groupMembers.map((a) => a.id),
            group: name,
            done: `Renamed the group to ${name}.`,
          })
        }
        onCancel={() => setDialog(null)}
      />

      {fileRun.dialogs}
    </div>
  );
}
