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
// This plugin pins the two blocks to a fixed order so the assembled prompt is
// byte-stable across processes and the cache survives session boundaries. It is
// surgical: it only moves the Discord addendum relative to the base
// instruction and leaves every other part (skills list, dynamic reminders, the
// user's message) exactly where it was. If either signature is absent (for
// example OpenCode changes its base wording in a future version) it is a no-op,
// so it fails safe to current behaviour.

import type { Hooks, Plugin } from '@opencode-ai/plugin'

// Stable substring of Kimaki's Discord addendum. See getOpencodeSystemMessage
// in system-message.ts.
const DISCORD_ADDENDUM_SIGNATURE = 'reading your messages from inside Discord'
// Stable substring of OpenCode's base tool-use instruction.
const OPENCODE_BASE_SIGNATURE = 'use the appropriate tool immediately'

// Return the system parts with the Discord addendum pinned to directly after
// the OpenCode base instruction. Deterministic and idempotent: the two possible
// arrival orders both map to the same output. Returns the same array reference
// (a no-op signal) when nothing needs to move.
export function canonicalizeSystemOrder(system: string[]): string[] {
  const discordIndex = system.findIndex((part) =>
    part.includes(DISCORD_ADDENDUM_SIGNATURE),
  )
  const baseIndex = system.findIndex((part) =>
    part.includes(OPENCODE_BASE_SIGNATURE),
  )
  // One of the blocks is missing, or the base instruction already precedes the
  // Discord addendum: nothing to do.
  if (discordIndex === -1 || baseIndex === -1) return system
  if (baseIndex < discordIndex) return system

  const result = system.slice()
  const [discordPart] = result.splice(discordIndex, 1)
  // Removing the Discord part (which was ahead of the base instruction) shifts
  // the base instruction left by one, so re-find it and insert the addendum
  // immediately after.
  const insertionIndex =
    result.findIndex((part) => part.includes(OPENCODE_BASE_SIGNATURE)) + 1
  result.splice(insertionIndex, 0, discordPart)
  return result
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

export { systemOrderPlugin }
