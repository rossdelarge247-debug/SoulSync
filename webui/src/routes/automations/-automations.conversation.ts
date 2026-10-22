/**
 * The Assistant's one conversation, which follows you between the list and
 * the editor. Kept per profile in session storage (a reload keeps it; a new
 * tab or a sign-out doesn't), with a module-level stream so leaving the list
 * for the editor mid-answer doesn't drop it.
 */

import { useCallback, useSyncExternalStore } from 'react';

import {
  streamAssistant,
  type AssistantContext,
  type AssistantErrorCode,
  type AssistantEvent,
  type DraftOffer,
  type SuggestionOffer,
} from './-automations.assistant';

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** "From the Fill Wanted card", "From the run on Tue 21:15". */
  from?: string;
  state?: 'thinking' | 'streaming' | 'done' | 'stopped' | 'error';
  reading?: string;
  quote?: { started_at: string | null; lines: string[] } | null;
  offers?: DraftOffer[];
  cantBuild?: { missing: string; nearest: DraftOffer | null } | null;
  suggestions?: SuggestionOffer[];
  /** Suggestions answered "Not now" in the thread. */
  hidden?: string[];
  error?: { code: AssistantErrorCode; message: string } | null;
  /** What was asked, so Try again can ask it again. */
  ask?: { message: string; context: AssistantContext; from?: string };
}

export interface ConversationState {
  open: boolean;
  conversationId: string | null;
  messages: ThreadMessage[];
  composer: string;
  /** A draft on its way to the editor ("Open in the editor"). */
  pendingDraft: DraftOffer | null;
}

const MAX_MESSAGES = 40;
const EMPTY: ConversationState = {
  open: false,
  conversationId: null,
  messages: [],
  composer: '',
  pendingDraft: null,
};

const states = new Map<number, ConversationState>();
const listeners = new Set<() => void>();
const streams = new Map<number, AbortController>();
let seed = 0;

function storageKey(profileId: number): string {
  return `soulsync.assistant.${profileId}`;
}

