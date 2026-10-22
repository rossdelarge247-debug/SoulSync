/**
 * The Assistant panel (boards 3a, 3c–3k): one conversation, shown in the
 * list's right column (in place of Runs), in the editor's right column (the
 * Assistant tab beside Preview), or as a full-screen sheet on a phone.
 *
 * It writes drafts only: a draft opens in the editor, where the person
 * previews it and saves it themselves. Library text it quotes (run logs) is
 * shown as data, in Activity's log style.
 */

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

import { Button } from '@/components/form';
import { Notice, Spinner, StatusTag } from '@/components/primitives';

import type { AutomationBlocks } from '../-automations.types';

import {
  errorCopy,
  type AiStatus,
  type AssistantContext,
  type DraftOffer,
  type SuggestionOffer,
} from '../-automations.assistant';
import {
  acknowledgeFirstUse,
  firstUseAcknowledged,
  useConversation,
  type ThreadMessage,
} from '../-automations.conversation';
import { actionSentence, schedulePhrase, thenSentence } from '../-automations.steps';
import styles from './automations.module.css';

export type PanelVariant = 'list' | 'editor' | 'sheet';

function CloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function SettingsLink({ children }: { children: ReactNode }) {
  return (
    <Button
      size="lg"
      variant="primary"
      onClick={() => {
        if (typeof window.openAiSettings === 'function') window.openAiSettings();
        else window.location.assign('/settings?tab=ai');
      }}
    >
      {children}
    </Button>
  );
}

