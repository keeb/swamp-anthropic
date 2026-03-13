import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiKey: z.string(),
  model: z.string().default("claude-sonnet-4-20250514"),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().positive().default(512),
});

const ResultSchema = z.object({
  response: z.string(),
  model: z.string(),
  timestamp: z.string().datetime(),
});

export const model = {
  type: "@user/anthropic/claude",
  version: "2026.02.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Claude API response",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    generate: {
      description: "Generate text with Claude",
      arguments: z.object({
        prompt: z.string(),
      }),
      execute: async (args, context) => {
        const { apiKey, model: modelName, systemPrompt, maxTokens } =
          context.globalArgs;

        const messages = [{ role: "user", content: args.prompt }];

        const body = {
          model: modelName,
          max_tokens: maxTokens,
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
        const responseText = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");

        const handle = await context.writeResource("result", "result", {
          response: responseText,
          model: modelName,
          timestamp: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
