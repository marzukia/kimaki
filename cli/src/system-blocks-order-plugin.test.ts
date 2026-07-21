// Tests for locale-independent ordering of <available_references> and
// <mcp_instructions> blocks.

import { describe, expect, it } from 'vitest'
import {
  BLOCK_SPECS,
  canonicalizeBlock,
  canonicalizeSystemBlocks,
} from './system-blocks-order-plugin.js'

function reference(name: string): string {
  return (
    `  <reference>\n` +
    `    <name>${name}</name>\n` +
    `    <path>/refs/${name}</path>\n` +
    `  </reference>`
  )
}

function referencesBlock(names: string[]): string {
  return `<available_references>\n${names.map(reference).join('\n')}\n</available_references>`
}

function server(name: string): string {
  return `  <server name="${name}">\n    instructions for ${name}\n  </server>`
}

function mcpBlock(names: string[]): string {
  return `<mcp_instructions>\n${names.map(server).join('\n')}\n</mcp_instructions>`
}

describe('canonicalizeSystemBlocks', () => {
  it('maps differently-ordered reference blocks to byte-identical output', () => {
    const fromA = canonicalizeSystemBlocks([
      `intro\n${referencesBlock(['zeta', 'alpha', 'mid'])}\noutro`,
    ])
    const fromB = canonicalizeSystemBlocks([
      `intro\n${referencesBlock(['mid', 'zeta', 'alpha'])}\noutro`,
    ])
    expect(fromA).toEqual(fromB)
    expect(fromA).toEqual([
      `intro\n${referencesBlock(['alpha', 'mid', 'zeta'])}\noutro`,
    ])
  })

  it('maps differently-ordered mcp server blocks to byte-identical output', () => {
    const fromA = canonicalizeSystemBlocks([mcpBlock(['srv-b', 'srv-a'])])
    const fromB = canonicalizeSystemBlocks([mcpBlock(['srv-a', 'srv-b'])])
    expect(fromA).toEqual(fromB)
    expect(fromA).toEqual([mcpBlock(['srv-a', 'srv-b'])])
  })

  it('sorts both blocks when present in the same part, leaving other bytes intact', () => {
    const part = `head\n${mcpBlock(['z', 'a'])}\nmiddle\n${referencesBlock(['b', 'a'])}\ntail`
    const [result] = canonicalizeSystemBlocks([part])
    expect(result).toBe(
      `head\n${mcpBlock(['a', 'z'])}\nmiddle\n${referencesBlock(['a', 'b'])}\ntail`,
    )
  })

  it('no-ops (same reference) when there is nothing to sort', () => {
    const alreadySorted = [referencesBlock(['a', 'b'])]
    expect(canonicalizeSystemBlocks(alreadySorted)).toBe(alreadySorted)
    const noBlocks = ['plain prompt']
    expect(canonicalizeSystemBlocks(noBlocks)).toBe(noBlocks)
    const single = [mcpBlock(['only'])]
    expect(canonicalizeSystemBlocks(single)).toBe(single)
  })

  it('no-ops on an unterminated block (parse ambiguity fails safe)', () => {
    const broken = '<available_references>\n  <reference><name>x</name>'
    expect(canonicalizeBlock(broken, BLOCK_SPECS[0]!)).toBe(broken)
  })

  it('uses code-point order, not locale order', () => {
    // Code-point order puts uppercase before lowercase ("Z" < "a"), which is
    // exactly where localeCompare-based orders typically differ.
    const [result] = canonicalizeSystemBlocks([referencesBlock(['a', 'Z'])])
    expect(result).toBe(referencesBlock(['Z', 'a']))
  })

  it('is idempotent', () => {
    const input = [referencesBlock(['c', 'a', 'b'])]
    const once = canonicalizeSystemBlocks(input)
    expect(canonicalizeSystemBlocks(once)).toBe(once)
  })
})
