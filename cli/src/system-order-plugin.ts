// OpenCode assembles the system prompt as an array of string parts. The base
// OpenCode tool-use instruction ("...you MUST use the appropriate tool
// immediately...") and Kimaki's Discord addendum ("The user is reading your
// messages from inside Discord, via kimaki.dev...") land in that array in an
// order that is decided once per process and can differ between processes. Both
// blocks sit right after the skills list, so when the order flips the cached KV
// prefix ends where they start (around token 11.6k). A new session or a process
// restart that rolls the opposite order cannot reuse the disk checkpoints a
// previous session wrote, and the whole conversation re-prefills cold.
//
// This plugin canonicalizes the two blocks to a single fixed layout so the
// assembled prompt is byte-stable across processes. It pulls both blocks
// together as [base, discord] at the slot of whichever came first. That
// converges for BOTH arrival orders even when unrelated parts sit between the
// two blocks (pinning only their relative order does NOT converge in that case,
// which is why this removes-and-reinserts both rather than moving just one).
// Every other part keeps its relative order. If either signature is absent, is
// ambiguous, or the layout is already canonical, it is a no-op (returns the
// same array reference) and fails safe to current behaviour.

import type { Hooks, Plugin } from '@opencode-ai/plugin'

// Stable substring of Kimaki's Discord addendum. See getOpencodeSystemMessage
// in system-message.ts. A contract test asserts the real addendum still
// contains this, so a Kimaki-side wording change fails CI instead of silently
// turning this plugin into a no-op.
const DISCORD_ADDENDUM_SIGNATURE = 'reading your messages from inside Discord'
// Stable substring of OpenCode's base tool-use instruction. This block is owned
// by OpenCode core (not this repo), so it can't be contract-tested locally; an
// OpenCode wording change would silently no-op this plugin.
const OPENCODE_BASE_SIGNATURE = 'use the appropriate tool immediately'

function matches(part: unknown, signature: string): boolean {
  return typeof part === 'string' && part.includes(signature)
}

// Return the system parts with the base instruction and Discord addendum pulled
// together as [base, discord] at the position of whichever came first.
// Deterministic and idempotent: both possible arrival orders map to the same
// output. Returns the same array reference (a no-op signal) when nothing needs
// to move or the situation is ambiguous.
export function canonicalizeSystemOrder(system: string[]): string[] {
  if (!Array.isArray(system)) return system

  const discordIndex = system.findIndex((part) =>
    matches(part, DISCORD_ADDENDUM_SIGNATURE),
  )
  const baseIndex = system.findIndex((part) =>
    matches(part, OPENCODE_BASE_SIGNATURE),
  )
  // A block is missing, or both signatures live in the same element: nothing
  // safe to do.
  if (discordIndex === -1 || baseIndex === -1 || discordIndex === baseIndex) {
    return system
  }
  // A signature appears in more than one element: bail rather than guess which
  // is the real block, so a future wording collision fails safe.
  const discordCount = system.filter((part) =>
    matches(part, DISCORD_ADDENDUM_SIGNATURE),
  ).length
  const baseCount = system.filter((part) =>
    matches(part, OPENCODE_BASE_SIGNATURE),
  ).length
  if (discordCount > 1 || baseCount > 1) return system
  // Already canonical: base immediately followed by the Discord addendum.
  if (baseIndex + 1 === discordIndex) return system

  const basePart = system[baseIndex]
  const discordPart = system[discordIndex]
  const anchor = Math.min(baseIndex, discordIndex)
  // Everything except the two blocks, in original relative order. All parts
  // before `anchor` are non-block (anchor is the first block's slot), so they
  // occupy rest[0..anchor-1]; reinsert [base, discord] at `anchor`.
  const rest = system.filter((_, i) => i !== baseIndex && i !== discordIndex)
  return [...rest.slice(0, anchor), basePart, discordPart, ...rest.slice(anchor)]
}

const systemOrderPlugin: Plugin = async () => {
  return {
    'experimental.chat.system.transform': (async (_input, output) => {
      const canonical = canonicalizeSystemOrder(output.system)
      if (canonical === output.system) return
      // Mutate in place so other transform hooks keep their array reference.
      output.system.splice(0, output.system.length, ...canonical)
    }) satisfies NonNullable<Hooks['experimental.chat.system.transform']>,
  }
}

export { systemOrderPlugin, DISCORD_ADDENDUM_SIGNATURE, OPENCODE_BASE_SIGNATURE }
