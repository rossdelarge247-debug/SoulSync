/**
 * An automation's schedule in words, from its trigger (core/automation/blocks.py
 * TRIGGERS): "every 24 hours", "every day at 02:00", "every Monday and
 * Thursday at 06:00". '' for triggers that aren't a schedule.
 */

import { parseServerTime } from '@/features/automations/format';

const DAY_NAMES: Readonly<Record<string, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function clock(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^\d{1,2}:\d{2}$/.test(text) ? text.padStart(5, '0') : '';
}

export function scheduleText(
  triggerType: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
): string {
  const c = config ?? {};
  if (triggerType === 'schedule') {
    const interval = Number(c.interval);
    const unit = typeof c.unit === 'string' ? c.unit.toLowerCase().replace(/s$/, '') : 'hour';
    if (!Number.isFinite(interval) || interval <= 0) return '';
    if (!['minute', 'hour', 'day', 'week'].includes(unit)) return '';
    return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
  }
  if (triggerType === 'daily_time') {
    const at = clock(c.time);
    return at ? `every day at ${at}` : 'every day';
  }
  if (triggerType === 'weekly_time') {
    const at = clock(c.time);
    const days = (Array.isArray(c.days) ? c.days : [])
      .map((d) => DAY_NAMES[String(d).toLowerCase()])
      .filter(Boolean);
    const when = days.length ? `every ${listWords(days)}` : 'every week';
    return at ? `${when} at ${at}` : when;
  }
  if (triggerType === 'monthly_time') {
    const at = clock(c.time);
    const day = Number(c.day_of_month) || 1;
    return `on day ${day} of each month${at ? ` at ${at}` : ''}`;
  }
  return '';
}

/** "at 02:00" today or tomorrow, "on Tuesday at 02:00" within a week, else a date. */
export function nextRunText(nextRun: string | null | undefined, nowMs: number): string {
  if (!nextRun) return '';
  const at = parseServerTime(nextRun);
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const ahead = at - nowMs;
  if (ahead <= 0) return 'soon';
  const today = new Date(nowMs);
  const sameDay = date.toDateString() === today.toDateString();
  const tomorrow = new Date(nowMs + 86_400_000).toDateString() === date.toDateString();
  if (sameDay) return `at ${time}`;
  if (tomorrow) return `tomorrow at ${time}`;
  if (ahead < 7 * 86_400_000) {
    return `on ${date.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
  }
  return `on ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
}
