/**
 * The Automation Assistant's API (docs/design/CONTRACTS.md, "The Assistant"):
 * whether it can be used, the suggestion card, and the conversation, which
 * streams as server-sent events over a plain POST.
 *
 * The Assistant writes drafts only. A draft is exactly the body
 * POST /api/automations/preview takes, plus its name and trigger, already
 * checked on the server against the parts list and the viewer's role.
 */

import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';
import { appURL } from '@/platform/url-base';

import type { ThenAction } from './-automations.types';

export type AiReason = 'not_configured' | 'members_not_allowed' | 'cap_reached' | 'key_refused';

/** GET /api/ai/status. */
export interface AiStatus {
  success?: boolean;
  configured: boolean;
  can_use: boolean;
  reason: AiReason | null;
  model: 'fast' | 'best';
  provider: string;
  provider_name: string;
  is_admin?: boolean;
}

/** A checked draft: the preview body plus the editor's parts. */
export interface AssistantDraft {
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  then_actions: ThenAction[];
}

export interface DraftOffer {
  draft: AssistantDraft;
  summary: string;
  why: string;
  facts: string[];
  /** What the server left out, in sentences ("I left out “Run Script”: …"). */
  notes: string[];
  /** Set when the draft changes an automation the profile already has. */
  automation_id?: number | null;
}

export interface SuggestionOffer extends DraftOffer {
  key: string;
  title: string;
  reason: string;
}

export type AssistantErrorCode =
  | 'bad_key'
  | 'no_credit'
  | 'rate_limited'
  | 'offline'
  | 'cap_reached'
  | 'busy'
  | 'provider_error'
  | 'not_configured'
  | 'members_not_allowed'
  | 'key_refused'
  | 'bad_request';

export type AssistantEvent =
  | { type: 'status'; reading: string }
  | { type: 'quote'; run_id: number; started_at: string | null; lines: string[] }
  | { type: 'text'; delta: string }
  | { type: 'draft'; offer: DraftOffer }
  | { type: 'cant_build'; missing: string; nearest: DraftOffer | null }
  | { type: 'suggestions'; items: SuggestionOffer[] }
  | { type: 'error'; code: AssistantErrorCode; message: string }
  | {
      type: 'done';
      conversation_id: string;
      usage: { input_tokens: number; output_tokens: number; estimated_cost_usd: number };
    };

/** What's on screen, so "explain this" and "fix this run" need no ids. */
export interface AssistantContext {
  page: 'list' | 'editor';
  automation_id?: number | null;
  run_id?: number | null;
  draft?: AssistantDraft | null;
}

export interface AssistantRequest {
  message: string;
  conversation_id?: string | null;
  context: AssistantContext;
}

/** GET /api/ai/suggestion's one card. */
export interface ListSuggestion {
  key: string;
  title: string;
  reason: string;
  draft_prompt: string;
  automation_id: number | null;
}

export const AI_QUERY_KEY = ['ai'] as const;

export function aiStatusQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...AI_QUERY_KEY, 'status', profileId] as const,
    queryFn: () => readJson<AiStatus>(apiClient.get('ai/status')),
    staleTime: 30_000,
    retry: false,
  });
}

