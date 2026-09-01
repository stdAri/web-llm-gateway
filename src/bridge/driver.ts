/**
 * Automation Driver interface, per ADR-0007.
 *
 * Web Provider Adapters are written against this abstract interface, never
 * against a specific browser mechanism. The Bridge Driver (userscript running
 * inside the Developer User's own browser) is the first implementation.
 *
 * Text entry is deliberately not one primitive: the driver exposes distinct
 * primitives rather than a single `type()` that assumes a plain input,
 * because paste, React-aware value setting, contenteditable, and drag-drop
 * upload all appear across the first providers (see docs/research/
 * doubao-deepseek-behavior.md).
 */

export interface AutomationDriver {
  /**
   * Set a text value the way the site's framework expects (React-aware
   * setter with synthetic input events for DeepSeek's composer textarea).
   */
  setComposerText(text: string): void;

  /** Click the primary send/submit control for the composer. */
  clickSend(): void;

  /**
   * Install a per-turn stream observer and return a handle used to detach it.
   * The callback receives canonical events; the driver decides which
   * reliability tier (network / frontend-state / dom-diff / rendered-text)
   * produced them and tags streamSource accordingly.
   */
  observeStream(
    turnId: string,
    onEvent: (event: unknown) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): () => void;
}
