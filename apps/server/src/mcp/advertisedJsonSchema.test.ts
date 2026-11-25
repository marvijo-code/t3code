import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import {
  advertisedJsonSchema,
  COMPACT_MCP_TOOL_MAX_BYTES,
  compactMcpToolForByteLimit,
  compactToolsListJsonRpcPayload,
} from "./advertisedJsonSchema.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("advertises only string enum values, which Gemini requires", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set));

  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});

it("compacts oversized tools like delegate_task under Antigravity's byte limit", () => {
  const delegate = OrchestratorToolkit.tools.delegate_task;
  const raw = {
    name: delegate.name,
    description: delegate.description ?? "",
    inputSchema: advertisedJsonSchema(delegate),
  };
  const compacted = compactMcpToolForByteLimit(raw);
  const bytes = Buffer.byteLength(
    JSON.stringify({
      name: compacted.name,
      description: compacted.description,
      parameters: compacted.inputSchema,
    }),
    "utf8",
  );
  expect(bytes).toBeLessThanOrEqual(COMPACT_MCP_TOOL_MAX_BYTES);
  expect((compacted.inputSchema as { properties?: Record<string, unknown> }).properties).toMatchObject({
    task: { type: "string" },
    target: { type: "object" },
  });

  const ssePayload = `event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [raw] },
  })}\n\n`;
  const rewritten = compactToolsListJsonRpcPayload(ssePayload);
  expect(rewritten).toBeDefined();
  const dataLine = rewritten!.split("\n").find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(dataLine!.slice(6)) as {
    result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
  };
  expect(parsed.result.tools[0]!.name).toBe("delegate_task");
  expect(
    Buffer.byteLength(
      JSON.stringify({
        name: parsed.result.tools[0]!.name,
        description: parsed.result.tools[0]!.description,
        parameters: parsed.result.tools[0]!.inputSchema,
      }),
      "utf8",
    ),
  ).toBeLessThanOrEqual(COMPACT_MCP_TOOL_MAX_BYTES);
});
