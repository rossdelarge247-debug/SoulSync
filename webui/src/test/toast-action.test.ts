import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Gauntlet review H1: a notice with an action (a set's Undo) is used once and
 * goes, is said through a polite live region, can ask to stay longer, and two
 * of them with the same words are both shown. The real showToast from
 * static/downloads.js, run against the real index.html's toast markup.
 */

const JS = readFileSync(resolve(process.cwd(), 'static/downloads.js'), 'utf8');
const HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const BLOCK = JS.slice(JS.indexOf('function showToast('), JS.indexOf('function _escAttr('));

type Toast = (m: string, t?: string, h?: string | null, o?: unknown) => void;

function load(): Toast {
  const make = new Function(
    `const _recentToastKeys = new Map();
     const _notifState = { history: [], maxHistory: 50, unreadCount: 0, currentToast: null, toastTimer: null };
     const _notifIcons = {};
     function _updateNotifBadge() {}
     function _queueNotifJournal() {}
     ${BLOCK}
     return showToast;`,
  );
  return make() as Toast;
}

function markup(id: string) {
  const at = HTML.indexOf(`id="${id}"`);
  const start = HTML.lastIndexOf('<div', at);
  return HTML.slice(start, HTML.indexOf('</div>', at) + 6);
}

describe('a toast with an action', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = markup('toast-container') + markup('toast-live');
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('index.html has a polite live region for it', () => {
    const live = document.getElementById('toast-live')!;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });

  it('is said politely, runs once, and goes when used', () => {
    const showToast = load();
    const run = vi.fn();
    showToast('Removed Foghorn Study from Sunday Set', 'success', null, {
      ms: 10_000,
      action: { label: 'Undo', run },
    });
    vi.advanceTimersByTime(60);
    expect(document.getElementById('toast-live')!.textContent).toBe(
      'Removed Foghorn Study from Sunday Set. Undo is in the notice.',
    );
    const button = document.querySelector<HTMLButtonElement>('.toast-compact-action')!;
    button.click();
    button.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    vi.advanceTimersByTime(250);
    expect(document.querySelector('.toast-compact')).toBeNull();
  });

  it('stays the time it asks for (10 s for Undo), 6 s otherwise', () => {
    const showToast = load();
    showToast('Removed One', 'success', null, { ms: 10_000, action: { label: 'Undo', run() {} } });
    vi.advanceTimersByTime(9_000);
    expect(document.querySelector('.toast-compact:not(.toast-exit)')).toBeTruthy();
    vi.advanceTimersByTime(1_500);
    expect(document.querySelector('.toast-compact:not(.toast-exit)')).toBeNull();

    showToast('Added to Sunday Set', 'success', null, { action: { label: 'Open it', run() {} } });
    vi.advanceTimersByTime(6_100);
    expect(document.querySelector('.toast-compact:not(.toast-exit)')).toBeNull();
  });

  it('[re-review Low a] dismissToast takes down only the toast put up with that key', () => {
    const make = new Function(
      `const _recentToastKeys = new Map();
       const _notifState = { history: [], maxHistory: 50, unreadCount: 0, currentToast: null, toastTimer: null };
       const _notifIcons = {};
       function _updateNotifBadge() {}
       function _queueNotifJournal() {}
       ${BLOCK}
       return { showToast, dismissToast };`,
    );
    const { showToast, dismissToast } = make() as {
      showToast: Toast;
      dismissToast: (key: string) => boolean;
    };
    showToast('Removed One', 'success', null, {
      key: 'set-undo',
      action: { label: 'Undo', run() {} },
    });
    expect(dismissToast('other')).toBe(false);
    expect(dismissToast('set-undo')).toBe(true);
    vi.advanceTimersByTime(250);
    expect(document.querySelector('.toast-compact')).toBeNull();
  });

  it('is not swallowed as a repeat when the words are the same', () => {
    const showToast = load();
    const first = vi.fn();
    const second = vi.fn();
    showToast('Removed Intro from Sunday Set', 'success', null, {
      action: { label: 'Undo', run: first },
    });
    showToast('Removed Intro from Sunday Set', 'success', null, {
      action: { label: 'Undo', run: second },
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>('.toast-compact-action');
    buttons[buttons.length - 1].click();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
