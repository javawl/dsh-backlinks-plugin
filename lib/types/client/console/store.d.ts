/**
 * Console data, batch selection, and submission into a workspace's blank session
 * using the `backlink-operator` preset (falling back to the default preset if needed).
 */
import type { BacklinkBatchDetail, BacklinkBatchSummary } from '../../shared/backlinks-types.ts';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type SnapshotStore } from '@deepseek-ai/dsh-client-store';
declare module '@deepseek-ai/dsh-api-session-controller/client' {
    interface SessionReferenceSourceMap {
        backlinksConsole: unknown;
    }
}
export interface ConsoleViewState {
    open: boolean;
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string | null;
    batches: readonly BacklinkBatchSummary[];
    details: Record<number, BacklinkBatchDetail>;
    selectedBatchIds: readonly number[];
    publishing: readonly number[] | null;
}
export interface ConsoleStore {
    readonly store: SnapshotStore<ConsoleViewState>;
    open(): void;
    close(): void;
    refresh(): Promise<void>;
    toggleDetail(batchId: number): Promise<void>;
    selectBatches(batchIds: readonly number[], selected: boolean): void;
    publish(batchId: number): Promise<void>;
    publishSelected(): Promise<void>;
}
export declare function createConsoleStore(ctx: ClientContext): ConsoleStore;
