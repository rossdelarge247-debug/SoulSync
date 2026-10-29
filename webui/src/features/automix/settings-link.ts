import { openDjSettings } from '@/features/dj/dj-settings-link';

/**
 * Settings → Library → DJ's Between tracks (33e) from anywhere (Player
 * settings' "Style and key lock…", the https notes, the Mix tab): the DJ
 * section opened and its Between tracks card focused (dj-settings-link.ts).
 */
export function openBetweenTracksSettings(): void {
  openDjSettings('between');
}
