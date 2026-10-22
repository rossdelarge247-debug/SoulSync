/**
 * Settings → AI over the page's real markup (index.html #ai-settings): the
 * key's states (none yet, set and working, refused, testing), the model and
 * who-can-use radios, the usage card and its cap, and the admin-only tab.
 */

import { HttpResponse, http } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw';
import { createShellBridge } from '@/test/shell-bridge';

import {
  _resetAiSettingsForTests,
  capText,
  costWords,
  initAiSettings,
  keyStatusLine,
  loadAiSettings,
  type AiSettings,
  type AiUsage,
  whenWords,
} from './ai-settings';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
let parsed: Document | null = null;

function mount() {
  parsed ??= new DOMParser().parseFromString(html, 'text/html');
  const page = document.createElement('div');
  page.id = 'settings-page';
  const tab = document.importNode(parsed.getElementById('stg-tab-ai')!, true);
  page.append(tab, document.importNode(parsed.getElementById('ai-settings')!, true));
  document.body.replaceChildren(page);
}

const NOW = new Date();
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function settings(over: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: 'anthropic',
    api_key: { set: true, masked: 'sk-ant-••••••••••••••••••••3f9' },
    model: 'fast',
    who_can_use: 'admins',
    monthly_cap_usd: null,
    key_status: {
      state: 'ok',
      message: 'Key works.',
      tested_at: iso(60_000),
      tested_by: 'ross',
      added_at: iso(3_600_000),
      added_by: 'ross',
    },
    ...over,
  };
}

const USAGE: AiUsage = {
  month: '2026-10',
  requests: 412,
  input_tokens: 500_000,
  output_tokens: 60_000,
  estimated_cost_usd: 1.8,
  drafts_saved: 7,
  cap_usd: null,
};

let current: AiSettings;
let puts: Record<string, unknown>[] = [];
let tests = 0;
let testReply: () => Response = () =>
  HttpResponse.json({
    ok: true,
    message: 'Key works.',
    saved_key: true,
    key_status: { ...current.key_status, state: 'ok', tested_at: new Date().toISOString() },
  });

function serve(initial: AiSettings) {
  current = initial;
  server.use(
    http.get('/api/ai/settings', () =>
      HttpResponse.json({ success: true, settings: current, usage: USAGE }),
    ),
    http.put('/api/ai/settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      puts.push(body);
      if (body.monthly_cap_usd === 'lots')
        return HttpResponse.json(
          { success: false, error: 'Write the cap as an amount in dollars, like 10.' },
          { status: 400 },
        );
      if (typeof body.api_key === 'string') {
        current = {
          ...current,
          api_key: { set: true, masked: `sk-ant-${'•'.repeat(20)}${body.api_key.slice(-3)}` },
          key_status: { ...current.key_status, state: 'untested', tested_at: null },
        };
      }
      for (const key of ['model', 'who_can_use'] as const) {
        if (key in body) current = { ...current, [key]: body[key] } as AiSettings;
      }
      if ('monthly_cap_usd' in body)
        current = {
          ...current,
          monthly_cap_usd: body.monthly_cap_usd == null ? null : Number(body.monthly_cap_usd),
        };
      return HttpResponse.json({ success: true, settings: current, usage: USAGE });
    }),
    http.post('/api/ai/test', () => {
      tests += 1;
      return testReply();
    }),
  );
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const keyInput = () => $<HTMLInputElement>('ai-key');
const statusLine = () => $('ai-key-status');
const radio = (group: string, value: string) =>
  $(group).querySelector<HTMLElement>(`[data-value="${value}"]`)!;

beforeEach(() => {
  puts = [];
  tests = 0;
  _resetAiSettingsForTests();
  window.SoulSyncWebShellBridge = createShellBridge({
    getCurrentProfileContext: vi.fn(() => ({ profileId: 1, isAdmin: true })),
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

async function start(initial: AiSettings) {
  serve(initial);
  mount();
  initAiSettings();
  await loadAiSettings();
}

describe('the tab', () => {
  it('is shown to admins and hidden from everyone else', async () => {
    mount();
    initAiSettings();
    expect($('stg-tab-ai').hidden).toBe(false);
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 3, isAdmin: false })),
    });
    _resetAiSettingsForTests();
    mount();
    initAiSettings();
    expect($('stg-tab-ai').hidden).toBe(true);
    expect($('stg-tab-ai')).toHaveTextContent('AI');
  });
});

