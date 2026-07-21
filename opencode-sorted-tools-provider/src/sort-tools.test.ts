import { describe, expect, test } from 'vitest'

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
} from '@ai-sdk/provider'

import {
  sortToolDefinitions,
  sortToolsInParams,
  sortToolsMiddleware,
  withSortedTools,
} from './sort-tools.js'

function fn(name: string): LanguageModelV3FunctionTool {
  return {
    type: 'function',
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: {} },
  }
}

// A realistic mixed set: OpenCode built-ins, a Kimaki plugin tool, and an MCP
// tool — the segments whose registration order actually drifts at runtime.
const TOOL_NAMES = [
  'read',
  'question',
  'edit',
  'bash',
  'kimaki_file_upload',
  'grep',
  'mcp_github_search',
]

function params(tools: LanguageModelV3FunctionTool[]): LanguageModelV3CallOptions {
  return { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools }
}

describe('sortToolDefinitions', () => {
  test('two different input orders produce a byte-identical tools block', () => {
    const orderA = TOOL_NAMES.map(fn)
    // A genuinely different order: reversed, then rotate one, so it is neither
    // equal to orderA nor already sorted.
    const orderB = [...TOOL_NAMES].reverse().map(fn)
    const rotated = [orderB[orderB.length - 1]!, ...orderB.slice(0, -1)]

    expect(JSON.stringify(orderA)).not.toBe(JSON.stringify(rotated))

    const sortedA = sortToolDefinitions(orderA)!
    const sortedB = sortToolDefinitions(rotated)!

    // The whole point: the serialised tools block is identical regardless of
    // the incoming order, so a KV checkpoint written under one order is reusable
    // under the other.
    expect(JSON.stringify(sortedA)).toBe(JSON.stringify(sortedB))

    // And it is actually sorted by name (code-point order).
    expect(sortedA.map((t) => t.name)).toEqual([...TOOL_NAMES].sort())
  })

  test('is idempotent: sorting an already-sorted list is a no-op reference', () => {
    const sortedOnce = sortToolDefinitions(TOOL_NAMES.map(fn))!
    // Second pass returns the same reference (canonical-order no-op signal).
    expect(sortToolDefinitions(sortedOnce)).toBe(sortedOnce)
  })

  test('fewer than two tools is a no-op reference', () => {
    const one = [fn('read')]
    expect(sortToolDefinitions(one)).toBe(one)
    expect(sortToolDefinitions([])).toEqual([])
    expect(sortToolDefinitions(undefined)).toBeUndefined()
  })

  test('a tool missing a string name aborts the sort (fail safe)', () => {
    const drifted = [fn('read'), { type: 'function' } as LanguageModelV3FunctionTool, fn('edit')]
    // Left untouched rather than throwing or dropping the malformed entry.
    expect(sortToolDefinitions(drifted)).toBe(drifted)
  })

  test('is stable for duplicate names', () => {
    const a = fn('dup')
    const b = fn('dup')
    a.description = 'first'
    b.description = 'second'
    const sorted = sortToolDefinitions([fn('zzz'), a, b])!
    expect(sorted.map((t) => t.description)).toEqual(['first', 'second', 'the zzz tool'])
  })
})

describe('sortToolsInParams', () => {
  test('returns the same params reference when order is unchanged', () => {
    const p = params(TOOL_NAMES.map(fn).sort((x, y) => (x.name < y.name ? -1 : 1)))
    expect(sortToolsInParams(p)).toBe(p)
  })

  test('replaces only the tools array, preserving other params', () => {
    const unsorted = params([fn('read'), fn('bash'), fn('edit')])
    const out = sortToolsInParams(unsorted)
    expect(out).not.toBe(unsorted)
    expect(out.prompt).toBe(unsorted.prompt)
    expect(out.tools!.map((t) => t.name)).toEqual(['bash', 'edit', 'read'])
  })
})

describe('sortToolsMiddleware', () => {
  test('transformParams sorts tools for both generate and stream', async () => {
    const unsorted = params([fn('read'), fn('question'), fn('edit')])
    for (const type of ['generate', 'stream'] as const) {
      const out = await sortToolsMiddleware.transformParams!({
        type,
        params: unsorted,
        model: {} as LanguageModelV3,
      })
      expect(out.tools!.map((t) => t.name)).toEqual(['edit', 'question', 'read'])
    }
  })
})

describe('withSortedTools', () => {
  test('the wrapped model sees tools sorted on doGenerate and doStream', async () => {
    const seen: string[][] = []
    const base: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'test-model',
      supportedUrls: {},
      doGenerate: async (options) => {
        seen.push(options.tools!.map((t) => t.name))
        return { content: [], finishReason: 'stop', usage: {}, warnings: [] } as never
      },
      doStream: async (options) => {
        seen.push(options.tools!.map((t) => t.name))
        return { stream: new ReadableStream() } as never
      },
    }
    const wrapped = withSortedTools(base)
    expect(wrapped.provider).toBe('test')
    expect(wrapped.modelId).toBe('test-model')

    await wrapped.doGenerate(params([fn('read'), fn('bash'), fn('edit')]))
    await wrapped.doStream(params([fn('grep'), fn('bash'), fn('read')]))

    expect(seen[0]).toEqual(['bash', 'edit', 'read'])
    expect(seen[1]).toEqual(['bash', 'grep', 'read'])
  })
})
