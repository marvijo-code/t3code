import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

// Gemini rejects function declarations whose enums hold anything but strings.
const isNonStringEnum = (key: string, value: Json) =>
  key === "enum" && Array.isArray(value) && value.some((item) => typeof item !== "string");

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const compact = (schema: Json, optional: boolean): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    if (isNonStringEnum(key, value)) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name)),
            ]),
          )
        : compact(value, false);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullSchema(branch)) && !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    const only = branches.length === 1 ? branches[0] : mergeTaggedObjects(branches);
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

/**
 * The input schema T3 advertises for a tool. Drops JSON noise that every thread pays for:
 * `additionalProperties: true`, safe-integer bounds, nested `anyOf`, JSON-string fallbacks, and
 * the `null` branch of optional properties. A tagged union of objects becomes one object.
 * Decoding still uses the full schema, so each tag's own required fields still apply.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(Tool.getJsonSchema(tool), false) as ReturnType<typeof Tool.getJsonSchema>;

/** Per-tool byte ceiling for Antigravity ACP session MCP tools (drops tools above ~600 bytes). */
export const COMPACT_MCP_TOOL_MAX_BYTES = 520;

interface CompactableMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Json;
  readonly [key: string]: Json;
}

const serializedToolBytes = (tool: CompactableMcpTool): number =>
  Buffer.byteLength(
    JSON.stringify({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object" },
    }),
    "utf8",
  );

const STRIPPED_SCHEMA_KEYS = new Set([
  "description",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "default",
  "additionalProperties",
]);

const TARGET_KEY_SUBSET = ["providerInstanceId", "model", "options", "environmentId"] as const;

const stripSchemaForLimit = (schema: Json, level: 1 | 2 | 3): Json => {
  if (Array.isArray(schema)) return schema.map((item) => stripSchemaForLimit(item, level));
  if (!Predicate.isObject(schema)) return schema;
  if (Array.isArray(schema.anyOf)) {
    const objectBranch = schema.anyOf.find(
      (branch) => Predicate.isObject(branch) && branch.type === "object",
    );
    return stripSchemaForLimit(objectBranch ?? schema.anyOf[0] ?? { type: "object" }, level);
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRIPPED_SCHEMA_KEYS.has(key)) continue;
    if (level >= 2 && key === "enum") continue;
    if (key === "properties" && Predicate.isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([propName, propSchema]) => {
          if (level >= 3 && Predicate.isObject(propSchema)) {
            if (propSchema.type === "object") {
              if (propName === "target" && Predicate.isObject(propSchema.properties)) {
                const kept = TARGET_KEY_SUBSET.filter((k) => k in (propSchema.properties as JsonObject));
                return [
                  propName,
                  {
                    type: "object",
                    properties: Object.fromEntries(
                      kept.map((k) => [k, { type: k === "options" ? "object" : "string" }]),
                    ),
                  },
                ];
              }
              return [propName, { type: "object" }];
            }
            if (propSchema.type === "array") {
              const itemType =
                Predicate.isObject(propSchema.items) && typeof propSchema.items.type === "string"
                  ? propSchema.items.type
                  : "string";
              return [propName, { type: "array", items: { type: itemType } }];
            }
          }
          return [propName, stripSchemaForLimit(propSchema, level)];
        }),
      );
    } else {
      out[key] = stripSchemaForLimit(value, level);
    }
  }
  return out;
};

const shortenDescription = (text: string | undefined, max: number): string => {
  const value = (text ?? "").trim();
  if (value.length <= max) return value;
  const firstSentence = value.split(". ", 1)[0] ?? value;
  if (firstSentence.length + 1 <= max) return `${firstSentence}.`;
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}.`;
};

export const compactMcpToolForByteLimit = <T extends CompactableMcpTool>(
  tool: T,
  maxBytes: number = COMPACT_MCP_TOOL_MAX_BYTES,
): T => {
  if (serializedToolBytes(tool) <= maxBytes) return tool;

  const attempt1: T = { ...tool, inputSchema: stripSchemaForLimit(tool.inputSchema, 1) };
  if (serializedToolBytes(attempt1) <= maxBytes) return attempt1;

  const attempt2: T = {
    ...tool,
    description: shortenDescription(tool.description, 72),
    inputSchema: stripSchemaForLimit(tool.inputSchema, 2),
  };
  if (serializedToolBytes(attempt2) <= maxBytes) return attempt2;

  const attempt3: T = {
    ...tool,
    description: shortenDescription(tool.description, 32),
    inputSchema: stripSchemaForLimit(tool.inputSchema, 3),
  };
  if (serializedToolBytes(attempt3) <= maxBytes) return attempt3;

  const props =
    Predicate.isObject(tool.inputSchema) && Predicate.isObject(tool.inputSchema.properties)
      ? tool.inputSchema.properties
      : {};
  const bareProperties: JsonObject = {};
  for (const [propName, propSchema] of Object.entries(props)) {
    const propType =
      Predicate.isObject(propSchema) && typeof propSchema.type === "string"
        ? propSchema.type
        : "string";
    bareProperties[propName] = { type: propType };
  }
  const required =
    Predicate.isObject(tool.inputSchema) && Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required
      : undefined;
  const attempt4: T = {
    ...tool,
    description: shortenDescription(tool.description, 28),
    inputSchema: {
      type: "object",
      ...(required === undefined ? {} : { required }),
      properties: bareProperties,
    },
  };
  if (serializedToolBytes(attempt4) <= maxBytes) return attempt4;

  return {
    ...tool,
    description: shortenDescription(tool.description, 24),
    inputSchema: { type: "object" },
  };
};

const compactToolsListJsonMessage = (
  rawJson: string,
  maxBytes: number,
): string | undefined => {
  if (!rawJson.includes('"tools"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (!Predicate.isObject(parsed) || !Predicate.isObject(parsed.result)) return undefined;
  const tools = parsed.result.tools;
  if (!Array.isArray(tools)) return undefined;
  let changed = false;
  const nextTools = tools.map((entry) => {
    if (!Predicate.isObject(entry) || typeof entry.name !== "string") return entry;
    const compacted = compactMcpToolForByteLimit(entry as CompactableMcpTool, maxBytes);
    if (compacted !== entry) changed = true;
    return compacted;
  });
  if (!changed) return undefined;
  return JSON.stringify({
    ...parsed,
    result: { ...parsed.result, tools: nextTools },
  });
};

/** Rewrites JSON or SSE `tools/list` MCP responses so every tool fits under `maxBytes`. */
export const compactToolsListJsonRpcPayload = (
  payload: string,
  maxBytes: number = COMPACT_MCP_TOOL_MAX_BYTES,
): string | undefined => {
  if (!payload.includes('"tools"')) return undefined;
  const trimmed = payload.trimStart();
  if (trimmed.startsWith("{")) {
    return compactToolsListJsonMessage(payload, maxBytes);
  }
  let changed = false;
  const rewritten = payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const prefixLength = line.startsWith("data: ") ? 6 : 5;
      const next = compactToolsListJsonMessage(line.slice(prefixLength), maxBytes);
      if (next === undefined) return line;
      changed = true;
      return `${line.slice(0, prefixLength)}${next}`;
    })
    .join("\n");
  return changed ? rewritten : undefined;
};
