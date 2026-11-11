/**
 * Host-face Typert contribution exported at `./typert` so `@deepseek-ai/dsh-typert-loader`
 * registers `backlinksConsole/batches` and `backlinksConsole/batch` automatically.
 */
import { PACKAGE_NAME, TYPERT_REMOTE } from "../shared/typert-remote.js";
export const TYPERT = {
    package: PACKAGE_NAME,
    face: 'host',
    schemas: [],
    get invocations() {
        return TYPERT_REMOTE.descriptors;
    },
    model: {
        services: [
            {
                description: 'Read-only Remote console over ctx.backlinks for the Web publish-batch panel.',
                summary: 'Read-only Remote console over ctx.backlinks.',
                tags: [],
                key: 'backlinksConsole',
                exportName: 'BacklinksConsoleRuntime',
                members: [
                    {
                        kind: 'method',
                        name: 'batches',
                        signature: '@Remote async batches(): Promise<readonly BacklinkBatchSummary[]>',
                        summary: 'Every batch in the workspace with per-status counts and the executing flag.',
                    },
                    {
                        kind: 'method',
                        name: 'batch',
                        signature: '@Remote async batch(batchId: number): Promise<BacklinkBatchDetail>',
                        summary: "One batch's full detail: website, anchors, and items.",
                    },
                ],
                types: [
                    {
                        name: 'BacklinkBatchSummary',
                        declaration: 'export interface BacklinkBatchSummary { readonly id: number; readonly name: string; }',
                    },
                    {
                        name: 'BacklinkBatchDetail',
                        declaration: 'export interface BacklinkBatchDetail { readonly batch: BacklinkBatchSummary; }',
                    },
                ],
            },
        ],
        events: [],
        objects: [],
    },
};
