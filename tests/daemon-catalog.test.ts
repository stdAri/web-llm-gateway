/**
 * Ticket 06: Web Model Catalog and fail-closed selection.
 *
 * The model names here are the ones chat.deepseek.com actually shows — 快速模式
 * / 专家模式 / 识图模式, read off the page rather than invented. The previous
 * catalog claimed `deepseek-chat` and `deepseek-reasoner`, which are API names
 * that appear nowhere in the Web Product.
 */

import { describe, expect, test } from "bun:test";
import {
  assertSwitchAllowed,
  CATALOG_FRESH_MS,
  listCatalog,
  qualify,
  resolveSelection,
  SelectionError,
  verifyServed,
  type ProviderCatalogView,
} from "../src/daemon/catalog";

const NOW = 1_800_000_000_000;

function deepseek(over: Partial<ProviderCatalogView> = {}): ProviderCatalogView {
  return {
    provider: "deepseek",
    models: [
      { id: "快速模式", displayName: "快速模式", effort: ["深度思考"] },
      { id: "专家模式", displayName: "专家模式", effort: ["深度思考"] },
      { id: "识图模式", displayName: "识图模式", effort: ["深度思考"] },
    ],
    modelSwitching: "at-conversation-start",
    selectedModel: "快速模式",
    observedAt: NOW,
    ...over,
  };
}

describe("catalog listing", () => {
  test("keeps the site's own display name behind a provider prefix", () => {
    // No renaming table: the identifier is the label the site shows.
    const entries = listCatalog([deepseek()], NOW);
    expect(entries.map((e) => e.id)).toEqual([
      "deepseek/快速模式",
      "deepseek/专家模式",
      "deepseek/识图模式",
    ]);
  });

  test("offers only the effort the site genuinely exposes", () => {
    const entries = listCatalog([deepseek()], NOW);
    expect(entries[0]!.effort).toEqual(["深度思考"]);
  });

  test("marks a recent observation fresh", () => {
    expect(listCatalog([deepseek()], NOW + 1000)[0]!.fresh).toBe(true);
  });

  test("marks an old observation stale rather than trusting it silently", () => {
    const entries = listCatalog([deepseek()], NOW + CATALOG_FRESH_MS + 1);
    expect(entries[0]!.fresh).toBe(false);
    expect(entries[0]!.observedAt).toBe(NOW);
  });

  test("marks a never-observed catalog stale", () => {
    // A Bridge sitting inside a conversation cannot see DeepSeek's mode radios
    // at all, so it may report models it has never actually confirmed.
    const entries = listCatalog([deepseek({ observedAt: undefined })], NOW);
    expect(entries[0]!.fresh).toBe(false);
  });
});

describe("fail-closed selection", () => {
  test("resolves a model the account can actually reach", () => {
    expect(resolveSelection("deepseek/专家模式", deepseek()).displayName).toBe("专家模式");
  });

  test("an unavailable model names what is available", () => {
    // Criterion: the error lists what is available rather than just refusing.
    const err = (() => {
      try {
        resolveSelection("deepseek/deepseek-reasoner", deepseek());
      } catch (e) {
        return e as SelectionError;
      }
    })()!;
    expect(err.code).toBe("model_unavailable");
    expect(err.message).toContain("deepseek/快速模式");
    expect(err.message).toContain("deepseek/识图模式");
  });

  test("an unknown catalog fails instead of guessing", () => {
    // "The Bridge has not looked" is not "the account has no models"; picking
    // one anyway would be the substitution ADR-0013 forbids.
    const err = (() => {
      try {
        resolveSelection("deepseek/快速模式", deepseek({ models: [] }));
      } catch (e) {
        return e as SelectionError;
      }
    })()!;
    expect(err.code).toBe("catalog_unavailable");
  });

  test("never resolves to a different model than the one asked for", () => {
    for (const asked of ["deepseek/nope", "deepseek/DeepSeek Chat", "deepseek/快速"]) {
      expect(() => resolveSelection(asked, deepseek())).toThrow(SelectionError);
    }
  });
});

describe("switching strategy differs by site", () => {
  test("a site that switches mid-conversation just switches", () => {
    // Doubao exposes its picker inside the conversation.
    expect(() =>
      assertSwitchAllowed({
        provider: "doubao",
        switching: "mid-conversation",
        conversationModel: "豆包快速",
        requestedModel: "豆包 2.1 Turbo专家",
      }),
    ).not.toThrow();
  });

  test("a site that fixes the model at creation fails instead of switching", () => {
    // DeepSeek's mode radios are gone once a conversation exists, so honouring
    // this would mean abandoning the conversation the request belongs to.
    const err = (() => {
      try {
        assertSwitchAllowed({
          provider: "deepseek",
          switching: "at-conversation-start",
          conversationModel: "快速模式",
          requestedModel: "专家模式",
        });
      } catch (e) {
        return e as SelectionError;
      }
    })()!;
    expect(err.code).toBe("model_switch_unavailable");
    expect(err.message).toContain("快速模式");
    expect(err.message).toContain("专家模式");
    expect(err.message).toContain("new conversation");
  });

  test("asking for the model already in use is never a switch", () => {
    expect(() =>
      assertSwitchAllowed({
        provider: "deepseek",
        switching: "at-conversation-start",
        conversationModel: "专家模式",
        requestedModel: "专家模式",
      }),
    ).not.toThrow();
  });

  test("a site with no selection at all refuses a change", () => {
    expect(() =>
      assertSwitchAllowed({
        provider: "x",
        switching: "none",
        conversationModel: "a",
        requestedModel: "b",
      }),
    ).toThrow(SelectionError);
  });
});

describe("verifying what actually served the turn", () => {
  test("accepts a turn the site served as selected", () => {
    expect(() =>
      verifyServed({ requestedEffort: "深度思考", reportedThinkingEnabled: true }),
    ).not.toThrow();
  });

  test("rejects a turn served without the effort that was selected", () => {
    // Criterion: no request is served by a different effort than the one chosen.
    const err = (() => {
      try {
        verifyServed({ requestedEffort: "深度思考", reportedThinkingEnabled: false });
      } catch (e) {
        return e as SelectionError;
      }
    })()!;
    expect(err.code).toBe("effort_not_honoured");
  });

  test("treats unreported provenance as unknown, not as a mismatch", () => {
    // Absence of evidence is not evidence of substitution; failing here would
    // break every provider that reports nothing.
    expect(() =>
      verifyServed({ requestedEffort: "深度思考", reportedThinkingEnabled: undefined }),
    ).not.toThrow();
  });
});

describe("qualify", () => {
  test("prefixes without rewriting the site's name", () => {
    expect(qualify("deepseek", "快速模式")).toBe("deepseek/快速模式");
  });
});
