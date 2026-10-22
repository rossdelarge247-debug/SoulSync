/**
 * Module switches in the legacy shell: Settings -> Modules, the sidebar
 * guard, the chat page's notice, and 409 module_disabled answers.
 */

import { HttpResponse, http } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  navGuardCss,
  normalizeModules,
  type ModuleState,
} from '@/features/modules/modules.helpers';
import { server } from '@/test/msw';
import { createShellBridge } from '@/test/shell-bridge';

import {
  _resetModulesForTests,
  applyModuleStates,
  getModuleStates,
  initModules,
  loadModulesSettings,
  moduleIsOff,
  noteModuleDisabled,
  openModulesSettings,
} from './modules';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

function state(over: Partial<ModuleState> & { name: string }): ModuleState {
  return {
    display_name: over.name[0].toUpperCase() + over.name.slice(1),
    description: `${over.name} description`,
    enabled: true,
    restart_required: false,
    restart_reason: null,
    pages: [over.name],
    ...over,
  };
}

const ALL = (): ModuleState[] => [
  state({ name: 'video', pages: ['video-dashboard', 'video-library'] }),
  state({ name: 'podcasts', display_name: 'Podcasts' }),
  state({ name: 'chat', display_name: 'Chat & Arcade', pages: ['chat', 'video-chat'] }),
];

let served: ModuleState[] = [];
let puts: Array<{ name: string; body: unknown }> = [];

function serveModules(modules: ModuleState[]) {
  served = modules;
  server.use(http.get('/api/modules', () => HttpResponse.json({ success: true, modules: served })));
}

function acceptPuts(reply?: (name: string, enabled: boolean) => Response | Promise<Response>) {
  server.use(
    http.put('/api/modules/:name', async ({ params, request }) => {
      const name = String(params.name);
      const body = (await request.json()) as { enabled: boolean };
      puts.push({ name, body });
      if (reply) return reply(name, body.enabled);
      const current = served.find((m) => m.name === name)!;
      const next = { ...current, enabled: body.enabled };
      served = served.map((m) => (m.name === name ? next : m));
      return HttpResponse.json({ success: true, module: next });
    }),
  );
}

/** The real markup: the Modules settings group, the sidebar and the chat page. */
let parsed: Document | null = null;
function mountShell() {
  parsed ??= new DOMParser().parseFromString(html, 'text/html');
  const take = (id: string) => document.importNode(parsed!.getElementById(id)!, true);
  const settings = take('settings-page');
  document.body.replaceChildren(take('app-sidebar'), settings, take('chat-page'));
  document.body.removeAttribute('data-side');
  settings.classList.add('active');
  document.head.querySelector('#soulsync-module-guard')?.remove();
}

const list = () => document.getElementById('modules-settings-list')!;
const row = (name: string) => list().querySelector<HTMLElement>(`[data-module="${name}"]`)!;
const switchOf = (name: string) => row(name).querySelector<HTMLButtonElement>('[role="switch"]')!;
const settle = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await settle();
}

beforeAll(() => {
  initModules();
});

beforeEach(() => {
  puts = [];
  mountShell();
  window.SoulSyncWebShellBridge = createShellBridge();
  _resetModulesForTests(ALL());
  serveModules(ALL());
});

afterEach(() => {
  delete window.SOULSYNC_MODULES;
  vi.restoreAllMocks();
});

