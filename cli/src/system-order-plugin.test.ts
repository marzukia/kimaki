import { describe, expect, it } from 'vitest'
import { canonicalizeSystemOrder } from './system-order-plugin.js'

// Approximations of the two blocks that flip order in the logs.
const BASE =
  "IMPORTANT: When the user's request can be answered using the provided tools, you MUST use the appropriate tool immediately. Do NOT ask for clarification when a reasonable default exists."
const DISCORD =
  'The user is reading your messages from inside Discord, via kimaki.dev\n\n## bash tool\n\nWhen calling the bash tool, always include these extra fields alongside `command`:'
const SKILLS = '<available_skills>\n<skill>...</skill>\n</available_skills>'
const REMINDER = '<system-reminder>\nCurrent agent: build\n</system-reminder>'

describe('canonicalizeSystemOrder', () => {
  it('maps both arrival orders to the same canonical order', () => {
    const fromOrderA = canonicalizeSystemOrder([SKILLS, BASE, DISCORD])
    const fromOrderB = canonicalizeSystemOrder([SKILLS, DISCORD, BASE])
    expect(fromOrderA).toEqual(fromOrderB)
    // Canonical order is base instruction first, Discord addendum second.
    expect(fromOrderB).toEqual([SKILLS, BASE, DISCORD])
  })

  it('is idempotent', () => {
    const once = canonicalizeSystemOrder([SKILLS, DISCORD, BASE])
    const twice = canonicalizeSystemOrder(once)
    expect(twice).toEqual(once)
  })

  it('leaves unrelated parts (skills, reminders) in place', () => {
    const result = canonicalizeSystemOrder([SKILLS, DISCORD, BASE, REMINDER])
    expect(result).toEqual([SKILLS, BASE, DISCORD, REMINDER])
  })

  it('no-ops (same reference) when already canonical', () => {
    const input = [SKILLS, BASE, DISCORD]
    expect(canonicalizeSystemOrder(input)).toBe(input)
  })

  it('no-ops (same reference) when the base signature is absent', () => {
    const input = [SKILLS, DISCORD]
    expect(canonicalizeSystemOrder(input)).toBe(input)
  })

  it('no-ops (same reference) when the Discord signature is absent', () => {
    const input = [SKILLS, BASE, REMINDER]
    expect(canonicalizeSystemOrder(input)).toBe(input)
  })
})
