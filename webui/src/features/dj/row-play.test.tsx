import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { RowPlay, rowPlayHandlers } from './row-play';

/** gauntlet review H2 and L2 on the row's primary button (Brief D) */

const w = window as unknown as Record<string, unknown>;
afterEach(() => {
  delete w.SoulSyncPlayer;
});

it('[L2] the playing row says Pause while it plays and Resume while paused', () => {
  let playing = true;
  w.SoulSyncPlayer = { state: () => ({ track: { id: '1' }, playing }) };
  render(<RowPlay title="Night Ferry" playing onPlay={() => {}} />);
  expect(screen.getByRole('button', { name: 'Pause Night Ferry' })).toBeTruthy();
  playing = false;
  act(() => {
    window.dispatchEvent(new CustomEvent('ss:player'));
  });
  expect(screen.getByRole('button', { name: 'Resume Night Ferry' })).toBeTruthy();
});

it('[H2] a double-click on Play is one Play, not a Play and a pause', () => {
  const onPlay = vi.fn();
  const { rerender } = render(<RowPlay title="Night Ferry" onPlay={onPlay} />);
  const button = screen.getByRole('button', { name: 'Play Night Ferry' });
  fireEvent.click(button);
  // the row now reads Playing; the double-click's second click isn't a pause
  w.SoulSyncPlayer = { state: () => ({ track: { id: '1' }, playing: true }), toggle: vi.fn() };
  rerender(<RowPlay title="Night Ferry" playing onPlay={onPlay} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pause Night Ferry' }));
  expect(onPlay).toHaveBeenCalledTimes(1);
  expect((w.SoulSyncPlayer as { toggle: () => void }).toggle).not.toHaveBeenCalled();
});

it("[H2] the playing row and a phone's rows have no double-click play", () => {
  const play = vi.fn();
  expect(rowPlayHandlers(play, true)).toEqual({});
  expect(rowPlayHandlers(null)).toEqual({});
  expect(rowPlayHandlers(play).onDoubleClick).toBeTypeOf('function');
});
