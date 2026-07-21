// Deterministic tool ordering for KV-cache prefix stability.
//
// OpenCode passes tool definitions to the model as a native `tools` array
// (built in packages/opencode/src/session/tools.ts as a Record keyed by tool
// id, then handed to the AI SDK's streamText). The array order is the
// insertion order of that Record: the fixed built-in list first, then
// filesystem/plugin `custom` tools (appended in plugin.list() / glob order),
// then MCP tools (appended from Object.entries(mcp.tools())). The custom and
// MCP segments are NOT sorted, so their order depends on async plugin and MCP
// registration timing and can differ between processes and sessions.
//
// On a backend that renders tools INTO the prompt (a Hermes-style chat
// template serialises each tool's JSON schema into a <tools> block), any
// reorder of that array changes the prompt bytes at the tools block. A disk
// KV checkpoint written by a session with one order cannot be reused by a
// request with another: the shared prefix snaps at the first differing tool
// and everything after it re-prefills cold.
//
// The tools do not appear in OpenCode's system-prompt string (that array is
// [env, instructions, mcpInstructions, skills] — see session/prompt.ts), so a
// system-prompt transform hook like the skills-order plugin cannot reach them.
// The stable seam is the AI SDK model call itself: sort params.tools by name
// just before the provider serialises the request, via a LanguageModelV3
// middleware. Sorting by tool name is safe because tool order carries no
// meaning to the model: it selects a tool by name from the schema, and
// toolChoice references tools by name, never by position.

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Middleware,
  LanguageModelV3ProviderTool,
} from '@ai-sdk/provider'

type ToolDefinition = LanguageModelV3FunctionTool | LanguageModelV3ProviderTool

// Deterministic, locale-independent comparison by Unicode code point, so the
// same set of names produces the same order on every machine and process.
// Mirrors the comparator the skills-order plugin uses.
function compareByCodePoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// Return a copy of `tools` sorted by tool name in code-point order.
//
// Returns the SAME array reference (a no-op signal) when nothing changes:
// undefined/empty input, fewer than two tools, any entry missing a string
// `name` (a format drift we cannot safely sort around), or an input that is
// already in canonical order. The sort is stable, so tools that share a name
// keep their relative input order and the output stays deterministic.
export function sortToolDefinitions<T extends ToolDefinition>(
  tools: T[] | undefined,
): T[] | undefined {
  if (!Array.isArray(tools)) return tools
  if (tools.length < 2) return tools
  if (tools.some((tool) => typeof tool?.name !== 'string')) return tools

  const sorted = tools
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => {
      const byName = compareByCodePoint(a.tool.name, b.tool.name)
      // Stable tiebreak on original index so equal names never reorder.
      return byName !== 0 ? byName : a.index - b.index
    })

  if (sorted.every((entry, index) => entry.index === index)) {
    // Already canonical: preserve the reference so callers can detect no-op.
    return tools
  }
  return sorted.map((entry) => entry.tool)
}

// Sort params.tools deterministically. Returns the same params object when the
// order is unchanged, otherwise a shallow copy with a new tools array.
export function sortToolsInParams(
  params: LanguageModelV3CallOptions,
): LanguageModelV3CallOptions {
  const sorted = sortToolDefinitions(params.tools)
  if (sorted === params.tools) return params
  return { ...params, tools: sorted }
}

// AI SDK middleware that pins the tool order for every generate/stream call.
// Wrap a model with the AI SDK's wrapLanguageModel({ model, middleware }) or
// the withSortedTools helper below. NOTE: prefer withSortedTools — the
// installed @ai-sdk/openai-compatible already emits LanguageModelV4-shaped
// models, and wrapLanguageModel version-gates middleware on
// specificationVersion, so this v3-tagged middleware may be rejected against
// newer models. withSortedTools is version-agnostic (it only touches
// doGenerate/doStream params) and is what provider.ts uses.
export const sortToolsMiddleware: LanguageModelV3Middleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => sortToolsInParams(params),
}

// Wrap a LanguageModelV3 so every call sorts its tools first. Implemented as a
// thin passthrough (no dependency on the `ai` package): only doGenerate and
// doStream see params, so those are the sole methods that need the transform.
export function withSortedTools(model: LanguageModelV3): LanguageModelV3 {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(sortToolsInParams(options)),
    doStream: (options) => model.doStream(sortToolsInParams(options)),
  }
}
