/**
 * Where the Mix tab shows (29a–29c), rendered by the router's root so it
 * shares the app's queries, and placed into the shell's static markup
 * (webui/index.html) with portals:
 *
 * - `[data-player-modes="music"]` / `="radio"`: the Now playing · Mix switch
 *   at the top of the tray's record (music's, or a station's while its
 *   track on air is one of yours);
 * - `[data-player-mix]`: the tray's Mix mode (29a), or on a phone the
 *   sheet's Mix · Set (29c). `#media-player[data-tray-mode="mix"]` tells
 *   static/player.css to step the other columns aside;
 * - in Visuals, `#np-v2-visuals-mix-btn` and the 520px drawer (29b).
 *
 * The keys (24a) come from static/media-player.js's one handler, which
 * already leaves inputs, dialogs and menus alone (S's guard): it calls
 * `window.SoulSyncMix.key('A' | 'N' | 'M')`, true when the Mix tab acted.
 * X is reserved for Mix now (auto-mix, 26c) and isn't bound yet.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { playTrackNext } from '@/features/dj/dj-actions';
import { useProfile } from '@/platform/shell/route-controllers';

import { useMixModel, type MixModel } from './mix-model';
import { getMixState, setDrawer, setTrayMode, useMixState } from './mix-store';
import { useMixSubject, type MixSubject } from './mix-subject';
import { MixDrawer, MixSheet, MixTray, ModesSwitch, PreviewTray } from './mix-tab';
import { mixQueryOptions } from './mix.api';

export const PHONE_QUERY = '(max-width: 768px)';

declare global {
  interface Window {
    SoulSyncMix?: {
      /** A, N or M from the player's keys; true when the Mix tab acted */
      key: (key: string) => boolean;
      available: () => boolean;
      drawerOpen: () => boolean;
      closeDrawer: () => void;
    };
  }
}

interface ChromeLike {
  expand: () => void;
  isExpanded: () => boolean;
  openSheet: () => void;
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const on = () => setMatches(list.matches);
    on();
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}

interface Slots {
  modesMusic: HTMLElement | null;
  modesRadio: HTMLElement | null;
  mix: HTMLElement | null;
  overlay: HTMLElement | null;
  visualsStage: HTMLElement | null;
  visualsButton: HTMLButtonElement | null;
  visualsPanelButton: HTMLElement | null;
}

function findSlots(): Slots {
  const doc = document;
  return {
    modesMusic: doc.querySelector<HTMLElement>('[data-player-modes="music"]'),
    modesRadio: doc.querySelector<HTMLElement>('[data-player-modes="radio"]'),
    mix: doc.querySelector<HTMLElement>('[data-player-mix]'),
    overlay: doc.getElementById('np-modal-overlay'),
    visualsStage: doc.querySelector<HTMLElement>('#np-modal-overlay .np-modal'),
    visualsButton: doc.querySelector<HTMLButtonElement>('#np-v2-visuals-mix-btn'),
    visualsPanelButton: doc.getElementById('np-v2-visuals-panel-btn'),
  };
}

