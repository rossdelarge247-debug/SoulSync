import { afterEach, describe, expect, it } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import {
  errorCopy,
  parseFrame,
  streamAssistant,
  type AssistantErrorCode,
  type AssistantEvent,
} from './-automations.assistant';
import {
  _resetConversationsForTests,
  acknowledgeFirstUse,
  ask,
  firstUseAcknowledged,
  getConversation,
  newChat,
  stop,
  updateConversation,
} from './-automations.conversation';

const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function sseBody(text: string): Response {
  return new HttpResponse(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** A stream that sends its frames and then stays open, as a slow answer does. */
function openStream(text: string): Response {
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => {
  _resetConversationsForTests();
  window.localStorage.clear();
});

describe('parseFrame', () => {
  it('reads each event the server sends', () => {
    expect(parseFrame('event: status\ndata: {"reading":"your automations"}')).toEqual({
      type: 'status',
      reading: 'your automations',
    });
    expect(parseFrame('event: text\ndata: {"delta":"Hi"}')).toEqual({ type: 'text', delta: 'Hi' });
    expect(parseFrame('event: error\ndata: {"code":"busy","message":"Two others first."}')).toEqual(
      { type: 'error', code: 'busy', message: 'Two others first.' },
    );
    expect(parseFrame('event: done\ndata: {"conversation_id":"c9"}')).toMatchObject({
      type: 'done',
      conversation_id: 'c9',
    });
  });

  it('skips keep-alives, unknown events and broken data', () => {
    expect(parseFrame(': keep-alive')).toBeNull();
    expect(parseFrame('event: mystery\ndata: {}')).toBeNull();
    expect(parseFrame('event: text\ndata: {not json')).toBeNull();
    expect(parseFrame('data: {"delta":"x"}')).toBeNull();
  });
});

describe('streamAssistant', () => {
  it('delivers events as they arrive, across chunks and keep-alives', async () => {
    server.use(
      http.post('/api/ai/assistant', () =>
        sseBody(
          `: open\n\n${frame('status', { reading: 'runs' })}: keep-alive\n\n${frame('text', {
            delta: 'One',
          })}${frame('text', { delta: ' two' })}${frame('done', { conversation_id: 'c1' })}`,
        ),
      ),
    );
    const events: AssistantEvent[] = [];
    await streamAssistant({ message: 'hi', context: { page: 'list' } }, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['status', 'text', 'text', 'done']);
  });

  it('turns a refused request into one error event', async () => {
    server.use(
      http.post('/api/ai/assistant', () =>
        HttpResponse.json(
          { success: false, error: 'Admins only', reason: 'members_not_allowed' },
          { status: 403 },
        ),
      ),
    );
    const events: AssistantEvent[] = [];
    await streamAssistant({ message: 'hi', context: { page: 'list' } }, (e) => events.push(e));
    expect(events).toEqual([
      {
        type: 'error',
        code: 'members_not_allowed',
        message: 'The Assistant isn’t available right now. Your message is still in the box.',
      },
    ]);

    server.use(
      http.post('/api/ai/assistant', () =>
        HttpResponse.json({ error: 'Say what you want.' }, { status: 400 }),
      ),
    );
    events.length = 0;
    await streamAssistant({ message: '', context: { page: 'list' } }, (e) => events.push(e));
    expect(events).toEqual([{ type: 'error', code: 'bad_request', message: 'Say what you want.' }]);
  });

  it('Stop ends a stream that is still open', async () => {
    server.use(
      http.post('/api/ai/assistant', () => openStream(frame('status', { reading: 'runs' }))),
    );
    const controller = new AbortController();
    const events: AssistantEvent[] = [];
    const done = streamAssistant(
      { message: 'hi', context: { page: 'list' } },
      (e) => {
        events.push(e);
        controller.abort();
      },
      controller.signal,
    );
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.map((e) => e.type)).toEqual(['status']);
  });
});

describe('errorCopy', () => {
  const codes: [AssistantErrorCode, 'danger' | 'warning', string][] = [
    ['bad_key', 'danger', 'The AI key didn’t work'],
    ['key_refused', 'danger', 'The AI key didn’t work'],
    ['no_credit', 'warning', 'The AI account is out of credit'],
    ['rate_limited', 'warning', 'Too many requests right now'],
    ['offline', 'danger', 'Couldn’t reach the AI provider'],
    ['cap_reached', 'warning', 'This month’s Assistant budget is spent'],
    ['busy', 'warning', 'The Assistant is busy'],
    ['provider_error', 'danger', 'The Assistant couldn’t answer'],
  ];
  it.each(codes)('%s: %s, “%s”', (code, tone, title) => {
    const copy = errorCopy(code, '', true);
    expect(copy.tone).toBe(tone);
    expect(copy.title).toBe(title);
  });

  it('sends admins to Settings → AI and tells members who can fix it', () => {
    expect(errorCopy('bad_key', '', true).action).toBe('settings');
    const member = errorCopy('bad_key', '', false);
    expect(member.action).toBeNull();
    expect(member.meta).toBe('Ask an admin to check the key.');
    expect(errorCopy('offline', '', false).action).toBe('retry');
  });
});

describe('the conversation', () => {
  it('streams an answer in, and keeps it per profile in session storage', async () => {
    server.use(
      http.post('/api/ai/assistant', () =>
        sseBody(
          frame('text', { delta: 'Here.' }) +
            frame('draft', {
              draft: { name: 'X' },
              summary: 'A draft',
              why: '',
              facts: [],
              notes: [],
            }) +
            frame('done', { conversation_id: 'c7' }),
        ),
      ),
    );
    await ask(1, 'Make one', { page: 'list' });
    const state = getConversation(1);
    expect(state.open).toBe(true);
    expect(state.conversationId).toBe('c7');
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(state.messages[1]).toMatchObject({ text: 'Here.', state: 'done' });
    expect(state.messages[1].offers?.[0].summary).toBe('A draft');
    const saved = JSON.parse(window.sessionStorage.getItem('soulsync.assistant.1')!);
    expect(saved.conversationId).toBe('c7');
    expect(getConversation(2).messages).toEqual([]);
  });

  it('puts the message back in the box when the answer fails', async () => {
    server.use(
      http.post('/api/ai/assistant', () =>
        sseBody(frame('error', { code: 'rate_limited', message: 'Slow down.' })),
      ),
    );
    await ask(1, 'Make one', { page: 'list' });
    const state = getConversation(1);
    expect(state.composer).toBe('Make one');
    expect(state.messages[1]).toMatchObject({
      state: 'error',
      error: { code: 'rate_limited', message: 'Slow down.' },
    });
  });

  it('Stop marks the answer stopped; New chat forgets the thread', async () => {
    server.use(
      http.post('/api/ai/assistant', () => openStream(frame('status', { reading: 'runs' }))),
    );
    const asking = ask(1, 'Why?', { page: 'list' });
    await new Promise((r) => setTimeout(r, 50));
    expect(getConversation(1).messages[1].reading).toBe('runs');
    stop(1);
    await asking;
    expect(getConversation(1).messages[1].state).toBe('stopped');
    newChat(1);
    expect(getConversation(1)).toMatchObject({ messages: [], conversationId: null, open: true });
  });

  it('an answer cut off by a reload comes back stopped, not thinking', () => {
    updateConversation(3, (s) => ({
      ...s,
      messages: [{ id: 'a', role: 'assistant', text: 'Half', state: 'streaming' }],
    }));
    const saved = window.sessionStorage.getItem('soulsync.assistant.3')!;
    _resetConversationsForTests();
    window.sessionStorage.setItem('soulsync.assistant.3', saved);
    expect(getConversation(3).messages[0].state).toBe('stopped');
  });

  it('remembers the first-use notice per profile', () => {
    expect(firstUseAcknowledged(1)).toBe(false);
    acknowledgeFirstUse(1);
    expect(firstUseAcknowledged(1)).toBe(true);
    expect(firstUseAcknowledged(2)).toBe(false);
  });
});
