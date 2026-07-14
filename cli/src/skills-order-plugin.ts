// OpenCode hands Kimaki the system prompt as an array of string parts, but in
// the current build the whole prompt arrives as a SINGLE ~61k-char element
// rather than one part per block. Inside that one string sits an
// <available_skills> block whose <skill> entries are emitted in an order that
// is decided once per process and can differ between processes/sessions (e.g.
// `egaki` and `debug-session` swap places). Because everything is one prefix,
// any reorder of those entries cold-breaks the KV cache from that point on
// (~8.6k tokens in): a new session or a process restart that rolls the opposite
// order cannot reuse the disk checkpoints a previous session wrote, and the
// conversation re-prefills cold.
//
// The earlier system-order-plugin fixed a related break by REORDERING array
// elements. That approach is now a no-op because there is only one element, so
// this plugin operates on the STRING content instead: it sorts the <skill>
// entries inside the block into a deterministic order while preserving every
// byte outside the entries (surrounding text, the tags, and the original
// inter-entry whitespace/indentation). If the block is absent, has fewer than
// two entries, is already sorted, or is ambiguous to parse, it is a no-op
// (returns the same array reference) and fails safe to current behaviour.

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { createPluginLogger } from './plugin-logger.js'

const logger = createPluginLogger('OPENCODE')

const OPEN_TAG_PREFIX = '<available_skills'
const CLOSE_TAG = '</available_skills>'

const SKILL_RE = /<skill>[\s\S]*?<\/skill>/g
const NAME_RE = /<name>([\s\S]*?)<\/name>/

type SkillsBlock = {
  before: string
  openingTag: string
  leadingWhitespace: string
  skills: string[]
  separators: string[]
  trailingWhitespace: string
  after: string
}

// Locate and split the FIRST <available_skills>...</available_skills> block in
// `part` into its literal pieces. Returns undefined when there is no complete
// block. The interior is decomposed as leadingWhitespace + skill[0] + sep[0] +
// skill[1] + ... + skill[N-1] + trailingWhitespace, so reassembling with the
// skills reordered but separators kept in their positional slots preserves the
// original whitespace layout exactly.
function parseSkillsBlock(part: string): SkillsBlock | undefined {
  const startIndex = part.indexOf(OPEN_TAG_PREFIX)
  if (startIndex === -1) return undefined
  const openEnd = part.indexOf('>', startIndex + OPEN_TAG_PREFIX.length)
  if (openEnd === -1) return undefined
  const closeIndex = part.indexOf(CLOSE_TAG, openEnd + 1)
  if (closeIndex === -1) return undefined

  const before = part.slice(0, startIndex)
  const openingTag = part.slice(startIndex, openEnd + 1)
  const interior = part.slice(openEnd + 1, closeIndex)
  const after = part.slice(closeIndex + CLOSE_TAG.length)

  const skills: string[] = []
  const spans: Array<[number, number]> = []
  SKILL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SKILL_RE.exec(interior)) !== null) {
    skills.push(match[0])
    spans.push([match.index, match.index + match[0].length])
  }
  if (skills.length === 0) {
    return {
      before,
      openingTag,
      leadingWhitespace: interior,
      skills: [],
      separators: [],
      trailingWhitespace: '',
      after,
    }
  }

  const leadingWhitespace = interior.slice(0, spans[0][0])
  const trailingWhitespace = interior.slice(spans[spans.length - 1][1])
  const separators: string[] = []
  for (let i = 0; i < spans.length - 1; i += 1) {
    separators.push(interior.slice(spans[i][1], spans[i + 1][0]))
  }

  return {
    before,
    openingTag,
    leadingWhitespace,
    skills,
    separators,
    trailingWhitespace,
    after,
  }
}

// Inner text of the first <name> in a skill entry, trimmed. undefined when the
// entry has no parseable <name> (a parse ambiguity that must abort the sort).
function skillName(skill: string): string | undefined {
  const match = NAME_RE.exec(skill)
  if (!match) return undefined
  return match[1].trim()
}

// Deterministic, locale-independent comparison by Unicode code point, so the
// same set of names produces the same order on every machine and process.
function compareNames(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// Sort the <skill> entries inside the FIRST <available_skills> block of each
// system part into a deterministic (code-point-by-name) order, preserving all
// surrounding bytes and the original inter-entry whitespace. Idempotent.
// Returns the same array reference (a no-op signal) when nothing changes: no
// block, fewer than two skills, already sorted, or any entry lacks a parseable
// <name>.
export function canonicalizeSkillsOrder(system: string[]): string[] {
  if (!Array.isArray(system)) return system

  let changed = false
  const result = system.map((part) => {
    if (typeof part !== 'string') return part
    const block = parseSkillsBlock(part)
    if (!block) return part
    if (block.skills.length < 2) return part

    const named = block.skills.map((skill) => ({
      skill,
      name: skillName(skill),
    }))
    // Any entry without a parseable <name> is a format drift we can't safely
    // sort around; leave the part untouched.
    if (named.some((entry) => entry.name === undefined)) return part

    const sorted = [...named].sort((a, b) =>
      compareNames(a.name as string, b.name as string),
    )
    if (sorted.every((entry, i) => entry.skill === block.skills[i])) {
      // Already in canonical order for this part.
      return part
    }

    const sortedSkills = sorted.map((entry) => entry.skill)
    let interior = block.leadingWhitespace
    for (let i = 0; i < sortedSkills.length; i += 1) {
      interior += sortedSkills[i]
      if (i < block.separators.length) interior += block.separators[i]
    }
    interior += block.trailingWhitespace

    const rebuilt =
      block.before + block.openingTag + interior + CLOSE_TAG + block.after
    if (rebuilt === part) return part
    changed = true
    return rebuilt
  })

  return changed ? result : system
}

// True when a part contains an <available_skills> block but not a single
// parseable <name> inside it. Signals that the block format has drifted and the
// sort has silently become a no-op.
function hasSkillsBlockWithNoNames(part: string): boolean {
  const block = parseSkillsBlock(part)
  if (!block) return false
  if (block.skills.length === 0) return true
  return block.skills.every((skill) => skillName(skill) === undefined)
}

const skillsOrderPlugin: Plugin = async () => {
  let warnedFormatDrift = false
  return {
    'experimental.chat.system.transform': (async (_input, output) => {
      try {
        const system = output.system
        if (!Array.isArray(system)) return
        // One-shot observability for the drift that has no test and no other
        // signal: an <available_skills> block is present but nothing inside it
        // parses as a <name>, so the sort silently reverts to cold re-prefills.
        if (
          !warnedFormatDrift &&
          system.some((part) =>
            typeof part === 'string' && hasSkillsBlockWithNoNames(part),
          )
        ) {
          warnedFormatDrift = true
          logger.warn(
            '[skills-order] <available_skills> block present but no parseable ' +
              '<name> entries — deterministic sort is a no-op; the skills block ' +
              'format may have drifted.',
          )
        }
        const canonical = canonicalizeSkillsOrder(system)
        if (canonical === system) return
        // Mutate in place so other transform hooks keep their array reference.
        output.system.splice(0, system.length, ...canonical)
      } catch (err) {
        // Degrade to "no reordering" rather than killing the turn if a future
        // change ever makes the sort throw.
        logger.warn(
          `[skills-order] transform failed, skipping reorder: ${String(err)}`,
        )
      }
    }) satisfies NonNullable<Hooks['experimental.chat.system.transform']>,
  }
}

export { skillsOrderPlugin }
