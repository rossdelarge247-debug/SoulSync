import { afterEach, describe, expect, it, vi } from 'vitest';

const extra = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('@/platform/shell/route-manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/shell/route-manifest')>();
  return {
    ...actual,
    getShellRouteByPath: (path: string) =>
      extra.paths.includes(path)
        ? { pageId: path.slice(1), path, kind: 'react' as const }
        : actual.getShellRouteByPath(path),
  };
});

const { HOME_ROUTES, resolveHomeRoute, resolveHref } = await import('./-home.routes');

afterEach(() => {
  extra.paths = [];
});

describe('the route map', () => {
  it('falls back to Wishlist and Downloads until Wanted and Activity exist', () => {
    expect(resolveHomeRoute('wanted')).toMatchObject({ href: '/wishlist', pageId: 'wishlist' });
    expect(resolveHomeRoute('activity')).toMatchObject({
      href: '/active-downloads',
      pageId: 'active-downloads',
    });
    expect(resolveHomeRoute('followed')).toMatchObject({ href: '/watchlist' });
  });

  it('uses /wanted and /activity once the shell has them', () => {
    extra.paths = ['/wanted', '/activity'];
    expect(resolveHomeRoute('wanted').href).toBe('/wanted');
    expect(resolveHomeRoute('activity').href).toBe('/activity');
  });

  it('sends the quality target to Settings → Quality', () => {
    expect(resolveHomeRoute('quality')).toEqual({
      href: '/settings?tab=quality',
      pageId: 'settings',
      settingsTab: 'quality',
    });
    expect(resolveHomeRoute('mirrored')).toMatchObject({ href: '/sync', pageId: 'sync' });
    expect(HOME_ROUTES.setupCheck.path).toBe('/setup-check');
  });

  it('resolves a server link to the shell page it opens', () => {
    expect(resolveHref('/tools')).toEqual({ href: '/tools', pageId: 'tools', settingsTab: null });
    expect(resolveHref('/nowhere').pageId).toBeNull();
  });
});
