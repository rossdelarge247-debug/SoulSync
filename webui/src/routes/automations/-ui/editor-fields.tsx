/**
 * The editor's pieces: the Runs choice (the engine's real triggers), step 1
 * (the action and its options) and the follow-up steps, each written as a
 * sentence with its choices inside it.
 */

import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';

import { Button, OptionButton, Select, TextArea, TextInput } from '@/components/form';

import type {
  AutomationBlockDef,
  AutomationBlocks,
  BlockConfigField,
  StepCondition,
} from '../-automations.types';

import {
  mirroredPlaylistsQueryOptions,
  scriptsQueryOptions,
  testNotification,
} from '../-automations.api';
import {
  cleanSignalName,
  MAX_THEN_STEPS,
  type DraftErrors,
  type ScheduleDraft,
  type ThenDraft,
} from '../-automations.draft';
import { PLAN_GATED_ACTIONS } from '../-automations.helpers';
import {
  findBlock,
  intervalPhrase,
  NOTIFY_TYPES,
  OPERATORS,
  operatorWords,
  THEN_LABELS,
  WEEKDAYS,
  type ScheduleKind,
  text,
} from '../-automations.steps';
import { ActionMenu, type MenuEntry } from './action-menu';
import styles from './automations.module.css';

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className={styles.fieldError} role="alert">
      {message}
    </p>
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────

const KIND_ORDER: ScheduleKind[] = ['interval', 'daily', 'weekly', 'monthly', 'event'];

export function kindLabel(kind: ScheduleKind, s: ScheduleDraft, selected: boolean): string {
  switch (kind) {
    case 'interval':
      return selected ? intervalPhrase(s.interval, s.unit) : 'Every…';
    case 'daily':
      return selected ? `Daily at ${s.time}` : 'Daily at…';
    case 'weekly':
      return 'Weekly…';
    case 'monthly':
      return 'Monthly…';
    default:
      return 'After something happens';
  }
}

const TIMED_TRIGGERS = new Set(['schedule', 'daily_time', 'weekly_time', 'monthly_time']);

export function eventTriggers(blocks: AutomationBlocks | undefined): AutomationBlockDef[] {
  return (blocks?.triggers ?? []).filter((t) => !TIMED_TRIGGERS.has(t.type));
}

function grouped(
  defs: AutomationBlockDef[],
  order: string[] | undefined,
): [string, AutomationBlockDef[]][] {
  const map = new Map<string, AutomationBlockDef[]>();
  for (const def of defs) {
    const key = def.category || 'Other';
    map.set(key, [...(map.get(key) ?? []), def]);
  }
  const ranked = order ?? [];
  return [...map.entries()].sort(
    (a, b) =>
      (ranked.indexOf(a[0]) + 1 || 99) - (ranked.indexOf(b[0]) + 1 || 99) ||
      a[0].localeCompare(b[0]),
  );
}

function sentenceCase(label: string): string {
  if (!label) return label;
  const words = label.split(' ');
  return words
    .map((w, i) =>
      i === 0 ? w : /^[A-Z][a-z]+$/.test(w) && !KEEP_CASE.has(w) ? w.toLowerCase() : w,
    )
    .join(' ');
}

const KEEP_CASE = new Set([
  'Spotify',
  'Soulseek',
  'Beatport',
  'Discord',
  'Telegram',
  'Pushbullet',
  'Gotify',
  'Last.fm',
  'ListenBrainz',
  'Plex',
]);

