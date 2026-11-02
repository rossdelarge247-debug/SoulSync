/**
 * "Send to…" (32d, 32e): the desktop "…"'s submenu (the working set and
 * where a track goes in it, Up next after its last row, Another set…; DJ
 * now absent until step 5), and the tray at the foot (the working set · Up
 * next · Other sets · DJ now, laptop only on a phone), opened from the
 * phone sheet's Send to….
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trackMenu } from '@/features/dj/track-menu';
import { resetMixTabForTests } from '@/features/mix/mix-visibility';

import type { DragItem } from './dnd-model';

import { setSendToContext } from './send-to';
import {
  SendToTray,
  closeSendToTray,
  openSendToTray,
  provideDjNowEntry,
  sendToEntries,
  trayTargets,
} from './send-to-ui';

const items: DragItem[] = [
  { id: '9', title: 'Canopy', queue: { id: '9', title: 'Canopy', file_path: '/9' } },
];

function phone(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on && q.includes('max-width'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  // the sets are targets with the mixing features shown (Settings → Library → DJ)
  resetMixTabForTests(true);
  setSendToContext({
    working: { id: 4, name: 'Sunday Set', kind: 'hand', next: 9 },
    after: null,
    upNextLast: 'Static Bloom',
  });
  phone(false);
});
afterEach(() => {
  act(() => closeSendToTray());
  provideDjNowEntry(null);
  setSendToContext({ working: null, after: null, upNextLast: null });
  resetMixTabForTests();
});

describe('with the mixing features hidden (the default)', () => {
  beforeEach(() => resetMixTabForTests());

  it('Up next is the only target, in the submenu and the tray, and DJ now isn’t named', () => {
    provideDjNowEntry(() => ({ key: 'send-dj', label: 'DJ now', onSelect: () => {} }));
    expect(sendToEntries(items).map((e) => e.label)).toEqual(['Up next']);
    expect(trayTargets(true).map((t) => t.key)).toEqual(['upnext']);
    expect(trayTargets(false).map((t) => t.key)).toEqual(['upnext']);
  });

  it('the track menu has no Add to set… or Send to…, on a desktop and on a phone', () => {
    for (const onPhone of [false, true]) {
      const keys = trackMenu(
        { id: '9', title: 'Canopy' },
        { phone: onPhone, sendTo: items, playNext: { onSelect: () => {} } },
      ).map((e) => e.key);
      expect(keys).not.toContain('mixset');
      expect(keys).not.toContain('send');
      expect(keys).toContain('next');
    }
  });

  it('the phone’s tray says Up next alone, and sends there', () => {
    phone(true);
    render(<SendToTray />);
    act(() => openSendToTray(items));
    const dialog = screen.getByRole('dialog', { name: 'Send Canopy to…' });
    expect(
      Array.from(dialog.querySelectorAll('[class*="trayName"]')).map((n) => n.textContent),
    ).toEqual(['Up next']);
  });
});

describe('Send to… in the "…" (32d)', () => {
  it('names where each goes, in 32d’s words', () => {
    const entries = sendToEntries(items);
    expect(entries.map((e) => [e.label, e.reason ?? ''])).toEqual([
      ['Sunday Set (working set)', 'adds as #9'],
      ['Up next', 'after Static Bloom'],
      ['Another set…', ''],
    ]);
  });

  it('says "after Night Ferry" while the working set plays (293)', () => {
    setSendToContext({ after: { track_id: '2', number: 4, title: 'Night Ferry' } });
    expect(sendToEntries(items)[0].reason).toBe('after Night Ferry · adds as #5');
  });

  it('keeps a famous working set disabled with why', () => {
    setSendToContext({ working: { id: 4, name: 'Boiler Room', kind: 'famous', next: 3 } });
    expect(sendToEntries(items)[0]).toMatchObject({
      disabled: true,
      reason: "A famous mix can't be changed · Save a copy to edit it",
    });
  });

  it('has DJ now only once step 5 provides it (absent, not disabled)', () => {
    expect(sendToEntries(items).some((e) => e.label.startsWith('DJ now'))).toBe(false);
    provideDjNowEntry(() => ({
      key: 'send-dj',
      label: 'DJ now',
      reason: 'cue as next',
      onSelect: () => {},
    }));
    expect(sendToEntries(items).map((e) => e.label)).toContain('DJ now');
  });

  it('is a submenu in the track menu on a desktop, and the tray on a phone', () => {
    const desk = trackMenu({ id: '9', title: 'Canopy' }, { sendTo: items });
    expect(desk.find((e) => e.key === 'send')?.submenu?.map((e) => e.label)).toEqual([
      'Sunday Set (working set)',
      'Up next',
      'Another set…',
    ]);
    const onPhone = trackMenu({ id: '9', title: 'Canopy' }, { sendTo: items, phone: true });
    render(<SendToTray />);
    act(() => onPhone.find((e) => e.key === 'send')!.onSelect());
    expect(screen.getByRole('dialog', { name: 'Send Canopy to…' })).toBeTruthy();
    // a missing file has no Send to…
    expect(
      trackMenu({ id: '9', title: 'Canopy', fileMissing: true }, { sendTo: items }).some(
        (e) => e.key === 'send',
      ),
    ).toBe(false);
  });
});

describe('the tray at the foot (32e)', () => {
  it('lists the working set · Up next · Other sets · DJ now (laptop only) on a phone', () => {
    expect(trayTargets(true).map((t) => [t.name, t.sub, Boolean(t.disabled)])).toEqual([
      ['Sunday Set', 'working set · adds as #9', false],
      ['Up next', 'play next', false],
      ['Other sets', 'choose…', false],
      ['DJ now', 'laptop only', true],
    ]);
    expect(trayTargets(false).map((t) => t.name)).toEqual(['Sunday Set', 'Up next', 'Other sets']);
  });

  it('takes the focus, sends on a tap, and closes on Escape', () => {
    phone(true);
    const insertAt = vi.fn((_at: number, tracks: Record<string, unknown>[]) => tracks);
    (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
      state: () => ({ queue: [{ id: 'a' }], index: 0, track: null }),
      insertAt,
      removeTracks: () => 1,
    };
    window.showToast = vi.fn() as never;
    render(<SendToTray />);
    act(() => openSendToTray(items));
    const first = screen.getByRole('button', { name: /Sunday Set/ });
    expect(document.activeElement).toBe(first);
    expect(screen.getByRole('button', { name: /DJ now/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Up next/ }));
    expect(insertAt).toHaveBeenCalledWith(1, [expect.objectContaining({ id: '9' })]);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openSendToTray(items));
    // Escape elsewhere on the page is that place's; in the tray it closes it (L8)
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Tab stays inside the tray: from the last target back to the first
    const dialog = screen.getByRole('dialog');
    const live = [
      ...dialog.querySelectorAll('button:not([aria-disabled="true"])'),
    ] as HTMLElement[];
    live[live.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(live[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(live[live.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
  });
});
