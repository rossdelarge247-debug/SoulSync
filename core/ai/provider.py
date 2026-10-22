"""The model provider, behind one small interface.

Anthropic is the only provider for now, through the official ``anthropic``
SDK (pinned in requirements.txt). The assistant (core/ai/assistant.py) and
the tests only see:

- ``open_stream(...)`` → a ``ProviderStream``: iterate it for
  ``("text", piece)`` and ``("tick", None)`` events, then read ``final()``
  for the stop reason, the tool calls, the token counts and the model that
  answered; ``close()`` stops the call (the browser's Stop).
- ``test_key()`` → ``(ok, message)``, without spending tokens.
- ``ProviderError(code, message)`` with the codes the panel knows:
  ``bad_key``, ``no_credit``, ``rate_limited``, ``offline``,
  ``provider_error``.

The SDK is imported when it's first needed, so the app starts without it.
The key is never logged.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Tuple

logger = logging.getLogger(__name__)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
TIMEOUT_SECONDS = 90.0
MAX_TOKENS = 16_000
EFFORT = "medium"


class ProviderError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


MESSAGES = {
    "bad_key": "Anthropic refused the key saved in Settings → AI.",
    "no_credit": "Anthropic says the account behind the key has used up its credit.",
    "rate_limited": "Anthropic asked us to slow down. Try again in about a minute.",
    "offline": "SYNCHRO.S couldn't connect to Anthropic. Your server may be offline, or the provider is.",
    "provider_error": "Anthropic couldn't answer that. Try again, or ask another way.",
    "missing_sdk": "The anthropic package isn't installed. Reinstall SYNCHRO.S's requirements to use the Assistant.",
}


@dataclass
class ToolCall:
    name: str
    input: Dict[str, Any]


@dataclass
class Final:
    stop_reason: Optional[str]
    tool_calls: List[ToolCall] = field(default_factory=list)
    usage: Dict[str, int] = field(default_factory=dict)
    model: Optional[str] = None


def _sdk():
    try:
        import anthropic
    except ImportError as exc:
        raise ProviderError("provider_error", MESSAGES["missing_sdk"]) from exc
    return anthropic


def classify(exc: BaseException) -> ProviderError:
    """The SDK's typed errors as the panel's codes, most specific first."""
    if isinstance(exc, ProviderError):
        return exc
    try:
        import anthropic
    except ImportError:
        return ProviderError("provider_error", MESSAGES["provider_error"])
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return ProviderError("bad_key", MESSAGES["bad_key"])
    if isinstance(exc, anthropic.RateLimitError):
        return ProviderError("rate_limited", MESSAGES["rate_limited"])
    if isinstance(exc, anthropic.BadRequestError):
        text = str(getattr(exc, "message", "") or exc).lower()
        if "credit balance" in text or "billing" in text or "purchase credits" in text:
            return ProviderError("no_credit", MESSAGES["no_credit"])
        return ProviderError("provider_error", MESSAGES["provider_error"])
    if isinstance(exc, anthropic.APIStatusError):
        status = int(getattr(exc, "status_code", 0) or 0)
        if status == 402:
            return ProviderError("no_credit", MESSAGES["no_credit"])
        if status == 529:
            return ProviderError("rate_limited", "Anthropic is busy right now. Try again in about a minute.")
        if status >= 500:
            return ProviderError("offline", MESSAGES["offline"])
        return ProviderError("provider_error", MESSAGES["provider_error"])
    if isinstance(exc, (anthropic.APITimeoutError, anthropic.APIConnectionError)):
        return ProviderError("offline", MESSAGES["offline"])
    if isinstance(exc, ValueError):
        # the stream's tool input couldn't be parsed at all
        return ProviderError("provider_error", "The answer came back garbled. Try again.")
    return ProviderError("provider_error", MESSAGES["provider_error"])


def _usage(raw: Any) -> Dict[str, int]:
    if raw is None:
        return {}
    def num(name: str) -> int:
        try:
            return int(getattr(raw, name, 0) or 0)
        except (TypeError, ValueError):
            return 0
    return {
        "input_tokens": num("input_tokens"),
        "output_tokens": num("output_tokens"),
        "cache_read_tokens": num("cache_read_input_tokens"),
        "cache_write_tokens": num("cache_creation_input_tokens"),
    }


class ProviderStream:
    """One streamed request. Iterate for events, then ``final()``."""

    def __init__(self, manager):
        self._manager = manager
        self._stream = None
        self._usage: Dict[str, int] = {}
        self._final: Optional[Final] = None
        self._closed = False

    def __iter__(self) -> Iterator[Tuple[str, Optional[str]]]:
        try:
            self._stream = self._manager.__enter__()
            for event in self._stream:
                etype = getattr(event, "type", "")
                if etype == "content_block_delta" and getattr(event.delta, "type", "") == "text_delta":
                    yield ("text", event.delta.text)
                    continue
                if etype == "message_start":
                    self._usage.update({k: v for k, v in _usage(getattr(event.message, "usage", None)).items() if v})
                elif etype == "message_delta":
                    out = _usage(getattr(event, "usage", None)).get("output_tokens")
                    if out:
                        self._usage["output_tokens"] = out
                yield ("tick", None)
            message = self._stream.get_final_message()
            calls = [ToolCall(name=b.name, input=dict(b.input) if isinstance(b.input, dict) else {})
                     for b in message.content if getattr(b, "type", "") == "tool_use"]
            usage = _usage(message.usage) or dict(self._usage)
            self._final = Final(stop_reason=message.stop_reason, tool_calls=calls, usage=usage,
                                model=getattr(message, "model", None))
        except GeneratorExit:
            raise
        except Exception as exc:  # noqa: BLE001 - every provider failure becomes a code
            raise classify(exc) from exc
        finally:
            self.close()

    def usage_so_far(self) -> Dict[str, int]:
        return dict(self._final.usage if self._final else self._usage)

    def final(self) -> Optional[Final]:
        return self._final

    def close(self) -> None:
        """Stop the call: closes the HTTP response, which ends generation."""
        if self._closed:
            return
        self._closed = True
        try:
            if self._stream is not None:
                self._stream.close()
            self._manager.__exit__(None, None, None)
        except Exception as exc:  # noqa: BLE001 - closing never raises into the request
            logger.debug("closing the provider stream: %s", exc)


class AnthropicProvider:
    def __init__(self, api_key: str, model: str, *, timeout: float = TIMEOUT_SECONDS):
        self._api_key = api_key
        self.model = model
        self._timeout = timeout

    def _client(self):
        anthropic = _sdk()
        return anthropic.Anthropic(api_key=self._api_key, timeout=self._timeout, max_retries=1)

    def open_stream(self, *, system: List[Dict[str, Any]], messages: List[Dict[str, Any]],
                    tools: List[Dict[str, Any]], max_tokens: int = MAX_TOKENS) -> ProviderStream:
        client = self._client()
        manager = client.beta.messages.stream(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            tools=tools,
            output_config={"effort": EFFORT},
            # a refusal on this model is retried server-side on one that can answer
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        return ProviderStream(manager)

    def test_key(self) -> Tuple[bool, str]:
        """Ask for the chosen model's details: proves the key works and can
        use the model, and costs nothing."""
        try:
            self._client().models.retrieve(self.model)
        except Exception as exc:  # noqa: BLE001
            err = classify(exc)
            if err.code == "bad_key":
                return False, "Anthropic refused this key."
            return False, err.message
        return True, "Key works."
