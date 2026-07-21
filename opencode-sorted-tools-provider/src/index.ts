export {
  sortToolDefinitions,
  sortToolsInParams,
  sortToolsMiddleware,
  withSortedTools,
} from './sort-tools.js'
// NOTE: opencode's provider loader calls the FIRST export whose name starts
// with "create" (module namespace keys are code-unit sorted, so keep this the
// only create* export).
export {
  createSortedToolsOpenAICompatible,
  wrapSdkWithSortedTools,
} from './provider.js'
