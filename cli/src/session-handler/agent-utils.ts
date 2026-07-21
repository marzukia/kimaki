// Agent preference resolution utility.
// Validates agent preferences against the OpenCode API.
// When a requested agent is not found, we fall back to the default agent
// instead of throwing. This handles stale agent preferences from CLI send
// commands or database references to agents that were removed from config.


import {
  getSessionAgent,
  getSessionModel,
  getChannelAgent,
} from '../database.js'
import { createLogger } from '../logger.js'
import { OpenCodeSdkError } from '../errors.js'
import { type initializeOpencodeForDirectory } from '../opencode.js'
import {
  toSystemMessageAgents,
  type AgentInfo,
} from '../system-message.js'

const agentLogger = createLogger('agent')

export async function resolveValidatedAgentPreference({
  agent,
  sessionId,
  channelId,
  getClient,
  directory,
}: {
  agent?: string
  sessionId: string
  channelId?: string
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
  directory?: string
}): Promise<{ agentPreference?: string; agents: AgentInfo[] }> {
  const agentPreference = await (async (): Promise<string | undefined> => {
    if (agent) {
      return agent
    }

    const sessionAgent = await getSessionAgent(sessionId)
    if (sessionAgent) {
      return sessionAgent
    }

    const sessionModel = await getSessionModel(sessionId)
    if (sessionModel) {
      return undefined
    }

    if (!channelId) {
      return undefined
    }
    return getChannelAgent(channelId)
  })()

  if (getClient instanceof Error) {
    return { agentPreference: agentPreference || undefined, agents: [] }
  }

  // The agents list is ALWAYS fetched, even without an agent preference. It
  // feeds the "Available agents" section of getOpencodeSystemMessage, which
  // must be byte-identical across every path that prompts a session — the
  // voice-tools path (fetchAvailableAgents in message-preprocessing.ts)
  // always embeds the list, so an empty list here would produce a shorter
  // system prompt for the same session and snap the shared KV-cache prefix
  // at the agents section.
  const agentsResponse = await getClient().app.agents({ directory })
    .catch((e) => new OpenCodeSdkError({ operation: 'app.agents', cause: e }))
  if (agentsResponse instanceof Error) {
    if (agentPreference) {
      throw new Error(`Failed to validate agent "${agentPreference}"`, {
        cause: agentsResponse,
      })
    }
    return { agentPreference: undefined, agents: [] }
  }

  const availableAgents = agentsResponse.data || []
  // Non-hidden primary/all agents for system message context. Uses the shared
  // projection so this path and fetchAvailableAgents can never drift apart.
  const agents: AgentInfo[] = toSystemMessageAgents(availableAgents)

  if (!agentPreference) {
    return { agentPreference: undefined, agents }
  }

  const hasAgent = availableAgents.some((availableAgent) => {
    return availableAgent.name === agentPreference
  })
  if (hasAgent) {
    return { agentPreference, agents }
  }

  // Fall back to default agent instead of erroring. This handles stale
  // preferences from CLI send commands or removed agents in config.
  agentLogger.warn(
    `Agent "${agentPreference}" not found, falling back to default agent`,
  )
  return { agentPreference: undefined, agents }
}
