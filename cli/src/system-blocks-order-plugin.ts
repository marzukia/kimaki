// Locale-independent ordering for the remaining sortable XML blocks in the
// system prompt: <available_references> and <mcp_instructions>.
//
// OpenCode core does sort both blocks, but with localeCompare
// (session/system.ts renders references with .toSorted(localeCompare); the
// MCP instructions list sorts server names with localeCompare in
// mcp/index.ts). localeCompare consults the process ICU locale, which
// differs between e.g. a systemd service with no LANG and an interactive
// shell — so two processes on the same machine can render the same set of
// entries in different orders. On a prefix-cached backend any reorder snaps
// the shared KV-cache prefix at the first differing byte and cold-prefills
// everything after it (these blocks sit before the conversation history).
// The <mcp_instructions> block additionally only includes servers that are
// CONNECTED at request time, so a slow MCP handshake makes early requests
// differ from later ones — that presence race is not fixable by sorting and
// is called out in the PR instead.
//
// Same string-surgery pattern as skills-order-plugin.ts: sort the entries
// inside each block into deterministic code-point order while preserving
// every byte outside the entries (surrounding text, tags, inter-entry
// whitespace). No-op and fail-safe when a block is absent, has fewer than
// two entries, is already sorted, or is ambiguous to parse.

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { createPluginLogger } from './plugin-logger.js'

const logger = createPluginLogger('OPENCODE')

type BlockSpec = {
  /** Opening tag prefix, e.g. '<available_references' */
  openTagPrefix: string
  /** Full closing tag, e.g. '</available_references>' */
  closeTag: string
  /** Matches one complete entry inside the block. Must use the g flag. */
  entryRe: RegExp
  /** Extracts the sort key from one entry; undefined aborts the sort. */
  keyOf: (entry: string) => string | undefined
}

const REFERENCE_NAME_RE = /<name>([\s\S]*?)<\/name>/

export const BLOCK_SPECS: BlockSpec[] = [
  {
    openTagPrefix: '<available_references',
    closeTag: '</available_references>',
    entryRe: /<reference>[\s\S]*?<\/reference>/g,
    keyOf: (entry) => REFERENCE_NAME_RE.exec(entry)?.[1]?.trim(),
  },
  {
    openTagPrefix: '<mcp_instructions',
    closeTag: '</mcp_instructions>',
    entryRe: /<server name="[^"]*">[\s\S]*?<\/server>/g,
    keyOf: (entry) => /<server name="([^"]*)">/.exec(entry)?.[1],
  },
]

// Deterministic, locale-independent comparison by Unicode code point.
function compareByCodePoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// Sort the entries of the FIRST occurrence of the spec's block inside `part`
// into code-point order by key, preserving all surrounding bytes and the
// original inter-entry whitespace (separators stay in their positional
// slots). Returns `part` unchanged (no-op signal) when there is no complete
// block, fewer than two entries, any entry lacks a parseable key, or the
// order is already canonical.
export function canonicalizeBlock(part: string, spec: BlockSpec): string {
  if (typeof part !== 'string') return part
  const startIndex = part.indexOf(spec.openTagPrefix)
  if (startIndex === -1) return part
  const openEnd = part.indexOf('>', startIndex + spec.openTagPrefix.length)
  if (openEnd === -1) return part
  const closeIndex = part.indexOf(spec.closeTag, openEnd + 1)
  if (closeIndex === -1) return part

  const interior = part.slice(openEnd + 1, closeIndex)

  const entries: string[] = []
  const spans: Array<[number, number]> = []
  spec.entryRe.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = spec.entryRe.exec(interior)) !== null) {
    entries.push(match[0])
    spans.push([match.index, match.index + match[0].length])
  }
  if (entries.length < 2) return part

  const keyed = entries.map((entry) => ({ entry, key: spec.keyOf(entry) }))
  if (keyed.some((item) => item.key === undefined)) return part

  const sorted = keyed
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => {
      const byKey = compareByCodePoint(a.key as string, b.key as string)
      // Stable tiebreak so equal keys never reorder.
      return byKey !== 0 ? byKey : a.index - b.index
    })
  if (sorted.every((item, i) => item.entry === entries[i])) return part

  const leading = interior.slice(0, spans[0]![0])
  const trailing = interior.slice(spans[spans.length - 1]![1])
  const separators: string[] = []
  for (let i = 0; i < spans.length - 1; i += 1) {
    separators.push(interior.slice(spans[i]![1], spans[i + 1]![0]))
  }

  let rebuiltInterior = leading
  for (let i = 0; i < sorted.length; i += 1) {
    rebuiltInterior += sorted[i]!.entry
    if (i < separators.length) rebuiltInterior += separators[i]
  }
  rebuiltInterior += trailing

  return (
    part.slice(0, openEnd + 1) +
    rebuiltInterior +
    part.slice(closeIndex)
  )
}

// Apply every block spec to every system part. Returns the same array
// reference when nothing changes.
export function canonicalizeSystemBlocks(system: string[]): string[] {
  if (!Array.isArray(system)) return system
  let changed = false
  const result = system.map((part) => {
    if (typeof part !== 'string') return part
    let current = part
    for (const spec of BLOCK_SPECS) {
      current = canonicalizeBlock(current, spec)
    }
    if (current !== part) changed = true
    return current
  })
  return changed ? result : system
}

const systemBlocksOrderPlugin: Plugin = async () => {
  return {
    'experimental.chat.system.transform': (async (_input, output) => {
      try {
        const system = output.system
        if (!Array.isArray(system)) return
        const canonical = canonicalizeSystemBlocks(system)
        if (canonical === system) return
        // Mutate in place so other transform hooks keep their array reference.
        output.system.splice(0, system.length, ...canonical)
      } catch (err) {
        // Degrade to "no reordering" rather than killing the turn.
        logger.warn(
          `[system-blocks-order] transform failed, skipping: ${String(err)}`,
        )
      }
    }) satisfies NonNullable<Hooks['experimental.chat.system.transform']>,
  }
}

export { systemBlocksOrderPlugin }
