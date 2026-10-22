/**
 * The editor's draft: an automation as the editor holds it, and back.
 *
 * It edits the engine's real parts and nothing else: the trigger (Runs), the
 * one action (step 1, with its delay) and the ordered follow-up steps (2+,
 * each with an optional "only when" condition). Keys the editor doesn't show
 * ride along untouched, so saving never drops a setting another screen made.
 */

import type {
  Automation,
  AutomationPayload,
  StepCondition,
  ThenAction,
} from './-automations.types';

import { scheduleKind, TRIGGER_FOR_KIND, type ScheduleKind } from './-automations.steps';

export const MAX_THEN_STEPS = 3;

export interface ScheduleDraft {
  kind: ScheduleKind;
  interval: number;
  unit: 'minutes' | 'hours' | 'days';
  time: string;
  days: string[];
  dayOfMonth: number;
  /** IANA time zone; '' = the server's. */
  tz: string;
  /** The event trigger type, for kind 'event'. */
  eventType: string;
  conditions: StepCondition[];
  match: 'all' | 'any';
  signalName: string;
}

export interface ThenDraft {
  /** Stable React key; not saved. */
  key: string;
  type: string;
  config: Record<string, unknown>;
  condition: StepCondition | null;
  /** Anything else on the item (`match`, …), kept as it was. */
  extra: Record<string, unknown>;
}

export interface Draft {
  id: number | null;
  isSystem: boolean;
  name: string;
  group: string;
  schedule: ScheduleDraft;
  /** The trigger_config the automation had, so unknown keys survive. */
  triggerBase: Record<string, unknown>;
  triggerTypeBase: string;
  actionType: string;
  /** action_config without `delay`. */
  actionConfig: Record<string, unknown>;
  delay: number;
  followUps: ThenDraft[];
}

let keySeed = 0;
export function stepKey(): string {
  keySeed += 1;
  return `step-${keySeed}`;
}

