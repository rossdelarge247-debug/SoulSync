"""One Assistant request, as server-sent events (POST /api/ai/assistant).

Events, in the order they can come (docs/design/CONTRACTS.md, "The Assistant"):

- ``status {reading}``: what it's reading, for the Thinking state;
- ``quote {run_id, started_at, lines}``: the log lines it read, when the
  request is about a run, shown as data under the question;
- ``text {delta}``: the reply, a piece at a time;
- ``draft {draft, summary, why, facts, notes, automation_id}``;
- ``cant_build {missing, nearest}``;
- ``suggestions {items: [{key, title, reason, summary, why, facts, draft}]}``;
- ``error {code, message}``: ``bad_key``, ``no_credit``, ``rate_limited``,
  ``offline``, ``cap_reached``, ``busy`` or ``provider_error``;
- ``done {conversation_id, usage}``.

At most ``MAX_STREAMS`` run at once: each holds one of the server's threads
for as long as it streams, so a third is told ``busy`` straight away. When
the browser closes the stream (Stop), the server's write fails, this
generator is closed, and closing it closes the provider call. Usage is
counted for every request that reached the provider, stopped or not.

Never logs the key or the prompt; a request is logged at debug level by its
size only.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional

from core.ai import config as ai_config
from core.ai import context as ai_context
from core.ai import drafts as ai_drafts
from core.ai import prompt as ai_prompt
from core.ai import store
from core.ai.provider import AnthropicProvider, ProviderError

logger = logging.getLogger(__name__)

MAX_STREAMS = 2
MAX_MESSAGE = 4000
HISTORY_MESSAGES = 6
CONVERSATION_TTL = 2 * 3600
MAX_CONVERSATIONS = 200
KEEPALIVE_SECONDS = 5.0
CONVERSATION_RE = re.compile(r"^[a-f0-9]{8,64}$")

_slots = threading.BoundedSemaphore(MAX_STREAMS)
_conversations: "OrderedDict[tuple, Dict[str, Any]]" = OrderedDict()
_conversations_lock = threading.Lock()

ProviderFactory = Callable[[str, str], Any]


def default_provider_factory(api_key: str, model: str):
    return AnthropicProvider(api_key, model)


# ── status ─────────────────────────────────────────────────────────────────

def status(config, database, *, is_admin: bool) -> Dict[str, Any]:
    """GET /api/ai/status. ``reason`` is None when the Assistant can be used."""
    configured = bool(ai_config.api_key(config))
    usage = store.month_usage(database)
    cap = ai_config.monthly_cap(config)
    reason = None
    if not configured:
        reason = "not_configured"
    elif not is_admin and ai_config.who_can_use(config) == "admins":
        reason = "members_not_allowed"
    elif ai_config.key_status(config)["state"] == "refused":
        reason = "key_refused"
    elif cap is not None and usage["cost_usd"] >= cap:
        reason = "cap_reached"
    provider = ai_config.provider(config)
    out: Dict[str, Any] = {
        "success": True,
        "configured": configured,
        "can_use": reason is None,
        "reason": reason,
        "model": ai_config.model_key(config),
        "provider": provider,
        "provider_name": ai_config.PROVIDERS[provider]["name"],
        "is_admin": bool(is_admin),
    }
    if is_admin:
        out["usage"] = usage_payload(usage, cap)
    return out


def usage_payload(usage: Dict[str, Any], cap: Optional[float]) -> Dict[str, Any]:
    return {
        "month": usage["month"],
        "requests": usage["requests"],
        "input_tokens": usage["input_tokens"] + usage["cache_read_tokens"] + usage["cache_write_tokens"],
        "output_tokens": usage["output_tokens"],
        "estimated_cost_usd": round(float(usage["cost_usd"]), 4),
        "drafts_saved": usage["drafts_saved"],
        "cap_usd": cap,
    }


# ── conversations ──────────────────────────────────────────────────────────

def _history(profile_id: int, conversation_id: str) -> List[Dict[str, Any]]:
    now = time.time()
    with _conversations_lock:
        for key in [k for k, v in _conversations.items() if now - v["at"] > CONVERSATION_TTL]:
            _conversations.pop(key, None)
        entry = _conversations.get((profile_id, conversation_id))
        return [dict(m) for m in entry["messages"]] if entry else []


def _remember(profile_id: int, conversation_id: str, user_text: str, assistant_text: str) -> None:
    with _conversations_lock:
        key = (profile_id, conversation_id)
        entry = _conversations.pop(key, None) or {"messages": []}
        entry["messages"].extend([
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": assistant_text or "(no answer)"},
        ])
        entry["messages"] = entry["messages"][-HISTORY_MESSAGES:]
        entry["at"] = time.time()
        _conversations[key] = entry
        while len(_conversations) > MAX_CONVERSATIONS:
            _conversations.popitem(last=False)


def reset_for_tests() -> None:
    global _slots
    with _conversations_lock:
        _conversations.clear()
    _slots = threading.BoundedSemaphore(MAX_STREAMS)


# ── the request ────────────────────────────────────────────────────────────

@dataclass
class AssistantRequest:
    profile_id: int
    is_admin: bool
    message: str
    conversation_id: Optional[str] = None
    page: str = "list"
    automation_id: Optional[int] = None
    run_id: Optional[int] = None
    draft: Optional[Dict[str, Any]] = None
    actor: str = "the Assistant"
    extra: Dict[str, Any] = field(default_factory=dict)


class RequestError(ValueError):
    pass


def _int_or_none(value: Any) -> Optional[int]:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def parse_request(body: Any, *, profile_id: int, is_admin: bool, actor: str = "the Assistant") -> AssistantRequest:
    """The POST body ``{conversation_id?, message, context}``. Raises
    RequestError with a sentence to show."""
    if not isinstance(body, dict):
        raise RequestError("Send the message as JSON.")
    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        raise RequestError("Write a message first.")
    message = message.strip()
    if len(message) > MAX_MESSAGE:
        raise RequestError(f"That message is too long. Keep it under {MAX_MESSAGE} characters.")
    cid = body.get("conversation_id")
    cid = cid.lower() if isinstance(cid, str) and CONVERSATION_RE.match(cid.lower()) else None
    ctx = body.get("context") if isinstance(body.get("context"), dict) else {}
    draft = ctx.get("draft") if isinstance(ctx.get("draft"), dict) else None
    return AssistantRequest(
        profile_id=int(profile_id), is_admin=bool(is_admin), message=message, conversation_id=cid,
        page="editor" if ctx.get("page") == "editor" else "list",
        automation_id=_int_or_none(ctx.get("automation_id")), run_id=_int_or_none(ctx.get("run_id")),
        draft=draft, actor=actor)


def sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


def _first_reading(req: AssistantRequest) -> str:
    if req.run_id:
        return "the run's log and the runs around it"
    if req.automation_id:
        return "the automation and its last 10 runs"
    if req.draft:
        return "the draft and your automations"
    return "your automations, Wanted and your targets"


def _explained(raw: Dict[str, Any], blocks, facts: ai_context.Facts, is_admin: bool):
    """A tool's {summary, why, facts, draft} checked; (payload, notes)."""
    if not isinstance(raw, dict):
        return None, ["The draft didn't come back in a shape I can use."]
    cleaned, notes = ai_drafts.clean_draft(ai_drafts.from_tool(raw.get("draft")), blocks, is_admin=is_admin,
                                           playlist_ids=facts.playlist_ids, scripts=facts.scripts)
    if cleaned is None:
        return None, notes
    facts_list = [ai_drafts._text(f, 120) for f in raw.get("facts") or [] if ai_drafts._text(f, 120)][:6]
    return {
        "draft": cleaned,
        "summary": ai_drafts._text(raw.get("summary"), 300) or cleaned["name"],
        "why": ai_drafts._text(raw.get("why"), 600),
        "facts": facts_list,
        "notes": notes,
    }, notes