/** Whether the Visuals overlay is open, kept current. */
function useVisualsOpen(overlay: HTMLElement | null): boolean {
  const [open, setOpen] = useState(() => Boolean(overlay && !overlay.classList.contains('hidden')));
  useEffect(() => {
    if (!overlay) return;
    const check = () => setOpen(!overlay.classList.contains('hidden'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [overlay]);
  return open;
}

function isAvailable(subject: MixSubject): boolean {
  return subject.kind !== 'none';
}

/** The keys' actions, against the latest model. */
function keyAction(
  key: string,
  subject: MixSubject,
  model: MixModel,
  visualsOpen: boolean,
  phone: boolean,
  fetchTop: (id: string) => Promise<void>,
): boolean {
  if (!isAvailable(subject)) return false;
  const k = key.toUpperCase();
  // the keys work for a library track (or a station's that's yours) only: a
  // preview's tab only says why there's nothing, so M stays the player's
  // (gauntlet L7)
  if (subject.kind !== 'track') return false;
  if (k === 'M') {
    if (visualsOpen) {
      setDrawer(!getMixState().drawer);
      return true;
    }
    const chrome = (window as unknown as { SoulSyncPlayerChrome?: ChromeLike })
      .SoulSyncPlayerChrome;
    const mode = getMixState().mode;
    if (phone) {
      if (chrome && !chrome.isExpanded()) {
        setTrayMode('mix');
        chrome.openSheet();
      } else setTrayMode(mode === 'mix' ? 'now' : 'mix');
      return true;
    }
    if (chrome && !chrome.isExpanded()) {
      setTrayMode('mix');
      chrome.expand();
      return true;
    }
    setTrayMode(mode === 'mix' ? 'now' : 'mix');
    return true;
  }
  if (k === 'A') {
    void model.addPlaying();
    return true;
  }
  if (k === 'N') {
    const top = model.matches[0];
    if (top) playTrackNext(top);
    else if (model.mix.isPending && model.seed) void fetchTop(model.seed.id);
    else
      window.showToast?.(
        `Nothing to play next: nothing in your library fits ${subject.title || 'this track'} yet.`,
        'info',
      );
    return true;
  }
  return false;
}

export function MixTabHost() {
  const subject = useMixSubject();
  const { profileId } = useProfile();
  const state = useMixState();
  const phone = useMedia(PHONE_QUERY);
  const queryClient = useQueryClient();
  const trackSubject = subject.kind === 'track' ? subject : null;
  const model = useMixModel(trackSubject, profileId ?? null);
  const [slots, setSlots] = useState<Slots>(() => findSlots());
  const visualsOpen = useVisualsOpen(slots.overlay);
  const available = isAvailable(subject);
  const mixShown = available && state.mode === 'mix';
  const drawerShown = visualsOpen && state.drawer && Boolean(trackSubject);

  // the shell's markup is there from the start; look again once in case
  useEffect(() => {
    if (!slots.mix) setSlots(findSlots());
  }, [slots.mix]);

  // the tray is 500px while there's a Mix tab (static/player.css)
  useEffect(() => {
    document.documentElement.toggleAttribute('data-mix-available', available);
    return () => document.documentElement.removeAttribute('data-mix-available');
  }, [available]);

  // the tray's mode, for static/player.css
  useEffect(() => {
    const root = document.getElementById('media-player');
    if (root) {
      if (mixShown) root.dataset.trayMode = 'mix';
      else delete root.dataset.trayMode;
    }
    if (slots.mix) slots.mix.hidden = !mixShown;
    return () => {
      if (root) delete root.dataset.trayMode;
    };
  }, [mixShown, slots.mix]);

  // Visuals: the header's Mix button and the drawer (29b)
  useEffect(() => {
    const button = slots.visualsButton;
    if (!button) return;
    button.hidden = !trackSubject;
    button.setAttribute('aria-pressed', drawerShown ? 'true' : 'false');
    button.setAttribute('aria-expanded', drawerShown ? 'true' : 'false');
    const toggle = () => {
      const open = !getMixState().drawer;
      // one panel at a time on the right: the visuals' own closes
      const visuals = (
        window as unknown as {
          SoulSyncVisuals?: { panelOpen?: () => boolean; closePanel?: () => void };
        }
      ).SoulSyncVisuals;
      if (open && visuals?.panelOpen?.()) visuals.closePanel?.();
      setDrawer(open);
    };
    button.addEventListener('click', toggle);
    const panel = slots.visualsPanelButton;
    const closeMine = () => setDrawer(false);
    panel?.addEventListener('click', closeMine);
    return () => {
      button.removeEventListener('click', toggle);
      panel?.removeEventListener('click', closeMine);
    };
  }, [slots.visualsButton, slots.visualsPanelButton, trackSubject, drawerShown]);

  // the drawer closes with the visuals
  useEffect(() => {
    if (!visualsOpen && getMixState().drawer) setDrawer(false);
  }, [visualsOpen]);

  // the keys, against the latest model
  const latest = useRef({ subject, model, visualsOpen, phone });
  latest.current = { subject, model, visualsOpen, phone };
  useEffect(() => {
    const fetchTop = async (id: string) => {
      const m = latest.current.model;
      try {
        const data = await queryClient.fetchQuery(
          mixQueryOptions(id, { setId: m.workingSet?.id ?? null, wide: m.state.wide }),
        );
        if (data.matches[0]) playTrackNext(data.matches[0]);
      } catch {
        /* not a library track: nothing to play next */
      }
    };
    window.SoulSyncMix = {
      key: (key) => {
        const l = latest.current;
        return keyAction(key, l.subject, l.model, l.visualsOpen, l.phone, fetchTop);
      },
      available: () => isAvailable(latest.current.subject),
      drawerOpen: () => getMixState().drawer && latest.current.visualsOpen,
      closeDrawer: () => setDrawer(false),
    };
    return () => {
      delete window.SoulSyncMix;
    };
  }, [queryClient]);

  if (!available) return null;
  const preview = subject.kind === 'preview' ? subject.title : null;
  return (
    <>
      {slots.modesMusic && !trackSubject?.radio
        ? createPortal(<ModesSwitch mode={state.mode} />, slots.modesMusic)
        : null}
      {slots.modesRadio && trackSubject?.radio
        ? createPortal(<ModesSwitch mode={state.mode} />, slots.modesRadio)
        : null}
      {slots.mix && mixShown
        ? createPortal(
            phone ? (
              <MixSheet model={model} tab={state.sheetTab} preview={preview} />
            ) : trackSubject ? (
              <MixTray model={model} />
            ) : (
              <PreviewTray title={preview ?? ''} />
            ),
            slots.mix,
          )
        : null}
      {drawerShown && slots.visualsStage
        ? createPortal(
            <MixDrawer model={model} onClose={() => setDrawer(false)} />,
            slots.visualsStage,
          )
        : null}
    </>
  );
}