describe('Settings -> Modules', () => {
  it('renders one row per module from GET /api/modules, with a real switch', async () => {
    serveModules([...ALL(), state({ name: 'sample_studio', display_name: 'Sample Studio' })]);
    await loadModulesSettings();

    const names = [...list().querySelectorAll('.module-row-name')].map((n) => n.textContent);
    expect(names).toEqual(['Video', 'Podcasts', 'Chat & Arcade', 'Sample Studio']);
    expect(row('podcasts').querySelector('.module-row-desc')?.textContent).toBe(
      'podcasts description',
    );
    const sw = switchOf('podcasts');
    expect(sw.tagName).toBe('BUTTON');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.textContent).toContain('On');
    // the accessible name is the module's name
    expect(document.getElementById(sw.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Podcasts',
    );
    expect(document.getElementById('modules-settings-readonly')!.hidden).toBe(true);
  });

  it('turning a module on sends PUT and updates the row and the sidebar', async () => {
    serveModules([
      ...ALL().filter((m) => m.name !== 'podcasts'),
      state({ name: 'podcasts', display_name: 'Podcasts', enabled: false }),
    ]);
    _resetModulesForTests(served);
    acceptPuts();
    await loadModulesSettings();
    expect(switchOf('podcasts').getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById('soulsync-module-guard')?.textContent).toContain(
      'data-page="podcasts"',
    );
    const changed = vi.fn();
    window.addEventListener('soulsync:modules-changed', changed, { once: true });

    switchOf('podcasts').click();
    // turning on needs no confirmation
    expect(row('podcasts').querySelector<HTMLElement>('.module-confirm')!.hidden).toBe(true);
    await until(
      () => puts.length === 1 && switchOf('podcasts').getAttribute('aria-checked') === 'true',
    );

    expect(puts).toEqual([{ name: 'podcasts', body: { enabled: true } }]);
    expect(switchOf('podcasts').getAttribute('aria-checked')).toBe('true');
    expect(row('podcasts').querySelector('[role="status"]')?.textContent).toBe(
      'Podcasts is on. Its pages are back in the sidebar.',
    );
    expect(document.getElementById('soulsync-module-guard')?.textContent).toBe('');
    expect(moduleIsOff('podcasts')).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  it('stays focusable and says what it is doing while the change is in flight', async () => {
    let release: () => void = () => {};
    acceptPuts(
      (name, enabled) =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(HttpResponse.json({ success: true, module: { ...state({ name }), enabled } }));
        }),
    );
    await loadModulesSettings();
    switchOf('chat').click();
    row('chat').querySelector<HTMLButtonElement>('.module-confirm button')!.click();
    await until(() => puts.length === 1);
    const sw = switchOf('chat');
    expect(document.activeElement).toBe(sw);
    expect(sw.getAttribute('aria-busy')).toBe('true');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(sw.textContent).toContain('Turning off…');
    // a second click while busy does nothing
    sw.click();
    expect(row('chat').querySelector<HTMLElement>('.module-confirm')!.hidden).toBe(true);
    release();
    await until(() => sw.getAttribute('aria-checked') === 'false');
    expect(sw.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(sw);
  });

  it('asks before turning a module off, and only sends PUT once confirmed', async () => {
    acceptPuts();
    await loadModulesSettings();

    switchOf('podcasts').click();
    const confirm = row('podcasts').querySelector<HTMLElement>('.module-confirm')!;
    expect(confirm.hidden).toBe(false);
    expect(confirm.textContent).toContain('Turn off Podcasts?');
    expect(confirm.textContent).toContain(
      "Podcasts' pages and downloads stop until you turn it back on.",
    );
    const [yes, no] = confirm.querySelectorAll('button');
    expect(document.activeElement).toBe(yes);

    no.click();
    expect(confirm.hidden).toBe(true);
    expect(document.activeElement).toBe(switchOf('podcasts'));
    await settle();
    expect(puts).toEqual([]);

    switchOf('podcasts').click();
    yes.click();
    await until(() => switchOf('podcasts').getAttribute('aria-checked') === 'false');
    expect(puts).toEqual([{ name: 'podcasts', body: { enabled: false } }]);
    expect(row('podcasts').querySelector('[role="status"]')?.textContent).toBe(
      'Podcasts is off. Its pages are hidden from the sidebar.',
    );
    expect(document.getElementById('soulsync-module-guard')?.textContent).toContain(
      '.nav-button[data-page="podcasts"]',
    );
    expect(
      getComputedStyle(document.querySelector('.nav-button[data-page="podcasts"]')!).display,
    ).toBe('none');
    expect(
      getComputedStyle(document.querySelector('.nav-button[data-page="library"]')!).display,
    ).not.toBe('none');
  });

  it('a slow GET that started before a change does not undo it', async () => {
    acceptPuts();
    await loadModulesSettings();
    let answer: () => void = () => {};
    const stale = ALL();
    server.use(
      http.get(
        '/api/modules',
        () =>
          new Promise<Response>((resolve) => {
            answer = () => resolve(HttpResponse.json({ success: true, modules: stale }));
          }),
      ),
    );
    const reopened = loadModulesSettings();
    switchOf('podcasts').click();
    row('podcasts').querySelector<HTMLButtonElement>('.module-confirm button')!.click();
    await until(() => switchOf('podcasts').getAttribute('aria-checked') === 'false');
    answer();
    await reopened;
    expect(switchOf('podcasts').getAttribute('aria-checked')).toBe('false');
    expect(moduleIsOff('podcasts')).toBe(true);
  });

  it('Escape closes the confirmation without changing anything', async () => {
    acceptPuts();
    await loadModulesSettings();
    switchOf('chat').click();
    const confirm = row('chat').querySelector<HTMLElement>('.module-confirm')!;
    confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(confirm.hidden).toBe(true);
    await settle();
    expect(puts).toEqual([]);
  });

  it('shows which parts need a restart when the server says so', async () => {
    const reason =
      'The video download monitor and subtitle worker have no stop switch; they keep running until SYNCHRO.S restarts.';
    acceptPuts((name, enabled) =>
      HttpResponse.json({
        success: true,
        module: {
          ...state({ name, display_name: 'Video' }),
          enabled,
          restart_required: true,
          restart_reason: reason,
          pages: ['video-dashboard'],
        },
      }),
    );
    await loadModulesSettings();
    switchOf('video').click();
    row('video').querySelector<HTMLButtonElement>('.module-confirm button')!.click();
    await until(() => !row('video').querySelector<HTMLElement>('.module-restart')!.hidden);

    const notice = row('video').querySelector<HTMLElement>('.module-restart')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Restart needed');
    expect(notice.textContent).toContain('Restart SYNCHRO.S to finish turning Video off.');
    expect(notice.textContent).toContain(reason);
    expect(row('video').querySelector('[role="status"]')?.textContent).toContain(
      'Restart SYNCHRO.S to finish.',
    );
  });

  it('shows a restart a module already needed when the tab opens', async () => {
    serveModules(
      ALL().map((m) =>
        m.name === 'chat'
          ? { ...m, restart_required: true, restart_reason: 'Chat needs a restart.' }
          : m,
      ),
    );
    await loadModulesSettings();
    expect(row('chat').querySelector<HTMLElement>('.module-restart')!.hidden).toBe(false);
    expect(row('podcasts').querySelector<HTMLElement>('.module-restart')!.hidden).toBe(true);
  });

  it('keeps the old state and says why when the change fails', async () => {
    acceptPuts(() =>
      HttpResponse.json(
        { success: false, error: 'boom', message: 'Config is read-only.' },
        { status: 500 },
      ),
    );
    await loadModulesSettings();
    switchOf('podcasts').click();
    row('podcasts').querySelector<HTMLButtonElement>('.module-confirm button')!.click();
    await until(() => !!row('podcasts').querySelector('[data-tone="error"]'));
    expect(switchOf('podcasts').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('podcasts').hasAttribute('aria-disabled')).toBe(false);
    expect(row('podcasts').querySelector('[role="status"]')?.textContent).toBe(
      "Couldn't turn Podcasts off. Config is read-only. Nothing changed.",
    );
    expect(moduleIsOff('podcasts')).toBe(false);
  });

  it('non-admins see the states read-only, with a note', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 3, isAdmin: false })),
    });
    serveModules(ALL().map((m) => (m.name === 'chat' ? { ...m, enabled: false } : m)));
    await loadModulesSettings();
    expect(document.getElementById('modules-settings-readonly')!.hidden).toBe(false);
    expect(list().querySelector('[role="switch"]')).toBeNull();
    expect(row('chat').querySelector('.module-state')?.textContent).toBe('Off');
    expect(row('podcasts').querySelector('.module-state')?.textContent).toBe('On');
  });

  it('a 403 answer turns the rows read-only', async () => {
    acceptPuts(() =>
      HttpResponse.json({ success: false, error: 'Admin access required' }, { status: 403 }),
    );
    await loadModulesSettings();
    switchOf('chat').click();
    row('chat').querySelector<HTMLButtonElement>('.module-confirm button')!.click();
    await until(() => !list().querySelector('[role="switch"]'));
    expect(document.getElementById('modules-settings-readonly')!.hidden).toBe(false);
  });

  it('says so when the states cannot be loaded', async () => {
    server.use(
      http.get('/api/modules', () => HttpResponse.json({ success: false }, { status: 500 })),
    );
    await loadModulesSettings();
    const error = document.getElementById('modules-settings-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("Couldn't load the latest module states");
    // the rows from the page's own copy are still there
    expect(list().querySelectorAll('.module-row')).toHaveLength(3);
  });
});

