/**
 * Compact DOM snapshot compressors for `browser action="snapshot"` (`aria`, `text`,
 * and fallback plain text). Prunes decorative header/nav/footer/SVG bloat while
 * preserving interactive forms, inputs, buttons, comments, auth gates, and alerts.
 */
export declare const STATUS_FEEDBACK_PATTERN: RegExp;
export declare const SELECT_OPTION_COLLAPSE_THRESHOLD = 15;
export interface CompactSnapshotOutput {
    readonly text: string;
    readonly truncated: boolean;
    readonly compactSummary: string;
}
/**
 * Compress a Playwright ARIA snapshot by pruning boilerplate navigation/footer/SVG
 * subtrees, deduplicating prose, collapsing long link lists, and prioritizing
 * forms/inputs/comments under tight character budgets.
 */
export declare function compactAriaSnapshot(rawAria: string, maxChars: number): CompactSnapshotOutput;
/** Evaluated in the browser for compact `snapshot format="text"`. */
export declare const COMPACT_TEXT_SCRIPT: string;
export interface CompactTextEvalPayload {
    readonly forms: number;
    readonly inputs: number;
    readonly buttons: number;
    readonly iframes: number;
    readonly alerts: readonly string[];
    readonly formLines: readonly string[];
    readonly mainLines: readonly string[];
    readonly rawChars: number;
}
/** Format the evaluated `COMPACT_TEXT_SCRIPT` result under `maxChars`. */
export declare function formatCompactTextEvaluation(raw: unknown, maxChars: number): CompactSnapshotOutput;
/** Fallback pure-text compressor used when `page.evaluate` is unavailable or selector-scoped. */
export declare function compactPlainText(rawText: string, maxChars: number): CompactSnapshotOutput;
