// OpenCode requests that do not originate from a Kimaki prompt call carry no
// per-message `system` parameter, so their assembled system prompt ends at
// `</available_skills>` while every Kimaki-prompted turn continues into the
// Discord addendum. Affected in-session paths: slash-command turns
// (session.command), the post-compaction synthetic "continue" turn, and
// revert/redo replays. On a prefix-cached backend (qMLX restores disk KV
// checkpoints keyed on the token prefix) the shared prefix snaps at exactly
// that byte — the live divergence logs show cached `next` = the Discord
// addendum and incoming `next` = qMLX's server-side tool-use suffix, i.e. the
// incoming request simply had no addendum at all.
//
// This plugin appends the canonical addendum (written by the bot process via
// system-addendum-store.ts) to any system prompt that contains the skills
// block but not the addendum, reproducing OpenCode's own join ("\n" between
// parts — see the system assembly in session/llm/request.ts) byte-for-byte.
// Gates, all fail-safe to current behaviour:
// - system is the expected array shape with a string first element
// - the prompt contains `<available_skills` (present on main-agent and
//   subagent turns; absent on title/summarize prompts, which must NOT get the
//   addendum)
// - the addendum signature is not already present (Kimaki-prompted turns)
// - the canonical file for this project directory exists and is non-empty

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { createPluginLogger } from './plugin-logger.js'
import {
  ADDENDUM_SIGNATURE,
  readCanonicalAddendum,
} from './system-addendum-store.js'

const logger = createPluginLogger('OPENCODE')

const SKILLS_MARKER = '<available_skills'

// Append `addendum` to the final system part the way OpenCode's own join
// would have ("\n" separator), when the gates allow it. Returns the same
// array reference (no-op signal) otherwise. Exported for tests.
export function appendCanonicalAddendum(
  system: string[],
  addendum: string | undefined,
): string[] {
  if (!Array.isArray(system) || system.length === 0) return system
  if (!addendum) return system
  const joined = system.join('\n')
  if (!joined.includes(SKILLS_MARKER)) return system
  if (joined.includes(ADDENDUM_SIGNATURE)) return system
  const last = system[system.length - 1]
  if (typeof last !== 'string') return system
  const result = system.slice()
  // OpenCode joins system parts with "\n"; appending "\n" + addendum to the
  // last part produces the identical byte stream to the addendum having been
  // passed as the per-message `system` parameter.
  result[result.length - 1] = last + '\n' + addendum
  return result
}

const systemAddendumPlugin: Plugin = async (input) => {
  const directory = input?.directory
  let warnedMissingFile = false
  return {
    'experimental.chat.system.transform': (async (_input, output) => {
      try {
        const system = output.system
        if (!Array.isArray(system)) return
        if (typeof directory !== 'string' || directory.length === 0) return
        // Cheap pre-gates before touching the filesystem.
        const joined = system.join('\n')
        if (!joined.includes(SKILLS_MARKER)) return
        if (joined.includes(ADDENDUM_SIGNATURE)) return
        const addendum = readCanonicalAddendum(directory)
        if (!addendum) {
          // One-shot observability: a skills-bearing request had no addendum
          // and no canonical file exists, so this turn will snap the shared
          // prefix at </available_skills> — the exact break this plugin is
          // for. Happens legitimately until the bot has prompted this
          // directory once.
          if (!warnedMissingFile) {
            warnedMissingFile = true
            logger.warn(
              '[system-addendum] no canonical addendum file for ' +
                `${directory}; skills-bearing request without an addendum ` +
                'will cold-break the shared KV-cache prefix.',
            )
          }
          return
        }
        const appended = appendCanonicalAddendum(system, addendum)
        if (appended === system) return
        // Mutate in place so other transform hooks keep their array reference.
        output.system.splice(0, system.length, ...appended)
      } catch (err) {
        // Degrade to "no addendum" rather than killing the turn.
        logger.warn(
          `[system-addendum] transform failed, skipping: ${String(err)}`,
        )
      }
    }) satisfies NonNullable<Hooks['experimental.chat.system.transform']>,
  }
}

export { systemAddendumPlugin }