describe('the sidebar and module pages', () => {
  it('hides the Audio/Video switch and leaves the video side while Video is off', () => {
    const switchSide = vi.fn();
    window._switchAppSide = switchSide;
    document.body.setAttribute('data-side', 'video');
    _resetModulesForTests(ALL().map((m) => (m.name === 'video' ? { ...m, enabled: false } : m)));
    applyModuleStates();
    expect(document.getElementById('soulsync-module-guard')?.textContent).toContain('.side-toggle');
    expect(getComputedStyle(document.querySelector('.side-toggle')!).display).toBe('none');
    expect(switchSide).toHaveBeenCalledWith('music', { force: true });
    delete window._switchAppSide;
  });

  it('shows the chat notice on #chat-page while Chat & Arcade is off, and clears it after', () => {
    const chat = document.getElementById('chat-page')!;
    _resetModulesForTests(ALL().map((m) => (m.name === 'chat' ? { ...m, enabled: false } : m)));
    applyModuleStates();
    const notice = chat.querySelector('.module-off-notice')!;
    expect(chat.classList.contains('module-off-page')).toBe(true);
    expect(notice.querySelector('h2')?.textContent).toBe('Chat & Arcade is turned off');
    expect(notice.textContent).toContain('Module off');
    expect(notice.querySelector('a')?.textContent).toBe('Open Settings → Modules');
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/settings?tab=modules');

    _resetModulesForTests(ALL());
    applyModuleStates();
    expect(chat.querySelector('.module-off-notice')).toBeNull();
    expect(chat.classList.contains('module-off-page')).toBe(false);
  });

  it('a non-admin gets no Settings link on the notice', () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 3, isAdmin: false })),
    });
    _resetModulesForTests(ALL().map((m) => (m.name === 'chat' ? { ...m, enabled: false } : m)));
    applyModuleStates();
    const notice = document.querySelector('#chat-page .module-off-notice')!;
    expect(notice.querySelector('a')).toBeNull();
    expect(notice.textContent).toContain('An admin can turn it back on in Settings → Modules.');
  });

  it('a 409 module_disabled answer marks the module off and asks for fresh states', async () => {
    let asked = 0;
    server.use(
      http.get('/api/modules', () => {
        asked += 1;
        return HttpResponse.json({ success: true, modules: served });
      }),
    );
    served = ALL().map((m) => (m.name === 'chat' ? { ...m, enabled: false } : m));
    window.dispatchEvent(
      new CustomEvent('soulsync:module-disabled', {
        detail: { module: 'chat', message: 'Chat & Arcade is turned off.' },
      }),
    );
    expect(moduleIsOff('chat')).toBe(true);
    expect(document.querySelector('#chat-page .module-off-notice')).not.toBeNull();
    await until(() => asked === 1);
    expect(asked).toBe(1);
    // a second answer for a module already off is not news
    noteModuleDisabled({ success: false, error: 'module_disabled', module: 'chat', message: '' });
    await settle();
    expect(asked).toBe(1);
    expect(window.SOULSYNC_MODULES).toEqual(getModuleStates());
  });

  it('the notice link opens Settings on the Modules tab', () => {
    const navigate = vi.fn();
    const request = vi.fn();
    window.navigateToPage = navigate;
    window.requestSettingsTab = request;
    document.getElementById('settings-page')!.classList.remove('active');
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(null);
    openModulesSettings();
    expect(request).toHaveBeenCalledWith('modules');
    expect(navigate).toHaveBeenCalledWith('settings');
    delete window.navigateToPage;
    delete window.requestSettingsTab;
  });
});

