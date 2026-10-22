import { describe, expect, it } from 'vitest';

import type { AutomationBlocks } from './-automations.types';

import {
  actionSentence,
  conditionPhrase,
  dayAndTime,
  eventPhrase,
  nextPhrase,
  schedulePhrase,
  stepCount,
  stepSentences,
  thenSentence,
} from './-automations.steps';

const BLOCKS: AutomationBlocks = {
  triggers: [
    {
      type: 'issue_created',
      label: 'Issue Reported',
      description: 'When someone reports a problem with a track',
    },
    {
      type: 'quality_scan_completed',
      label: 'Quality Scan Done',
      description: 'Quality scan finishes',
    },
  ],
  actions: [
    {
      type: 'run_repair_job',
      label: 'Run Maintenance Job',
      config_fields: [
        { key: 'job_id', type: 'select', options: [{ value: 'dead_files', label: 'Dead Files' }] },
      ],
    },
    { type: 'brand_new_thing', label: 'Brand New Thing' },
  ],
};

describe('how an automation runs, in words', () => {
  it.each([
    [{ trigger_type: 'schedule', trigger_config: { interval: 6, unit: 'hours' } }, 'Every 6 hours'],
    [{ trigger_type: 'schedule', trigger_config: { interval: 1, unit: 'hours' } }, 'Every hour'],
    [
      { trigger_type: 'schedule', trigger_config: { interval: 30, unit: 'minutes' } },
      'Every 30 minutes',
    ],
    [{ trigger_type: 'daily_time', trigger_config: { time: '06:00' } }, 'Daily at 06:00'],
    [
      { trigger_type: 'weekly_time', trigger_config: { time: '02:00', days: ['thu', 'mon'] } },
      'Weekly on Mon and Thu at 02:00',
    ],
    [
      { trigger_type: 'weekly_time', trigger_config: { time: '02:00', days: [] } },
      'Daily at 02:00',
    ],
    [
      { trigger_type: 'monthly_time', trigger_config: { time: '09:00', day_of_month: 22 } },
      'Monthly on the 22nd at 09:00',
    ],
    [
      { trigger_type: 'batch_complete', trigger_config: {} },
      'After an album or playlist download finishes',
    ],
    [
      { trigger_type: 'signal_received', trigger_config: { signal_name: 'ready' } },
      'When the signal “ready” fires',
    ],
  ])('%j reads "%s"', (automation, words) => {
    expect(schedulePhrase(automation, BLOCKS)).toBe(words);
  });

  it('uses the block description when it reads as "when …", else names the event', () => {
    expect(eventPhrase('issue_created', {}, BLOCKS)).toBe(
      'When someone reports a problem with a track',
    );
    expect(eventPhrase('quality_scan_completed', {}, BLOCKS)).toBe(
      'When quality scan done happens',
    );
  });

  it('adds the event conditions', () => {
    expect(
      eventPhrase('track_downloaded', {
        conditions: [
          { field: 'artist', operator: 'contains', value: 'Saltmarsh' },
          { field: 'quality', operator: 'not_equals', value: 'MP3' },
        ],
        match: 'any',
      }),
    ).toBe("After a track downloads, if artist contains “Saltmarsh” or quality isn't “MP3”");
    expect(conditionPhrase([{ field: '', operator: 'contains', value: 'x' }])).toBe('');
  });
});

describe('the steps as sentences', () => {
  it('says what each action really does with the options it reads', () => {
    expect(actionSentence('process_wishlist', { category: 'albums' })).toBe(
      "Search for what's due on Wanted, albums and singles in turn",
    );
    expect(actionSentence('refresh_mirrored', { all: true })).toBe(
      'Refresh every mirrored playlist from its source',
    );
    expect(
      actionSentence(
        'sync_playlist',
        { playlist_id: '7' },
        { playlistName: (id) => (id === '7' ? 'Sunday Mornings' : undefined) },
      ),
    ).toBe('Sync “Sunday Mornings” to your media server');
    expect(actionSentence('library_cleanup', { recycle_bin: false })).toBe(
      'Clear the download quarantine, for good',
    );
    expect(actionSentence('run_repair_job', { job_id: 'dead_files' }, { blocks: BLOCKS })).toBe(
      'Run the maintenance job “Dead Files”',
    );
    expect(actionSentence('brand_new_thing', {}, { blocks: BLOCKS })).toBe('Brand new thing');
    expect(actionSentence('', {})).toBe('Choose what this automation does');
  });

  it('starts with the wait when the action has a delay', () => {
    expect(actionSentence('scan_library', { delay: 5 })).toBe(
      'Wait 5 minutes, then ask your media server to rescan the library',
    );
  });

  it('writes follow-up steps with their "only when"', () => {
    expect(
      thenSentence({
        type: 'telegram',
        config: {},
        conditions: [{ field: 'status', operator: 'equals', value: 'error' }],
      }),
    ).toBe('Send a Telegram message, only when status is “error”');
    expect(thenSentence({ type: 'webhook', config: { url: 'https://hooks.example.org/x' } })).toBe(
      'Send a webhook to hooks.example.org',
    );
    expect(thenSentence({ type: 'fire_signal', config: { signal_name: 'ready' } })).toBe(
      'Fire the signal “ready”',
    );
  });

  it('counts and orders the steps as the engine runs them', () => {
    const a = {
      action_type: 'scan_watchlist',
      action_config: {},
      then_actions: [
        { type: 'discord_webhook', config: {} },
        { type: 'run_script', config: { script_name: 'x.sh' } },
      ],
    };
    expect(stepCount(a)).toBe(3);
    expect(stepSentences(a)).toEqual([
      'Check followed artists and labels for new releases, and add them to Wanted',
      'Send a Discord message',
      'Run the script “x.sh”',
    ]);
  });
});

describe('times', () => {
  const now = new Date(2026, 9, 21, 12, 0).getTime(); // Wed 21 Oct, 12:00 local

  it('says today, yesterday, a weekday or a date', () => {
    expect(dayAndTime(new Date(2026, 9, 21, 9, 15).getTime(), now)).toBe('today 09:15');
    expect(dayAndTime(new Date(2026, 9, 20, 21, 15).getTime(), now)).toBe('yesterday 21:15');
    expect(dayAndTime(new Date(2026, 9, 18, 2, 0).getTime(), now, true)).toMatch(/^Sunday 02:00$/);
  });

  it('says when the next run is', () => {
    const at = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    expect(
      nextPhrase({ next_run: at(new Date(2026, 9, 21, 16, 0)), trigger_type: 'schedule' }, now),
    ).toBe('next at 16:00');
    expect(
      nextPhrase(
        {
          next_run: at(new Date(2026, 9, 22, 6, 0)),
          trigger_type: 'daily_time',
          trigger_config: { time: '06:00' },
        },
        now,
      ),
    ).toBe('next tomorrow');
    expect(
      nextPhrase({ next_run: at(new Date(2026, 9, 22, 3, 15)), trigger_type: 'schedule' }, now),
    ).toBe('next tomorrow at 03:15');
    expect(nextPhrase({ next_run: null, trigger_type: 'schedule' }, now)).toBeNull();
  });
});