function TimeZoneField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <label className={styles.inlineField} htmlFor={id}>
      <span className={styles.inlineLabel}>Time zone</span>
      <TextInput
        id={id}
        className={styles.tzInput}
        value={value}
        placeholder="The server's (blank)"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ConditionsEditor({
  fields,
  conditions,
  match,
  onChange,
  onMatch,
}: {
  fields: string[];
  conditions: StepCondition[];
  match: 'all' | 'any';
  onChange: (next: StepCondition[]) => void;
  onMatch: (next: 'all' | 'any') => void;
}) {
  const set = (index: number, patch: Partial<StepCondition>) =>
    onChange(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  return (
    <div className={styles.conditions}>
      {conditions.map((c, index) => (
        <div key={index} className={styles.sentence}>
          <span className={styles.word}>
            {index === 0 ? 'Only if' : match === 'any' ? 'or' : 'and'}
          </span>
          <Select
            size="lg"
            aria-label={`Condition ${index + 1}: what to check`}
            value={c.field ?? ''}
            onChange={(e) => set(index, { field: e.target.value })}
          >
            {fields.map((f) => (
              <option key={f} value={f}>
                {f.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            size="lg"
            aria-label={`Condition ${index + 1}: how`}
            value={c.operator ?? 'contains'}
            onChange={(e) => set(index, { operator: e.target.value })}
          >
            {OPERATORS.map((op) => (
              <option key={op} value={op}>
                {operatorWords(op)}
              </option>
            ))}
          </Select>
          <TextInput
            className={styles.sentenceInput}
            aria-label={`Condition ${index + 1}: value`}
            value={c.value ?? ''}
            onChange={(e) => set(index, { value: e.target.value })}
          />
          <Button
            size="lg"
            variant="ghost"
            onClick={() => onChange(conditions.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className={styles.sentence}>
        <Button
          size="lg"
          onClick={() =>
            onChange([...conditions, { field: fields[0] ?? '', operator: 'contains', value: '' }])
          }
        >
          {conditions.length ? 'Add another condition' : 'Add a condition'}
        </Button>
        {conditions.length > 1 ? (
          <Select
            size="lg"
            aria-label="Match"
            value={match}
            onChange={(e) => onMatch(e.target.value as 'all' | 'any')}
          >
            <option value="all">All of them must match</option>
            <option value="any">Any of them can match</option>
          </Select>
        ) : null}
      </div>
    </div>
  );
}

export function RunsField({
  schedule: s,
  onChange,
  blocks,
  locked,
  errors,
  phone,
}: {
  schedule: ScheduleDraft;
  onChange: (patch: Partial<ScheduleDraft>) => void;
  blocks?: AutomationBlocks;
  /** Built-in automations keep how they're started. */
  locked: boolean;
  errors: DraftErrors;
  phone: boolean;
}) {
  const ids = {
    interval: useId(),
    unit: useId(),
    time: useId(),
    day: useId(),
    event: useId(),
    signal: useId(),
  };
  const events = eventTriggers(blocks);
  const eventDef = events.find((e) => e.type === s.eventType);
  const pick = (kind: ScheduleKind) => {
    if (kind === s.kind || locked) return;
    onChange({ kind, ...(kind === 'event' && !s.eventType ? { eventType: '' } : {}) });
  };
  const timeField = (
    <label className={styles.inlineField} htmlFor={ids.time}>
      <span className={styles.inlineLabel}>
        {s.kind === 'weekly' || s.kind === 'monthly' ? 'at' : 'At'}
      </span>
      <TextInput
        id={ids.time}
        type="time"
        className={styles.timeInput}
        value={s.time}
        aria-invalid={errors['schedule.time'] ? true : undefined}
        aria-describedby={errors['schedule.time'] ? `${ids.time}-err` : undefined}
        onChange={(event) => onChange({ time: event.target.value })}
      />
    </label>
  );

  return (
    <fieldset className={styles.runsField}>
      <legend className={styles.fieldLabel}>Runs</legend>
      {phone ? (
        <Select
          size="lg"
          aria-label="Runs"
          value={s.kind}
          disabled={locked}
          onChange={(e) => pick(e.target.value as ScheduleKind)}
        >
          {KIND_ORDER.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(kind, s, kind === s.kind)}
            </option>
          ))}
        </Select>
      ) : (
        <div className={styles.kindButtons} role="group" aria-label="Runs">
          {KIND_ORDER.map((kind) => (
            <OptionButton
              key={kind}
              selected={s.kind === kind}
              disabled={locked && s.kind !== kind}
              onClick={() => pick(kind)}
            >
              {kindLabel(kind, s, s.kind === kind)}
            </OptionButton>
          ))}
        </div>
      )}
      {locked ? (
        <p className={styles.help}>
          Built-in automations keep how they start; you can change the timing.
        </p>
      ) : null}

      <div className={styles.runsDetail}>
        {s.kind === 'interval' ? (
          <div className={styles.sentence}>
            <label className={styles.inlineField} htmlFor={ids.interval}>
              <span className={styles.inlineLabel}>Every</span>
              <TextInput
                id={ids.interval}
                type="number"
                min={1}
                className={styles.numberInput}
                value={String(s.interval)}
                aria-invalid={errors['schedule.interval'] ? true : undefined}
                onChange={(event) =>
                  onChange({ interval: Number.parseInt(event.target.value, 10) || 0 })
                }
              />
            </label>
            <Select
              size="lg"
              aria-label="Unit"
              value={s.unit}
              onChange={(e) => onChange({ unit: e.target.value as ScheduleDraft['unit'] })}
            >
              <option value="minutes">{s.interval === 1 ? 'minute' : 'minutes'}</option>
              <option value="hours">{s.interval === 1 ? 'hour' : 'hours'}</option>
              <option value="days">{s.interval === 1 ? 'day' : 'days'}</option>
            </Select>
          </div>
        ) : null}
        {s.kind === 'daily' ? (
          <div className={styles.sentence}>
            {timeField}
            <TimeZoneField value={s.tz} onChange={(tz) => onChange({ tz })} />
          </div>
        ) : null}
        {s.kind === 'weekly' ? (
          <>
            <div className={styles.dayButtons} role="group" aria-label="Days">
              {WEEKDAYS.map((d) => (
                <OptionButton
                  key={d.value}
                  selected={s.days.includes(d.value)}
                  aria-label={d.long}
                  onClick={() =>
                    onChange({
                      days: s.days.includes(d.value)
                        ? s.days.filter((x) => x !== d.value)
                        : [...s.days, d.value],
                    })
                  }
                >
                  {d.short}
                </OptionButton>
              ))}
            </div>
            <div className={styles.sentence}>
              {timeField}
              <TimeZoneField value={s.tz} onChange={(tz) => onChange({ tz })} />
            </div>
            {s.days.length === 0 ? (
              <p className={styles.help}>No days picked means every day.</p>
            ) : null}
          </>
        ) : null}
        {s.kind === 'monthly' ? (
          <div className={styles.sentence}>
            <label className={styles.inlineField} htmlFor={ids.day}>
              <span className={styles.inlineLabel}>On day</span>
              <TextInput
                id={ids.day}
                type="number"
                min={1}
                max={31}
                className={styles.numberInput}
                value={String(s.dayOfMonth)}
                onChange={(event) =>
                  onChange({
                    dayOfMonth: Math.min(
                      31,
                      Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                    ),
                  })
                }
              />
            </label>
            {timeField}
            <TimeZoneField value={s.tz} onChange={(tz) => onChange({ tz })} />
          </div>
        ) : null}
        {s.kind === 'monthly' ? (
          <p className={styles.help}>In a shorter month it runs on the last day.</p>
        ) : null}
        {s.kind === 'event' ? (
          <>
            <div className={styles.sentence}>
              <Select
                size="lg"
                id={ids.event}
                aria-label="What it runs after"
                value={s.eventType}
                disabled={locked}
                aria-invalid={errors['schedule.eventType'] ? true : undefined}
                onChange={(e) =>
                  onChange({ eventType: e.target.value, conditions: [], signalName: '' })
                }
              >
                <option value="" disabled>
                  Choose what it runs after…
                </option>
                {s.eventType && !eventDef ? (
                  <option value={s.eventType}>{s.eventType}</option>
                ) : null}
                {grouped(events, blocks?.category_order).map(([category, defs]) => (
                  <optgroup key={category} label={category}>
                    {defs.map((d) => (
                      <option key={d.type} value={d.type}>
                        {sentenceCase(d.label ?? d.type)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            {eventDef?.description ? <p className={styles.help}>{eventDef.description}</p> : null}
            {s.eventType === 'signal_received' ? (
              <div className={styles.sentence}>
                <label className={styles.inlineField} htmlFor={ids.signal}>
                  <span className={styles.inlineLabel}>Signal</span>
                  <TextInput
                    id={ids.signal}
                    className={styles.sentenceInput}
                    value={s.signalName}
                    list={`${ids.signal}-list`}
                    placeholder="libraryReady"
                    aria-invalid={errors['schedule.signalName'] ? true : undefined}
                    onChange={(event) => onChange({ signalName: event.target.value })}
                    onBlur={(event) =>
                      onChange({ signalName: cleanSignalName(event.target.value) })
                    }
                  />
                </label>
                <datalist id={`${ids.signal}-list`}>
                  {(blocks?.known_signals ?? []).map((sig) => (
                    <option key={sig} value={sig} />
                  ))}
                </datalist>
              </div>
            ) : null}
            {eventDef?.has_conditions && eventDef.condition_fields?.length ? (
              <ConditionsEditor
                fields={eventDef.condition_fields}
                conditions={s.conditions}
                match={s.match}
                onChange={(conditions) => onChange({ conditions })}
                onMatch={(match) => onChange({ match })}
              />
            ) : null}
          </>
        ) : null}
        <FieldError id={`${ids.interval}-err`} message={errors['schedule.interval']} />
        <FieldError id={`${ids.time}-err`} message={errors['schedule.time']} />
        <FieldError id={`${ids.event}-err`} message={errors['schedule.eventType']} />
        <FieldError id={`${ids.signal}-err`} message={errors['schedule.signalName']} />
      </div>
    </fieldset>
  );
}

// ── step 1: the action ──────────────────────────────────────────────────────

/** Short names for the step-1 choice; the rest use the block's label. */
const ACTION_CHOICES: Record<string, string> = {
  process_wishlist: 'Search for what’s on Wanted',
  scan_watchlist: 'Check followed artists',
  scan_watchlist_podcasts: 'Check followed podcasts',
  scan_library: 'Rescan the media server',
  start_database_update: 'Update the library database',
  refresh_mirrored: 'Refresh a mirrored playlist',
  sync_playlist: 'Sync a mirrored playlist',
  discover_playlist: 'Identify playlist tracks',
  playlist_pipeline: 'Mirror a playlist end to end',
  run_duplicate_cleaner: 'Tidy up: duplicate files',
  clear_quarantine: 'Tidy up: clear the quarantine',
  library_cleanup: 'Tidy up: quarantine and recycle bin',
  full_cleanup: 'Tidy up: full clean-up',
  deep_scan_library: 'Deep Scan the library',
  apply_quality_upgrades: 'Upgrade quality',
  start_quality_scan: 'Look for quality upgrades',
  backup_database: 'Back up the database',
  notify_only: 'Only notify',
  run_script: 'Run a script',
};

export function actionChoiceLabel(def: AutomationBlockDef): string {
  return ACTION_CHOICES[def.type] ?? sentenceCase(def.label ?? def.type);
}

/** What step 1 does, where the block's own description doesn't say it plainly. */
const ACTION_HELP: Record<string, string> = {
  process_wishlist:
    'Searches the Wanted tracks that are due, albums and singles in turn. Tracks that keep failing wait longer between tries (Wanted → How often to try again).',
  scan_watchlist:
    'Checks every artist and label you follow for releases since the last check, and adds the new tracks to Wanted.',
  scan_library: 'Asks your media server to rescan its music library.',
  start_database_update: 'Reads your media server’s library into SoulSync’s database.',
  notify_only: 'Does nothing itself; the steps after it run every time it starts.',
};

function actionHelp(type: string, def: AutomationBlockDef | undefined, delay: number): string {
  const what = ACTION_HELP[type] ?? def?.description ?? '';
  const wait = delay > 0 ? ' Run now starts straight away; only scheduled runs wait.' : '';
  return `${what}${wait}`.trim();
}

/** Options a step stores that its handler never reads; not shown. */
const IGNORED_FIELDS: Record<string, string[]> = {
  // the Wanted search takes albums and singles in turn by itself
  process_wishlist: ['category'],
};

function fieldValue(config: Record<string, unknown>, field: BlockConfigField): unknown {
  return config[field.key] ?? field.default;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string')
    return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
  return Boolean(value);
}

function PlaylistSelect({
  value,
  disabled,
  refreshOnly,
  onChange,
}: {
  value: string;
  disabled: boolean;
  refreshOnly: boolean;
  onChange: (v: string) => void;
}) {
  const query = useQuery(mirroredPlaylistsQueryOptions());
  const playlists = (query.data?.playlists ?? []).filter((p) => {
    if (!refreshOnly) return true;
    if (p.source === 'file' || p.source === 'beatport') return false;
    return !(p.source === 'spotify' && !query.data?.spotifyAuthenticated);
  });
  return (
    <Select
      size="lg"
      aria-label="Playlist"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{query.isPending ? 'Loading playlists…' : 'Choose a playlist'}</option>
      {playlists.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

function ScriptSelect({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const query = useQuery(scriptsQueryOptions());
  const scripts = query.data ?? [];
  return (
    <Select
      size="lg"
      aria-label="Script"
      value={value}
      aria-invalid={invalid ? true : undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">
        {query.isPending
          ? 'Loading scripts…'
          : scripts.length
            ? 'Choose a script'
            : 'No scripts in the scripts folder'}
      </option>
      {value && !scripts.some((s) => s.name === value) ? (
        <option value={value}>{value}</option>
      ) : null}
      {scripts.map((s) => (
        <option key={s.name} value={s.name}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

/** One option of step 1, from the block's config_fields. */
function OptionField({
  field,
  config,
  onChange,
  actionType,
}: {
  field: BlockConfigField;
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  actionType: string;
}) {
  const id = useId();
  const value = fieldValue(config, field);
  if (field.type === 'checkbox') {
    const isConfirm = field.key === 'confirm' && PLAN_GATED_ACTIONS.has(actionType);
    const label = isConfirm
      ? 'Act without a preview on scheduled runs'
      : (field.label ?? field.key);
    return (
      <div className={styles.option}>
        <label className={styles.checkRow} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={truthy(value)}
            onChange={(e) => onChange({ [field.key]: e.target.checked })}
          />
          <span>{label}</span>
        </label>
        {isConfirm ? (
          <p className={styles.help} data-tone={truthy(value) ? 'warning' : undefined}>
            {truthy(value)
              ? 'Scheduled runs move or delete files without asking. Run now still shows the list and asks first.'
              : 'Off: scheduled runs only report what they would move or delete. Run now shows the list and asks first.'}
          </p>
        ) : null}
      </div>
    );
  }
  if (field.type === 'personalized_playlist_select') {
    const kinds = Array.isArray(value) ? value.length : 0;
    return (
      <p className={styles.help}>
        {kinds === 1
          ? '1 personalized playlist is chosen.'
          : `${kinds} personalized playlists are chosen.`}{' '}
        They’re picked in the full builder (this step’s ⋮ menu).
      </p>
    );
  }
  const label = field.label ?? field.key;
  let control: ReactNode;
  if (field.type === 'number') {
    control = (
      <TextInput
        id={id}
        type="number"
        className={styles.numberInput}
        min={field.min}
        max={field.max}
        value={text(value)}
        onChange={(e) =>
          onChange({ [field.key]: e.target.value === '' ? '' : Number(e.target.value) })
        }
      />
    );
  } else if (field.type === 'time') {
    control = (
      <TextInput
        id={id}
        type="time"
        className={styles.timeInput}
        value={text(value, '03:00')}
        onChange={(e) => onChange({ [field.key]: e.target.value })}
      />
    );
  } else {
    control = (
      <TextInput
        id={id}
        className={styles.sentenceInput}
        value={text(value)}
        placeholder={field.placeholder}
        onChange={(e) => onChange({ [field.key]: e.target.value })}
      />
    );
  }
  return (
    <div className={styles.option}>
      <label className={styles.inlineField} htmlFor={id}>
        <span className={styles.inlineLabel}>{label}</span>
        {control}
      </label>
      {field.description ? <p className={styles.help}>{field.description}</p> : null}
    </div>
  );
}

export function ActionStep({
  actionType,
  config,
  delay,
  blocks,
  locked,
  error,
  onType,
  onConfig,
  onDelay,
  menu,
}: {
  actionType: string;
  config: Record<string, unknown>;
  delay: number;
  blocks?: AutomationBlocks;
  locked: boolean;
  error?: string;
  onType: (type: string) => void;
  onConfig: (patch: Record<string, unknown>) => void;
  onDelay: (minutes: number) => void;
  menu: MenuEntry[];
}) {
  const ids = { type: useId(), delay: useId(), script: useId(), timeout: useId() };
  const def = findBlock(blocks, 'actions', actionType);
  const ignored = new Set(IGNORED_FIELDS[actionType] ?? []);
  const fields = (def?.config_fields ?? []).filter((f) => !ignored.has(f.key));
  const inline = fields.filter((f) => f.type === 'select' || f.type === 'mirrored_playlist_select');
  const below = fields.filter((f) => !inline.includes(f));
  const actions = blocks?.actions ?? [];
  const all = truthy(config.all);

  return (
    <li className={styles.step} data-testid="step-1">
      <span className={styles.stepNumber} aria-hidden="true">
        1
      </span>
      <span className={styles.stepTitle} aria-hidden="true">
        {def ? actionChoiceLabel(def) : 'What it does'}
      </span>
      <div className={styles.stepBody}>
        <div className={styles.sentence}>
          <Select
            size="lg"
            id={ids.type}
            aria-label="Step 1: what it does"
            value={actionType}
            disabled={locked}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${ids.type}-err` : undefined}
            onChange={(e) => onType(e.target.value)}
          >
            <option value="" disabled>
              Choose what it does…
            </option>
            {actionType && !def ? <option value={actionType}>{actionType}</option> : null}
            {grouped(actions, blocks?.category_order).map(([category, defs]) => (
              <optgroup key={category} label={category}>
                {defs.map((d) => (
                  <option key={d.type} value={d.type}>
                    {actionChoiceLabel(d)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          {inline.map((field) =>
            field.type === 'mirrored_playlist_select' ? (
              <PlaylistSelect
                key={field.key}
                value={text(config.playlist_id)}
                disabled={all}
                refreshOnly={actionType === 'refresh_mirrored'}
                onChange={(v) => onConfig({ playlist_id: v })}
              />
            ) : (
              <Select
                key={field.key}
                size="lg"
                aria-label={field.label ?? field.key}
                value={text(fieldValue(config, field))}
                onChange={(e) => onConfig({ [field.key]: e.target.value })}
              >
                {(field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ),
          )}
          {actionType === 'run_script' ? (
            <ScriptSelect
              value={text(config.script_name)}
              onChange={(v) => onConfig({ script_name: v })}
            />
          ) : null}
        </div>
        <FieldError id={`${ids.type}-err`} message={error} />
        {locked ? (
          <p className={styles.help}>
            Built-in automations keep their first step; you can change its options.
          </p>
        ) : null}
        {below.length || actionType === 'run_script' ? (
          <div className={styles.options}>
            {below.map((field) => (
              <OptionField
                key={field.key}
                field={field}
                config={config}
                onChange={onConfig}
                actionType={actionType}
              />
            ))}
            {actionType === 'run_script' ? (
              <div className={styles.option}>
                <label className={styles.inlineField} htmlFor={ids.timeout}>
                  <span className={styles.inlineLabel}>Stop it after</span>
                  <TextInput
                    id={ids.timeout}
                    type="number"
                    min={5}
                    max={300}
                    className={styles.numberInput}
                    value={text(config.timeout, '60')}
                    onChange={(e) => onConfig({ timeout: Number(e.target.value) || 60 })}
                  />
                  <span className={styles.inlineLabel}>seconds</span>
                </label>
              </div>
            ) : null}
          </div>
        ) : null}
        {actionType ? (
          <div className={styles.option}>
            <label className={styles.inlineField} htmlFor={ids.delay}>
              <span className={styles.inlineLabel}>Wait</span>
              <TextInput
                id={ids.delay}
                type="number"
                min={0}
                className={styles.numberInput}
                value={String(delay)}
                onChange={(e) => onDelay(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
              />
              <span className={styles.inlineLabel}>minutes before starting</span>
            </label>
          </div>
        ) : null}
        {actionType ? <p className={styles.help}>{actionHelp(actionType, def, delay)}</p> : null}
      </div>
      <ActionMenu label="More for step 1" entries={menu} vertical bare />
    </li>
  );
}

// ── steps 2+: the follow-ups ────────────────────────────────────────────────

interface NotifyField {
  key: string;
  label: string;
  kind?: 'text' | 'textarea' | 'password' | 'number' | 'priority';
  placeholder?: string;
  /** Folded under "More settings" (opened when one of them has a value). */
  more?: boolean;
}

const THEN_FIELDS: Record<string, NotifyField[]> = {
  discord_webhook: [
    { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' },
    { key: 'message', label: 'Message', kind: 'textarea' },
  ],
  pushbullet: [
    { key: 'access_token', label: 'Access token', placeholder: 'o.xxxxxxxx' },
    { key: 'title', label: 'Title' },
    { key: 'message', label: 'Message', kind: 'textarea' },
  ],
  telegram: [
    { key: 'bot_token', label: 'Bot token', placeholder: '123456:ABC-DEF…' },
    { key: 'chat_id', label: 'Chat ID', placeholder: '-1001234567890 or @channel' },
    { key: 'message', label: 'Message', kind: 'textarea' },
    { key: 'thread_id', label: 'Thread ID', more: true },
  ],
  ntfy: [
    { key: 'topic', label: 'Topic', placeholder: 'soulsync' },
    { key: 'title', label: 'Title' },
    { key: 'message', label: 'Message', kind: 'textarea' },
    { key: 'server', label: 'Server', placeholder: 'https://ntfy.sh, or your own', more: true },
    { key: 'priority', label: 'Priority', kind: 'priority', more: true },
    { key: 'tags', label: 'Tags', placeholder: 'white_check_mark,cd', more: true },
    { key: 'token', label: 'Access token', more: true },
    { key: 'username', label: 'Username', more: true },
    { key: 'password', label: 'Password', kind: 'password', more: true },
  ],
  gotify: [
    { key: 'server', label: 'Server URL', placeholder: 'http://your-nas:8080' },
    { key: 'token', label: 'Application token' },
    { key: 'title', label: 'Title' },
    { key: 'message', label: 'Message', kind: 'textarea' },
    { key: 'priority', label: 'Priority (0 to 10)', kind: 'number', more: true },
  ],
  webhook: [
    { key: 'url', label: 'URL', placeholder: 'https://your-server/hook' },
    { key: 'message', label: 'Message', kind: 'textarea' },
    { key: 'headers', label: 'Headers, one per line (Key: Value)', kind: 'textarea', more: true },
    {
      key: 'payload_template',
      label: 'Custom body, instead of the default',
      kind: 'textarea',
      more: true,
    },
  ],
};

const BASE_VARIABLES = ['name', 'status', 'time', 'run_count'];

function ThenField({
  field,
  value,
  error,
  onChange,
}: {
  field: NotifyField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  const id = useId();
  const common = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-err` : undefined,
  } as const;
  let control: ReactNode;
  if (field.kind === 'textarea') {
    control = (
      <TextArea
        {...common}
        className={styles.textArea}
        value={text(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (field.kind === 'priority') {
    control = (
      <Select
        {...common}
        size="lg"
        value={text(value, '3')}
        onChange={(e) => onChange(e.target.value)}
      >
        {[
          ['1', 'Min'],
          ['2', 'Low'],
          ['3', 'Default'],
          ['4', 'High'],
          ['5', 'Urgent'],
        ].map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    );
  } else {
    control = (
      <TextInput
        {...common}
        type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        value={text(value)}
        placeholder={field.placeholder}
        onChange={(e) =>
          onChange(field.kind === 'number' ? Number(e.target.value) : e.target.value)
        }
      />
    );
  }
  return (
    <div className={styles.thenField}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {field.label}
      </label>
      {control}
      <FieldError id={`${id}-err`} message={error} />
    </div>
  );
}

export function ThenStep({
  step,
  position,
  triggerVariables,
  errors,
  onChange,
  menu,
}: {
  step: ThenDraft;
  position: number;
  triggerVariables: string[];
  errors: DraftErrors;
  onChange: (patch: Partial<ThenDraft>) => void;
  menu: MenuEntry[];
}) {
  const ids = { type: useId(), signal: useId(), condField: useId() };
  const [test, setTest] = useState<{ state: 'idle' | 'sending' | 'done'; text?: string }>({
    state: 'idle',
  });
  const fields = THEN_FIELDS[step.type] ?? [];
  const setConfig = (patch: Record<string, unknown>) =>
    onChange({ config: { ...step.config, ...patch } });
  const err = (key: string) => errors[`then.${step.key}.${key}`];
  const variables = [...new Set([...BASE_VARIABLES, ...triggerVariables])];
  const known = Object.keys(THEN_LABELS);
  const cond = step.condition;

  const sendTest = async () => {
    setTest({ state: 'sending' });
    try {
      const res = await testNotification(step.type, step.config);
      setTest({
        state: 'done',
        text: res.success
          ? 'Sent. Check that it arrived.'
          : `Didn’t send: ${res.error ?? 'no reason given'}`,
      });
    } catch (error) {
      setTest({ state: 'done', text: `Didn’t send: ${(error as Error).message}` });
    }
  };

  return (
    <li className={styles.step} data-testid={`step-${position}`}>
      <span className={styles.stepNumber} aria-hidden="true">
        {position}
      </span>
      <span className={styles.stepTitle} aria-hidden="true">
        {THEN_LABELS[step.type] ?? step.type}
      </span>
      <div className={styles.stepBody}>
        <div className={styles.sentence}>
          {NOTIFY_TYPES.includes(step.type) ? <span className={styles.word}>Send a</span> : null}
          <Select
            size="lg"
            id={ids.type}
            aria-label={`Step ${position}: what it does`}
            value={step.type}
            onChange={(e) => onChange({ type: e.target.value })}
          >
            {!known.includes(step.type) ? <option value={step.type}>{step.type}</option> : null}
            <optgroup label="Notify">
              {NOTIFY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {THEN_LABELS[t]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other">
              <option value="fire_signal">{THEN_LABELS.fire_signal}</option>
              <option value="run_script">{THEN_LABELS.run_script}</option>
            </optgroup>
          </Select>
          {step.type === 'fire_signal' ? (
            <>
              <span className={styles.word}>called</span>
              <TextInput
                id={ids.signal}
                className={styles.sentenceInput}
                aria-label="Signal name"
                value={text(step.config.signal_name)}
                placeholder="libraryReady"
                aria-invalid={err('signal_name') ? true : undefined}
                onChange={(e) => setConfig({ signal_name: e.target.value })}
                onBlur={(e) => setConfig({ signal_name: cleanSignalName(e.target.value) })}
              />
            </>
          ) : null}
          {step.type === 'run_script' ? (
            <ScriptSelect
              value={text(step.config.script_name)}
              invalid={Boolean(err('script_name'))}
              onChange={(v) => setConfig({ script_name: v })}
            />
          ) : null}
        </div>
        <FieldError id={`${ids.signal}-err`} message={err('signal_name') ?? err('script_name')} />
        {step.type === 'fire_signal' ? (
          <p className={styles.help}>
            Automations set to run after this signal start when this step runs.
          </p>
        ) : null}

        {fields.length ? (
          <div className={styles.thenFields}>
            {fields
              .filter((f) => !f.more)
              .map((f) => (
                <ThenField
                  key={f.key}
                  field={f}
                  value={step.config[f.key]}
                  error={err(f.key)}
                  onChange={(v) => setConfig({ [f.key]: v })}
                />
              ))}
          </div>
        ) : null}
        {fields.some((f) => f.more) ? (
          <details
            className={styles.more}
            open={fields.some(
              (f) => f.more && text(step.config[f.key]) !== '' && !(f.key === 'priority'),
            )}
          >
            <summary className={styles.moreSummary}>More settings</summary>
            <div className={styles.thenFields}>
              {fields
                .filter((f) => f.more)
                .map((f) => (
                  <ThenField
                    key={f.key}
                    field={f}
                    value={step.config[f.key]}
                    error={err(f.key)}
                    onChange={(v) => setConfig({ [f.key]: v })}
                  />
                ))}
            </div>
          </details>
        ) : null}
        {fields.some((f) => f.key === 'message') ? (
          <div className={styles.variables}>
            <span className={styles.inlineLabel}>Add to the message:</span>
            {variables.map((v) => (
              <button
                key={v}
                type="button"
                className={styles.variable}
                onClick={() => setConfig({ message: `${text(step.config.message)}{${v}}` })}
              >
                {`{${v}}`}
              </button>
            ))}
          </div>
        ) : null}

        <div className={styles.sentence}>
          <span className={styles.word}>Runs</span>
          <Select
            size="lg"
            aria-label={`Step ${position}: when it runs`}
            value={cond ? 'when' : 'always'}
            onChange={(e) =>
              onChange({
                condition:
                  e.target.value === 'when'
                    ? { field: 'status', operator: 'equals', value: 'error' }
                    : null,
              })
            }
          >
            <option value="always">every time</option>
            <option value="when">only when…</option>
          </Select>
        </div>
        {cond ? (
          <div className={styles.sentence}>
            <>
              <TextInput
                id={ids.condField}
                className={styles.condInput}
                aria-label={`Step ${position}: value to check`}
                list={`${ids.condField}-list`}
                value={cond.field ?? ''}
                onChange={(e) => onChange({ condition: { ...cond, field: e.target.value } })}
              />
              <datalist id={`${ids.condField}-list`}>
                {variables.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <Select
                size="lg"
                aria-label={`Step ${position}: how to compare`}
                value={cond.operator ?? 'equals'}
                onChange={(e) => onChange({ condition: { ...cond, operator: e.target.value } })}
              >
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {operatorWords(op)}
                  </option>
                ))}
              </Select>
              <TextInput
                className={styles.condInput}
                aria-label={`Step ${position}: compare with`}
                value={cond.value ?? ''}
                onChange={(e) => onChange({ condition: { ...cond, value: e.target.value } })}
              />
            </>
          </div>
        ) : null}
        {NOTIFY_TYPES.includes(step.type) ? (
          <div className={styles.sentence}>
            <Button
              size="lg"
              onClick={() => void sendTest()}
              disabled={test.state === 'sending'}
              focusableWhenDisabled
            >
              {test.state === 'sending' ? 'Sending…' : 'Send a test'}
            </Button>
            {test.state === 'done' ? (
              <span className={styles.help} role="status">
                {test.text}
              </span>
            ) : (
              <span className={styles.help}>Sends one message with sample values, now.</span>
            )}
          </div>
        ) : null}
      </div>
      <ActionMenu label={`More for step ${position}`} entries={menu} vertical bare />
    </li>
  );
}

export const ADD_STEP_TYPES: { type: string; label: string }[] = [
  { type: 'discord_webhook', label: 'Notify' },
  { type: 'fire_signal', label: 'Fire a signal' },
  { type: 'run_script', label: 'Run a script' },
];

export function canAddStep(count: number): boolean {
  return count < MAX_THEN_STEPS;
}
