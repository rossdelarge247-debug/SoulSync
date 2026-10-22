import { describe, expect, it } from 'vitest';

import {
  changeResultCopy,
  moduleDisabledPayload,
  moduleForPage,
  moduleForPath,
  moduleOffCopy,
  navGuardCss,
  normalizeModules,
  restartCopy,
  turnOffCopy,
  withModuleOff,
  type ModuleState,
} from './modules.helpers';

const MODULES: ModuleState[] = normalizeModules([
  {
    name: 'video',
    display_name: 'Video',
    enabled: true,
    pages: ['video-dashboard', 'video-library', 'video-settings'],
  },
  { name: 'podcasts', display_name: 'Podcasts', enabled: true, pages: ['podcasts'] },
  { name: 'chat', display_name: 'Chat & Arcade', enabled: true, pages: ['chat', 'video-chat'] },
]);

describe('normalizeModules', () => {
  it('reads the API shape and treats only an explicit false as off', () => {
    const [a, b, c] = normalizeModules([
      { name: 'podcasts', display_name: 'Podcasts', enabled: false, pages: ['podcasts'] },
      { name: 'chat', enabled: 'no', pages: ['chat'] },
      { name: 'sample_studio', pages: ['sample-studio', 'Bad Page', 7] },
    ]);
    expect(a).toMatchObject({ name: 'podcasts', enabled: false, pages: ['podcasts'] });
    expect(b.enabled).toBe(true);
    expect(c).toMatchObject({ display_name: 'Sample studio', pages: ['sample-studio'] });
  });

  it('drops junk', () => {
    expect(normalizeModules(null)).toEqual([]);
    expect(normalizeModules([null, 3, { display_name: 'no name' }])).toEqual([]);
  });
});

describe('page and path ownership', () => {
  it('finds the module that owns a page id', () => {
    expect(moduleForPage(MODULES, 'video-chat')?.name).toBe('chat');
    expect(moduleForPage(MODULES, 'library')).toBeUndefined();
  });

  it('maps a path, and video detail links to the video module', () => {
    expect(moduleForPath(MODULES, '/podcasts/123')?.name).toBe('podcasts');
    expect(moduleForPath(MODULES, '/video-library')?.name).toBe('video');
    expect(moduleForPath(MODULES, '/video-detail/library/movie/7')?.name).toBe('video');
    expect(moduleForPath(MODULES, '/dashboard')).toBeUndefined();
    expect(moduleForPath(MODULES, '/')).toBeUndefined();
  });
});

describe('moduleDisabledPayload', () => {
  it('reads both 409 envelopes', () => {
    expect(
      moduleDisabledPayload({
        success: false,
        error: 'module_disabled',
        module: 'podcasts',
        message: 'Podcasts is turned off.',
      }),
    ).toEqual({ module: 'podcasts', message: 'Podcasts is turned off.' });
    expect(
      moduleDisabledPayload({
        success: false,
        error: { code: 'MODULE_DISABLED', module: 'video', message: 'Video is turned off.' },
      }),
    ).toEqual({ module: 'video', message: 'Video is turned off.' });
  });

  it('ignores every other error', () => {
    expect(moduleDisabledPayload({ error: 'conflict', module: 'podcasts' })).toBeNull();
    expect(moduleDisabledPayload({ error: { code: 'CONFLICT' } })).toBeNull();
    expect(moduleDisabledPayload('module_disabled')).toBeNull();
  });
});

describe('navGuardCss', () => {
  it('is empty while everything is on', () => {
    expect(navGuardCss(MODULES)).toBe('');
  });

  it("hides an off module's music and video nav entries", () => {
    const css = navGuardCss(withModuleOff(MODULES, 'chat'));
    expect(css).toContain('.nav-button[data-page="chat"]');
    expect(css).toContain('.nav-button[data-video-page="video-chat"]');
    expect(css).not.toContain('podcasts');
    expect(css).not.toContain('.side-toggle');
  });

  it('hides the Audio/Video switch while Video is off', () => {
    expect(navGuardCss(withModuleOff(MODULES, 'video'))).toContain(
      '.side-toggle{display:none!important}',
    );
  });
});

describe('copy', () => {
  const podcasts = MODULES[1];

  it('says what stops before turning a module off', () => {
    expect(turnOffCopy(podcasts)).toEqual({
      title: 'Turn off Podcasts?',
      body: "Podcasts' pages and downloads stop until you turn it back on.",
      confirm: 'Turn off Podcasts',
      cancel: 'Keep it on',
    });
    expect(turnOffCopy({ name: 'new_thing', display_name: 'New Thing' }).body).toBe(
      "New Thing's pages stop until you turn it back on.",
    );
  });

  it('offers admins the way back and tells everyone else who can', () => {
    expect(moduleOffCopy(podcasts, true)).toMatchObject({
      title: 'Podcasts is turned off',
      action: 'Open Settings → Modules',
    });
    const member = moduleOffCopy(podcasts, false);
    expect(member.action).toBeNull();
    expect(member.hint).toBe('An admin can turn it back on in Settings → Modules.');
  });

  it('reports the result and any restart still needed', () => {
    expect(changeResultCopy({ ...podcasts, enabled: false })).toBe(
      'Podcasts is off. Its pages are hidden from the sidebar.',
    );
    const video: ModuleState = {
      ...MODULES[0],
      enabled: false,
      restart_required: true,
      restart_reason: 'The video download monitor keeps running until SYNCHRO.S restarts.',
    };
    expect(changeResultCopy(video)).toBe(
      'Video is off. Its pages are hidden from the sidebar. Restart SYNCHRO.S to finish.',
    );
    expect(restartCopy(video)).toEqual({
      title: 'Restart SYNCHRO.S to finish turning Video off.',
      body: 'The video download monitor keeps running until SYNCHRO.S restarts.',
    });
    expect(restartCopy(podcasts)).toBeNull();
  });
});