def _tool_events(calls, blocks, facts: ai_context.Facts, req: AssistantRequest, database):
    """(events, words for the history) for the tool calls of one answer."""
    from core.automation.api import automation_for_viewer

    events: List[str] = []
    noted: List[str] = []
    for call in calls:
        data = call.input if isinstance(call.input, dict) else {}
        if call.name == "propose_draft":
            payload, notes = _explained(data, blocks, facts, req.is_admin)
            if payload is None:
                events.append(sse("cant_build", {"missing": notes[0] if notes else "I couldn't build that.",
                                                 "nearest": None}))
                noted.append("[I couldn't build that draft.]")
                continue
            target = _int_or_none(data.get("automation_id"))
            if target is not None and automation_for_viewer(database, target, req.profile_id) is None:
                target = None
            payload["automation_id"] = target
            events.append(sse("draft", payload))
            noted.append(f"[I offered a draft: {payload['summary']}]")
        elif call.name == "cant_build":
            missing = ai_drafts._text(data.get("missing"), 600) or "The engine can't do that."
            nearest = None
            if isinstance(data.get("nearest"), dict):
                nearest, _notes = _explained(data["nearest"], blocks, facts, req.is_admin)
            events.append(sse("cant_build", {"missing": missing, "nearest": nearest}))
            noted.append(f"[I said I can't build that exactly: {missing}]")
        elif call.name == "suggest_automations":
            items = []
            for n, item in enumerate(data.get("items") or []):
                if not isinstance(item, dict) or len(items) >= 3:
                    continue
                reason = ai_drafts._text(item.get("reason"), 400)
                if not re.search(r"\d", reason):
                    continue  # a suggestion always says why with a number
                payload, _notes = _explained(item, blocks, facts, req.is_admin)
                if payload is None:
                    continue
                items.append({"key": f"chat-{n + 1}", "title": ai_drafts._text(item.get("title"), 120)
                              or payload["summary"], "reason": reason, **payload})
            if items:
                events.append(sse("suggestions", {"items": items}))
                noted.append("[I suggested: " + "; ".join(i["title"] for i in items) + "]")
    return events, noted


