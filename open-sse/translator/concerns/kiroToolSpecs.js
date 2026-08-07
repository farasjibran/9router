/**
 * Kiro tool-spec canonicalization.
 *
 * Ported from the removed v0.5.50 kiroConversation.js, keeping only the
 * request-side piece: normalize OpenAI-/Claude-shaped tool definitions into
 * the Kiro `toolSpecification` shape. Kiro's GenerateAssistantResponse rejects
 * over-length tool names (>64 chars), `additionalProperties` keys, and empty
 * `required:[]` with HTTP 400 REQUEST_BODY_INVALID, so all three are stripped
 * here before the payload leaves the process.
 */
import {
  KIRO_TOOL_DESCRIPTION_MAX_LENGTH,
  KIRO_TOOL_NAME_MAX_LENGTH,
} from "../../config/kiroConstants.js";

const TOOL_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function trimCodePoints(value, limit) {
  return [...String(value || "")].slice(0, limit).join("");
}

function uniqueName(rawName, index, usedNames) {
  const cleaned = String(rawName || "")
    .trim()
    .replace(TOOL_NAME_PATTERN, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = trimCodePoints(cleaned || `tool_${index + 1}`, KIRO_TOOL_NAME_MAX_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, KIRO_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function cleanSchemaValue(value) {
  if (Array.isArray(value)) return value.map(cleanSchemaValue);
  if (!value || typeof value !== "object") return value;

  const cleaned = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "additionalProperties") continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    cleaned[key] = cleanSchemaValue(child);
  }
  return cleaned;
}

function normalizeRootSchema(schema) {
  const cleaned = cleanSchemaValue(schema && typeof schema === "object" ? clone(schema) : {});
  cleaned.type = "object";
  if (!cleaned.properties || typeof cleaned.properties !== "object" || Array.isArray(cleaned.properties)) {
    cleaned.properties = {};
  }
  if (Array.isArray(cleaned.required)) {
    cleaned.required = [...new Set(cleaned.required.filter(
      (name) => typeof name === "string" && Object.hasOwn(cleaned.properties, name)
    ))];
    if (cleaned.required.length === 0) delete cleaned.required;
  }
  return cleaned;
}

/**
 * Normalize OpenAI- or Claude-shaped tool definitions into Kiro tool specs.
 * Repeated definitions with the same source name describe the same tool.
 *
 * @returns {{ specs: Array, nameMap: Map }}
 */
export function normalizeKiroToolSpecs(tools) {
  const specs = [];
  const nameMap = new Map();
  const usedNames = new Set();

  for (const [index, tool] of (Array.isArray(tools) ? tools : []).entries()) {
    if (!tool || typeof tool !== "object") continue;
    const rawName = tool.function?.name ?? tool.name;
    if (typeof rawName !== "string" || !rawName.trim()) continue;

    // A repeated definition with the same source name describes the same tool.
    if (nameMap.has(rawName)) continue;
    const name = uniqueName(rawName, index, usedNames);
    nameMap.set(rawName, name);

    const rawDescription = tool.function?.description ?? tool.description ?? `Tool: ${rawName}`;
    const description = trimCodePoints(
      String(rawDescription || `Tool: ${rawName}`),
      KIRO_TOOL_DESCRIPTION_MAX_LENGTH
    );
    const schema = tool.function?.parameters ?? tool.parameters ?? tool.input_schema ?? {};
    specs.push({
      toolSpecification: {
        name,
        description,
        inputSchema: { json: normalizeRootSchema(schema) },
      },
    });
  }

  return { specs, nameMap };
}
