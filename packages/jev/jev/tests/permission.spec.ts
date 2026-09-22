import { describe, expect, it } from 'vitest'
import { DEFAULT_RISK_RULES } from '../src/index.ts'
import { assessRisk, describeAction, judgePermission } from '../src/permission.ts'
import { parsePermissionClauses } from '../src/preferences.ts'
import type { PermissionProfile, PermissionRequest, RiskRule } from '../src/types.ts'

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolName: 'bash',
    arguments: { command: 'ls' },
    profile: 'balanced',
    riskRules: DEFAULT_RISK_RULES,
    clauses: [],
    ...overrides,
  }
}

describe('risk rules', () => {
  it('allows an action no rule matches', () => {
    const judgment = judgePermission(request())
    expect(judgment.outcome).toBe('allow')
    expect(judgment.level).toBe('none')
  })

  it('flags a destructive command', () => {
    const judgment = judgePermission(request({ arguments: { command: 'rm -rf ./build' } }))
    expect(judgment.level).toBe('high')
    expect(judgment.signals).toContain('destructive')
  })

  it('searches the arguments rather than only the tool name', () => {
    const judgment = judgePermission(request({ toolName: 'bash', arguments: { command: 'cat .env' } }))
    expect(judgment.signals).toContain('credentials')
  })

  it('flags a broad-scope modification', () => {
    const judgment = judgePermission(request({ arguments: { command: 'chmod -R 777 /etc/ssl' } }))
    expect(judgment.level).toBe('medium')
    expect(judgment.signals).toContain('scope')
  })

  it('describes string, absent, large, and non-serializable arguments', () => {
    expect(describeAction('bash', 'echo hi')).toBe('bash echo hi')
    expect(describeAction('noop', undefined)).toBe('noop ')
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(describeAction('cycle', cyclic)).toContain('[object Object]')
    expect(describeAction('write', 'x'.repeat(5000))).toHaveLength(4000)
  })

  it('keeps every matched signal while selecting the highest severity', () => {
    expect(assessRisk('publish and delete', [
      { name: 'low', level: 'low', patterns: ['publish'] },
      { name: 'high', level: 'high', patterns: ['delete'] },
      { name: 'miss', level: 'critical', patterns: ['transfer'] },
    ])).toEqual({ level: 'high', signals: ['low', 'high'] })
  })
})

describe('profiles', () => {
  const low = { toolName: 'bash', arguments: { command: 'charge the payment' } }
  const medium = { toolName: 'bash', arguments: { command: 'npm publish' } }
  const high = { toolName: 'bash', arguments: { command: 'rm -rf /' } }

  function outcome(profile: PermissionProfile, overrides: Partial<PermissionRequest>): string {
    return judgePermission(request({ profile, ...overrides })).outcome
  }

  it('conservative confirms at every flagged severity', () => {
    expect(outcome('conservative', low)).toBe('ask')
    expect(outcome('conservative', medium)).toBe('ask')
    expect(outcome('conservative', high)).toBe('ask')
  })

  it('balanced skips the lowest severity and confirms above it', () => {
    expect(outcome('balanced', low)).toBe('allow')
    expect(outcome('balanced', medium)).toBe('ask')
    expect(outcome('balanced', high)).toBe('ask')
  })

  it('autonomous confirms only the highest configured severity', () => {
    expect(outcome('autonomous', low)).toBe('allow')
    expect(outcome('autonomous', medium)).toBe('allow')
    expect(outcome('autonomous', high)).toBe('ask')
  })

  it('rejects a critical rule under every profile', () => {
    const critical: RiskRule[] = [{ name: 'fatal', level: 'critical', patterns: ['drop database'] }]
    for (const profile of ['conservative', 'balanced', 'autonomous'] as const) {
      const judgment = judgePermission(request({ profile, riskRules: critical, arguments: { command: 'drop database prod' } }))
      expect(judgment.outcome).toBe('deny')
    }
  })
})

describe('natural-language clauses', () => {
  const clauses = parsePermissionClauses('Allow publishing packages without confirmation. Ask before deleting files. Never force push.')

  it('lets an explicit allow clause override a risk rule', () => {
    const judgment = judgePermission(request({
      arguments: { command: 'npm publish --access public' },
      clauses,
    }))
    expect(judgment.outcome).toBe('allow')
  })

  it('asks when the ask clause matches', () => {
    const judgment = judgePermission(request({ arguments: { path: 'delete file ./notes.md' }, clauses }))
    expect(judgment.outcome).toBe('ask')
    expect(judgment.reason).toContain('confirmation')
  })

  it('rejects when a deny clause matches, outranking allow', () => {
    const judgment = judgePermission(request({
      arguments: { command: 'git push --force origin main' },
      clauses: parsePermissionClauses('Allow force push. Never force push.'),
    }))
    expect(judgment.outcome).toBe('deny')
  })

  it('leaves unmatched actions to the profile', () => {
    const judgment = judgePermission(request({ clauses, profile: 'autonomous' }))
    expect(judgment.outcome).toBe('allow')
  })

  it('chooses the most specific qualifying clause and ignores weak matches', () => {
    const judgment = judgePermission(request({
      arguments: { command: 'deploy production service' },
      clauses: [
        { outcome: 'allow', keywords: ['deploy', 'staging'] },
        { outcome: 'allow', keywords: ['deploy', 'production'] },
        { outcome: 'allow', keywords: ['deploy', 'production', 'service'] },
        { outcome: 'allow', keywords: ['deploy', 'missing', 'also-missing'] },
        { outcome: 'ask', keywords: ['unrelated'] },
      ],
    }))
    expect(judgment.signals[0]).toBe('clause:deploy production')
  })
})