function load(profileId: number): ConversationState {
  try {
    const raw = window.sessionStorage.getItem(storageKey(profileId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ConversationState>;
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      return {
        ...EMPTY,
        ...parsed,
        // an answer that was streaming when the page went away isn't coming
        messages: messages.map((m) =>
          m.state === 'thinking' || m.state === 'streaming' ? { ...m, state: 'stopped' } : m,
        ),
      };
    }
  } catch {
    /* no storage: the conversation lasts as long as the page */
  }
  return { ...EMPTY };
}

function save(profileId: number, state: ConversationState): void {
  try {
    window.sessionStorage.setItem(storageKey(profileId), JSON.stringify(state));
  } catch {
    /* full or blocked: it still works for this page */
  }
}

export function getConversation(profileId: number): ConversationState {
  let state = states.get(profileId);
  if (!state) {
    state = load(profileId);
    states.set(profileId, state);
  }
  return state;
}

export function updateConversation(
  profileId: number,
  change: (state: ConversationState) => ConversationState,
): void {
  const next = change(getConversation(profileId));
  next.messages = next.messages.slice(-MAX_MESSAGES);
  states.set(profileId, next);
  save(profileId, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function messageId(): string {
  seed += 1;
  return `m${Date.now().toString(36)}${seed}`;
}

function patchMessage(profileId: number, id: string, patch: (m: ThreadMessage) => ThreadMessage) {
  updateConversation(profileId, (s) => ({
    ...s,
    messages: s.messages.map((m) => (m.id === id ? patch(m) : m)),
  }));
}

/** Apply one stream event to the answer it belongs to. */
export function applyEvent(message: ThreadMessage, event: AssistantEvent): ThreadMessage {
  switch (event.type) {
    case 'status':
      return { ...message, reading: event.reading };
    case 'quote':
      return { ...message, quote: { started_at: event.started_at, lines: event.lines } };
    case 'text':
      return { ...message, state: 'streaming', text: message.text + event.delta };
    case 'draft':
      return { ...message, offers: [...(message.offers ?? []), event.offer] };
    case 'cant_build':
      return { ...message, cantBuild: { missing: event.missing, nearest: event.nearest } };
    case 'suggestions':
      return { ...message, suggestions: event.items };
    case 'error':
      return { ...message, state: 'error', error: { code: event.code, message: event.message } };
    case 'done':
      return { ...message, state: 'done' };
    default:
      return message;
  }
}

/** Ask. The answer streams into the conversation, wherever you are. */
export async function ask(
  profileId: number,
  message: string,
  context: AssistantContext,
  from?: string,
): Promise<void> {
  const text = message.trim();
  if (!text) return;
  streams.get(profileId)?.abort();
  const controller = new AbortController();
  streams.set(profileId, controller);
  const answerId = messageId();
  updateConversation(profileId, (s) => ({
    ...s,
    open: true,
    composer: '',
    messages: [
      ...s.messages,
      { id: messageId(), role: 'user', text, from },
      {
        id: answerId,
        role: 'assistant',
        text: '',
        state: 'thinking',
        ask: { message: text, context, from },
      },
    ],
  }));
  let errored = false;
  try {
    await streamAssistant(
      { message: text, conversation_id: getConversation(profileId).conversationId, context },
      (event) => {
        if (event.type === 'done') {
          updateConversation(profileId, (s) => ({ ...s, conversationId: event.conversation_id }));
        }
        if (event.type === 'error') {
          errored = true;
          // nothing typed is lost: the message goes back in the box
          updateConversation(profileId, (s) => ({ ...s, composer: s.composer || text }));
        }
        patchMessage(profileId, answerId, (m) => applyEvent(m, event));
      },
      controller.signal,
    );
    patchMessage(profileId, answerId, (m) =>
      m.state === 'thinking' || m.state === 'streaming' ? { ...m, state: 'done' } : m,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      patchMessage(profileId, answerId, (m) => ({ ...m, state: 'stopped' }));
    } else if (!errored) {
      updateConversation(profileId, (s) => ({ ...s, composer: s.composer || text }));
      patchMessage(profileId, answerId, (m) => ({
        ...m,
        state: 'error',
        error: {
          code: 'offline',
          message: (error as Error).message || 'The connection to SYNCHRO.S dropped.',
        },
      }));
    }
  } finally {
    if (streams.get(profileId) === controller) streams.delete(profileId);
  }
}

/** Stop: closes the stream; the server stops the provider call. */
export function stop(profileId: number): void {
  streams.get(profileId)?.abort();
}

export function isAsking(profileId: number): boolean {
  return streams.has(profileId);
}

/** New chat: forget the thread (the server forgets it after two hours). */
export function newChat(profileId: number): void {
  stop(profileId);
  updateConversation(profileId, (s) => ({
    ...EMPTY,
    open: s.open,
    composer: '',
  }));
}

/** Test seam. */
export function _resetConversationsForTests(): void {
  for (const controller of streams.values()) controller.abort();
  streams.clear();
  states.clear();
  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith('soulsync.assistant.')) window.sessionStorage.removeItem(key);
    }
  } catch {
    /* no storage */
  }
}

/** The conversation, kept current, and its actions. */
export function useConversation(profileId: number) {
  const state = useSyncExternalStore(
    subscribe,
    () => getConversation(profileId),
    () => getConversation(profileId),
  );
  const set = useCallback(
    (change: Partial<ConversationState>) =>
      updateConversation(profileId, (s) => ({ ...s, ...change })),
    [profileId],
  );
  return {
    state,
    set,
    asking: state.messages.some((m) => m.state === 'thinking' || m.state === 'streaming'),
    ask: (message: string, context: AssistantContext, from?: string) =>
      void ask(profileId, message, context, from),
    stop: () => stop(profileId),
    newChat: () => newChat(profileId),
    hideSuggestion: (messageId_: string, key: string) =>
      patchMessage(profileId, messageId_, (m) => ({ ...m, hidden: [...(m.hidden ?? []), key] })),
  };
}

const ACK_KEY = 'soulsync.assistant.firstUse.';

/** The first-use data notice stays until "Got it", per profile, per browser. */
export function firstUseAcknowledged(profileId: number): boolean {
  try {
    return window.localStorage.getItem(`${ACK_KEY}${profileId}`) === '1';
  } catch {
    return false;
  }
}

export function acknowledgeFirstUse(profileId: number): void {
  try {
    window.localStorage.setItem(`${ACK_KEY}${profileId}`, '1');
  } catch {
    /* it shows again next time */
  }
}