def run(req: AssistantRequest, *, database, config, blocks: Dict[str, Any],
        list_scripts: Optional[Callable[[], List[str]]] = None,
        provider_factory: ProviderFactory = default_provider_factory) -> Iterator[str]:
    """The event stream for one request. A generator: close it to stop."""
    if not _slots.acquire(blocking=False):
        yield sse("error", {"code": "busy", "message": "The Assistant is answering two other questions. "
                                                      "Try again in a moment; your message is still in the box."})
        return
    stream = None
    served_model = ""
    started = False
    # everything after the slot is taken runs inside the try, so the slot is
    # always given back (the Mix tab's gauntlet review, L1)
    try:
        model_key = ai_config.model_key(config)
        served_model = ai_config.MODELS[model_key]["id"]
        cap = ai_config.monthly_cap(config)
        if cap is not None and store.month_usage(database)["cost_usd"] >= cap:
            yield sse("error", {"code": "cap_reached",
                                "message": f"This month's Assistant budget of ${cap:g} is spent, so it waits "
                                           "for the 1st. Automations run as usual."})
            return
        conversation_id = req.conversation_id or uuid.uuid4().hex
        yield sse("status", {"reading": _first_reading(req)})

        facts = ai_context.gather(database, config, profile_id=req.profile_id, is_admin=req.is_admin,
                                  page=req.page, automation_id=req.automation_id, run_id=req.run_id,
                                  draft=req.draft, blocks=blocks, list_scripts=list_scripts)
        yield sse("status", {"reading": facts.reading})
        if facts.quote:
            yield sse("quote", facts.quote)

        messages = _history(req.profile_id, conversation_id)
        messages.append({"role": "user", "content": [
            {"type": "text", "text": ai_context.data_block(facts)},
            {"type": "text", "text": req.message},
        ]})
        system = ai_prompt.system_blocks(blocks, is_admin=req.is_admin)
        logger.debug("Assistant request: %d history messages, %d characters of facts",
                     len(messages) - 1, len(ai_context.data_block(facts)))

        provider = provider_factory(ai_config.api_key(config), ai_config.MODELS[model_key]["id"])
        stream = provider.open_stream(system=system, messages=messages, tools=ai_prompt.tools())
        started = True
        text_parts: List[str] = []
        last_write = time.monotonic()
        try:
            for kind, piece in stream:
                now = time.monotonic()
                if kind == "text" and piece:
                    text_parts.append(piece)
                    yield sse("text", {"delta": piece})
                    last_write = now
                elif now - last_write >= KEEPALIVE_SECONDS:
                    # a closed tab is only noticed on a write
                    yield ": keep-alive\n\n"
                    last_write = now
        except ProviderError as err:
            if err.code == "bad_key":
                ai_config.record_key_test(config, ok=False, message="Anthropic refused this key.",
                                          actor=req.actor)
            yield sse("error", {"code": err.code, "message": err.message})
            return

        final = stream.final()
        if final is None:
            yield sse("error", {"code": "provider_error", "message": "The answer stopped before it finished. "
                                                                     "Try again."})
            return
        if final.stop_reason == "refusal":
            yield sse("error", {"code": "provider_error",
                                "message": "Anthropic declined to answer that. Try asking another way."})
            return
        served_model = final.model or served_model
        calls = final.tool_calls
        if final.stop_reason == "max_tokens" and calls:
            yield sse("error", {"code": "provider_error", "message": "The answer was cut off before the draft "
                                                                     "was complete. Try again."})
            calls = []
        events, noted = _tool_events(calls, blocks, facts, req, database)
        for event in events:
            yield event
        answer = "".join(text_parts).strip()
        _remember(req.profile_id, conversation_id, req.message, " ".join([answer, *noted]).strip())
        usage = final.usage
        cost = ai_config.estimate_cost_usd(served_model, usage)
        yield sse("done", {"conversation_id": conversation_id, "usage": {
            "input_tokens": usage.get("input_tokens", 0) + usage.get("cache_read_tokens", 0)
            + usage.get("cache_write_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "estimated_cost_usd": cost,
        }})
    finally:
        try:
            if stream is not None:
                stream.close()
            if started:
                usage = stream.usage_so_far() if stream is not None else {}
                store.record_request(
                    database, profile_id=req.profile_id, input_tokens=usage.get("input_tokens", 0),
                    output_tokens=usage.get("output_tokens", 0),
                    cache_read_tokens=usage.get("cache_read_tokens", 0),
                    cache_write_tokens=usage.get("cache_write_tokens", 0),
                    cost_usd=ai_config.estimate_cost_usd(served_model, usage))
        finally:
            _slots.release()
