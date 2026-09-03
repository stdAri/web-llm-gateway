/**
 * Web Model Catalog: what the authenticated account can actually reach, and
 * whether a selection can be honoured.
 *
 * The rule throughout is ADR-0013: never substitute. A selection that cannot be
 * served fails with an error naming what was asked for and what is available,
 * because quietly serving a different model changes an agent loop's reasoning
 * quality, cost, and capabilities without anyone knowing.
 */

import type { CatalogModel, ModelSwitching } from "../shared/canonical";

/** How long a page-read catalog is presented as current. */
export const CATALOG_FRESH_MS = 10 * 60 * 1000;

export interface ProviderCatalogView {
  provider: string;
  models: CatalogModel[];
  modelSwitching: ModelSwitching;
  selectedModel?: string;
  observedAt?: number;
}

export interface CatalogEntry {
  /** `<provider>/<the site's own display name>`. No renaming table exists. */
  id: string;
  provider: string;
  displayName: string;
  effort: string[];
  /** False when the entry is older than CATALOG_FRESH_MS, or never observed. */
  fresh: boolean;
  observedAt?: number;
}

export class SelectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Qualify a site's display name with its provider, per spec "Model selection". */
export function qualify(provider: string, displayName: string): string {
  return `${provider}/${displayName}`;
}

export function listCatalog(
  catalogs: Iterable<ProviderCatalogView>,
  now = Date.now(),
): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const c of catalogs) {
    for (const m of c.models) {
      out.push({
        id: qualify(c.provider, m.displayName),
        provider: c.provider,
        displayName: m.displayName,
        effort: m.effort ?? [],
        // Staleness is reported rather than hidden: a Bridge sitting inside a
        // conversation cannot see DeepSeek's mode radios at all, so what it
        // reports is necessarily an older observation.
        fresh: c.observedAt !== undefined && now - c.observedAt < CATALOG_FRESH_MS,
        observedAt: c.observedAt,
      });
    }
  }
  return out;
}

/**
 * Resolve a requested `<provider>/<model>` against what the account can reach.
 *
 * An empty catalog fails rather than defaulting: a Bridge that has never seen
 * the picker cannot tell us the account has no models, only that it has not
 * looked, and guessing would be the substitution this ADR forbids.
 */
export function resolveSelection(
  requested: string,
  catalog: ProviderCatalogView | undefined,
): CatalogModel {
  if (!catalog || catalog.models.length === 0) {
    throw new SelectionError(
      `no model catalog is known for provider "${catalog?.provider ?? requested}" yet; ` +
        "open the Web Product's new-chat screen once so the Bridge can read it",
      "catalog_unavailable",
    );
  }
  const slash = requested.indexOf("/");
  const name = slash === -1 ? requested : requested.slice(slash + 1);
  const found = catalog.models.find((m) => m.displayName === name);
  if (!found) {
    const available = catalog.models
      .map((m) => qualify(catalog.provider, m.displayName))
      .join(", ");
    throw new SelectionError(
      `model "${requested}" is not available on ${catalog.provider}; available: ${available}`,
      "model_unavailable",
    );
  }
  return found;
}

/**
 * Whether a turn continuing an existing conversation may change model.
 *
 * Where the site supports switching we switch; where it does not, this fails
 * instead of silently answering with the model the conversation already has.
 * DeepSeek is the second case: its mode radios vanish once a conversation
 * exists, so honouring the change would mean abandoning the conversation the
 * tool results belong to.
 */
export function assertSwitchAllowed(opts: {
  provider: string;
  switching: ModelSwitching;
  conversationModel: string;
  requestedModel: string;
}): void {
  if (opts.conversationModel === opts.requestedModel) return;
  if (opts.switching === "mid-conversation") return;
  const why =
    opts.switching === "none"
      ? `${opts.provider} exposes no model selection`
      : `${opts.provider} fixes the model when a conversation is created`;
  throw new SelectionError(
    `cannot switch to "${opts.requestedModel}" partway through this conversation: ${why}. ` +
      `It is running "${opts.conversationModel}"; start a new conversation to use a different model.`,
    "model_switch_unavailable",
  );
}

/**
 * Check what the Web Product said actually served the turn against what was
 * selected. Provenance the page did not report is not treated as a mismatch —
 * absence of evidence is not evidence of substitution.
 */
export function verifyServed(opts: {
  requestedEffort?: string;
  reportedThinkingEnabled?: boolean;
}): void {
  if (opts.requestedEffort === undefined) return;
  if (opts.reportedThinkingEnabled === undefined) return;
  const wanted = opts.requestedEffort.length > 0;
  if (wanted !== opts.reportedThinkingEnabled) {
    throw new SelectionError(
      `the turn was served with thinking ${opts.reportedThinkingEnabled ? "on" : "off"}, ` +
        `but effort "${opts.requestedEffort}" was requested`,
      "effort_not_honoured",
    );
  }
}
