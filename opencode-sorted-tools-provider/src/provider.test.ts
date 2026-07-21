// Tests for the loadable wrapper provider.

import { describe, expect, test } from 'vitest'
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
} from '@ai-sdk/provider'
import * as pkg from './index.js'
import { wrapSdkWithSortedTools } from './provider.js'

function fakeModel(captured: LanguageModelV3CallOptions[]): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      captured.push(options)
      return {
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }
    },
    doStream: async (options: LanguageModelV3CallOptions) => {
      captured.push(options)
      return { stream: new ReadableStream() }
    },
  } as unknown as LanguageModelV3
}

function tools(names: string[]) {
  return names.map((name) => ({
    type: 'function' as const,
    name,
    inputSchema: { type: 'object' as const },
  }))
}

describe('wrapSdkWithSortedTools', () => {
  test('languageModel results sort tools on doGenerate and doStream', async () => {
    const captured: LanguageModelV3CallOptions[] = []
    const sdk = wrapSdkWithSortedTools({
      languageModel: (_modelId: string) => fakeModel(captured),
    })
    const model = sdk.languageModel('any')

    await model.doGenerate({
      prompt: [],
      tools: tools(['webfetch', 'bash', 'todowrite', 'edit']),
    } as unknown as LanguageModelV3CallOptions)
    await model.doStream({
      prompt: [],
      tools: tools(['todowrite', 'edit', 'webfetch', 'bash']),
    } as unknown as LanguageModelV3CallOptions)

    const namesA = captured[0]!.tools?.map((t) => t.name)
    const namesB = captured[1]!.tools?.map((t) => t.name)
    expect(namesA).toEqual(['bash', 'edit', 'todowrite', 'webfetch'])
    // Two different input orders converge on identical serialised order.
    expect(namesB).toEqual(namesA)
  })

  test('chat factory is wrapped too when present', async () => {
    const captured: LanguageModelV3CallOptions[] = []
    const sdk = wrapSdkWithSortedTools({
      languageModel: (_modelId: string) => fakeModel(captured),
      chatModel: (_modelId: string) => fakeModel(captured),
    } as unknown as { languageModel: (modelId: string) => LanguageModelV3 })
    const model = (
      sdk as unknown as { chatModel: (id: string) => LanguageModelV3 }
    ).chatModel('any')
    await model.doGenerate({
      prompt: [],
      tools: tools(['b', 'a']),
    } as unknown as LanguageModelV3CallOptions)
    expect(captured[0]!.tools?.map((t) => t.name)).toEqual(['a', 'b'])
  })

  test('createSortedToolsOpenAICompatible is the only create* export (opencode picks the first)', () => {
    const createExports = Object.keys(pkg).filter((key) =>
      key.startsWith('create'),
    )
    expect(createExports).toEqual(['createSortedToolsOpenAICompatible'])
  })

  test('createSortedToolsOpenAICompatible returns a wrapped SDK', () => {
    const sdk = pkg.createSortedToolsOpenAICompatible({
      name: 'qmlx',
      baseURL: 'http://127.0.0.1:9/v1',
    })
    const model = sdk.languageModel('some-model')
    expect(model.modelId).toBe('some-model')
    expect(typeof model.doGenerate).toBe('function')
    expect(typeof model.doStream).toBe('function')
  })
})
