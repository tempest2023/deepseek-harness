import { describe, expect, it } from 'vitest'
import { selectTools } from '../src/tool-filter.ts'
import type { ToolFilterRequest } from '../src/types.ts'

const tools = [
  { name: 'read_file', description: 'Read a file from the workspace' },
  { name: 'write_file', description: 'Write a file in the workspace' },
  { name: 'web_search', description: 'Search the public web' },
  { name: 'deploy', description: 'Deploy the service to production' },
]

function request(overrides: Partial<ToolFilterRequest> = {}): ToolFilterRequest {
  return {
    tools,
    alwaysKeep: [],
    minToolsToFilter: 2,
    minRetained: 1,
    maxRemovalFraction: 1,
    ...overrides,
  }
}

describe('skipping the filter', () => {
  it('skips when the tool set is below the configured threshold', () => {
    expect(selectTools(request({ minToolsToFilter: 10 })).keep).toBeUndefined()
  })

  it('skips when no task text has been observed yet', () => {
    const decision = selectTools(request())
    expect(decision.keep).toBeUndefined()
    expect(decision.reason).toContain('no task context')
  })

  it('skips when nothing matches the task', () => {
    const decision = selectTools(request({ task: 'zzz qqq' }))
    expect(decision.keep).toBeUndefined()
  })

  it('skips when task terms are ubiquitous across the catalog', () => {
    const decision = selectTools(request({ task: 'file workspace' }))
    expect(decision.keep).toBeUndefined()
    expect(decision.reason).toContain('ubiquitous')
  })

  it('skips when every tool is relevant', () => {
    const decision = selectTools(request({ task: 'read write file web search deploy service workspace' }))
    expect(decision.keep).toBeUndefined()
    expect(decision.reason).toContain('every tool')
  })
})

describe('pruning', () => {
  it('retains tools whose text matches the task and drops the rest', () => {
    const decision = selectTools(request({ task: 'please read the file and report it' }))
    expect(decision.keep).toEqual(['read_file'])
  })

  it('keeps an always-kept wildcard regardless of score', () => {
    const decision = selectTools(request({
      task: 'please read the file',
      alwaysKeep: ['deploy', 'web_*', 'run_code'],
    }))
    expect(decision.keep).toEqual(['read_file', 'web_search', 'deploy'])
  })

  it('skips when the result would fall below the retained floor', () => {
    const decision = selectTools(request({ task: 'read the file', minRetained: 3 }))
    expect(decision.keep).toBeUndefined()
    expect(decision.reason).toContain('floor')
  })

  it('skips when the removal fraction exceeds the allowance', () => {
    const decision = selectTools(request({ task: 'read the file', maxRemovalFraction: 0.1 }))
    expect(decision.keep).toBeUndefined()
    expect(decision.reason).toContain('fraction')
  })

  it('keeps the surviving tools in catalog order', () => {
    const decision = selectTools(request({ task: 'write and deploy the file service' }))
    expect(decision.keep).toEqual(['write_file', 'deploy'])
  })
})
