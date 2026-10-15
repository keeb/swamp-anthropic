import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { model } from "./claude.ts";

type Written = Map<string, Record<string, unknown>>;

function ctx(globalArgs: Record<string, unknown>, written: Written) {
  return {
    globalArgs: { model: "claude-test", maxTokens: 512, ...globalArgs },
    logger: { info: () => {}, warning: () => {} },
    writeResource: (
      _spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.set(name, data);
      return Promise.resolve({ name });
    },
  };
}

/**
 * Puts a fake `claude` on PATH for the duration of `fn`. The fake records its
 * argv and stdin, then prints `$FAKE_CLAUDE_OUT` (or exits 2 with garbage).
 */
async function withFakeClaude(
  fn: (calls: () => Promise<{ args: string; stdin: string }[]>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = `${dir}/calls`;
  await Deno.writeTextFile(
    `${dir}/claude`,
    `#!/bin/sh
stdin=$(cat)
printf '%s\\t%s\\n' "$*" "$stdin" >> "${log}"
case "$stdin" in
  *FAIL*) echo "not json"; exit 2 ;;
  *ERR*) printf '%s' '{"is_error":true,"subtype":"error_max_turns","result":"boom"}' ;;
  *) printf '%s' "$FAKE_CLAUDE_OUT" ;;
esac
`,
  );
  await Deno.chmod(`${dir}/claude`, 0o755);
  const path = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${path}`);
  Deno.env.set(
    "FAKE_CLAUDE_OUT",
    JSON.stringify({
      result: "hello",
      structured_output: { answer: 42 },
      total_cost_usd: 0.01,
      modelUsage: { "claude-served": {} },
    }),
  );
  try {
    await fn(async () =>
      (await Deno.readTextFile(log)).trim().split("\n").map((l) => {
        const [args, stdin] = l.split("\t");
        return { args, stdin };
      })
    );
  } finally {
    Deno.env.set("PATH", path);
    Deno.env.delete("FAKE_CLAUDE_OUT");
    await Deno.remove(dir, { recursive: true });
  }
}

const m = model.methods;

Deno.test("generate posts to the Messages API and writes result", async () => {
  const written: Written = new Map();
  const real = globalThis.fetch;
  let body: Record<string, unknown> = {};
  let headers: Headers = new Headers();
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    headers = new Headers(init.headers);
    return Promise.resolve(
      new Response(JSON.stringify({
        content: [{ type: "text", text: "hi " }, { type: "thinking" }, {
          type: "text",
          text: "there",
        }],
      })),
    );
  }) as typeof fetch;
  try {
    await m.generate.execute(
      { prompt: "p" },
      ctx({ apiKey: "k", systemPrompt: "s" }, written),
    );
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(headers.get("x-api-key"), "k");
  assertEquals(body.system, "s");
  assertEquals(body.max_tokens, 512);
  assertEquals(written.get("result")?.response, "hi there");
});

Deno.test("generate fails without apiKey and on API errors, writing nothing", async () => {
  const written: Written = new Map();
  await assertRejects(
    () => m.generate.execute({ prompt: "p" }, ctx({}, written)),
    Error,
    "use cli_generate",
  );
  const real = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("overloaded", { status: 529 }),
    )) as typeof fetch;
  try {
    await assertRejects(
      () => m.generate.execute({ prompt: "p" }, ctx({ apiKey: "k" }, written)),
      Error,
      "Anthropic API error (529): overloaded",
    );
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(written.size, 0);
});

Deno.test("cli_generate runs claude -p headless and keeps structured output", async () => {
  await withFakeClaude(async (calls) => {
    const written: Written = new Map();
    await m.cli_generate.execute(
      {
        prompt: "the prompt",
        jsonSchema: { type: "object" },
        effort: "low",
        timeoutSeconds: 30,
      },
      ctx({ systemPrompt: "sys" }, written),
    );
    const [call] = await calls();
    assertEquals(call.stdin, "the prompt");
    for (
      const flag of [
        "-p",
        "--output-format json",
        "--no-session-persistence",
        "--safe-mode",
        "--model claude-test",
        "--effort low",
        "--system-prompt sys",
        '--json-schema {"type":"object"}',
      ]
    ) assertStringIncludes(call.args, flag);
    const result = written.get("result")!;
    assertEquals(result.response, "hello");
    assertEquals(result.structured, { answer: 42 });
    assertEquals(result.model, "claude-served");
  });
});

Deno.test("cli_generate throws on CLI errors and bad arguments, writing nothing", async () => {
  await withFakeClaude(async () => {
    const written: Written = new Map();
    await assertRejects(
      () =>
        m.cli_generate.execute(
          { prompt: "FAIL", timeoutSeconds: 30 },
          ctx({}, written),
        ),
      Error,
      "claude exited 2",
    );
    await assertRejects(
      () =>
        m.cli_generate.execute(
          { prompt: "ERR", timeoutSeconds: 30 },
          ctx({}, written),
        ),
      Error,
      "claude error_max_turns: boom",
    );
    await assertRejects(
      () =>
        m.cli_generate.execute(
          { prompt: "x", timeoutSeconds: 0 },
          ctx({}, written),
        ),
      Error,
      "timeoutSeconds must be a positive integer",
    );
    assertEquals(written.size, 0);
  });
});

Deno.test("cli_generate_many records each request, failures included", async () => {
  await withFakeClaude(async (calls) => {
    const written: Written = new Map();
    await m.cli_generate_many.execute(
      {
        batch: "b",
        requests: [
          { key: "ok", prompt: "fine" },
          { key: "bad", prompt: "FAIL", systemPrompt: "own" },
        ],
        systemPrompt: "shared",
        concurrency: 2,
        timeoutSeconds: 30,
      },
      ctx({}, written),
    );
    assertEquals(written.get("cli-b-ok")?.ok, true);
    assertEquals(written.get("cli-b-ok")?.structured, { answer: 42 });
    assertEquals(written.get("cli-b-bad")?.ok, false);
    assertStringIncludes(String(written.get("cli-b-bad")?.error), "claude exited 2");
    const args = (await calls()).map((c) => c.args).join("\n");
    assert(args.includes("--system-prompt shared"));
    assert(args.includes("--system-prompt own"));
  });
});

Deno.test("generate rejects a response without a content array", async () => {
  const written: Written = new Map();
  const real = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ id: "x" })))) as typeof fetch;
  try {
    await assertRejects(
      () => m.generate.execute({ prompt: "p" }, ctx({ apiKey: "k" }, written)),
      Error,
      "no content array",
    );
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(written.size, 0);
});

Deno.test("cli_generate_many rejects duplicate keys before running anything", async () => {
  const written: Written = new Map();
  await assertRejects(
    () =>
      m.cli_generate_many.execute(
        {
          batch: "b",
          requests: [{ key: "a", prompt: "1" }, { key: "a", prompt: "2" }],
          concurrency: 1,
          timeoutSeconds: 30,
        },
        ctx({}, written),
      ),
    Error,
    'Duplicate request key "a"',
  );
  assertEquals(written.size, 0);
});
