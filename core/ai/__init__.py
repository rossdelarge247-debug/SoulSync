"""The Automation Assistant: Settings → AI, the streamed conversation that
writes automation drafts, and the suggestion card (docs/design/CONTRACTS.md,
"The Assistant").

- ``config``: the settings (provider, key, model, who may use it, the cap)
  and the models' list prices.
- ``store``: usage per month and per-profile "Not now", in the music database.
- ``drafts``: every draft is checked against the parts list and the viewer's
  role before it's sent.
- ``context``: the facts a request sends, read as the asking profile.
- ``prompt``: the system prompt, the parts list and the tools.
- ``provider``: the Anthropic SDK behind one small interface.
- ``assistant``: one request, as server-sent events.
- ``suggestions``: the list's suggestion card, worked out locally.
"""
