/**
 * The block editor, a full page (boards 3b, 3l): one When, one Do (with
 * "after waiting N minutes") and up to three Then blocks, drawn as the engine
 * runs them. Typing "/" on the empty line adds a follow-up; Then blocks
 * reorder by dragging or from their handle's menu. The right column holds
 * the Assistant and the Preview as two tabs (Preview alone while the
 * Assistant is closed). A draft from the Assistant opens here with a note;
 * nothing runs until it's saved.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button, OptionButton, TextInput } from '@/components/form';
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
import { aiStatusQueryOptions, type DraftOffer } from '../-automations.assistant';
import { useVanillaBuilder } from '../-automations.builder';
import { getConversation, updateConversation, useConversation } from '../-automations.conversation';
import {
  actionConfig,
  draftChanged,
  draftFromAssistant,
  draftFromAutomation,
  draftToAssistant,
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
import {
  findBlock,
  intervalPhrase,
  nextPhrase,
  scheduleKind,
  WEEKDAYS,
} from '../-automations.steps';
import { ActionMenu, type MenuEntry } from './action-menu';
import { AssistantPanel } from './assistant-panel';
import styles from './automations.module.css';
import { DragHandle, SlashLine, useBlockDrag, type SlashChoice } from './block-editor';
import { ConfirmDialog } from './confirm-dialog';
import { BlockCard, DoBlock, RunsField, ThenBlock } from './editor-fields';
import { useFileStepRun } from './file-run';
import { PreviewPanel, type PreviewState } from './preview-panel';
import { useMediaQuery } from './use-narrow';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

function clockOf(time: string): [number, number] | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** "today at 06:00", "tomorrow at 06:00", "Thursday at 02:00", "on the 1st at 03:00". */
export function firstRunWords(s: ScheduleDraft, now = new Date()): string {
  if (s.kind === 'interval') {
    return `about ${intervalPhrase(s.interval, s.unit)
      .replace(/^Every/, '')
      .trim()} after you save`;
  }
  const hm = clockOf(s.time);
  if (!hm) return 'once a time is set';
  const at = (d: Date) => {
    const x = new Date(d);
    x.setHours(hm[0], hm[1], 0, 0);
    return x;
  };
  const dayWords = (d: Date) => {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const that = new Date(d);
    that.setHours(0, 0, 0, 0);
    const diff = Math.round((that.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    return d.toLocaleDateString([], { weekday: 'long' });
  };
  if (s.kind === 'monthly') {
    const suffix = (n: number) =>
      n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
    return `on the ${s.dayOfMonth}${suffix(s.dayOfMonth)} at ${s.time}`;
  }
  for (let add = 0; add < 8; add += 1) {
    const day = new Date(now.getTime() + add * 86_400_000);
    const when = at(day);
    if (when.getTime() <= now.getTime()) continue;
    const code = WEEKDAYS[(day.getDay() + 6) % 7].value;
    if (s.kind === 'weekly' && s.days.length && !s.days.includes(code)) continue;
    return `${dayWords(day)} at ${s.time}`;
  }
  return `at ${s.time}`;
}

function whenNote(draft: Draft, saved: Automation | undefined): string {
  const s = draft.schedule;
  if (s.kind === 'event') {
    return 'It runs each time this happens. If the same job is still running then, this run is skipped.';
  }
  const sameSchedule =
    saved &&
    scheduleKind(saved.trigger_type) === s.kind &&
    JSON.stringify(draftToPayload(draft).trigger_config) ===
      JSON.stringify(saved.trigger_config ?? {});
  const next =
    sameSchedule && saved && (saved.enabled === true || saved.enabled === 1)
      ? nextPhrase(saved)
      : null;
  const lead = next
    ? `${next.charAt(0).toUpperCase()}${next.slice(1)}.`
    : `First run ${firstRunWords(s)}.`;
  return draft.isSystem
    ? lead
    : `${lead} Or choose “After something happens” to start it from an event or a signal.`;
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
        <span aria-current="page">{isNew ? 'New automation' : 'Edit'}</span>
      </nav>
      <header className={styles.header}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>
            <span className={styles.wide}>
              One When, one Do, up to three Then. Type / on the empty line to add a follow-up.
            </span>
          </p>
        </div>
        {actions ? <div className={styles.headActions}>{actions}</div> : null}
      </header>
    </>
  );
}

export function AutomationEditorPage({
  automationId,
  fromAssistant = false,
}: {
  automationId: number | null;
  /** Opened from an Assistant draft (`?from=assistant`). */
  fromAssistant?: boolean;
}) {
  useReactPageShell('automations');
  const { profileId, isAdmin } = useProfile();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const phone = useMediaQuery();
  const isNew = automationId == null;

  const savedQuery = useQuery({ ...automationQueryOptions(automationId ?? 0), enabled: !isNew });
  const blocksQuery = useQuery(automationBlocksQueryOptions());
  const listQuery = useQuery(automationsListQueryOptions(profileId));
  const statusQuery = useQuery(aiStatusQueryOptions(profileId));
  const conversation = useConversation(profileId);
  const groups = useMemo(
    () => groupNames(forMusicSide(readAutomationsList(listQuery.data))),
    [listQuery.data],
  );
  const blocks = blocksQuery.data;
  const saved = savedQuery.data;

  // A draft handed over by the Assistant ("Open in the editor"), taken once.
  const [handed] = useState<DraftOffer | null>(() => {
    if (!fromAssistant) return null;
    const offer = getConversation(profileId).pendingDraft;
    if (offer) updateConversation(profileId, (s) => ({ ...s, pendingDraft: null }));
    return offer;
  });
  const [fromDraft, setFromDraft] = useState(Boolean(handed));

  const [draft, setDraft] = useState<Draft | null>(() =>
    isNew ? (handed ? draftFromAssistant(handed.draft) : newDraft()) : null,
  );
  const [baseline, setBaseline] = useState<Draft | null>(() => (isNew ? newDraft() : null));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const [leaving, setLeaving] = useState<null | 'list' | 'builder'>(null);
  const [replaceWith, setReplaceWith] = useState<DraftOffer | null>(null);
  const [sideTab, setSideTab] = useState<'assistant' | 'preview'>(() =>
    getConversation(profileId).open ? 'assistant' : 'preview',
  );
  const loadedFor = useRef<number | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const nameId = useId();
  const groupId = useId();
  const groupListId = useId();
  const whenId = useId();

  // Start from the saved automation once it arrives (and again after the
  // full builder changed it). An Assistant draft for it goes on top.
  useEffect(() => {
    if (!saved || isNew) return;
    const stamp = saved.updated_at ? Date.parse(saved.updated_at) || saved.id : saved.id;
    if (loadedFor.current === stamp) return;
    const first = loadedFor.current == null;
    loadedFor.current = stamp;
    const fresh = draftFromAutomation(saved);
    setDraft(first && handed ? draftFromAssistant(handed.draft, fresh) : fresh);
    setBaseline(draftFromAutomation(saved));
  }, [saved, isNew, handed]);

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
  const reorder = (from: number, to: number) =>
    setDraft((d) => {
      if (!d || from === to) return d;
      const next = [...d.followUps];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...d, followUps: next };
    });
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
  const drag = useBlockDrag(draft?.followUps ?? [], reorder);

  // Errors refresh as you fix them, once a save has been tried.
  useEffect(() => {
    if (tried && draft) setErrors(validateDraft(draft));
  }, [draft, tried]);

  const openBuilder = useVanillaBuilder(() => {
    loadedFor.current = null;
    void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_QUERY_KEY });
  });

  const save = useMutation({
    mutationFn: (d: Draft) =>
      saveAutomation(d.id, {
        ...draftToPayload(d),
        // counts on Settings → AI's "Drafts saved"
        ...(fromDraft ? { assistant_draft: true } : {}),
      }),
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

  const previewParts = (d: Pick<Draft, 'id'>, parts: ReturnType<typeof draftToAssistant>) => {
    setPreview({ kind: 'loading' });
    setSideTab('preview');
    previewAutomation(d.id, {
      action_type: parts.action_type,
      action_config: parts.action_config,
      then_actions: parts.then_actions,
    })
      .then((result) => {
        setPreview({ kind: 'done', result });
        if (d.id != null && result.recorded) {
          void queryClient.invalidateQueries({
            queryKey: automationHistoryQueryOptions(d.id).queryKey,
          });
        }
      })
      .catch((error: Error) => setPreview({ kind: 'error', message: error.message }));
  };

  const onPreview = () => {
    if (!draft) return;
    if (!draft.actionType) {
      setTried(true);
      setErrors(validateDraft(draft));
      return;
    }
    previewParts(draft, {
      ...draftToAssistant(draft),
      action_config: actionConfig(draft),
    });
  };

  const onCancel = () => (dirty ? setLeaving('list') : backToList(automationId));

  const openAssistant = (prefill?: string) => {
    conversation.set({
      open: true,
      ...(prefill != null ? { composer: prefill } : {}),
    });
    setSideTab('assistant');
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };
  const closeAssistant = () => {
    conversation.set({ open: false });
    setSideTab('preview');
  };

  const applyOffer = (offer: DraftOffer) => {
    setDraft((d) => {
      const base = d && !isNew ? (baseline ?? d) : null;
      const next = draftFromAssistant(offer.draft, base);
      // the draft replaces the blocks; an existing automation keeps the name
      // and group on screen
      if (!d) return next;
      return isNew ? { ...next, group: d.group } : { ...next, name: d.name, group: d.group };
    });
    setFromDraft(true);
    setTried(false);
    setErrors({});
    toast('The draft is in the editor. Nothing is saved until you save it.', 'success');
  };

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
            : 'SYNCHRO.S didn’t answer. The automation is safe and keeps running as set; this is a display problem.'}
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
  const panelOpen = conversation.state.open;

  const headerMenu: MenuEntry[] = [
    {
      key: 'builder',
      label: 'Open in the full builder',
      onSelect: () => (dirty ? setLeaving('builder') : openBuilder(draft.id ?? undefined)),
    },
  ];

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
        {phone ? 'Preview' : 'Preview a run'}
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

  const thenMenu = (key: string, index: number): MenuEntry[] => [
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
      disabled: draft.followUps.length >= 3,
      onSelect: () =>
        setDraft((d) => {
          if (!d || d.followUps.length >= 3) return d;
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

  const onSlash = (choice: SlashChoice) => {
    if (choice.kind === 'assistant') {
      openAssistant(`Add a follow-up that ${choice.text}`.trimEnd() + (choice.text ? '' : ' '));
      return;
    }
    setDraft((d) =>
      d && d.followUps.length < 3
        ? {
            ...d,
            followUps: [
              ...d.followUps,
              {
                key: stepKey(),
                type: choice.type,
                config: newThenConfig(choice.type),
                condition: null,
                extra: {},
              },
            ],
          }
        : d,
    );
  };

  const assistantContext = () => ({
    page: 'editor' as const,
    automation_id: draft.id,
    draft: draftToAssistant(draft),
  });
  const assistant = (variant: 'editor' | 'sheet') => (
    <AssistantPanel
      variant={variant}
      profileId={profileId}
      isAdmin={isAdmin}
      status={statusQuery.data}
      statusLoading={statusQuery.isPending}
      blocks={blocks}
      context={assistantContext}
      composerRef={composerRef}
      onOpenDraft={(offer) => {
        if (dirty || fromDraft) setReplaceWith(offer);
        else applyOffer(offer);
        if (variant === 'sheet') closeAssistant();
      }}
      onPreviewDraft={(offer) => {
        if (variant === 'sheet') closeAssistant();
        previewParts(draft, offer.draft);
      }}
      onClose={closeAssistant}
      tabs={
        variant === 'editor' ? (
          <div className={styles.sideTabs} role="tablist" aria-label="Assistant and Preview">
            <OptionButton
              role="tab"
              selected={sideTab === 'assistant'}
              aria-selected={sideTab === 'assistant'}
              onClick={() => setSideTab('assistant')}
            >
              Assistant
            </OptionButton>
            <OptionButton
              role="tab"
              selected={false}
              aria-selected={false}
              onClick={() => setSideTab('preview')}
            >
              Preview
            </OptionButton>
          </div>
        ) : undefined
      }
    />
  );

  const previewPanel = <PreviewPanel state={preview} onPreview={onPreview} runAction={runAction} />;

  let side: React.ReactNode = previewPanel;
  if (!phone && panelOpen) {
    side =
      sideTab === 'assistant' ? (
        assistant('editor')
      ) : (
        <div className={styles.sideStack}>
          <div className={styles.sideTabsBar}>
            <div className={styles.sideTabs} role="tablist" aria-label="Assistant and Preview">
              <OptionButton
                role="tab"
                selected={false}
                aria-selected={false}
                onClick={() => setSideTab('assistant')}
              >
                Assistant
              </OptionButton>
              <OptionButton role="tab" selected aria-selected>
                Preview
              </OptionButton>
            </div>
            <button
              type="button"
              className={styles.iconButton}
              data-variant="bare"
              aria-label="Close the Assistant"
              onClick={closeAssistant}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {previewPanel}
        </div>
      );
  }

  return (
    <div className={styles.page} data-testid="automation-editor" data-editor="true">
      <EditorHeader
        title={isNew ? draft.name.trim() || 'New automation' : baseline?.name || draft.name}
        isNew={isNew}
        onBack={onCancel}
        actions={
          phone ? (
            <ActionMenu label="More for this automation" entries={headerMenu} />
          ) : (
            <>
              {panelOpen ? null : (
                <Button size="lg" onClick={() => openAssistant()}>
                  Assistant
                </Button>
              )}
              {actionsBar}
              <ActionMenu label="More for this automation" entries={headerMenu} />
            </>
          )
        }
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
          {fromDraft ? (
            <Notice tone="info" data-testid="draft-notice">
              <strong>Draft from the Assistant.</strong>{' '}
              {phone
                ? 'Nothing runs until you save it.'
                : 'Change or remove any block, preview a run, then save. Nothing runs until you save it.'}
            </Notice>
          ) : null}
          <section className={styles.editorCard} aria-label="Name and group">
            <div className={styles.nameRow}>
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
                  <p className={styles.help}>Built in: its name stays as SYNCHRO.S set it.</p>
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
                    placeholder="None"
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
          </section>

          <ol className={styles.blocks} aria-label="Blocks">
            <BlockCard label="When" labelId={whenId} testId="block-when">
              <div className={styles.blockStack}>
                <RunsField
                  schedule={draft.schedule}
                  onChange={updateSchedule}
                  blocks={blocks}
                  locked={draft.isSystem}
                  errors={errors}
                  phone={phone}
                  variant="select"
                />
                <p className={styles.help}>{whenNote(draft, saved)}</p>
              </div>
            </BlockCard>
            <DoBlock
              actionType={draft.actionType}
              config={draft.actionConfig}
              delay={draft.delay}
              blocks={blocks}
              locked={draft.isSystem && Boolean(baseline?.actionType)}
              error={errors.action}
              isAdmin={isAdmin}
              onType={(type) => update({ actionType: type, actionConfig: {} })}
              onConfig={(patch) => update({ actionConfig: { ...draft.actionConfig, ...patch } })}
              onDelay={(delay) => update({ delay })}
            />
            {draft.followUps.map((step, index) => (
              <ThenBlock
                key={step.key}
                step={step}
                index={index + 1}
                triggerVariables={triggerDef?.variables ?? []}
                errors={errors}
                isAdmin={isAdmin}
                onChange={(patch) => updateThen(step.key, patch)}
                menu={thenMenu(step.key, index)}
                dragProps={drag.propsFor(step.key)}
                handle={
                  <DragHandle
                    index={index + 1}
                    count={draft.followUps.length}
                    onMove={(by) => moveThen(step.key, by)}
                    onDragStart={() => drag.start(step.key)}
                    onDragEnd={drag.end}
                  />
                }
              />
            ))}
            <SlashLine
              count={draft.followUps.length}
              isAdmin={isAdmin}
              phone={phone}
              assistant={Boolean(statusQuery.data?.can_use)}
              onPick={onSlash}
            />
          </ol>
        </div>

        <div
          className={styles.editorSide}
          data-panel={!phone && panelOpen ? 'assistant' : undefined}
        >
          {side}
        </div>
      </div>

      {phone ? (
        <div className={styles.phoneFooter} data-blocks="true">
          <Button
            size="lg"
            variant="primary"
            className={styles.phoneSave}
            onClick={onSave}
            disabled={save.isPending}
            focusableWhenDisabled
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <div className={styles.phoneFooterRow}>
            <Button
              size="lg"
              onClick={onPreview}
              disabled={preview.kind === 'loading'}
              focusableWhenDisabled
            >
              Preview
            </Button>
            <Button size="lg" onClick={() => openAssistant()}>
              Assistant
            </Button>
            <Button size="lg" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {phone && panelOpen ? <div className={styles.sheet}>{assistant('sheet')}</div> : null}

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

      <ConfirmDialog
        open={replaceWith != null}
        title="Put the draft in the editor?"
        confirmLabel="Use the draft"
        cancelLabel="Keep what’s here"
        onConfirm={() => {
          const offer = replaceWith;
          setReplaceWith(null);
          if (offer) applyOffer(offer);
        }}
        onCancel={() => setReplaceWith(null)}
      >
        It replaces the blocks you have here. Nothing is saved until you save.
      </ConfirmDialog>

      {fileRun.dialogs}
    </div>
  );
}
