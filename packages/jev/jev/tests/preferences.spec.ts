import { describe, expect, it } from 'vitest'
import {
  parseModelPreferences,
  parsePermissionClauses,
  roleFromText,
  splitClauses,
} from '../src/preferences.ts'

describe('role classification', () => {
  it('recognizes planning prose', () => {
    expect(roleFromText('planning and difficult decisions')).toBe('orchestration')
  })

  it('recognizes implementation prose', () => {
    expect(roleFromText('delegated implementation tasks')).toBe('execution')
  })

  it('returns undefined when neither role is named', () => {
    expect(roleFromText('everything')).toBeUndefined()
  })

  it('returns undefined when both role vocabularies are present', () => {
    expect(roleFromText('plan the implementation')).toBeUndefined()
  })
})

describe('model preferences', () => {
  it('parses the PRD example into two role-bound rules', () => {
    const parsed = parseModelPreferences(
      'Prefer DeepSeek V4.1 Pro for planning and difficult decisions. '
      + 'Prefer DeepSeek V4.1 Flash for delegated implementation tasks.',
    )
    expect(parsed.prefer).toEqual([
      { pattern: 'DeepSeek V4.1 Pro', role: 'orchestration' },
      { pattern: 'DeepSeek V4.1 Flash', role: 'execution' },
    ])
    expect(parsed.avoid).toEqual([])
  })

  it('parses role-agnostic preferences', () => {
    const parsed = parseModelPreferences('Prefer DeepSeek V4.1 Pro')
    expect(parsed.prefer).toEqual([{ pattern: 'DeepSeek V4.1 Pro', role: 'any' }])
  })

  it('parses every avoid form', () => {
    const parsed = parseModelPreferences('Do not use gemini-2. Never use gpt-3. Avoid old-model.')
    expect(parsed.avoid).toEqual(['gemini-2', 'gpt-3', 'old-model'])
  })

  it('ignores prose it does not recognize', () => {
    const parsed = parseModelPreferences('The weather is nice today. Maybe try something else.')
    expect(parsed.prefer).toEqual([])
    expect(parsed.avoid).toEqual([])
  })

  it('returns empty preferences for undefined text', () => {
    expect(parseModelPreferences(undefined)).toEqual({ prefer: [], avoid: [] })
  })

  it('cleans quoted prefixes and ignores empty cleaned patterns', () => {
    expect(parseModelPreferences('Prefer model "Pro". Avoid "...". Prefer "..."').prefer)
      .toEqual([{ pattern: 'Pro', role: 'any' }])
    expect(parseModelPreferences('Avoid "..."').avoid).toEqual([])
  })

  it('uses an any-role rule when the target prose names no known role', () => {
    expect(parseModelPreferences('Prefer quick-model for weekends').prefer)
      .toEqual([{ pattern: 'quick-model', role: 'any' }])
  })

  it('orders role-bound rules before role-agnostic ones', () => {
    const parsed = parseModelPreferences('Prefer broad-model. Prefer plan-model for planning.')
    expect(parsed.prefer.map(rule => rule.role)).toEqual(['orchestration', 'any'])
  })
})

describe('permission clauses', () => {
  it('splits the PRD example into per-action clauses', () => {
    const clauses = parsePermissionClauses(
      'Allow normal file edits, package installation, test execution, and git operations without confirmation. '
      + 'Ask before deleting files, changing credentials, publishing externally, spending money, '
      + 'or performing actions that are difficult to reverse.',
    )
    expect(clauses.filter(clause => clause.outcome === 'allow').map(clause => clause.keywords))
      .toEqual([['file', 'edit'], ['package', 'installation'], ['test', 'execution'], ['git', 'operation']])
    expect(clauses.filter(clause => clause.outcome === 'ask').map(clause => clause.keywords))
      .toEqual([
        ['delet', 'file'],
        ['chang', 'credential'],
        ['publish', 'externally'],
        ['spend', 'money'],
        ['perform', 'action', 'difficult', 'reverse'],
      ])
  })

  it('orders deny clauses before ask and allow clauses', () => {
    const clauses = parsePermissionClauses('Allow deploys. Ask before deleting. Never deploy on Friday.')
    expect(clauses.map(clause => clause.outcome)).toEqual(['deny', 'ask', 'allow'])
  })

  it('returns nothing for undefined prose', () => {
    expect(parsePermissionClauses(undefined)).toEqual([])
  })

  it('recognizes synonym forms, waivers, and empty action fragments', () => {
    const clauses = parsePermissionClauses(
      'Block data export or reject secrets. '
      + 'Deny the. '
      + 'Confirm before package publish. '
      + 'Ask before the. '
      + 'Permit tests with no confirmation. '
      + 'Feel free to edits without asking. '
      + 'Allow "...". '
      + 'Something else.',
    )
    expect(clauses).toEqual([
      { outcome: 'deny', keywords: ['data', 'export'] },
      { outcome: 'deny', keywords: ['reject', 'secret'] },
      { outcome: 'ask', keywords: ['package', 'publish'] },
      { outcome: 'allow', keywords: ['test'] },
      { outcome: 'allow', keywords: ['edit'] },
    ])
  })
})

describe('clause splitting', () => {
  it('handles numbered lines, bullets, semicolons, and blank pieces', () => {
    expect(splitClauses('1) Prefer pro;\n- Avoid old\n\n* Allow tests.')).toEqual([
      'Prefer pro',
      'Avoid old',
      'Allow tests.',
    ])
  })
})
