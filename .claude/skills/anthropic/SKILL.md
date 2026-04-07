---
name: anthropic
description: Use the @keeb/anthropic swamp extension to generate text with Anthropic's Claude models via the Messages API. Use when wiring Claude text generation into swamp workflows, configuring the `@keeb/anthropic/claude` model type, calling its `generate` method with a `prompt`, setting global arguments (`apiKey`, `model`, `systemPrompt`, `maxTokens`), reading the `result` resource, or chaining Claude output into downstream models. Triggers on "anthropic", "claude", "claude-sonnet", "claude-opus", "claude-haiku", "Anthropic API", "Messages API", "LLM prompt", "generate text", "@keeb/anthropic", "anthropic/claude".
---

# @keeb/anthropic

Swamp extension that wraps the Anthropic Messages API
(`POST https://api.anthropic.com/v1/messages`) as a single swamp model. One
model, one method: send a prompt, get text back, store it as a resource.

## Model

### `@keeb/anthropic/claude`

Generate text with an Anthropic Claude model.

**Global arguments** (set once per model definition, shared by every method
call):

| Name           | Type              | Default                    | Description                |
| -------------- | ----------------- | -------------------------- | -------------------------- |
| `apiKey`       | string (required) | —                          | Anthropic API key          |
| `model`        | string            | `claude-sonnet-4-20250514` | Claude model ID            |
| `systemPrompt` | string            | _(none)_                   | Optional system prompt     |
| `maxTokens`    | positive int      | `512`                      | Max tokens in the response |

**Methods**

| Method     | Arguments                   | Description                              |
| ---------- | --------------------------- | ---------------------------------------- |
| `generate` | `prompt: string` (required) | Send a single user message, return text. |

**Resources**

- `result` — written under instance name `result` (so the latest lookup key is
  `("result", "result")`). Lifetime `infinite`, GC keeps the last 10 versions.
  Schema:
  - `response: string` — concatenated text blocks from the API response
  - `model: string` — echoes the model ID that was used
  - `timestamp: string` — ISO-8601 datetime the call completed

## Defining the model

```yaml
# models/ask-claude.yaml
name: ask-claude
type: "@keeb/anthropic/claude"
globalArguments:
  apiKey: "{{ vault.anthropic.apiKey }}"
  model: claude-sonnet-4-20250514
  systemPrompt: "You are a terse release-notes writer."
  maxTokens: 1024
```

Use a vault expression for `apiKey` — never inline the key. Any swamp vault
provider works; the extension just reads the resolved string.

## Running the generate method

```bash
swamp model run ask-claude generate --arg prompt="Summarize PR #42 in one line."
```

Inspect the result:

```bash
swamp data latest ask-claude result --json
# → { response: "...", model: "...", timestamp: "..." }
```

## Chaining into workflows

Reference the response from downstream steps with CEL. Always use the
`data.latest(...)` form:

```yaml
# workflows/release-notes.yaml
jobs:
  - name: write-notes
    steps:
      - name: draft
        model: ask-claude
        method: generate
        arguments:
          prompt: "Write release notes for: {{ data.latest('changes', 'diff').attributes.summary }}"
      - name: publish
        model: github-release
        method: create
        dependsOn: [draft]
        arguments:
          body: "{{ data.latest('ask-claude', 'result').attributes.response }}"
```

Do not use the deprecated
`model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.

## Common patterns

- **Different personas, same key.** Define multiple models (`ask-claude-terse`,
  `ask-claude-verbose`, ...) that share an `apiKey` from the vault but vary
  `systemPrompt` / `maxTokens` / `model`.
- **Swap the underlying model per call site.** Override `model` in the
  definition (e.g. `claude-opus-4-...` for deep reasoning, a Haiku model for
  cheap classification).
- **Feeding structured output downstream.** Ask Claude to return JSON inside the
  prompt, then parse with CEL string functions or a follow-up `json/parse` style
  model — the resource itself stores the raw `response` string.

## Gotchas

- **Text blocks only.** The execute path filters the Anthropic response to
  `content[].type === "text"` and joins them. Tool-use, thinking, or image
  blocks are silently dropped. If you need those, extend the model.
- **Single-turn only.** `generate` sends exactly one `user` message per call.
  There is no conversation history or multi-turn context — each invocation is
  independent. Pass full context in `prompt` or `systemPrompt`.
- **`maxTokens` is an integer cap, not a target.** Requests that would exceed it
  are truncated by the API; the resource will still be written with whatever
  text came back.
- **Hard-coded API version.** The request sends `anthropic-version: 2023-06-01`.
  Newer beta features (e.g. extended thinking, prompt caching) are not wired
  through.
- **No retry / backoff.** Non-2xx responses throw immediately with the status
  code and body text. Wrap calls in a workflow-level retry if you need it.
- **Model default drifts.** The default `model` is pinned to
  `claude-sonnet-4-20250514` in `extensions/models/claude.ts`. Pin it explicitly
  in your model definition if you want stability across extension upgrades.
- **One resource instance.** Every `generate` call writes to instance name
  `result`, so each run overwrites the "latest" pointer. Older versions are
  retained up to the GC limit (10) — use `swamp data versions` to inspect
  history.
