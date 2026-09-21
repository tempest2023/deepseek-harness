/**
 * The built-in Jev provider: deterministic, dependency-free implementations of
 * the three bounded decisions. It is the default backend and the fallback for
 * a configured remote backend, so the plugin stays useful — and testable —
 * with no network reachable and no credential present.
 *
 * @module @deepseek-ai/dsh-jev/heuristic-provider
 */

import { judgePermission } from './permission.ts'
import { routeModel } from './router.ts'
import { selectTools } from './tool-filter.ts'
import type { JevProvider } from './types.ts'

/** Provider id reported in decision events. */
export const HEURISTIC_PROVIDER_ID = 'heuristic'

/**
 * Build the deterministic provider.
 * @returns a provider answering all three decisions locally.
 */
export function createHeuristicProvider(): JevProvider {
  return {
    id: HEURISTIC_PROVIDER_ID,
    routeModel: request => Promise.resolve(routeModel(request)),
    filterTools: request => Promise.resolve(selectTools(request)),
    judgePermission: request => Promise.resolve(judgePermission(request)),
  }
}
