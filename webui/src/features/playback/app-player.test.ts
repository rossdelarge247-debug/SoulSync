import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  playInAppPlayer,
  readAppPlayerMedia,
  toggleAppPlayer,
  useAppPlayerMedia,
  type MediaItem,
} from './app-player';

type Win = { SoulSyncPlayer?: unknown };

afterEach(() => {
  delete (window as Win).SoulSyncPlayer;
});

const episode: MediaItem = {
  kind: 'podcast',
  id: 'guid-1',
  src: '/api/podcasts/stream?u=x',
  title: 'Episode 1',
  subtitle: 'The Show',
};

function install(state: { track: { kind?: string; media_id?: string } | null; playing: boolean }) {
  const player = {
    current: state,
    playMedia: vi.fn(async () => undefined),
    toggle: vi.fn(),
    state: () => player.current,
  };
  (window as Win).SoulSyncPlayer = player;
  return player;
}

describe('the app player for spoken word', () => {
  it('hands the episode to the one player', () => {
    const player = install({ track: null, playing: false });
    expect(playInAppPlayer(episode)).toBe(true);
    expect(player.playMedia).toHaveBeenCalledWith(episode);
    toggleAppPlayer();
    expect(player.toggle).toHaveBeenCalled();
  });

  it('says false when the page has no player', () => {
    expect(playInAppPlayer(episode)).toBe(false);
    expect(readAppPlayerMedia('podcast')).toEqual({ id: null, playing: false });
  });

  it('reads only what is loaded of its own kind', () => {
    install({ track: { kind: 'podcast', media_id: 'guid-1' }, playing: true });
    expect(readAppPlayerMedia('podcast')).toEqual({ id: 'guid-1', playing: true });
    expect(readAppPlayerMedia('audiobook')).toEqual({ id: null, playing: false });
  });

  it('keeps current as the player changes', () => {
    const player = install({ track: null, playing: false });
    const { result } = renderHook(() => useAppPlayerMedia('podcast'));
    expect(result.current.id).toBeNull();
    act(() => {
      player.current = { track: { kind: 'podcast', media_id: 'guid-1' }, playing: true };
      window.dispatchEvent(new CustomEvent('ss:player'));
    });
    expect(result.current).toEqual({ id: 'guid-1', playing: true });
    act(() => {
      player.current = { track: { kind: 'podcast', media_id: 'guid-1' }, playing: false };
      window.dispatchEvent(new CustomEvent('ss:player'));
    });
    expect(result.current.playing).toBe(false);
  });
});
