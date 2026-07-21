// OpenCode's system prompt embeds an <env> block ("Working directory",
// "Workspace root folder", "Is directory a git repo", "Platform",
// "Today's date") roughly 10k tokens into the single-string prompt. The
// anthropic-auth plugin compacts this block for Anthropic requests only (its
// transform returns early unless providerID === 'anthropic'), so on every
// other provider the raw block ships — and "Today's date" flips at midnight
// in the server's timezone, cold-breaking the KV-cache prefix of every
// session once per day. The block sits before the entire conversation
// history, so a date change re-prefills everything after it.
//
// This transform replaces the <env> block with the same compact cwd-only
// <environment> block the Anthropic path uses, on all providers. Date
// awareness moves to a per-turn <system-reminder> in the synthetic user
// context (see system-message.ts), which lives in the append-only tail of
// the conversation and never invalidates the cached prefix. The per-session
// working directory is constant for the life of a session, so keeping it in
// the system prompt costs nothing. No-op and fail-safe when the markers or
// the "Working directory:" signature are absent.

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { createPluginLogger } from './plugin-logger.js'

const logger = createPluginLogger('OPENCODE')

const ENV_OPEN_TAG = '<env>'
const ENV_CLOSE_TAG = '</env>'

// Replace the FIRST <env>...</env> block in `text` with a compact cwd-only
// <environment> block, byte-identical to the one the anthropic-auth plugin
// produces. Returns the input unchanged when there is no complete block or
// the block lacks the OpenCode env signature, so a stray "<env>" mention
// elsewhere in the prompt is never mangled.
export function compactEnvBlock(text: string): string {
  if (typeof text !== 'string') return text
  const startIndex = text.indexOf(ENV_OPEN_TAG)
  if (startIndex === -1) return text
  const closeIndex = text.indexOf(ENV_CLOSE_TAG, startIndex)
  if (closeIndex === -1) return text
  const endIndex = closeIndex + ENV_CLOSE_TAG.length
  const afterEnd = text[endIndex] === '\n' ? endIndex + 1 : endIndex
  const stripped = text.slice(startIndex, afterEnd)
  const cwd = /Working directory:\s*(.+)/.exec(stripped)?.[1]?.trim()
  if (!cwd) return text
  const compact =
    `<environment>\n<cwd>${cwd}</cwd>\n</environment>\n` +
    `Read, write, and edit files under ${cwd}.\n`
  return text.slice(0, startIndex) + compact + text.slice(afterEnd)
}

const envCompactPlugin: Plugin = async () => {
  return {
    'experimental.chat.system.transform': (async (_input, output) => {
      try {
        const system = output.system
        if (!Array.isArray(system)) return
        for (let i = 0; i < system.length; i += 1) {
          const part = system[i]
          if (typeof part !== 'string') continue
          const compacted = compactEnvBlock(part)
          if (compacted !== part) {
            // Mutate in place so other transform hooks keep their reference.
            system.splice(i, 1, compacted)
          }
        }
      } catch (err) {
        // Degrade to "no compaction" rather than killing the turn if a future
        // change ever makes this throw.
        logger.warn(`[env-compact] transform failed, skipping: ${String(err)}`)
      }
    }) satisfies NonNullable<Hooks['experimental.chat.system.transform']>,
  }
}

export { envCompactPlugin }
