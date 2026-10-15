/**
 * Swamp extension model @keeb/anthropic/claude.
 *
 * Generates text with Anthropic's Claude models, either via the Messages API
 * (`generate`, needs `apiKey`) or via the local `claude` CLI (`cli_generate`,
 * `cli_generate_many`, which use the CLI's own login and never read
 * `apiKey`). Results are written to the `result` resource, or one
 * `cliResult` per request for batches.
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiKey: z.string().meta({ sensitive: true }).optional().describe(
    "Anthropic API key; required by generate, unused by the cli_* methods",
  ),
  model: z.string().default("claude-sonnet-4-20250514").describe(
    "Model ID to use",
  ),
  systemPrompt: z.string().optional().describe(
    "System prompt for the conversation",
  ),
  maxTokens: z.number().default(512).describe(
    "Maximum tokens in response, a positive integer (generate only)",
  ),
});

const ResultSchema = z.object({
  response: z.string(),
  structured: z.unknown().optional().describe(
    "Parsed answer when cli_generate was given a jsonSchema",
  ),
  model: z.string(),
  timestamp: z.string().datetime(),
});

const CliResultSchema = z.object({
  key: z.string(),
  batch: z.string(),
  ok: z.boolean(),
  response: z.string(),
  structured: z.unknown().optional(),
  error: z.string().optional(),
  model: z.string(),
  costUsd: z.number(),
  durationMs: z.number(),
  timestamp: z.string(),
});

const RequestSchema = z.object({
  key: z.string().describe(
    "Caller-chosen key; the result is stored as cli-<batch>-<key>",
  ),
  prompt: z.string(),
  systemPrompt: z.string().optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional().describe(
    "JSON Schema the answer must satisfy; the parsed answer lands in `structured`",
  ),
});

const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

type CliRequest = z.infer<typeof RequestSchema>;

interface CliOptions {
  model: string;
  effort?: string;
  timeoutMs: number;
}

interface CliOutcome {
  ok: boolean;
  response: string;
  structured?: unknown;
  error?: string;
  model: string;
  costUsd: number;
  durationMs: number;
}

/** Rejects non-positive or non-integer values with an error naming the argument. */
function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

