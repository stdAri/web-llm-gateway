/**
 * Daemon configuration resolved from the environment.
 *
 * Kept apart from `index.ts` because that module starts a server on import;
 * configuration has to be readable — and testable — without side effects.
 */

/** Default turn budget. Web products are slower than APIs, so this is minutes. */
export const DEFAULT_TURN_TIMEOUT_MS = 300_000;

/**
 * Pro tiers and high-effort models legitimately run for minutes, so the turn
 * budget is a knob rather than a constant. A non-numeric or non-positive value
 * falls back to the default rather than disabling the timeout outright.
 */
export function resolveTurnTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GATEWAY_TURN_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TURN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TURN_TIMEOUT_MS;
  return parsed;
}
