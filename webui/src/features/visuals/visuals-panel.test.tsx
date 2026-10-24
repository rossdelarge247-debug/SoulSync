import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PresetEntry } from './visuals.types';

import { useVisuals, VisualsContext } from './use-visuals';
import { clearPresetMemory } from './visuals-api';
import { VisualsController } from './visuals-controller';
import { VisualsPanel } from './visuals-panel';
import { FailureCard, RadioCard, StillCard, VisualsCredit } from './visuals-stage-cards';

const entry = (key: string, name: string, author: string | null): PresetEntry => ({
  key,
  name,
  author,
  full_name: author ? `${author} - ${name}` : name,
  size: 2.1 * 1024 * 1024,
  source: 'bundled',
});

const PRESETS = [
  entry('md-0000000000000001', 'Angel Rails', 'Hapax'),
  entry('md-0000000000000002', 'Diffusion Field', 'Orrery'),
  entry('md-0000000000000003', 'Hive Logic', 'Flux'),
];

function setup(
  opts: {
    webgl2?: boolean;
    reduce?: boolean;
    phone?: boolean;
    /** fields the index answers with on top of the default */
    index?: (url: string) => Record<string, unknown>;
  } = {},
) {
  document.body.innerHTML =
    '<div id="np-modal-overlay" class="hidden"><div class="np-modal"></div></div>';
  const overlay = document.getElementById('np-modal-overlay')!;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/visuals/presets?'))
      return new Response(
        JSON.stringify({
          success: true,
          presets: PRESETS,
          authors: [
            { name: 'Flux', key: 'flux', count: 1 },
            { name: 'Hapax', key: 'hapax', count: 1 },
          ],
          total: 3,
          count: 3,
          own: { configured: false, count: 0, problem: null },
          ...(opts.index ? opts.index(url) : {}),
        }),
      );
    if (url.startsWith('/api/visuals/favourites?'))
      return new Response(JSON.stringify({ keys: ['md-0000000000000002'] }));
    if (url.startsWith('/api/visuals/favourites/'))
      return new Response(JSON.stringify({ success: true, favourite: init?.method === 'PUT' }));
    return new Response(JSON.stringify({ baseVals: {}, shapes: [], waves: [] }));
  });
  (window as unknown as { npV2: unknown }).npV2 = {
    themeList: () =>
      Array.from({ length: 18 }, (_, i) => ({
        id: i === 0 ? 'aurora' : `t${i}`,
        name: i === 0 ? 'Aurora' : `Visual ${i}`,
        blurb: '',
      })),
    getTheme: () => 'aurora',
    setTheme: () => undefined,
    getReduceMotion: () => Boolean(opts.reduce),
    wakeVisuals: () => undefined,
  };
  const win = Object.create(window) as Window;
  Object.defineProperty(win, 'matchMedia', {
    value: (q: string) => ({
      matches: Boolean(opts.phone) && q.includes('max-width'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  const c = new VisualsController({
    win,
    fetch: fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>,
    tap: {
      time: (o) => o.fill(128),
      freq: (o) => o.fill(0),
      sampleRate: () => 48000,
      silent: () => false,
    },
    webgl2: () => opts.webgl2 ?? true,
    raf: () => 0,
    cancelRaf: () => undefined,
    loadEngine: async () => ({
      createMilkdropEngine: () => ({
        load: () => undefined,
        resize: () => undefined,
        frame: () => undefined,
      }),
    }),
  });
  c.attach({
    overlay,
    gl: document.createElement('canvas'),
    canvas2d: document.createElement('canvas'),
  });
  function Phone() {
    useVisuals();
    return null;
  }
  const view = render(
    <VisualsContext.Provider value={c}>
      <Phone />
      <StillCard art={null} />
      <RadioCard />
      <FailureCard />
      <VisualsCredit />
      <VisualsPanel />
    </VisualsContext.Provider>,
  );
  return { c, view, fetchImpl };
}

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearPresetMemory();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the panel (10a)', () => {
  it('three families as OptionButtons; AVS isn’t built, so it isn’t there', async () => {
    const { c } = setup();
    act(() => {
      c.setOpen(true);
      c.togglePanel(true);
    });
    const families = within(screen.getByRole('group', { name: 'Family' })).getAllByRole('button');
    expect(families.map((b) => b.textContent)).toEqual(['SYNCHRO.S', 'MilkDrop', 'Classic']);
    expect(screen.queryByText('AVS')).toBeNull();
    expect(families[0]).toHaveAttribute('aria-pressed', 'true');
    c.dispose();
  });

  it('the SYNCHRO.S family is today’s 18 tiles, the picked one pressed', () => {
    const { c } = setup();
    act(() => {
      c.setOpen(true);
      c.togglePanel(true);
    });
    const tiles = within(screen.getByRole('group', { name: 'SYNCHRO.S visuals' })).getAllByRole(
      'button',
    );
    expect(tiles).toHaveLength(18);
    expect(tiles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('18 visuals · drawn by SYNCHRO.S')).toBeInTheDocument();
    c.dispose();
  });

  it('MilkDrop: search, Show with counts, the author select, the count line, rows with tags and stars', async () => {
    const { c } = setup();
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    await settle();
    expect(screen.getByPlaceholderText('Search 3 presets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Favourites 1/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Author' })).toBeInTheDocument();
    expect(screen.getByText('3 from the curated packs · A–Z')).toBeInTheDocument();
    // no folder set: Yours isn't shown at all (18b)
    expect(screen.queryByRole('button', { name: /^Yours/ })).toBeNull();
    const rows = within(screen.getByRole('list', { name: 'Presets' })).getAllByRole('listitem');
    const real = rows.filter((r) => r.textContent);
    expect(real).toHaveLength(3);
    expect(real[0]).toHaveTextContent('Angel Rails');
    expect(real[0]).toHaveTextContent('by Hapax · 2.1 MB');
    expect(real[0]).toHaveTextContent('Playing');
    expect(
      within(real[1]!).getByRole('button', {
        name: 'Remove Diffusion Field from favourites',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByPlaceholderText('Search 3 presets'), {
      target: { value: 'flux' },
    });
    expect(screen.getByText('1 preset · A–Z · 1 author')).toBeInTheDocument();
    c.dispose();
  });

  it('18a: the curated list by default; Every preset in the foot adds the rest, remembered here', async () => {
    const OWN = {
      ...PRESETS[0]!,
      key: 'own-000000000000000a',
      name: 'Kelp Forest',
      source: 'own',
    };
    const { c, fetchImpl } = setup({
      index: (url) =>
        url.includes('set=all')
          ? {
              set: 'all',
              presets: [
                ...PRESETS,
                { ...PRESETS[0]!, key: 'md-00000000000000ff', name: 'Zzz' },
                OWN,
              ],
              total: 5,
              uncurated: 1,
              own: { configured: true, count: 1, problem: null },
            }
          : {
              set: 'curated',
              presets: [...PRESETS, OWN],
              total: 4,
              uncurated: 1,
              own: { configured: true, count: 1, problem: null },
            },
    });
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    await settle();
    const urls = () => fetchImpl.mock.calls.map((x) => String(x[0]));
    expect(urls().filter((u) => u.startsWith('/api/visuals/presets?'))).toEqual([
      '/api/visuals/presets?family=milkdrop&set=curated',
    ]);
    expect(screen.getByPlaceholderText('Search 4 presets')).toBeInTheDocument();
    expect(screen.getByText('3 from the curated packs and 1 of yours · A–Z')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yours 1' })).toBeInTheDocument();
    expect(
      screen.getByText('Adds 1 more, uncurated: some names are crude, some won’t load.'),
    ).toBeInTheDocument();
    const every = screen.getByRole('switch', { name: 'Every preset' });
    expect(every).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(every);
    await settle();
    expect(urls()).toContain('/api/visuals/presets?family=milkdrop&set=all');
    expect(screen.getByRole('switch', { name: 'Every preset' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('4 from every pack and 1 of yours · A–Z')).toBeInTheDocument();
    expect(localStorage.getItem('soulsync-visuals-every-preset')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Yours 1' }));
    const rows = within(screen.getByRole('list', { name: 'Presets' }))
      .getAllByRole('listitem')
      .filter((r) => r.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Kelp Forest');
    c.dispose();
  });

  it('18b: Yours with an empty or unreadable folder says so and points at Player settings', async () => {
    let problem: string | null = null;
    const { c } = setup({
      index: () => ({ own: { configured: true, count: 0, problem } }),
    });
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Yours 0' }));
    expect(screen.getByText('None of yours yet')).toBeInTheDocument();
    expect(
      screen.getByText(/The folder for your own presets is empty\. An admin adds \.milk files/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Player settings' })).toBeInTheDocument();
    problem = 'missing';
    act(() => c.reloadIndex());
    await settle();
    expect(screen.getByText('None of yours to show')).toBeInTheDocument();
    expect(screen.getByText(/can’t open the folder for your own presets/)).toBeInTheDocument();
    c.dispose();
  });

  it('a starred row stars through the route', async () => {
    const { c, fetchImpl } = setup();
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add Hive Logic to favourites' }));
    await settle();
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/visuals/favourites/milkdrop/md-0000000000000003',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(
      screen.getByRole('button', { name: 'Remove Hive Logic from favourites' }),
    ).toBeInTheDocument();
    c.dispose();
  });

  it('a row that failed says "Won’t load"', async () => {
    sessionStorage.setItem('soulsync-visuals-failed', JSON.stringify(['md-0000000000000003']));
    const { c } = setup();
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    await settle();
    expect(screen.getByText('Won’t load')).toBeInTheDocument();
    c.dispose();
  });

  it('the foot: Auto-cycle Off by default, Blend on, Quality Full', async () => {
    const { c } = setup();
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    await settle();
    expect(screen.getByRole('combobox', { name: 'Auto-cycle' })).toHaveValue('off');
    expect(screen.getByRole('switch', { name: 'Blend between presets' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Quarter' }));
    expect(localStorage.getItem('soulsync-visuals-quality')).toBe('quarter');
    c.dispose();
  });

  it('no WebGL 2: one warning Notice, and its button shows the SYNCHRO.S visuals', () => {
    const { c } = setup({ webgl2: false });
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    expect(screen.getByText('MilkDrop needs WebGL 2')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Auto-cycle' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show SYNCHRO.S’s visuals' }));
    expect(c.snapshot().family).toBe('synchros');
    c.dispose();
  });

  it('Classic: two tiles with one setting each; Auto-cycle disabled with its reason; Quality says Full', () => {
    const { c } = setup();
    act(() => {
      c.setFamily('classic');
      c.setOpen(true);
      c.togglePanel(true);
    });
    expect(screen.getByRole('button', { name: /Bars/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('switch', { name: 'Falling peaks' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Drawn as' })).toHaveValue('lines');
    const ac = screen.getByRole('combobox', { name: 'Auto-cycle' });
    expect(ac).toHaveAttribute('aria-disabled', 'true');
    expect(ac).toHaveAccessibleDescription('Doesn’t apply to Classic: there are two');
    expect(screen.getByText('Classic always draws at full size')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Scope/ }));
    expect(c.snapshot().classicMode).toBe('scope');
    c.dispose();
  });

  it('the phone sheet has a grabber and leaves Author and Blend to Player settings', async () => {
    const { c } = setup({ phone: true });
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
      c.togglePanel(true);
    });
    await settle();
    expect(screen.getByRole('complementary', { name: 'Visuals' })).toHaveAttribute(
      'data-phone',
      'true',
    );
    expect(screen.queryByRole('combobox', { name: 'Author' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Blend between presets' })).toBeNull();
    c.dispose();
  });
});

describe('the stage cards (10c, 10d)', () => {
  it('the credit names the preset over "by author · family · n of N · what moved it"', async () => {
    const { c } = setup();
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
    });
    await settle();
    act(() => c.key('next'));
    await settle();
    const credit = screen.getByRole('status');
    expect(credit).toHaveTextContent('Diffusion Field');
    expect(credit).toHaveTextContent('by Orrery · MilkDrop · 2 of 3 · next');
    c.dispose();
  });

  it('won’t load: the card offers Next preset and Try it again', async () => {
    const { c } = setup();
    act(() => {
      c.setFamily('milkdrop');
      c.setOpen(true);
    });
    await settle();
    act(() => {
      (c as unknown as { set: (p: object) => void }).set({
        failure: {
          key: 'md-0000000000000003',
          name: 'Hive Logic',
          backName: 'Angel Rails',
        },
      });
    });
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('Couldn’t load Hive Logic');
    expect(card).toHaveTextContent(
      'Angel Rails is back on; auto-cycle skips Hive Logic from now on.',
    );
    expect(within(card).getByRole('button', { name: 'Next preset' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Try it again' })).toBeInTheDocument();
    c.dispose();
  });

  it('Reduce motion: the still card with "Play visuals this time" and Player settings', () => {
    const { c } = setup({ reduce: true });
    act(() => c.setOpen(true));
    expect(screen.getByText('Visuals are off while Reduce motion is on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Player settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play visuals this time' }));
    expect(screen.queryByText('Visuals are off while Reduce motion is on')).toBeNull();
    c.dispose();
  });

  it('the radio card offers "Play through SYNCHRO.S"', () => {
    const { c } = setup();
    act(() => {
      c.setOpen(true);
      (c as unknown as { set: (p: object) => void }).set({
        radioDirect: { station: 'NTS 1' },
      });
    });
    expect(screen.getByText('Visuals can’t follow this station')).toBeInTheDocument();
    expect(screen.getByText(/NTS 1 plays straight from its own server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play through SYNCHRO.S' })).toBeInTheDocument();
    // 105: what to expect is in the sentence, so the button's old note went
    expect(
      screen.getByText(/it can\. The stream restarts: a second or two of silence\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('restarts the stream')).toBeNull();
    c.dispose();
  });
});