/** The When / Do / Then mini list of a draft. */
function DraftBlocks({ offer, blocks }: { offer: DraftOffer; blocks?: AutomationBlocks }) {
  const d = offer.draft;
  return (
    <dl className={styles.draftBlocks}>
      <div className={styles.draftBlockRow}>
        <dt>When</dt>
        <dd>
          {schedulePhrase(
            { trigger_type: d.trigger_type, trigger_config: d.trigger_config },
            blocks,
          )}
        </dd>
      </div>
      <div className={styles.draftBlockRow}>
        <dt>Do</dt>
        <dd>{actionSentence(d.action_type, d.action_config, { blocks })}</dd>
      </div>
      {d.then_actions.map((t, i) => (
        <div key={i} className={styles.draftBlockRow}>
          <dt>{i === 0 ? 'Then' : <span className={styles.srOnly}>Then</span>}</dt>
          <dd>{thenSentence(t)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DraftCard({
  offer,
  variant,
  blocks,
  label,
  primaryLabel,
  onOpen,
  onPreview,
  onRetry,
}: {
  offer: DraftOffer;
  variant: PanelVariant;
  blocks?: AutomationBlocks;
  /** "Nearest I can build" for the couldn't-build card. */
  label?: string;
  primaryLabel: string;
  onOpen: () => void;
  onPreview?: () => void;
  onRetry?: () => void;
}) {
  return (
    <article className={styles.draftCard} data-testid="draft-card" data-variant={variant}>
      <div className={styles.draftMain}>
        {label ? (
          <p className={styles.panelLabel}>{label}</p>
        ) : (
          <p className={styles.draftTagRow}>
            <StatusTag tone="info">Draft ready</StatusTag>
            {variant === 'editor' ? <span className={styles.panelMeta}>for the editor</span> : null}
          </p>
        )}
        <p className={styles.draftSummary}>{offer.summary}</p>
        {offer.why ? <p className={styles.draftWhy}>Why this shape: {offer.why}</p> : null}
        {offer.notes?.map((note) => (
          <p key={note} className={styles.draftNote}>
            {note}
          </p>
        ))}
      </div>
      <DraftBlocks offer={offer} blocks={blocks} />
      <div className={styles.draftActions} data-variant={variant}>
        <Button size="lg" variant={variant === 'editor' ? 'default' : 'primary'} onClick={onOpen}>
          {primaryLabel}
        </Button>
        {onPreview ? (
          <Button size="lg" onClick={onPreview}>
            Preview a run
          </Button>
        ) : null}
        {onRetry ? (
          <Button size="lg" variant="ghost" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function SuggestionCards({
  message,
  onUse,
  onHide,
}: {
  message: ThreadMessage;
  onUse: (s: SuggestionOffer) => void;
  onHide: (key: string) => void;
}) {
  const items = (message.suggestions ?? []).filter((s) => !(message.hidden ?? []).includes(s.key));
  if (!items.length) return null;
  return (
    <>
      <ul className={styles.suggestionList}>
        {items.map((s) => (
          <li key={s.key} className={styles.suggestionItem}>
            <p className={styles.suggestionTitle}>{s.title}</p>
            <p className={styles.suggestionReason}>{s.reason}</p>
            <div className={styles.draftActions}>
              <Button size="lg" onClick={() => onUse(s)}>
                Use this
              </Button>
              <Button size="lg" variant="ghost" onClick={() => onHide(s.key)}>
                Not now
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className={styles.panelMeta}>
        “Use this” opens a draft in the editor. Nothing is saved or run until you save it.
      </p>
    </>
  );
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p, i) => (
          <p key={i} className={styles.threadText}>
            {p}
          </p>
        ))}
    </>
  );
}

function AssistantMessage({
  message,
  variant,
  isAdmin,
  blocks,
  onOpenDraft,
  onPreviewDraft,
  onRetry,
  onStop,
  onHide,
}: {
  message: ThreadMessage;
  variant: PanelVariant;
  isAdmin: boolean;
  blocks?: AutomationBlocks;
  onOpenDraft: (offer: DraftOffer) => void;
  onPreviewDraft: (offer: DraftOffer) => void;
  onRetry: () => void;
  onStop: () => void;
  onHide: (key: string) => void;
}) {
  const thinking = message.state === 'thinking';
  const streaming = message.state === 'streaming';
  const primary = variant === 'editor' ? 'Put it in the editor' : 'Open in the editor';
  return (
    <div className={styles.threadEntry} data-role="assistant" aria-busy={thinking || streaming}>
      <p className={styles.panelLabel}>Assistant</p>
      {message.quote?.lines.length ? (
        <>
          <p className={styles.threadText}>The log’s last lines:</p>
          <pre className={styles.runLog} aria-label="The run’s log">
            {message.quote.lines.map((line, i) => (
              <span key={i} className={styles.logLine}>
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        </>
      ) : null}
      {thinking ? (
        <div className={styles.thinking} role="status">
          <Spinner size={20} />
          <p className={styles.thinkingText}>
            Thinking…{message.reading ? ` reading ${message.reading}.` : ''}
          </p>
          <Button size="lg" onClick={onStop}>
            Stop
          </Button>
        </div>
      ) : null}
      {message.text ? <Paragraphs text={message.text} /> : null}
      {streaming ? (
        <div className={styles.thinking}>
          <span className={styles.panelMeta}>Writing…</span>
          <Button size="lg" onClick={onStop}>
            Stop
          </Button>
        </div>
      ) : null}
      {message.cantBuild ? (
        <>
          <Notice tone="warning" title="I can’t build that exactly">
            {message.cantBuild.missing}
          </Notice>
          {message.cantBuild.nearest ? (
            <DraftCard
              offer={message.cantBuild.nearest}
              variant={variant}
              blocks={blocks}
              label="Nearest I can build"
              primaryLabel="Use the nearest"
              onOpen={() => onOpenDraft(message.cantBuild!.nearest!)}
              onRetry={onRetry}
            />
          ) : null}
        </>
      ) : null}
      {message.offers?.map((offer, i) => (
        <DraftCard
          key={i}
          offer={offer}
          variant={variant}
          blocks={blocks}
          primaryLabel={primary}
          onOpen={() => onOpenDraft(offer)}
          onPreview={() => onPreviewDraft(offer)}
          onRetry={onRetry}
        />
      ))}
      {message.offers?.length && variant !== 'editor' ? (
        <p className={styles.panelMeta}>
          Nothing is saved yet. Open it in the editor to change blocks and save.
        </p>
      ) : null}
      <SuggestionCards
        message={message}
        onUse={(s) => onOpenDraft(s)}
        onHide={(key) => onHide(key)}
      />
      {message.state === 'stopped' ? (
        <p className={styles.panelMeta}>Stopped. Nothing was changed.</p>
      ) : null}
      {message.error ? (
        <ErrorNotice
          code={message.error.code}
          message={message.error.message}
          isAdmin={isAdmin}
          onRetry={onRetry}
        />
      ) : null}
    </div>
  );
}

function ErrorNotice({
  code,
  message,
  isAdmin,
  onRetry,
}: {
  code: Parameters<typeof errorCopy>[0];
  message: string;
  isAdmin: boolean;
  onRetry?: () => void;
}) {
  const copy = errorCopy(code, message, isAdmin);
  return (
    <Notice
      tone={copy.tone}
      role="alert"
      title={copy.title}
      actions={
        copy.action === 'settings' ? (
          <SettingsLink>Open Settings → AI</SettingsLink>
        ) : copy.action === 'retry' && onRetry ? (
          <Button size="lg" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {copy.body}
      {copy.meta ? <span className={styles.noticeMeta}> {copy.meta}</span> : null}
    </Notice>
  );
}

/** What the panel shows instead of a conversation when it can't be used. */
function Unavailable({ status, isAdmin }: { status: AiStatus; isAdmin: boolean }) {
  switch (status.reason) {
    case 'not_configured':
      return isAdmin ? (
        <div className={styles.panelEmpty} data-testid="assistant-not-set-up">
          <h3 className={styles.panelEmptyTitle}>Set up the Assistant</h3>
          <p className={styles.threadText}>
            It turns a sentence into a draft automation, suggests what’s worth automating, and
            explains runs. It needs an AI provider and your own API key, which stay on your server.
          </p>
          <div className={styles.panelEmptyActions}>
            <SettingsLink>Open Settings → AI</SettingsLink>
            <span className={styles.panelMeta}>Admins only</span>
          </div>
        </div>
      ) : (
        <div className={styles.panelEmpty} data-testid="assistant-not-set-up">
          <h3 className={styles.panelEmptyTitle}>Ask an admin to set this up</h3>
          <p className={styles.threadText}>
            The Assistant needs an AI API key that only an admin can add, in Settings → AI. Once
            it’s there, it works for everyone it’s turned on for.
          </p>
        </div>
      );
    case 'members_not_allowed':
      return (
        <div className={styles.panelEmpty} data-testid="assistant-admins-only">
          <h3 className={styles.panelEmptyTitle}>The Assistant is for admins here</h3>
          <p className={styles.threadText}>
            An admin can let everyone with a profile use it, in Settings → AI.
          </p>
        </div>
      );
    case 'key_refused':
      return <ErrorNotice code="key_refused" message="" isAdmin={isAdmin} />;
    case 'cap_reached':
      return (
        <Notice
          tone="warning"
          role="alert"
          title="This month’s Assistant budget is spent"
          actions={isAdmin ? <SettingsLink>Open Settings → AI</SettingsLink> : undefined}
        >
          The Assistant waits for the 1st. Your automations run as usual.
        </Notice>
      );
    default:
      return null;
  }
}

export function AssistantPanel({
  variant,
  profileId,
  isAdmin,
  status,
  statusLoading,
  blocks,
  context,
  onOpenDraft,
  onPreviewDraft,
  onClose,
  tabs,
  composerRef,
  placeholder,
}: {
  variant: PanelVariant;
  profileId: number;
  isAdmin: boolean;
  status: AiStatus | undefined;
  statusLoading: boolean;
  blocks?: AutomationBlocks;
  /** What's on screen when a message is sent. */
  context: () => AssistantContext;
  onOpenDraft: (offer: DraftOffer) => void;
  onPreviewDraft: (offer: DraftOffer) => void;
  onClose: () => void;
  /** The editor's Assistant / Preview tabs, in place of the title. */
  tabs?: ReactNode;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}) {
  const conversation = useConversation(profileId);
  const { state, asking } = conversation;
  const threadRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = composerRef ?? ownRef;
  const usable = Boolean(status?.can_use);
  const acked = firstUseAcknowledged(profileId);
  const provider = status?.provider_name || 'Anthropic';

  // keep the newest words in view while they stream
  const last = state.messages[state.messages.length - 1];
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, last?.text, last?.state]);

  // the sheet: Escape closes it, focus starts in it
  useEffect(() => {
    if (variant !== 'sheet') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [variant, onClose]);

  const send = (text?: string) => {
    const message = (text ?? state.composer).trim();
    if (!message || asking) return;
    conversation.ask(message, context());
  };
  const retry = (m: ThreadMessage) => {
    if (!m.ask || asking) return;
    conversation.ask(m.ask.message, m.ask.context, m.ask.from);
  };

  const dataLine =
    variant === 'sheet'
      ? `Drafts only · sent to ${provider} (Settings → AI)`
      : `Writes drafts only. Sends your message, ${variant === 'editor' ? 'this draft' : 'your automations'} and the library facts it uses to ${provider} (Settings → AI).`;

  const header = (
    <div className={styles.assistantHead}>
      {tabs ?? (
        <h2 className={styles.panelTitle} id={titleId}>
          Assistant
        </h2>
      )}
      <div className={styles.assistantHeadActions}>
        {usable && state.messages.length ? (
          <Button size="lg" variant="ghost" onClick={conversation.newChat}>
            New chat
          </Button>
        ) : null}
        <button
          type="button"
          className={styles.iconButton}
          data-variant="bare"
          aria-label="Close the Assistant"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );

  let body: ReactNode;
  if (statusLoading && !status) {
    body = (
      <p className={styles.previewLoading} role="status">
        <Spinner size={18} />
        <span>Checking the Assistant…</span>
      </p>
    );
  } else if (!status) {
    body = (
      <Notice tone="danger" role="alert" title="Couldn’t check the Assistant">
        SYNCHRO.S didn’t answer. Your automations are safe; try again in a moment.
      </Notice>
    );
  } else if (!usable) {
    body = <Unavailable status={status} isAdmin={isAdmin} />;
  } else {
    body = (
      <>
        {!acked ? (
          <div className={styles.firstUse} data-testid="assistant-first-use">
            <p className={styles.threadText}>
              {
                'First time here: what you type, your automations and their runs, and the library facts the Assistant uses (counts, targets, setup results) are sent to '
              }
              <strong>{provider}</strong>
              {
                ', the provider set up in Settings → AI. Track and playlist names go as information, never as instructions.'
              }
            </p>
            <Button
              size="lg"
              variant="ghost"
              onClick={() => {
                acknowledgeFirstUse(profileId);
                conversation.set({});
              }}
            >
              Got it
            </Button>
          </div>
        ) : null}
        {state.messages.length === 0 ? (
          <div className={styles.threadIntro}>
            <p className={styles.threadText}>
              Describe an automation and I’ll draft it, or ask about one you have. I write drafts
              only: nothing is saved or run until you save it.
            </p>
            <div>
              <Button size="lg" onClick={() => send('What’s worth automating?')}>
                What’s worth automating?
              </Button>
            </div>
          </div>
        ) : null}
        {state.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className={styles.threadEntry} data-role="user">
              <p className={styles.panelLabel}>You{m.from ? <span> · {m.from}</span> : null}</p>
              <p className={styles.threadText}>{m.text}</p>
            </div>
          ) : (
            <AssistantMessage
              key={m.id}
              message={m}
              variant={variant}
              isAdmin={isAdmin}
              blocks={blocks}
              onOpenDraft={onOpenDraft}
              onPreviewDraft={onPreviewDraft}
              onRetry={() => retry(m)}
              onStop={conversation.stop}
              onHide={(key) => conversation.hideSuggestion(m.id, key)}
            />
          ),
        )}
      </>
    );
  }

  return (
    <section
      className={styles.assistantPanel}
      data-variant={variant}
      data-testid="assistant-panel"
      aria-labelledby={tabs ? undefined : titleId}
      aria-label={tabs ? 'Assistant' : undefined}
      role={variant === 'sheet' ? 'dialog' : undefined}
      aria-modal={variant === 'sheet' ? true : undefined}
    >
      {header}
      <div className={styles.thread} ref={threadRef} aria-live="polite">
        {body}
      </div>
      {usable ? (
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <div className={styles.composerRow}>
            <textarea
              ref={inputRef}
              className={styles.composerInput}
              aria-label="Message the Assistant"
              rows={2}
              placeholder={
                asking
                  ? 'Waiting for the answer…'
                  : (placeholder ??
                    (state.messages.some((m) => m.offers?.length)
                      ? 'Change the draft, or ask about it…'
                      : 'Describe an automation, or ask about one…'))
              }
              value={state.composer}
              onChange={(event) => conversation.set({ composer: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <Button
              type="submit"
              size="lg"
              variant="primary"
              className={styles.sendButton}
              aria-label="Send"
              disabled={asking}
              focusableWhenDisabled
            >
              <SendIcon />
            </Button>
          </div>
          <p className={styles.dataLine}>{dataLine}</p>
        </form>
      ) : null}
    </section>
  );
}