// the subscription login in ~/.claude is the credential; apiKey on the definition is never read here
async function invokeClaude(
  req: CliRequest,
  opts: CliOptions,
  signal?: AbortSignal,
): Promise<CliOutcome> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--safe-mode",
    "--model",
    opts.model,
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  if (req.systemPrompt) args.push("--system-prompt", req.systemPrompt);
  if (req.jsonSchema) {
    args.push("--json-schema", JSON.stringify(req.jsonSchema));
  }

  // an empty cwd keeps a repo's CLAUDE.md and settings out of a pure generation call
  const cwd = await Deno.makeTempDir({ prefix: "claude-cli-" });
  const started = Date.now();
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  try {
    // swamp-quality-ignore deno-command: the cli methods exist to run the local claude CLI; args are fixed flags plus model, effort enum, system prompt and JSON schema, and the prompt goes over stdin
    const child = new Deno.Command("claude", {
      args,
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(req.prompt));
    await writer.close();
    const out = await child.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
    const durationMs = Date.now() - started;
    if (!parsed) {
      return {
        ok: false,
        response: "",
        error: `claude exited ${out.code}: ${
          (stderr || stdout).slice(0, 2000)
        }`,
        model: opts.model,
        costUsd: 0,
        durationMs,
      };
    }
    const usage = parsed.modelUsage as Record<string, unknown> | undefined;
    const servedBy = usage ? Object.keys(usage)[0] ?? opts.model : opts.model;
    const isError = Boolean(parsed.is_error) || out.code !== 0;
    return {
      ok: !isError,
      response: String(parsed.result ?? ""),
      structured: parsed.structured_output,
      error: isError
        ? `claude ${String(parsed.subtype ?? "error")}: ${
          String(parsed.result ?? stderr).slice(0, 2000)
        }`
        : undefined,
      model: servedBy,
      costUsd: Number(parsed.total_cost_usd ?? 0),
      durationMs,
    };
  } finally {
    await Deno.remove(cwd, { recursive: true }).catch(() => undefined);
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

interface Ctx {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, args?: unknown) => void;
    warning: (msg: string, args?: unknown) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Swamp model definition for Claude text generation via the Messages API or the local claude CLI. */
export const model = {
  type: "@keeb/anthropic/claude",
  version: "2026.10.15.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.15.1",
      description:
        "apiKey is now optional (only generate needs it); adds cli_generate and cli_generate_many",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    result: {
      description: "Claude response",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cliResult: {
      description:
        "One answer from the claude CLI, keyed by batch and request key",
      schema: CliResultSchema,
      lifetime: "30d",
      garbageCollection: 3,
    },
  },
  methods: {
    generate: {
      description: "Generate text with Claude via the Messages API",
      arguments: z.object({
        prompt: z.string().describe("The user message to send to Claude"),
      }),
      execute: async (
        args: { prompt: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const { apiKey, model: modelName, systemPrompt, maxTokens } =
          context.globalArgs;
        if (!apiKey) {
          throw new Error(
            "generate needs globalArguments.apiKey; use cli_generate to go through the local claude CLI instead",
          );
        }

        context.logger.info("Calling the Messages API ({model})", {
          model: modelName,
        });
        const messages = [{ role: "user", content: args.prompt }];

        const body = {
          model: modelName,
          max_tokens: positiveInt("maxTokens", maxTokens),
          messages,
          ...(systemPrompt ? { system: systemPrompt } : {}),
        };

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Anthropic API error (${response.status}): ${errorText}`,
          );
        }

        const result = await response.json();
        if (!Array.isArray(result?.content)) {
          throw new Error(
            `Anthropic API returned no content array: ${
              JSON.stringify(result).slice(0, 500)
            }`,
          );
        }
        const responseText = result.content
          .filter((block: { type: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join("");

        const handle = await context.writeResource("result", "result", {
          response: responseText,
          model: modelName,
          timestamp: new Date().toISOString(),
        });
        context.logger.info("Wrote {n} characters of response", {
          n: responseText.length,
        });

        return { dataHandles: [handle] };
      },
    },
    cli_generate: {
      description:
        "Generate text with the local claude CLI (headless, no tools) instead of the Messages API.",
      arguments: z.object({
        prompt: z.string().describe("The user message to send to Claude"),
        jsonSchema: z.record(z.string(), z.unknown()).optional().describe(
          "JSON Schema the answer must satisfy; the parsed answer lands in `structured`",
        ),
        effort: EffortSchema.optional().describe("CLI effort level"),
        timeoutSeconds: z.number().default(900).describe(
          "Seconds before the CLI call is aborted",
        ),
      }),
      execute: async (
        args: {
          prompt: string;
          jsonSchema?: Record<string, unknown>;
          effort?: string;
          timeoutSeconds: number;
        },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        context.logger.info("Calling the claude CLI ({model})", {
          model: context.globalArgs.model,
        });
        const outcome = await invokeClaude({
          key: "result",
          prompt: args.prompt,
          systemPrompt: context.globalArgs.systemPrompt,
          jsonSchema: args.jsonSchema,
        }, {
          model: context.globalArgs.model,
          effort: args.effort,
          timeoutMs: positiveInt("timeoutSeconds", args.timeoutSeconds) * 1000,
        }, context.signal);
        if (!outcome.ok) throw new Error(outcome.error);
        context.logger.info("claude answered in {s}s", {
          s: Math.round(outcome.durationMs / 1000),
        });
        const handle = await context.writeResource("result", "result", {
          response: outcome.response,
          ...(outcome.structured !== undefined
            ? { structured: outcome.structured }
            : {}),
          model: outcome.model,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    cli_generate_many: {
      description:
        "Fan a batch of prompts out to the local claude CLI with bounded concurrency; one cliResult per request.",
      arguments: z.object({
        batch: z.string().describe("Batch id; namespaces the result instances"),
        requests: z.array(RequestSchema).describe("Prompts to run"),
        systemPrompt: z.string().optional().describe(
          "Shared system prompt for requests that do not carry their own",
        ),
        concurrency: z.number().default(4).describe(
          "Maximum CLI processes at once",
        ),
        effort: EffortSchema.optional().describe("CLI effort level"),
        timeoutSeconds: z.number().default(900).describe(
          "Seconds before each CLI call is aborted",
        ),
      }),
      execute: async (
        args: {
          batch: string;
          requests: CliRequest[];
          systemPrompt?: string;
          concurrency: number;
          effort?: string;
          timeoutSeconds: number;
        },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const concurrency = positiveInt("concurrency", args.concurrency);
        // Keys name the stored instances, so a repeat would silently overwrite an answer.
        const seen = new Set<string>();
        for (const req of args.requests) {
          if (seen.has(req.key)) {
            throw new Error(
              `Duplicate request key "${req.key}" in batch ${args.batch}`,
            );
          }
          seen.add(req.key);
        }
        const timeoutMs = positiveInt("timeoutSeconds", args.timeoutSeconds) *
          1000;
        context.logger.info("Sending {n} prompts to claude ({model})", {
          n: args.requests.length,
          model: context.globalArgs.model,
        });
        const handles = await mapLimit(
          args.requests,
          concurrency,
          async (req) => {
            const outcome = await invokeClaude({
              ...req,
              systemPrompt: req.systemPrompt ?? args.systemPrompt ??
                context.globalArgs.systemPrompt,
            }, {
              model: context.globalArgs.model,
              effort: args.effort,
              timeoutMs,
            }, context.signal);
            if (!outcome.ok) {
              context.logger.warning("{key} failed: {error}", {
                key: req.key,
                error: outcome.error,
              });
            } else {
              context.logger.info("{key} done in {s}s", {
                key: req.key,
                s: Math.round(outcome.durationMs / 1000),
              });
            }
            return await context.writeResource(
              "cliResult",
              `cli-${args.batch}-${req.key}`,
              {
                key: req.key,
                batch: args.batch,
                ...outcome,
                timestamp: new Date().toISOString(),
              },
            );
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};
