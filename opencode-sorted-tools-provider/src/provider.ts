// Loadable OpenCode provider that wraps @ai-sdk/openai-compatible with the
// sorted-tools middleware.
//
// OpenCode loads a custom provider by importing the configured `npm` package
// and calling its first export whose name starts with "create" (see
// resolveSDK in packages/opencode/src/provider/provider.ts), then obtains
// models via `sdk.languageModel(modelID)` / `sdk.chat(modelID)`. There is no
// plugin hook that can wrap the constructed LanguageModel, so the provider
// package itself is the only kimaki-owned seam that survives opencode
// upgrades. Point the backend's provider config at this package:
//
//   "provider": {
//     "qmlx": {
//       "npm": "file:///path/to/opencode-sorted-tools-provider",
//       "options": { "baseURL": "http://host:8095/v1" },
//       ...
//     }
//   }
//
// Every model handed to opencode is then guaranteed to sort its tools array
// by name (Unicode code point) immediately before the request is serialised,
// making the rendered <tools> block byte-identical across processes and
// sessions regardless of opencode's own registration/sort behaviour.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { withSortedTools } from './sort-tools.js'

type ModelFactory = (modelId: string, ...rest: unknown[]) => LanguageModelV3

// Wrap every model-returning method of an SDK object so returned models sort
// their tools before each call. Methods and properties that don't produce
// language models pass through untouched. Exported for tests.
export function wrapSdkWithSortedTools<
  T extends { languageModel: ModelFactory },
>(sdk: T): T {
  const wrapFactory = (factory: ModelFactory): ModelFactory => {
    return (modelId, ...rest) => withSortedTools(factory(modelId, ...rest))
  }

  // The base provider from createOpenAICompatible is itself callable; a plain
  // object copy is fine because opencode only uses the method surface
  // (languageModel / chat / completion / textEmbeddingModel / imageModel).
  const wrapped: Record<string, unknown> = {}
  for (const key of ['languageModel', 'chat', 'chatModel', 'completionModel']) {
    const factory = (sdk as Record<string, unknown>)[key]
    if (typeof factory === 'function') {
      wrapped[key] = wrapFactory(factory.bind(sdk) as ModelFactory)
    }
  }
  for (const key of Object.keys(sdk)) {
    if (!(key in wrapped)) {
      wrapped[key] = (sdk as Record<string, unknown>)[key]
    }
  }
  // Non-model factories opencode may probe for, passed through bound.
  for (const key of ['textEmbeddingModel', 'imageModel']) {
    const factory = (sdk as Record<string, unknown>)[key]
    if (typeof factory === 'function' && !(key in wrapped)) {
      wrapped[key] = (factory as (...args: unknown[]) => unknown).bind(sdk)
    }
  }
  return wrapped as T
}

// The factory opencode's provider loader calls. Accepts the same options as
// createOpenAICompatible ({ name, baseURL, apiKey, headers, ... }); opencode
// passes `{ name: providerID, ...providerOptions }`.
export function createSortedToolsOpenAICompatible(
  options: Parameters<typeof createOpenAICompatible>[0],
) {
  return wrapSdkWithSortedTools(
    createOpenAICompatible(options) as unknown as {
      languageModel: ModelFactory
    },
  )
}
