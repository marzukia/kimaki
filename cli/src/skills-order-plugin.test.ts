import { describe, expect, it } from 'vitest'
import { canonicalizeSkillsOrder } from './skills-order-plugin.js'

// A single <skill> entry with a given name, indented like the real block.
function skill(name: string): string {
  return (
    `  <skill>\n` +
    `    <name>${name}</name>\n` +
    `    <description>desc for ${name}</description>\n` +
    `    <location>&lt;built-in&gt;</location>\n` +
    `  </skill>`
  )
}

// Assemble an <available_skills> block from entries in the given order, with the
// uniform newline+indent separators the real prompt uses.
function block(names: string[]): string {
  return `<available_skills>\n${names.map(skill).join('\n')}\n</available_skills>`
}

// The exact captured format from the task, byte-for-byte.
const CAPTURED = `<available_skills>
  <skill>
    <name>egaki</name>
    <description>AI image and video generation CLI...</description>
    <location>&lt;built-in&gt;</location>
  </skill>
  <skill>
    <name>debug-session</name>
    <description>Systematic debugging workflow...</description>
    <location>/home/...</location>
  </skill>
</available_skills>`

describe('canonicalizeSkillsOrder', () => {
  it('maps two DIFFERENTLY-shuffled versions of the same block to byte-identical output', () => {
    const fromA = canonicalizeSkillsOrder([block(['egaki', 'debug-session', 'web-drop'])])
    const fromB = canonicalizeSkillsOrder([block(['web-drop', 'egaki', 'debug-session'])])
    expect(fromA).toEqual(fromB)
    expect(fromB).toEqual([block(['debug-session', 'egaki', 'web-drop'])])
  })

  it('no-ops (same reference) when there is no <available_skills> block', () => {
    const input = ['just a plain system prompt with no skills', 'another part']
    expect(canonicalizeSkillsOrder(input)).toBe(input)
  })

  it('no-ops (same reference) with a single skill', () => {
    const input = [block(['egaki'])]
    expect(canonicalizeSkillsOrder(input)).toBe(input)
  })

  it('preserves content outside the block byte-for-byte, including a sessionId', () => {
    const before = `You are an agent.\n\nsessionId: ses_abc123DEF456\n\n`
    const after = `\n\n<system-reminder>Current agent: build</system-reminder>`
    const input = [before + block(['egaki', 'debug-session']) + after]
    const result = canonicalizeSkillsOrder(input)
    expect(result).toEqual([before + block(['debug-session', 'egaki']) + after])
    // The bytes before and after the block are untouched.
    expect(result[0].startsWith(before)).toBe(true)
    expect(result[0].endsWith(after)).toBe(true)
    expect(result[0]).toContain('sessionId: ses_abc123DEF456')
  })

  it('sorts the exact captured format so debug-session precedes egaki', () => {
    const result = canonicalizeSkillsOrder([CAPTURED])
    const sorted = result[0]
    expect(sorted.indexOf('<name>debug-session</name>')).toBeLessThan(
      sorted.indexOf('<name>egaki</name>'),
    )
    // Everything outside the entries (tags, indentation) is preserved: the only
    // change is the entry order, so the sorted output re-parses cleanly and is
    // itself a fixed point.
    expect(canonicalizeSkillsOrder([sorted])).toEqual([sorted])
  })

  it('no-ops (same reference) when already sorted', () => {
    const input = [block(['debug-session', 'egaki', 'web-drop'])]
    expect(canonicalizeSkillsOrder(input)).toBe(input)
  })

  it('is idempotent (second pass is a no-op reference)', () => {
    const once = canonicalizeSkillsOrder([block(['egaki', 'debug-session'])])
    expect(canonicalizeSkillsOrder(once)).toBe(once)
  })

  it('no-ops (same reference) when a skill entry has no parseable <name>', () => {
    const malformed = `<available_skills>\n  <skill>\n    <description>no name here</description>\n  </skill>\n${skill('egaki')}\n</available_skills>`
    const input = [malformed]
    expect(canonicalizeSkillsOrder(input)).toBe(input)
  })

  it('no-ops on a non-array input', () => {
    const bad = undefined as unknown as string[]
    expect(canonicalizeSkillsOrder(bad)).toBe(bad)
  })
})
