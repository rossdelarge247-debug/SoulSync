/**
 * The Connections service modal's shared frame (15a, HANDOFF 85 and 132),
 * lifted out of the real static/settings.js with the functions it calls
 * stubbed, so the tests drive the code the page runs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { extractFunction } from './vanilla-extract';

export const SETTINGS_JS = readFileSync(resolve(process.cwd(), 'static/settings.js'), 'utf8');

const LIFTED = [
  'renderStgSpotifyPause',
  'renderStgSpotifyTile',
  'spotifyAccountParts',
  'renderStgSpotifyModal',
  '_svcSafeText',
  'serviceTestOutcome',
  'serviceFrameView',
  '_svcFrameContext',
  '_svcTestAction',
  '_svcOpenFrame',
  'renderServiceModalFrame',
  '_svcFrameTest',
  '_svcFrameDisconnect',
  '_svcFrameSave',
  '_svcMeta',
  '_svcConfigured',
];

export type TestAnswer = { success: boolean; message?: string; error?: string };
export type FrameView = {
  tag: { text: string; tone: string } | null;
  tileTag: { text: string; tone: string; pause?: boolean } | null;
  line: Array<{ text?: string; lead?: string; strong?: string }>;
  warning: { tone: string; lead: string; text: string } | null;
  connected: boolean;
  disconnect: boolean;
  test: boolean;
};
export type Outcome = {
  ok: boolean;
  tag: { text: string; tone: string };
  lead: string;
  text: string;
} | null;

export type Frame = {
  calls: string[];
  answers: Record<string, TestAnswer>;
  tests: Record<string, unknown>;
  rebuilt: () => number;
  setStatus: (payload: unknown) => void;
  setConfig: (state: unknown) => void;
  setQobuz: (state: unknown) => void;
  setLastfmAuthorized: (yes: boolean) => void;
  pause: (status: unknown) => void;
  render: () => void;
  test: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  save: (id: string) => void;
  view: (id: string, ctx: Record<string, unknown>) => FrameView;
  outcome: (answer: unknown) => Outcome;
  safe: (text: string) => string;
};

export function buildFrame(): Frame {
  return new Function(
    `let _stgSpotifyPauseStatus = null;
     let _stgSpotifyPauseAt = 0;
     let _stgSpotifyPauseTimer = null;
     let _lastStatusPayload = null;
     let _stgServiceStatusState = {};
     const _svcTests = {};
     let _svcLastfmAuthorized = false;
     let _svcQobuzAuth = null;
     const SERVICE_LOGOS = {};
     const INVERT_SERVICE_MARKS = new Set();
     const SERVICE_GLYPHS = {};
     let rebuilt = 0;
     const calls = [];
     const answers = {};
     function retryStgSpotifyPause() {}
     function buildServiceTiles() { rebuilt += 1; }
     function disconnectSpotify() { calls.push('disconnect spotify'); }
     function disconnectTidal() { calls.push('disconnect tidal'); }
     function logoutQobuz() { calls.push('logout qobuz'); }
     async function applyServiceStatusGradients() { calls.push('config-status'); }
     async function testConnection(s) { calls.push('test ' + s); return answers[s] || { success: true, message: 'ok' }; }
     async function testDeezerConnection() { calls.push('test deezer and its ARL'); return answers.deezer || { success: true, message: 'ok' }; }
     function saveSettings() { calls.push('save'); }
     const SERVICE_DISCONNECT = {
       spotify: () => disconnectSpotify(),
       tidal: () => disconnectTidal(),
       qobuz: () => logoutQobuz(),
     };
     ${LIFTED.map((name) => extractFunction(name, SETTINGS_JS)).join('\n')}
     return {
       calls, answers, tests: _svcTests,
       rebuilt: () => rebuilt,
       setStatus(p) { _lastStatusPayload = p; },
       setConfig(c) { _stgServiceStatusState = c; },
       setQobuz(q) { _svcQobuzAuth = q; },
       setLastfmAuthorized(yes) { _svcLastfmAuthorized = yes; },
       pause(status) { _stgSpotifyPauseStatus = status; _stgSpotifyPauseAt = Date.now(); renderStgSpotifyPause(); },
       render: renderServiceModalFrame,
       test: _svcFrameTest,
       disconnect: _svcFrameDisconnect,
       save: _svcFrameSave,
       view: serviceFrameView,
       outcome: serviceTestOutcome,
       safe: _svcSafeText,
     };`,
  )() as Frame;
}

/** The modal open on one service, its legacy panel moved into the body. */
export function mountModal(
  id: string,
  { title = id, form = '', video = false }: { title?: string; form?: string; video?: boolean } = {},
): void {
  const attr = video ? 'data-video-service' : 'data-service';
  document.body.innerHTML = `<div id="settings-page">
    <div id="service-config-modal" data-stg="connections" data-svc="${id}"><div class="src-modal">
      <div class="src-modal-header"><span class="src-modal-icon"></span><span class="src-modal-titles">
        <span class="src-modal-titlerow"><h3 id="svc-modal-title">${title}</h3></span>
        <span class="src-modal-sub" id="svc-modal-sub"></span></span><button class="src-modal-close"></button></div>
      <div class="src-modal-body" id="svc-modal-body"><div class="api-service-frame stg-service" ${attr}="${id}">
        <div class="stg-service-header"><span class="stg-service-dot"></span><h4 class="service-title">${title}</h4><span class="stg-service-chevron">›</span></div>
        <div class="stg-service-body">${form}</div></div></div>
      <div class="src-modal-foot" id="svc-modal-foot" hidden></div></div></div>
    <div id="service-tile-grid"><button data-service-tile="spotify"><span class="src-tile-chip svc-tile-tag" data-pause="1"></span></button></div>
  </div>`;
}

export const head = () => ({
  tag: document.querySelector<HTMLElement>('#service-config-modal .svc-modal-tag'),
  sub: document.getElementById('svc-modal-sub')!,
  box: document.querySelector<HTMLElement>('#svc-modal-body > .svc-modal-warning'),
  buttons: () =>
    [...document.querySelectorAll<HTMLButtonElement>('#svc-modal-foot button')]
      .filter((b) => !b.hidden)
      .map((b) => b.textContent),
});
