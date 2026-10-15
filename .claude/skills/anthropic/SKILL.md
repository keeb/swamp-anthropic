---
name: anthropic
description: Use the @keeb/anthropic swamp extension to generate text with Anthropic's Claude models, either through the Messages API (`generate`, needs an API key) or through the local `claude` CLI login (`cli_generate`, `cli_generate_many`, no key). Use when wiring Claude text generation into swamp workflows, configuring the `@keeb/anthropic/claude` model type, getting structured JSON back via `jsonSchema`, fanning out a batch of prompts, reading the `result` / `cliResult` resources, or calling Claude from another extension via `runModel`. Triggers on "anthropic", "claude", "claude cli", "claude -p", "claude-opus", "claude-sonnet", "claude-haiku", "Anthropic API", "Messages API", "LLM prompt", "generate text", "structured output", "@keeb/anthropic", "anthropic/claude".
---

# @keeb/anthropic

One model type, `@keeb/anthropic/claude`, with two backends:

- **Messages API**: `generate`. Needs `apiKey`.
- **Local `claude` CLI**: `cli_generate`, `cli_generate_many`. Runs `claude -p`
  headless with no tools, in an empty temp directory (no repo `CLAUDE.md` or
  settings leak in), authenticated by the CLI's own login. Never reads
  `apiKey`. Claude Code must be installed and logged in on the host.

## Global arguments

| Name           | Type   | Default                    | Description                                   |
| -------------- | ------ | -------------------------- | --------------------------------------------- |
| `apiKey`       | string | _(none)_                   | Anthropic API key; only `generate` needs it   |
| `model`        | string | `claude-sonnet-4-20250514` | Claude model ID (both backends)               |
| `systemPrompt` | string | _(none)_                   | System prompt (both backends)                 |
| `maxTokens`    | number | `512`                      | Positive integer output cap (`generate` only) |

## Methods

| Method              | Arguments                                                                                                    | Writes                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `generate`          | `prompt`                                                                                                     | `result`                   |
| `cli_generate`      | `prompt`, `jsonSchema?`, `effort?` (low…max), `timeoutSeconds` (900)                                         | `result`                   |
| `cli_generate_many` | `batch`, `requests[]` (`{key, prompt, systemPrompt?, jsonSchema?}`), `systemPrompt?`, `concurrency` (4), `effort?`, `timeoutSeconds` (900) | `cliResult` per request |

## Resources

- `result` (instance `result`): `response`, `structured?` (the parsed answer
  when `cli_generate` got a `jsonSchema`), `model`, `timestamp`.
- `cliResult` (instance `cli-<batch>-<key>`, lifetime 30d): `key`, `batch`,
  `ok`, `response`, `structured?`, `error?`, `model`, `costUsd`, `durationMs`,
  `timestamp`. A failed request is stored with `ok: false`; the batch itself
  does not fail.

## Usage

```bash
# API backend: keep the key in a vault
swamp vault put default ANTHROPIC_API_KEY
swamp model create @keeb/anthropic/claude ask-claude \
  --global-arg 'apiKey=${{ vault.get(default, ANTHROPIC_API_KEY) }}' \
  --global-arg model=claude-opus-5-5
swamp behavior run ask-claude generate --input prompt="Summarize PR #42 in one line."

# CLI backend: no key
swamp behavior run ask-claude cli_generate --input prompt="Summarize PR #42 in one line."

# Read the answer
swamp data query 'model("ask-claude") && name == "result"' --select attributes.response
```

## In workflows

```yaml
jobs:
  - name: notes
    steps:
      - name: draft
        task:
          type: model_method
          modelIdOrName: ask-claude
          methodName: cli_generate
          inputs:
            prompt: ${{ "Write release notes for: " + data.latest("changes", "diff").attributes.summary }}
      - name: publish
        dependsOn:
          - step: draft
            condition: { type: succeeded }
        task:
          type: model_method
          modelIdOrName: github-release
          methodName: create
          inputs:
            body: ${{ data.latest("ask-claude", "result").?attributes.?response.orValue("") }}
```

Use `data.latest(...)`, never the deprecated `model.<name>.resource...` form.

## From another extension (`runModel`)

List `@keeb/anthropic` under `dependencies` in your manifest, then:

```ts
const res = await context.runModel({
  modelType: "@keeb/anthropic/claude",
  name: "my-llm",
  method: "cli_generate_many",
  arguments: {
    model: "claude-opus-5-5",
    batch: "my-ext",
    requests: [{ key: "q1", prompt, systemPrompt, jsonSchema }],
  },
});
if (!res.ok) throw new Error(res.error.message);
const [rec] = (await context.readModelData("my-llm", "cliResult"))
  .filter((r) => r.name === "cli-my-ext-q1");
```

Pass system prompts as the per-request `systemPrompt` (a method argument), not
the `systemPrompt` global. `runModel` refuses global arguments that contain
`${{ }}` text, and prompts that teach swamp often quote expressions.

## Gotchas

- **Structured output only on the CLI backend.** `generate` returns text only;
  for JSON, use `cli_generate` / `cli_generate_many` with `jsonSchema`.
- **Single-turn.** Each call is one user message; pass full context every time.
- **`generate` is text blocks only**, with `anthropic-version: 2023-06-01`, and
  has no retry. Non-2xx responses throw.
- **One `result` instance.** Each `generate`/`cli_generate` call overwrites the
  latest `result`; older versions are kept up to the GC limit (10).
- **CLI host requirement.** `cli_*` fails with `claude exited ...` when Claude
  Code isn't installed or logged in where the method runs (including remote
  workers).
