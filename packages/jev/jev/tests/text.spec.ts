import { describe, expect, it } from 'vitest'
import {
  containsLiteral,
  matchesAny,
  normalizeToken,
  tokenize,
  tokensAgree,
  wildcardToRegExp,
} from '../src/text.ts'

describe('text normalization', () => {
  it('normalizes suffixes and preserves unrelated words', () => {
    expect(normalizeToken('DELETING')).toBe('delet')
    expect(normalizeToken('parties')).toBe('party')
    expect(normalizeToken('files')).toBe('file')
    expect(normalizeToken('glass')).toBe('glass')
    expect(normalizeToken('read')).toBe('read')
  })

  it('tokenizes significant words once and drops stopwords and short tokens', () => {
    expect(tokenize('The files, FILES, and go to editing')).toEqual(['file', 'edit'])
  })

  it('matches literal text only for non-empty patterns', () => {
    expect(containsLiteral('Deploy PROD', ' prod ')).toBe(true)
    expect(containsLiteral('Deploy PROD', '   ')).toBe(false)
    expect(containsLiteral('Deploy PROD', 'stage')).toBe(false)
  })

  it('matches equal and sufficiently long prefix-related tokens', () => {
    expect(tokensAgree('file', 'file')).toBe(true)
    expect(tokensAgree('delet', 'delete')).toBe(true)
    expect(tokensAgree('delete', 'delet')).toBe(true)
    expect(tokensAgree('cat', 'catalog')).toBe(false)
  })
})

describe('wildcard names', () => {
  it('escapes regexp syntax while expanding stars', () => {
    const matcher = wildcardToRegExp('tool.*[x]')
    expect(matcher.test('tool.any[x]')).toBe(true)
    expect(matcher.test('toolXanyx')).toBe(false)
  })

  it('matches any whole-name pattern and handles an empty list', () => {
    expect(matchesAny('web_search', ['read_*', 'web_*'])).toBe(true)
    expect(matchesAny('web_search', [])).toBe(false)
  })
})
