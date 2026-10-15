# @keeb/anthropic

[Swamp](https://github.com/systeminit/swamp) extension for generating text with Anthropic Claude, via the Messages API or the local `claude` CLI.

## Models

### `@keeb/anthropic/claude`

| Method | Backend | Description |
|--------|---------|-------------|
| `generate` | Messages API | Generate text from `prompt`. Requires `apiKey`. |
| `cli_generate` | `claude` CLI | Generate text from `prompt`; optional `jsonSchema` for structured output (lands in `structured`), `effort`, `timeoutSeconds`. |
| `cli_generate_many` | `claude` CLI | Run a `batch` of `requests` (`{key, prompt, systemPrompt?, jsonSchema?}`) with bounded `concurrency`; one `cliResult` per request. |

**Global arguments:** `apiKey` (only for `generate`), `model`, `systemPrompt`, `maxTokens` (only for `generate`)

The `cli_*` methods run `claude -p` headless with no tools, in an empty temp directory (so no repo `CLAUDE.md` or settings leak in), authenticated by the CLI's own login. They never read `apiKey`. Claude Code must be installed and logged in on the host that runs the method.

## Install

```bash
swamp extension pull @keeb/anthropic
```

## Usage

With an API key:

```bash
swamp model create @keeb/anthropic/claude claude --global-arg model=claude-opus-5-5
swamp behavior run claude generate --input prompt="Summarize the release notes"
```

With the local `claude` login (no key):

```bash
swamp behavior run claude cli_generate --input prompt="Summarize the release notes"
```

`generate` and `cli_generate` write the `result` resource (`response`, `structured?`, `model`, `timestamp`), readable downstream via `data.latest("claude", "result").attributes.response`. `cli_generate_many` writes `cliResult` instances named `cli-<batch>-<key>` with `ok`, `response`, `structured`, `error`, `costUsd`, and `durationMs`; a failed request is recorded with `ok: false` rather than failing the batch.

## License

MIT
