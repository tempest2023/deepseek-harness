/**
 * Shared, dependency-free text helpers for the Jev decision core: token
 * normalization, literal pattern matching, and `*`-wildcard name matching.
 *
 * Substring matching is deliberately literal rather than regular-expression
 * based: patterns come from user configuration, and a user-supplied regex
 * would be both a denial-of-service risk and impossible to explain in a
 * decision reason.
 *
 * @module @deepseek-ai/dsh-jev/text
 */

/**
 * Words that carry no selection signal on their own. Kept small and generic;
 * a deployment-tuned list belongs in configuration, not in this module.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'not', 'you', 'your', 'with', 'without', 'any', 'all',
  'this', 'that', 'these', 'those', 'from', 'into', 'onto', 'when', 'then',
  'than', 'them', 'they', 'their', 'there', 'here', 'have', 'has', 'had',
  'are', 'was', 'were', 'will', 'would', 'should', 'could', 'can', 'may',
  'use', 'using', 'used', 'after', 'before', 'about', 'also', 'only', 'just',
  'normal', 'normally', 'again', 'each', 'every', 'some', 'more', 'most',
  'less', 'least', 'very', 'much', 'many', 'such', 'other', 'others',
  'our', 'ours', 'its', 'it', 'is', 'be', 'been', 'being', 'do', 'does',
  'did', 'done', 'get', 'got', 'make', 'made', 'take', 'taken', 'give',
])

/**
 * Reduce one token to a comparison form: lowercase, trailing `ing` and plural
 * `s` removed. Both sides of every text comparison run through this, so a
 * clause saying "deleting files" and an action saying "delete file" agree.
 * @param token - the raw token.
 * @returns the normalized comparison form.
 */
export function normalizeToken(token: string): string {
  let value = token.toLowerCase()
  if (value.length >= 6 && value.endsWith('ing')) value = value.slice(0, -3)
  if (value.length >= 4 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`
  else if (value.length >= 4 && value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1)
  return value
}

/**
 * Split text into significant, normalized tokens.
 * @param text - free-form text.
 * @returns lowercase, de-duplicated, order-preserving comparison tokens.
 */
export function tokenize(text: string): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length < 3) continue
    if (STOPWORDS.has(raw)) continue
    const token = normalizeToken(raw)
    if (token.length < 3 || seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
  }
  return tokens
}

/**
 * Test whether text contains a configured pattern as a case-insensitive
 * literal substring.
 * @param text - haystack, compared case-insensitively.
 * @param pattern - literal needle; an empty pattern never matches.
 * @returns whether the pattern is present.
 */
export function containsLiteral(text: string, pattern: string): boolean {
  const needle = pattern.trim().toLowerCase()
  if (needle.length === 0) return false
  return text.toLowerCase().includes(needle)
}

/**
 * Test whether two normalized tokens refer to the same word, tolerating the
 * suffix differences that light stemming leaves behind ("delet"/"delete",
 * "file"/"files"). Prefix agreement is accepted only once the shorter token
 * is at least four characters, which keeps short words from matching
 * unrelated neighbors.
 * @param left - one normalized token.
 * @param right - the other normalized token.
 * @returns whether the tokens agree.
 */
export function tokensAgree(left: string, right: string): boolean {
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return shorter.length >= 4 && longer.startsWith(shorter)
}

/**
 * Compile one `*`-wildcard pattern to an anchored RegExp; every other
 * regular-expression metacharacter is matched literally.
 * @param pattern - the wildcard pattern.
 * @returns an anchored matcher for name comparisons.
 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`, 'u')
}

/**
 * Test one name against a `*`-wildcard pattern list.
 * @param name - the candidate name.
 * @param patterns - wildcard patterns; an empty list matches nothing.
 * @returns whether any pattern matches the whole name.
 */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => wildcardToRegExp(pattern).test(name))
}