export function aiSuggestionQueryOptions(profileId: number, enabled: boolean) {
  return queryOptions({
    queryKey: [...AI_QUERY_KEY, 'suggestion', profileId] as const,
    queryFn: async () => {
      const body = await readJson<{ suggestion?: ListSuggestion | null }>(
        apiClient.get('ai/suggestion'),
      );
      return body.suggestion ?? null;
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export async function dismissSuggestion(key: string): Promise<void> {
  await readJson(apiClient.post(`ai/suggestion/${encodeURIComponent(key)}/dismiss`));
}

/** A field as text: strings and numbers as they are, anything else as ''. */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

/** One SSE frame ("event: x\ndata: {...}") as an event, or null to skip it. */
export function parseFrame(frame: string): AssistantEvent | null {
  let name = '';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // a keep-alive comment
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!name) return null;
  let body: Record<string, unknown> = {};
  try {
    body = data.length ? (JSON.parse(data.join('\n')) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  switch (name) {
    case 'status':
      return { type: 'status', reading: str(body.reading) };
    case 'quote':
      return {
        type: 'quote',
        run_id: Number(body.run_id),
        started_at: (body.started_at as string | null) ?? null,
        lines: Array.isArray(body.lines) ? (body.lines as unknown[]).map(String) : [],
      };
    case 'text':
      return { type: 'text', delta: str(body.delta) };
    case 'draft':
      return { type: 'draft', offer: body as unknown as DraftOffer };
    case 'cant_build':
      return {
        type: 'cant_build',
        missing: str(body.missing),
        nearest: (body.nearest as DraftOffer | null) ?? null,
      };
    case 'suggestions':
      return {
        type: 'suggestions',
        items: Array.isArray(body.items) ? (body.items as SuggestionOffer[]) : [],
      };
    case 'error':
      return {
        type: 'error',
        code: str(body.code, 'provider_error') as AssistantErrorCode,
        message: str(body.message),
      };
    case 'done':
      return {
        type: 'done',
        conversation_id: str(body.conversation_id),
        usage: (body.usage as Extract<AssistantEvent, { type: 'done' }>['usage']) ?? {
          input_tokens: 0,
          output_tokens: 0,
          estimated_cost_usd: 0,
        },
      };
    default:
      return null;
  }
}

/**
 * Ask the Assistant. Calls ``onEvent`` for each event as it arrives. Aborting
 * ``signal`` is Stop: the browser closes the stream and the server stops the
 * provider call. A refused request (not set up, a bad body) arrives as one
 * ``error`` event, so the panel has one place to show it.
 */
export async function streamAssistant(
  request: AssistantRequest,
  onEvent: (event: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(appURL('/api/ai/assistant'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
    const reason = body.reason as AssistantErrorCode | undefined;
    onEvent({
      type: 'error',
      code: reason ?? (response.status === 400 ? 'bad_request' : 'provider_error'),
      message:
        reason || !body.error
          ? 'The Assistant isn’t available right now. Your message is still in the box.'
          : body.error,
    });
    return;
  }
  const reader = response.body.getReader();
  // Stop: cancel the read too, so it ends even where aborting the fetch
  // doesn't reach a body that's already streaming
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let cut = buffer.indexOf('\n\n');
    while (cut >= 0) {
      const event = parseFrame(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
      if (event) onEvent(event);
      cut = buffer.indexOf('\n\n');
    }
  }
  signal?.removeEventListener('abort', cancel);
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const tail = parseFrame(buffer.trim());
  if (tail) onEvent(tail);
}

/** Error notices: what happened, in the colour of the problem (board 3j). */
export function errorCopy(
  code: AssistantErrorCode,
  message: string,
  isAdmin: boolean,
): {
  title: string;
  body: string;
  tone: 'danger' | 'warning';
  action: 'settings' | 'retry' | null;
  meta?: string;
} {
  switch (code) {
    case 'bad_key':
    case 'key_refused':
      return {
        title: 'The AI key didn’t work',
        body: 'Anthropic refused the key saved in Settings → AI. Your message is still in the box; fix the key and send it again.',
        tone: 'danger',
        action: isAdmin ? 'settings' : null,
        meta: isAdmin ? undefined : 'Ask an admin to check the key.',
      };
    case 'no_credit':
      return {
        title: 'The AI account is out of credit',
        body: 'Anthropic says the account behind the key has used up its credit. Your automations run as usual; only the Assistant is affected. Your message is still in the box.',
        tone: 'warning',
        action: isAdmin ? 'settings' : null,
        meta: isAdmin ? undefined : 'Ask an admin to top it up.',
      };
    case 'rate_limited':
      return {
        title: 'Too many requests right now',
        body: `${message || 'Anthropic asked us to slow down. Try again in about a minute.'} The draft above is kept, and so is your message.`,
        tone: 'warning',
        action: 'retry',
      };
    case 'offline':
      return {
        title: 'Couldn’t reach the AI provider',
        body: 'SYNCHRO.S couldn’t connect to Anthropic. Your server may be offline, or the provider is. Your automations still run on their schedule; your message is still in the box.',
        tone: 'danger',
        action: 'retry',
      };
    case 'cap_reached':
      return {
        title: 'This month’s Assistant budget is spent',
        body: `${message || 'The Assistant waits for the 1st.'} Your message is still in the box.`,
        tone: 'warning',
        action: isAdmin ? 'settings' : null,
      };
    case 'busy':
      return {
        title: 'The Assistant is busy',
        body: message || 'It’s answering two other questions. Try again in a moment.',
        tone: 'warning',
        action: 'retry',
      };
    default:
      return {
        title: 'The Assistant couldn’t answer',
        body: `${message || 'Something went wrong on the way.'} Your message is still in the box.`,
        tone: 'danger',
        action: 'retry',
      };
  }
}