describe('the pre-paint guard in index.html', () => {
  function runHeadGuard(modules: unknown): string {
    const start = html.indexOf('window.SOULSYNC_MODULES = ');
    const end = html.indexOf('</script>', start);
    const script = html.slice(html.indexOf('\n', start) + 1, end);
    document.head.querySelector('#soulsync-module-guard')?.remove();
    window.SOULSYNC_MODULES = modules;
    // eslint-disable-next-line typescript-eslint/no-implied-eval
    new Function(script)();
    return document.getElementById('soulsync-module-guard')!.textContent ?? '';
  }

  it('builds exactly the rules the shell builds later', () => {
    const samples = [
      ALL(),
      ALL().map((m) => ({ ...m, enabled: false })),
      ALL().map((m) => (m.name === 'chat' ? { ...m, enabled: false } : m)),
      [{ name: 'x', enabled: false, pages: ['ok-page', 'Bad"Page'] }],
    ];
    for (const sample of samples) {
      expect(runHeadGuard(sample)).toBe(navGuardCss(normalizeModules(sample)));
    }
  });

  it('renders the switches from the page shell, not from a hard-coded list', () => {
    expect(html).toContain(
      'window.SOULSYNC_MODULES = {{ initial_modules | default([]) | tojson }};',
    );
  });
});
