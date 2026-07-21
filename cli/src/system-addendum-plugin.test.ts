// Tests for the canonical-addendum append plugin.

import { describe, expect, it } from 'vitest'
import { appendCanonicalAddendum } from './system-addendum-plugin.js'
import { ADDENDUM_SIGNATURE } from './system-addendum-store.js'

const PROVIDER_PROMPT = 'You are opencode, an interactive CLI tool.'
const ENV_BLOCK = '<environment>\n<cwd>/repo</cwd>\n</environment>'
const SKILLS_BLOCK =
  '<available_skills>\n' +
  '  <skill>\n    <name>web-drop</name>\n  </skill>\n' +
  '</available_skills>'
const ADDENDUM =
  '\nThe user is reading your messages from inside Discord, via kimaki.dev\n\n## bash tool\n'

describe('appendCanonicalAddendum', () => {
  it('produces byte-identical output to opencode joining user.system itself', () => {
    // OpenCode assembles the system prompt as
    //   [providerPrompt, ...systemParts, user.system].filter(Boolean).join("\n")
    // (session/llm/request.ts). A Kimaki prompt call supplies the addendum as
    // user.system; a slash-command / compaction-continue request supplies
    // nothing and the plugin appends instead. The two paths MUST converge on
    // the same bytes or the shared KV prefix snaps at </available_skills>.
    const parts = [PROVIDER_PROMPT, ENV_BLOCK, SKILLS_BLOCK]
    const corePath = [...parts, ADDENDUM].filter(Boolean).join('\n')

    const commandPath = appendCanonicalAddendum(
      [parts.filter(Boolean).join('\n')],
      ADDENDUM,
    )
    expect(commandPath.join('\n')).toBe(corePath)
  })

  it('no-ops (same reference) when the addendum is already present', () => {
    const system = [
      [PROVIDER_PROMPT, SKILLS_BLOCK, ADDENDUM].join('\n'),
    ]
    expect(system[0]).toContain(ADDENDUM_SIGNATURE)
    expect(appendCanonicalAddendum(system, ADDENDUM)).toBe(system)
  })

  it('no-ops (same reference) when the prompt has no skills block (title/summarize shapes)', () => {
    const system = ['Generate a short title for this conversation.']
    expect(appendCanonicalAddendum(system, ADDENDUM)).toBe(system)
  })

  it('no-ops (same reference) for empty addendum or empty system', () => {
    const system = [[PROVIDER_PROMPT, SKILLS_BLOCK].join('\n')]
    expect(appendCanonicalAddendum(system, undefined)).toBe(system)
    expect(appendCanonicalAddendum(system, '')).toBe(system)
    const empty: string[] = []
    expect(appendCanonicalAddendum(empty, ADDENDUM)).toBe(empty)
  })

  it('is idempotent', () => {
    const system = [[PROVIDER_PROMPT, SKILLS_BLOCK].join('\n')]
    const once = appendCanonicalAddendum(system, ADDENDUM)
    const twice = appendCanonicalAddendum(once, ADDENDUM)
    expect(twice).toBe(once)
  })

  it('appends to the LAST part when the system array has multiple parts', () => {
    const system = [PROVIDER_PROMPT, [ENV_BLOCK, SKILLS_BLOCK].join('\n')]
    const result = appendCanonicalAddendum(system, ADDENDUM)
    expect(result).not.toBe(system)
    expect(result[0]).toBe(PROVIDER_PROMPT)
    expect(result[1]!.endsWith('\n' + ADDENDUM)).toBe(true)
    // Join parity with core's "\n" join of separate parts.
    expect(result.join('\n')).toBe(
      [PROVIDER_PROMPT, ENV_BLOCK, SKILLS_BLOCK, ADDENDUM].join('\n'),
    )
  })
})
