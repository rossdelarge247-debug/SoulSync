/**
 * The step editor, a full page (boards 2j, 2l): name, how it runs, the steps
 * as sentences, and a Preview panel that shows what a run would do with
 * these steps, changing nothing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button, TextInput } from '@/components/form';
import { LoadingState, Notice, SkeletonList } from '@/components/primitives';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import type { Automation } from '../-automations.types';

import {
  AUTOMATIONS_QUERY_KEY,
  automationBlocksQueryOptions,
  automationHistoryQueryOptions,
  automationQueryOptions,
  automationsListQueryOptions,
  previewAutomation,
  runAutomation,
  saveAutomation,
} from '../-automations.api';
import { useVanillaBuilder } from '../-automations.builder';
import {
  actionConfig,
  draftChanged,
  draftFromAutomation,
  draftToPayload,
  newDraft,
  newThenConfig,
  stepKey,
  validateDraft,
  type Draft,
  type DraftErrors,
  type ScheduleDraft,
  type ThenDraft,
} from '../-automations.draft';
import { forMusicSide, readAutomationsList } from '../-automations.helpers';
import { groupNames, movesFiles } from '../-automations.list';
import { findBlock, nextPhrase, scheduleKind } from '../-automations.steps';
import { type MenuEntry } from './action-menu';
import styles from './automations.module.css';
import { ConfirmDialog } from './confirm-dialog';
import { ActionStep, ADD_STEP_TYPES, canAddStep, RunsField, ThenStep } from './editor-fields';
import { useFileStepRun } from './file-run';
import { PreviewPanel, type PreviewState } from './preview-panel';
import { useMediaQuery } from './use-narrow';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

function runsNote(draft: Draft, saved: Automation | undefined): string {
  const kind = draft.schedule.kind;
  const sameSchedule =
    saved &&
    scheduleKind(saved.trigger_type) === kind &&
    JSON.stringify(draftToPayload(draft).trigger_config) ===
      JSON.stringify(saved.trigger_config ?? {});
  const next =
    sameSchedule && saved && (saved.enabled === true || saved.enabled === 1)
      ? nextPhrase(saved)
      : null;
  const lead = next ? `${next.charAt(0).toUpperCase()}${next.slice(1)}. ` : '';
  return kind === 'event'
    ? `${lead}If the same job is still running when this happens, this run is skipped.`
    : `${lead}If the same job is still running when it’s due, this run is skipped and tried again 5 minutes later.`;
}

function EditorHeader({
  title,
  isNew,
  actions,
  onBack,
}: {
  title: string;
  isNew: boolean;
  actions?: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <button type="button" className={styles.crumbLink} onClick={onBack}>
          Automations
        </button>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{isNew ? 'New' : 'Edit'}</span>
      </nav>
      <header className={styles.header}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>
            <span className={styles.wide}>
              Steps run in order. Preview a run to see what it would do without changing anything.
            </span>
          </p>
        </div>
        {actions ? <div className={styles.headActions}>{actions}</div> : null}
      </header>
    </>
  );
}

export function AutomationEditorPage({ automationId }: { automationId: number | null }) {
  useReactPageShell('automations');
  const { profileId } = useProfile();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const phone = useMediaQuery();
  const isNew = automationId == null;

  const savedQuery = useQuery({ ...automationQueryOptions(automationId ?? 0), enabled: !isNew });
  const blocksQuery = useQuery(automationBlocksQueryOptions());
  const listQuery = useQuery(automationsListQueryOptions(profileId));
  const groups = useMemo(
    () => groupNames(forMusicSide(readAutomationsList(listQuery.data))),
    [listQuery.data],
  );
  const blocks = blocksQuery.data;
  const saved = savedQuery.data;

  const [draft, setDraft] = useState<Draft | null>(() => (isNew ? newDraft() : null));
  const [baseline, setBaseline] = useState<Draft | null>(() => (isNew ? newDraft() : null));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const [leaving, setLeaving] = useState<null | 'list' | 'builder'>(null);
  const loadedFor = useRef<number | null>(null);
  const nameId = useId();
  const groupId = useId();
  const groupListId = useId();

  // Start from the saved automation once it arrives (and again after the
  // full builder changed it).
  useEffect(() => {
    if (!saved || isNew) return;
    const stamp = saved.updated_at ? Date.parse(saved.updated_at) || saved.id : saved.id;
    if (loadedFor.current === stamp) return;
    loadedFor.current = stamp;
    const fresh = draftFromAutomation(saved);
    setDraft(fresh);
    setBaseline(draftFromAutomation(saved));
  }, [saved, isNew]);

  const dirty = draft != null && baseline != null && draftChanged(draft, baseline);
  const backToList = useCallback(
    (id?: number | null) =>
      void navigate({ to: '/automations', search: id ? { automation: id } : {} }),
    [navigate],
  );

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);
  const updateSchedule = (patch: Partial<ScheduleDraft>) =>
    setDraft((d) => (d ? { ...d, schedule: { ...d.schedule, ...patch } } : d));
  const updateThen = (key: string, patch: Partial<ThenDraft>) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            followUps: d.followUps.map((t) =>
              t.key === key
                ? {
                    ...t,
                    ...patch,
                    ...(patch.type && patch.type !== t.type
                      ? { config: newThenConfig(patch.type) }
                      : {}),
                  }
                : t,
            ),
          }
        : d,
    );
  const moveThen = (key: string, by: number) =>
    setDraft((d) => {
      if (!d) return d;
      const i = d.followUps.findIndex((t) => t.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= d.followUps.length) return d;
      const next = [...d.followUps];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...d, followUps: next };
    });

  // Errors refresh as you fix them, once a save has been tried.
  useEffect(() => {
    if (tried && draft) setErrors(validateDraft(draft));
  }, [draft, tried]);

  const openBuilder = useVanillaBuilder(() => {
    loadedFor.current = null;
    void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_QUERY_KEY });
  });

  const save = useMutation({
    mutationFn: (d: Draft) => saveAutomation(d.id, draftToPayload(d)),
    onSuccess: async (id, d) => {
      toast(`Saved “${d.name.trim()}”.`, 'success');
      await queryClient.invalidateQueries({ queryKey: AUTOMATIONS_QUERY_KEY });
      setBaseline(d);
      backToList(id);
    },
  });

  const run = useMutation({
    mutationFn: (a: Automation) => runAutomation(a.id),
    onSuccess: (_v, a) => {
      toast(`“${a.name}” is running. Its run shows under Runs when it finishes.`, 'success');
      window.setTimeout(
        () =>
          void queryClient.invalidateQueries({
            queryKey: automationHistoryQueryOptions(a.id).queryKey,
          }),
        1500,
      );
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });
  const runPlain = useCallback((a: Automation) => run.mutate(a), [run]);
  const fileRun = useFileStepRun(runPlain);

  const onSave = () => {
    if (!draft) return;
    const found = validateDraft(draft);
    setTried(true);
    setErrors(found);
    if (Object.keys(found).length) {
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('[data-editor] [aria-invalid="true"]')?.focus();
      }, 0);
      return;
    }
    save.mutate(draft);
  };

  const onPreview = () => {
    if (!draft) return;
    if (!draft.actionType) {
      setTried(true);
      setErrors(validateDraft(draft));
      return;
    }
    setPreview({ kind: 'loading' });
    previewAutomation(draft.id, {
      action_type: draft.actionType,
      action_config: actionConfig(draft),
      then_actions: draftToPayload(draft).then_actions,
    })
      .then((result) => {
        setPreview({ kind: 'done', result });
        if (draft.id != null && result.recorded) {
          void queryClient.invalidateQueries({
            queryKey: automationHistoryQueryOptions(draft.id).queryKey,
          });
        }
      })
      .catch((error: Error) => setPreview({ kind: 'error', message: error.message }));
  };

  const onCancel = () => (dirty ? setLeaving('list') : backToList(automationId));

  // ── states before there's a draft ─────────────────────────────────────────
  if (!isNew && (savedQuery.isPending || (savedQuery.isSuccess && !draft))) {
    return (
      <div className={styles.page} data-testid="automation-editor">
        <EditorHeader
          title="Edit automation"
          isNew={false}
          onBack={() => backToList(automationId)}
        />
        <LoadingState label="Loading the automation…">
          <SkeletonList rows={3} art={0} />
        </LoadingState>
      </div>
    );
  }
  if (!isNew && savedQuery.isError) {
    const missing = /not found/i.test(savedQuery.error.message);
    return (
      <div className={styles.page} data-testid="automation-editor">
        <EditorHeader title="Edit automation" isNew={false} onBack={() => backToList()} />
        <Notice
          tone={missing ? 'warning' : 'danger'}
          role="alert"
          title={missing ? 'This automation isn’t here any more' : 'Couldn’t load this automation'}
          actions={
            missing ? (
              <Button size="lg" onClick={() => backToList()}>
                Back to Automations
              </Button>
            ) : (
              <Button size="lg" onClick={() => void savedQuery.refetch()}>
                Try again
              </Button>
            )
          }
        >
          {missing
            ? 'It may have been deleted. Nothing else changed.'
            : 'SoulSync didn’t answer. The automation is safe and keeps running as set; this is a display problem.'}
        </Notice>
        <SkeletonList rows={2} art={0} faded />
      </div>
    );
  }
  if (!draft) return null;

  const errorCount = Object.keys(errors).length;
  const triggerDef = findBlock(
    blocks,
    'triggers',
    draft.schedule.kind === 'event' ? draft.schedule.eventType : '',
  );
  const savedRunnable = saved && !isNew;
  const runAction = savedRunnable
    ? {
        onRun: () => (movesFiles(saved) ? void fileRun.start(saved) : run.mutate(saved)),
        note: 'Runs with the steps as saved.',
        disabledReason: dirty ? 'Save first: Run this now runs the steps as saved.' : undefined,
      }
    : undefined;

  const actionsBar = (
    <>
      {save.isPending ? null : (
        <Button size="lg" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button
        size="lg"
        onClick={onPreview}
        disabled={preview.kind === 'loading'}
        focusableWhenDisabled
      >
        Preview a run
      </Button>
      <Button
        size="lg"
        variant="primary"
        onClick={onSave}
        disabled={save.isPending}
        focusableWhenDisabled
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </Button>
    </>
  );

  const stepMenu = (key: string, index: number): MenuEntry[] => [
    { key: 'up', label: 'Move up', disabled: index === 0, onSelect: () => moveThen(key, -1) },
    {
      key: 'down',
      label: 'Move down',
      disabled: index === draft.followUps.length - 1,
      onSelect: () => moveThen(key, 1),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      disabled: !canAddStep(draft.followUps.length),
      onSelect: () =>
        setDraft((d) => {
          if (!d) return d;
          const src = d.followUps[index];
          const copy: ThenDraft = {
            ...src,
            key: stepKey(),
            config: { ...src.config },
            condition: src.condition ? { ...src.condition } : null,
            extra: { ...src.extra },
          };
          const next = [...d.followUps];
          next.splice(index + 1, 0, copy);
          return { ...d, followUps: next };
        }),
    },
    { key: 'sep', separator: true },
    {
      key: 'remove',
      label: 'Remove',
      tone: 'danger',
      onSelect: () =>
        setDraft((d) => (d ? { ...d, followUps: d.followUps.filter((t) => t.key !== key) } : d)),
    },
  ];

  const firstMenu: MenuEntry[] = [
    {
      key: 'builder',
      label: 'Open in the full builder',
      onSelect: () => (dirty ? setLeaving('builder') : openBuilder(draft.id ?? undefined)),
    },
  ];

  return (
    <div className={styles.page} data-testid="automation-editor" data-editor="true">
      <EditorHeader
        title={isNew ? draft.name.trim() || 'New automation' : baseline?.name || draft.name}
        isNew={isNew}
        onBack={onCancel}
        actions={phone ? undefined : actionsBar}
      />
      {tried && errorCount ? (
        <p className={styles.formError} role="alert">
          {errorCount === 1
            ? 'Fix the one thing marked below, then save.'
            : `Fix the ${errorCount} things marked below, then save.`}
        </p>
      ) : null}
      {save.isError ? (
        <Notice
          tone="danger"
          role="alert"
          title="Couldn’t save the automation"
          actions={
            <Button size="lg" onClick={onSave}>
              Try again
            </Button>
          }
        >
          {save.error.message.replace(/\.?$/, '.')} Nothing was changed.
        </Notice>
      ) : null}

      <div className={styles.editorGrid}>
        <div className={styles.editorMain}>
          <section className={styles.editorCard} aria-label="Name and schedule">
            <div className={styles.nameRuns}>
              <div className={styles.nameColumn}>
                <div className={styles.thenField}>
                  <label className={styles.fieldLabel} htmlFor={nameId}>
                    Name
                  </label>
                  <TextInput
                    id={nameId}
                    value={draft.name}
                    readOnly={draft.isSystem}
                    aria-invalid={errors.name ? true : undefined}
                    aria-describedby={errors.name ? `${nameId}-err` : undefined}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                  {errors.name ? (
                    <p id={`${nameId}-err`} className={styles.fieldError} role="alert">
                      {errors.name}
                    </p>
                  ) : null}
                  {draft.isSystem ? (
                    <p className={styles.help}>Built in: its name stays as SoulSync set it.</p>
                  ) : null}
                </div>
                {draft.isSystem ? null : (
                  <div className={styles.thenField}>
                    <label className={styles.fieldLabel} htmlFor={groupId}>
                      Group (optional)
                    </label>
                    <TextInput
                      id={groupId}
                      value={draft.group}
                      list={groupListId}
                      autoComplete="off"
                      onChange={(e) => update({ group: e.target.value })}
                    />
                    <datalist id={groupListId}>
                      {groups.map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                  </div>
                )}
              </div>
              <RunsField
                schedule={draft.schedule}
                onChange={updateSchedule}
                blocks={blocks}
                locked={draft.isSystem}
                errors={errors}
                phone={phone}
              />
            </div>
            <p className={styles.help}>{runsNote(draft, saved)}</p>
          </section>

          <section className={styles.stepsSection} aria-labelledby="steps-heading">
            <div className={styles.sectionHead}>
              <h2 id="steps-heading" className={styles.sectionTitle}>
                Steps
              </h2>
              <p className={styles.sectionNote}>
                The first step does the work; the ones after it run when it finishes, in order.
              </p>
            </div>
            <ol className={styles.steps}>
              <ActionStep
                actionType={draft.actionType}
                config={draft.actionConfig}
                delay={draft.delay}
                blocks={blocks}
                locked={draft.isSystem && Boolean(baseline?.actionType)}
                error={errors.action}
                onType={(type) => update({ actionType: type, actionConfig: {} })}
                onConfig={(patch) => update({ actionConfig: { ...draft.actionConfig, ...patch } })}
                onDelay={(delay) => update({ delay })}
                menu={firstMenu}
              />
              {draft.followUps.map((step, index) => (
                <ThenStep
                  key={step.key}
                  step={step}
                  position={index + 2}
                  triggerVariables={triggerDef?.variables ?? []}
                  errors={errors}
                  onChange={(patch) => updateThen(step.key, patch)}
                  menu={stepMenu(step.key, index)}
                />
              ))}
            </ol>
            <div className={styles.addStep}>
              <span className={styles.inlineLabel}>Add a step:</span>
              {ADD_STEP_TYPES.map((option) => (
                <Button
                  key={option.type}
                  size="lg"
                  disabled={!canAddStep(draft.followUps.length)}
                  focusableWhenDisabled
                  onClick={() =>
                    setDraft((d) =>
                      d && canAddStep(d.followUps.length)
                        ? {
                            ...d,
                            followUps: [
                              ...d.followUps,
                              {
                                key: stepKey(),
                                type: option.type,
                                config: newThenConfig(option.type),
                                condition: null,
                                extra: {},
                              },
                            ],
                          }
                        : d,
                    )
                  }
                >
                  {option.label}
                </Button>
              ))}
              {!canAddStep(draft.followUps.length) ? (
                <span className={styles.help}>Up to 3 steps can follow the first.</span>
              ) : null}
            </div>
          </section>
        </div>

        <PreviewPanel state={preview} onPreview={onPreview} runAction={runAction} />
      </div>

      {phone ? <div className={styles.phoneFooter}>{actionsBar}</div> : null}

      <ConfirmDialog
        open={leaving != null}
        title="Leave without saving?"
        confirmLabel={leaving === 'builder' ? 'Open the full builder' : 'Leave without saving'}
        cancelLabel="Keep editing"
        onConfirm={() => {
          const where = leaving;
          setLeaving(null);
          if (where === 'builder') openBuilder(draft.id ?? undefined);
          else backToList(automationId);
        }}
        onCancel={() => setLeaving(null)}
      >
        {leaving === 'builder'
          ? 'Your changes here aren’t saved. The full builder opens the saved version.'
          : `Your changes to “${baseline?.name || draft.name || 'this automation'}” aren’t saved.`}
      </ConfirmDialog>

      {fileRun.dialogs}
    </div>
  );
}
