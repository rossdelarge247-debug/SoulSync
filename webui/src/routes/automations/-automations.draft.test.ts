import { describe, expect, it } from 'vitest';

import type { Automation } from './-automations.types';

import {
  draftChanged,
  draftFromAssistant,
  draftFromAutomation,
  draftToAssistant,
  draftToPayload,
  newDraft,
  validateDraft,
  type Draft,
} from './-automations.draft';

const SAVED: Automation = {
  id: 4,
  name: 'Fill Wanted',
  enabled: 1,
  trigger_type: 'schedule',
  trigger_config: { interval: 6, unit: 'hours', legacy_flag: true },
  action_type: 'process_wishlist',
  action_config: { category: 'all', delay: 5 },
  then_actions: [
    {
      type: 'telegram',
      config: { bot_token: 't', chat_id: 'c' },
      conditions: [{ field: 'status', operator: 'equals', value: 'error' }],
      match: 'all',
    },
    { type: 'fire_signal', config: { signal_name: 'ready' } },
  ],
  group_name: 'Nightly',
  is_system: 0,
};

describe('draft round trip', () => {
  it('saves exactly what it loaded, unknown keys included', () => {
    const payload = draftToPayload(draftFromAutomation(SAVED));
    expect(payload).toEqual({
      name: 'Fill Wanted',
      trigger_type: 'schedule',
      trigger_config: { interval: 6, unit: 'hours', legacy_flag: true },
      action_type: 'process_wishlist',
      action_config: { category: 'all', delay: 5 },
      then_actions: [
        {
          match: 'all',
          type: 'telegram',
          config: { bot_token: 't', chat_id: 'c' },
          conditions: [{ field: 'status', operator: 'equals', value: 'error' }],
        },
        { type: 'fire_signal', config: { signal_name: 'ready' } },
      ],
      group_name: 'Nightly',
    });
    expect(draftChanged(draftFromAutomation(SAVED), draftFromAutomation(SAVED))).toBe(false);
  });

  it('maps a new Runs choice onto the engine trigger and starts its config clean', () => {
    const d = draftFromAutomation(SAVED);
    const daily: Draft = {
      ...d,
      schedule: { ...d.schedule, kind: 'daily', time: '06:00', tz: 'Europe/London' },
    };
    expect(draftToPayload(daily)).toMatchObject({
      trigger_type: 'daily_time',
      trigger_config: { time: '06:00', tz: 'Europe/London' },
    });
    const weekly: Draft = {
      ...d,
      schedule: { ...d.schedule, kind: 'weekly', time: '02:00', days: ['mon', 'thu'] },
    };
    expect(draftToPayload(weekly).trigger_config).toEqual({ time: '02:00', days: ['mon', 'thu'] });
    const monthly: Draft = {
      ...d,
      schedule: { ...d.schedule, kind: 'monthly', time: '09:00', dayOfMonth: 15 },
    };
    expect(draftToPayload(monthly)).toMatchObject({
      trigger_type: 'monthly_time',
      trigger_config: { day_of_month: 15 },
    });
    const event: Draft = {
      ...d,
      schedule: {
        ...d.schedule,
        kind: 'event',
        eventType: 'track_downloaded',
        conditions: [{ field: 'artist', operator: 'contains', value: 'x' }],
        match: 'any',
      },
    };
    expect(draftToPayload(event)).toMatchObject({
      trigger_type: 'track_downloaded',
      trigger_config: {
        conditions: [{ field: 'artist', operator: 'contains', value: 'x' }],
        match: 'any',
      },
    });
  });

  it('drops a zero delay and keeps follow-up order', () => {
    const d = draftFromAutomation(SAVED);
    const next: Draft = { ...d, delay: 0, followUps: [...d.followUps].reverse() };
    const payload = draftToPayload(next);
    expect(payload.action_config).toEqual({ category: 'all' });
    expect(payload.then_actions.map((t) => t.type)).toEqual(['fire_signal', 'telegram']);
  });

  it('never sends a group for a built-in automation', () => {
    const system = draftFromAutomation({ ...SAVED, is_system: 1 });
    expect('group_name' in draftToPayload(system)).toBe(false);
  });
});

describe('validation', () => {
  it('needs a name, a first step and what each follow-up needs', () => {
    const d: Draft = {
      ...newDraft(),
      followUps: [
        {
          key: 'k1',
          type: 'discord_webhook',
          config: { message: 'hi' },
          condition: null,
          extra: {},
        },
      ],
    };
    expect(validateDraft(d)).toEqual({
      name: 'Give the automation a name.',
      action: 'Choose what this automation does.',
      'then.k1.webhook_url': 'Add the webhook URL.',
    });
  });

  it('checks the schedule it saves', () => {
    const base = draftFromAutomation(SAVED);
    expect(validateDraft({ ...base, schedule: { ...base.schedule, interval: 0 } })).toHaveProperty(
      'schedule.interval',
    );
    expect(
      validateDraft({ ...base, schedule: { ...base.schedule, kind: 'daily', time: '25:00' } }),
    ).toHaveProperty('schedule.time');
    expect(
      validateDraft({ ...base, schedule: { ...base.schedule, kind: 'event', eventType: '' } }),
    ).toHaveProperty('schedule.eventType');
    expect(
      validateDraft({
        ...base,
        schedule: { ...base.schedule, kind: 'event', eventType: 'signal_received', signalName: '' },
      }),
    ).toHaveProperty('schedule.signalName');
    expect(validateDraft(base)).toEqual({});
  });
});

describe('Assistant drafts', () => {
  const DRAFT = {
    name: 'Morning search',
    trigger_type: 'daily_time',
    trigger_config: { time: '07:00' },
    action_type: 'process_wishlist',
    action_config: { category: 'albums', delay: 10 },
    then_actions: [{ type: 'fire_signal', config: { signal_name: 'done' } }],
  };

  it('becomes an editor draft and comes back as the same body', () => {
    const d = draftFromAssistant(DRAFT);
    expect(d.name).toBe('Morning search');
    expect(d.schedule.kind).toBe('daily');
    expect(d.delay).toBe(10);
    expect(d.followUps).toHaveLength(1);
    expect(draftToAssistant(d)).toMatchObject({
      name: 'Morning search',
      trigger_type: 'daily_time',
      trigger_config: { time: '07:00' },
      action_type: 'process_wishlist',
      then_actions: [{ type: 'fire_signal', config: { signal_name: 'done' } }],
    });
    expect(draftToPayload(d).action_config).toEqual({ category: 'albums', delay: 10 });
  });

  it('keeps an existing automation’s id, and a built-in one’s start and action', () => {
    const base = draftFromAutomation(SAVED);
    expect(draftFromAssistant(DRAFT, base).id).toBe(4);
    const system = { ...base, isSystem: true };
    const kept = draftFromAssistant({ ...DRAFT, action_type: 'scan_library' }, system);
    expect(kept.actionType).toBe('process_wishlist');
    expect(kept.schedule.kind).toBe(system.schedule.kind);
  });
});