const UNITS = ['minutes', 'hours', 'days'] as const;

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function int(value: unknown, fallback: number): number {
  const n = Number.parseInt(str(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function defaultSchedule(): ScheduleDraft {
  return {
    kind: 'interval',
    interval: 6,
    unit: 'hours',
    time: '03:00',
    days: [],
    dayOfMonth: 1,
    tz: '',
    eventType: '',
    conditions: [],
    match: 'all',
    signalName: '',
  };
}

export function scheduleFromTrigger(
  type: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
): ScheduleDraft {
  const cfg = config ?? {};
  const kind = scheduleKind(type);
  const unit = (UNITS as readonly string[]).includes(str(cfg.unit))
    ? (cfg.unit as ScheduleDraft['unit'])
    : 'hours';
  return {
    ...defaultSchedule(),
    kind,
    interval: Math.max(1, int(cfg.interval, 6)),
    unit,
    time: str(cfg.time) || '03:00',
    days: Array.isArray(cfg.days) ? (cfg.days as unknown[]).map((d) => str(d)) : [],
    dayOfMonth: Math.min(31, Math.max(1, int(cfg.day_of_month, 1))),
    tz: str(cfg.tz),
    eventType: kind === 'event' ? str(type) : '',
    conditions: Array.isArray(cfg.conditions)
      ? (cfg.conditions as StepCondition[]).map((c) => ({ ...c }))
      : [],
    match: cfg.match === 'any' ? 'any' : 'all',
    signalName: str(cfg.signal_name),
  };
}

export function thenFromItem(item: ThenAction): ThenDraft {
  const { type, config, conditions, ...extra } = item;
  const first = Array.isArray(conditions) && conditions.length ? conditions[0] : null;
  return {
    key: stepKey(),
    type: str(type),
    config: { ...config },
    condition: first
      ? { field: first.field ?? '', operator: first.operator ?? 'equals', value: first.value ?? '' }
      : null,
    extra: {
      ...extra,
      ...(Array.isArray(conditions) && conditions.length > 1
        ? { conditions: conditions.slice(1) }
        : {}),
    },
  };
}

export function draftFromAutomation(a: Automation): Draft {
  const actionConfig = { ...((a.action_config ?? {}) as Record<string, unknown>) };
  const delay = Math.max(0, int(actionConfig.delay, 0));
  delete actionConfig.delay;
  return {
    id: a.id,
    isSystem: a.is_system === true || a.is_system === 1,
    name: a.name ?? '',
    group: a.group_name ?? '',
    schedule: scheduleFromTrigger(a.trigger_type, a.trigger_config),
    triggerBase: { ...((a.trigger_config ?? {}) as Record<string, unknown>) },
    triggerTypeBase: str(a.trigger_type),
    actionType: str(a.action_type),
    actionConfig,
    delay,
    followUps: (a.then_actions ?? []).map(thenFromItem),
  };
}

export function newDraft(): Draft {
  return {
    id: null,
    isSystem: false,
    name: '',
    group: '',
    schedule: defaultSchedule(),
    triggerBase: {},
    triggerTypeBase: '',
    actionType: '',
    actionConfig: {},
    delay: 0,
    followUps: [],
  };
}

/** The parts of an Assistant draft (the preview body plus name and trigger). */
export interface AssistantDraftParts {
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  then_actions: ThenAction[];
}

/**
 * An Assistant draft as the editor holds it. On its own it's a new
 * automation; over ``base`` (an automation you have) it changes that one,
 * keeping its id, group and name. A built-in automation keeps how it starts
 * and what it does, as the editor would: only its timing, its step's options
 * and its follow-ups take the draft's.
 */
export function draftFromAssistant(d: AssistantDraftParts, base?: Draft | null): Draft {
  const actionConfig = { ...d.action_config };
  const delay = Math.max(0, int(actionConfig.delay, 0));
  delete actionConfig.delay;
  const followUps = (d.then_actions ?? []).map(thenFromItem);
  const schedule = scheduleFromTrigger(d.trigger_type, d.trigger_config);
  if (!base) {
    return {
      ...newDraft(),
      name: d.name ?? '',
      schedule,
      triggerBase: { ...d.trigger_config },
      triggerTypeBase: str(d.trigger_type),
      actionType: str(d.action_type),
      actionConfig,
      delay,
      followUps,
    };
  }
  if (base.isSystem) {
    const sameKind = schedule.kind === base.schedule.kind;
    const sameAction = str(d.action_type) === base.actionType;
    return {
      ...base,
      schedule: sameKind ? { ...schedule, eventType: base.schedule.eventType } : base.schedule,
      actionConfig: sameAction ? actionConfig : base.actionConfig,
      delay,
      followUps,
    };
  }
  return {
    ...base,
    schedule,
    triggerBase: { ...d.trigger_config },
    triggerTypeBase: str(d.trigger_type),
    actionType: str(d.action_type),
    actionConfig,
    delay,
    followUps,
  };
}

/** What's on screen in the editor, for the Assistant's context. */
export function draftToAssistant(d: Draft): AssistantDraftParts {
  const payload = draftToPayload(d);
  return {
    name: payload.name,
    trigger_type: payload.trigger_type,
    trigger_config: payload.trigger_config,
    action_type: payload.action_type,
    action_config: payload.action_config,
    then_actions: payload.then_actions,
  };
}

/** The trigger type the draft's Runs choice saves as. */
export function triggerType(s: ScheduleDraft): string {
  return s.kind === 'event' ? s.eventType : TRIGGER_FOR_KIND[s.kind];
}

/**
 * The trigger_config to save. Unchanged kinds start from the saved config
 * (unknown keys survive); a new kind starts clean, keeping the time zone
 * between the timed kinds.
 */
export function triggerConfig(d: Draft): Record<string, unknown> {
  const s = d.schedule;
  const type = triggerType(s);
  const base = type === d.triggerTypeBase ? { ...d.triggerBase } : {};
  const tz = s.tz.trim();
  const withTz = (cfg: Record<string, unknown>) => {
    if (tz) cfg.tz = tz;
    else delete cfg.tz;
    return cfg;
  };
  switch (s.kind) {
    case 'interval':
      delete base.tz;
      return { ...base, interval: Math.max(1, Math.round(s.interval)), unit: s.unit };
    case 'daily':
      return withTz({ ...base, time: s.time });
    case 'weekly':
      return withTz({ ...base, time: s.time, days: [...s.days] });
    case 'monthly':
      return withTz({ ...base, time: s.time, day_of_month: s.dayOfMonth });
    case 'event': {
      if (type === 'signal_received') return { ...base, signal_name: s.signalName.trim() };
      const conditions = s.conditions.filter((c) => (c.field ?? '').trim() && c.operator);
      const cfg: Record<string, unknown> = { ...base };
      if (conditions.length) {
        cfg.conditions = conditions.map((c) => ({
          field: c.field,
          operator: c.operator,
          value: c.value ?? '',
        }));
        cfg.match = s.match;
      } else {
        delete cfg.conditions;
        delete cfg.match;
      }
      return cfg;
    }
  }
}

export function thenToItem(t: ThenDraft): ThenAction {
  const { conditions: rest, ...extra } = t.extra as { conditions?: StepCondition[] } & Record<
    string,
    unknown
  >;
  const item: ThenAction = { ...extra, type: t.type, config: { ...t.config } };
  const first =
    t.condition && (t.condition.field ?? '').trim() && t.condition.operator ? [t.condition] : [];
  const all = [...first, ...(Array.isArray(rest) ? rest : [])];
  if (all.length) item.conditions = all;
  return item;
}

export function actionConfig(d: Draft): Record<string, unknown> {
  const cfg = { ...d.actionConfig };
  if (d.delay > 0) cfg.delay = Math.round(d.delay);
  return cfg;
}

export function draftToPayload(d: Draft): AutomationPayload {
  const payload: AutomationPayload = {
    name: d.name.trim(),
    trigger_type: triggerType(d.schedule),
    trigger_config: triggerConfig(d),
    action_type: d.actionType,
    action_config: actionConfig(d),
    then_actions: d.followUps.map(thenToItem),
  };
  if (!d.isSystem) payload.group_name = d.group.trim() || null;
  return payload;
}

/** Required fields per follow-up step, as the senders need them. */
export const THEN_REQUIRED: Record<string, { key: string; label: string }[]> = {
  discord_webhook: [{ key: 'webhook_url', label: 'the webhook URL' }],
  pushbullet: [{ key: 'access_token', label: 'the access token' }],
  telegram: [
    { key: 'bot_token', label: 'the bot token' },
    { key: 'chat_id', label: 'the chat ID' },
  ],
  ntfy: [{ key: 'topic', label: 'the topic' }],
  gotify: [
    { key: 'server', label: 'the server URL' },
    { key: 'token', label: 'the application token' },
  ],
  webhook: [{ key: 'url', label: 'the URL' }],
  fire_signal: [{ key: 'signal_name', label: 'a signal name' }],
  run_script: [{ key: 'script_name', label: 'a script' }],
};

export type DraftErrors = Record<string, string>;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What stops a save, keyed by field: `name`, `schedule.interval`,
 * `schedule.time`, `schedule.eventType`, `schedule.signalName`, `action`,
 * `then.<key>.<config key>`.
 */
export function validateDraft(d: Draft): DraftErrors {
  const errors: DraftErrors = {};
  if (!d.name.trim()) errors.name = 'Give the automation a name.';
  const s = d.schedule;
  if (s.kind === 'interval' && (!Number.isFinite(s.interval) || s.interval < 1)) {
    errors['schedule.interval'] = 'Choose how often, 1 or more.';
  }
  if (s.kind !== 'interval' && s.kind !== 'event' && !TIME_RE.test(s.time)) {
    errors['schedule.time'] = 'Write the time as hours and minutes, like 06:00.';
  }
  if (s.kind === 'event') {
    if (!s.eventType) errors['schedule.eventType'] = 'Choose what it runs after.';
    else if (s.eventType === 'signal_received' && !s.signalName.trim()) {
      errors['schedule.signalName'] = 'Name the signal it listens for.';
    }
  }
  if (!d.actionType) errors.action = 'Choose what this automation does.';
  for (const t of d.followUps) {
    for (const req of THEN_REQUIRED[t.type] ?? []) {
      if (!str(t.config[req.key]).trim()) errors[`then.${t.key}.${req.key}`] = `Add ${req.label}.`;
    }
  }
  return errors;
}

/** Whether anything that would be saved differs. */
export function draftChanged(a: Draft, b: Draft): boolean {
  return JSON.stringify(draftToPayload(a)) !== JSON.stringify(draftToPayload(b));
}

/** Default config for a newly added follow-up step. */
export function newThenConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'discord_webhook':
    case 'telegram':
      return { message: '{name} completed with status: {status}' };
    case 'pushbullet':
    case 'gotify':
      return {
        title: '{name}',
        message: 'Completed with status: {status}',
        ...(type === 'gotify' ? { priority: 5 } : {}),
      };
    case 'ntfy':
      return { title: '{name}', message: 'Completed with status: {status}', priority: '3' };
    case 'run_script':
      return { timeout: 60 };
    default:
      return {};
  }
}

/** The signal-name rule the vanilla builder applied as you type. */
export function cleanSignalName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
