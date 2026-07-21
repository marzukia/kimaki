import { describe, expect, it } from 'vitest'
import { compactEnvBlock, envCompactPlugin } from './env-compact-plugin.js'

// The OpenCode env block as it appears mid-prompt, per
// packages/opencode/src/session/system.ts.
function promptWithEnv(date: string): string {
  return (
    'You are OpenCode, the best coding agent on the planet.\n' +
    'Here is some useful information about the environment you are running in:\n' +
    '<env>\n' +
    '  Working directory: /home/user/project\n' +
    '  Workspace root folder: /home/user/project\n' +
    '  Is directory a git repo: yes\n' +
    '  Platform: linux\n' +
    `  Today's date: ${date}\n` +
    '</env>\n' +
    '\nRest of the prompt with skills etc.'
  )
}

describe('compactEnvBlock', () => {
  it('strips the date and env tags, keeps cwd and surrounding bytes', () => {
    const out = compactEnvBlock(promptWithEnv('Fri Jul 17 2026'))
    expect(out).not.toContain("Today's date")
    expect(out).not.toContain('<env>')
    expect(out).not.toContain('</env>')
    expect(out).toContain('<cwd>/home/user/project</cwd>')
    expect(out).toContain('Rest of the prompt')
    expect(out.startsWith('You are OpenCode')).toBe(true)
  })

  it('maps two different dates to byte-identical output (cache-stable across days)', () => {
    const fromFriday = compactEnvBlock(promptWithEnv('Fri Jul 17 2026'))
    const fromSaturday = compactEnvBlock(promptWithEnv('Sat Jul 18 2026'))
    expect(fromFriday).toBe(fromSaturday)
  })

  it('no-ops when there is no <env> block', () => {
    const input = 'just a plain system prompt'
    expect(compactEnvBlock(input)).toBe(input)
  })

  it('no-ops on an <env> mention without the Working directory signature', () => {
    const input = 'docs mention <env> xml tag\n</env> but nothing else'
    expect(compactEnvBlock(input)).toBe(input)
  })

  it('no-ops on an unterminated <env> block', () => {
    const input = 'prompt with <env>\n  Working directory: /x\n and no close'
    expect(compactEnvBlock(input)).toBe(input)
  })

  it('only compacts the FIRST block when two are present', () => {
    const two = promptWithEnv('Fri Jul 17 2026') + '\n' + promptWithEnv('Sat Jul 18 2026')
    const out = compactEnvBlock(two)
    expect(out).not.toContain('Fri Jul 17 2026')
    // Second block is left for the next turn's transform of its own part.
    expect(out).toContain('Sat Jul 18 2026')
  })
})

describe('envCompactPlugin transform', () => {
  async function runTransform(system: unknown): Promise<unknown> {
    const hooks = await envCompactPlugin({} as never)
    const transform = hooks['experimental.chat.system.transform']
    const output = { system }
    await transform!({} as never, output as never)
    return output.system
  }

  it('rewrites output.system in place', async () => {
    const system = [promptWithEnv('Fri Jul 17 2026')]
    await runTransform(system)
    expect(system[0]).not.toContain("Today's date")
    expect(system[0]).toContain('<cwd>/home/user/project</cwd>')
  })

  it('leaves a date-free prompt byte-identical', async () => {
    const system = ['no env block here']
    await runTransform(system)
    expect(system[0]).toBe('no env block here')
  })

  it('tolerates a non-array output.system without throwing', async () => {
    await expect(runTransform('nope')).resolves.toBe('nope')
  })
})
