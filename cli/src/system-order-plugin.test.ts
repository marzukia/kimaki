import { describe, expect, it } from 'vitest'
import {
  canonicalizeSystemOrder,
  DISCORD_ADDENDUM_SIGNATURE,
  OPENCODE_BASE_SIGNATURE,
} from './system-order-plugin.js'
import { getOpencodeSystemMessage } from './system-message.js'

// Approximations of the two blocks that flip order in the logs.
const BASE = `IMPORTANT: When the user's request can be answered using the provided tools, you MUST ${OPENCODE_BASE_SIGNATURE}. Do NOT ask for clarification when a reasonable default exists.`
const DISCORD = `The user is ${DISCORD_ADDENDUM_SIGNATURE}, via kimaki.dev\n\n## bash tool`
const SKILLS = '<available_skills>\n<skill>...</skill>\n</available_skills>'
const X = '<some-other-instruction-block/>'
const REMINDER = '<system-reminder>\nCurrent agent: build\n</system-reminder>'

describe('canonicalizeSystemOrder', () => {
  it('maps both ADJACENT arrival orders to the same canonical order', () => {
    const fromA = canonicalizeSystemOrder([SKILLS, BASE, DISCORD])
    const fromB = canonicalizeSystemOrder([SKILLS, DISCORD, BASE])
    expect(fromA).toEqual(fromB)
    expect(fromB).toEqual([SKILLS, BASE, DISCORD])
  })

  it('maps both NON-ADJACENT arrival orders to the same canonical order', () => {
    // The real bug is a pure swap of the two blocks with an unrelated part X
    // fixed between them. Pinning only relative order does NOT converge here;
    // this is the case that must hold.
    const fromA = canonicalizeSystemOrder([SKILLS, BASE, X, DISCORD])
    const fromB = canonicalizeSystemOrder([SKILLS, DISCORD, X, BASE])
    expect(fromA).toEqual(fromB)
    expect(fromB).toEqual([SKILLS, BASE, DISCORD, X])
  })

  it('is idempotent (second pass is a no-op reference)', () => {
    const once = canonicalizeSystemOrder([SKILLS, DISCORD, X, BASE])
    expect(canonicalizeSystemOrder(once)).toBe(once)
  })

  it('keeps trailing unrelated parts after the blocks', () => {
    const result = canonicalizeSystemOrder([SKILLS, DISCORD, BASE, REMINDER])
    expect(result).toEqual([SKILLS, BASE, DISCORD, REMINDER])
  })

  it('no-ops (same reference) when already canonical', () => {
    const input = [SKILLS, BASE, DISCORD]
    expect(canonicalizeSystemOrder(input)).toBe(input)
  })

  it('no-ops (same reference) when a signature is absent', () => {
    const noBase = [SKILLS, DISCORD]
    expect(canonicalizeSystemOrder(noBase)).toBe(noBase)
    const noDiscord = [SKILLS, BASE, REMINDER]
    expect(canonicalizeSystemOrder(noDiscord)).toBe(noDiscord)
  })

  it('no-ops (same reference) when both signatures are in one element', () => {
    const combined = [SKILLS, `${BASE}\n${DISCORD}`]
    expect(canonicalizeSystemOrder(combined)).toBe(combined)
  })

  it('no-ops (same reference) when a signature is ambiguous (multiple matches)', () => {
    const dupDiscord = [SKILLS, DISCORD, BASE, DISCORD]
    expect(canonicalizeSystemOrder(dupDiscord)).toBe(dupDiscord)
  })

  it('no-ops on a non-array input', () => {
    // Defensive: the hook must not throw if output.system is malformed.
    const bad = undefined as unknown as string[]
    expect(canonicalizeSystemOrder(bad)).toBe(bad)
  })
})

// Contract test: the whole fix silently dies if the Discord addendum stops
// containing the signature this plugin matches on. Assert the real prompt still
// carries it, so a Kimaki-side wording change fails CI instead of shipping green
// while the KV cache re-prefills cold. (The OpenCode base signature is owned by
// OpenCode core and cannot be pinned from this repo.)
describe('DISCORD_ADDENDUM_SIGNATURE contract', () => {
  it('is present in the real getOpencodeSystemMessage output', () => {
    const prompt = getOpencodeSystemMessage({ sessionId: 'ses_contract_test' })
    expect(prompt).toContain(DISCORD_ADDENDUM_SIGNATURE)
  })
})