describe('the key', () => {
  it('with none yet: an empty field, Save and test as the primary, and no usage card', async () => {
    await start(
      settings({
        api_key: { set: false, masked: '' },
        key_status: { ...settings().key_status, state: 'missing', added_by: null, tested_at: null },
      }),
    );
    expect(keyInput().readOnly).toBe(false);
    expect(keyInput().value).toBe('');
    expect($('ai-key-save').hidden).toBe(false);
    expect($('ai-key-save')).toHaveClass('ai-button--primary');
    expect($('ai-key-replace').hidden).toBe(true);
    expect($('ai-key-test').hidden).toBe(true);
    expect($('ai-usage-card').hidden).toBe(true);
    expect(statusLine()).toHaveTextContent('No key yet.');
  });

  it('when set and working: masked, Replace and Test, and who tested it when', async () => {
    await start(settings());
    expect(keyInput().readOnly).toBe(true);
    expect(keyInput().value).toBe('sk-ant-••••••••••••••••••••3f9');
    expect($('ai-key-replace').hidden).toBe(false);
    expect($('ai-key-test').hidden).toBe(false);
    expect($('ai-key-save').hidden).toBe(true);
    expect(statusLine().dataset.tone).toBe('success');
    expect(statusLine().textContent).toMatch(
      /^Key works · tested today \d\d:\d\d · added by ross today$/,
    );
    expect(statusLine()).toHaveAttribute('aria-live', 'polite');
  });

  it('when refused: the danger border and the words under the field', async () => {
    await start(settings({ key_status: { ...settings().key_status, state: 'refused' } }));
    expect(keyInput()).toHaveAttribute('aria-invalid', 'true');
    expect(statusLine()).toHaveTextContent('Anthropic refused this key');
    expect(statusLine().dataset.tone).toBe('danger');
  });

  it('Replace, then Save and test: saves the key, says Testing… and shows the result', async () => {
    let release: () => void = () => {};
    testReply = () => {
      const reply = HttpResponse.json({
        ok: true,
        message: 'Key works.',
        saved_key: true,
        key_status: { ...current.key_status, state: 'ok', tested_at: new Date().toISOString() },
      });
      return reply;
    };
    await start(settings());
    $('ai-key-replace').click();
    expect(keyInput().readOnly).toBe(false);
    expect(keyInput().value).toBe('');
    expect($('ai-key-cancel').hidden).toBe(false);
    expect(document.activeElement).toBe(keyInput());
    keyInput().value = 'sk-ant-api03-NEWKEY9z1';
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post('/api/ai/test', async () => {
        tests += 1;
        await gate;
        return testReply();
      }),
    );
    $('ai-key-save').click();
    await vi.waitFor(() => expect(statusLine()).toHaveTextContent('Testing…'));
    expect(puts[0]).toEqual({ provider: 'anthropic', api_key: 'sk-ant-api03-NEWKEY9z1' });
    release();
    await vi.waitFor(() => expect(statusLine().textContent).toMatch(/^Key works/));
    expect(tests).toBe(1);
    expect(keyInput().readOnly).toBe(true);
    expect(keyInput().value.endsWith('9z1')).toBe(true);
  });

  it('Save and test with nothing pasted says so and sends nothing', async () => {
    await start(settings({ api_key: { set: false, masked: '' } }));
    $('ai-key-save').click();
    expect(statusLine()).toHaveTextContent('Paste a key first.');
    expect(puts).toEqual([]);
  });

  it('a test that fails shows the reason', async () => {
    testReply = () =>
      HttpResponse.json({
        ok: false,
        message: 'Anthropic refused this key.',
        saved_key: true,
        key_status: { ...current.key_status, state: 'refused' },
      });
    await start(settings());
    $('ai-key-test').click();
    await vi.waitFor(() => expect(statusLine()).toHaveTextContent('Anthropic refused this key'));
    expect(keyInput()).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('the choices', () => {
  it('the model is a radio group that saves at once, Faster and cheaper by default', async () => {
    await start(settings());
    const fast = radio('ai-model-cards', 'fast');
    const best = radio('ai-model-cards', 'best');
    expect($('ai-model-cards')).toHaveAttribute('role', 'radiogroup');
    expect(fast).toHaveAttribute('aria-checked', 'true');
    expect(fast).toHaveTextContent('Faster and cheaper');
    best.click();
    expect(best).toHaveAttribute('aria-checked', 'true');
    await vi.waitFor(() => expect(puts).toContainEqual({ model: 'best' }));
    await vi.waitFor(() => expect($('ai-save-status')).toHaveTextContent('Saved.'));
    // the arrow keys move the choice and the focus together
    best.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(fast).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(fast);
  });

  it('who can use it: admins only by default', async () => {
    await start(settings());
    expect(radio('ai-who', 'admins')).toHaveAttribute('aria-checked', 'true');
    radio('ai-who', 'everyone').click();
    await vi.waitFor(() => expect(puts).toContainEqual({ who_can_use: 'everyone' }));
  });
});

describe('usage', () => {
  it('shows the month’s numbers and saves a cap, or says why it can’t', async () => {
    await start(settings());
    expect($('ai-usage-card').hidden).toBe(false);
    expect($('ai-usage-requests')).toHaveTextContent('412');
    expect($('ai-usage-cost')).toHaveTextContent('about $1.80');
    expect($('ai-usage-drafts')).toHaveTextContent('7');
    expect($('ai-usage-note')).toHaveTextContent('since 1 October');
    const cap = $<HTMLInputElement>('ai-cap');
    cap.value = '10';
    cap.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(puts).toContainEqual({ monthly_cap_usd: '10' }));
    cap.value = 'lots';
    cap.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect($('ai-cap-error')).toHaveTextContent('Write the cap as an amount in dollars'),
    );
    expect(cap).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('the words', () => {
  it('says when, briefly', () => {
    const now = new Date(2026, 9, 22, 12, 0);
    expect(whenWords(new Date(2026, 9, 22, 10, 52).toISOString(), now)).toBe('today 10:52');
    expect(whenWords(new Date(2026, 9, 21, 9, 5).toISOString(), now)).toBe('yesterday 09:05');
    expect(whenWords(new Date(2026, 9, 2, 9, 5).toISOString(), now, false)).toBe('on 2 October');
    expect(whenWords(null, now)).toBe('');
  });

  it('the key status line for each state', () => {
    const base = settings().key_status;
    expect(keyStatusLine({ ...base, state: 'untested', tested_at: null }).text).toMatch(
      /^Not tested yet · added by ross/,
    );
    expect(keyStatusLine({ ...base, state: 'missing' }).tone).toBe('neutral');
  });

  it('cost and cap', () => {
    expect(costWords(0)).toBe('about $0.00');
    expect(costWords(0.004)).toBe('under $0.01');
    expect(costWords(1.8)).toBe('about $1.80');
    expect(capText(10)).toBe('$10');
    expect(capText(2.5)).toBe('$2.50');
    expect(capText(null)).toBe('');
  });
});
