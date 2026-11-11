/**
 * Shared Typert Remote client/host wire descriptors for `backlinksConsole`.
 */
import type { RemoteResult, TypertRemoteInfo, TypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol';
import type { BacklinkBatchDetail, BacklinkBatchSummary } from './backlinks-types.ts';
export declare const PACKAGE_NAME = "@javawl/dsh-backlinks-bundle";
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface BacklinksConsoleRemoteNamespace {
        batch: (batchId: number) => Promise<RemoteResult<BacklinkBatchDetail>>;
        batches: () => Promise<RemoteResult<readonly BacklinkBatchSummary[]>>;
    }
    interface TypertRemoteMap {
        'backlinksConsole/batch': (batchId: number) => Promise<RemoteResult<BacklinkBatchDetail>>;
        'backlinksConsole/batches': () => Promise<RemoteResult<readonly BacklinkBatchSummary[]>>;
    }
    interface TypertRemoteNamespaceMap {
        backlinksConsole: BacklinksConsoleRemoteNamespace;
    }
}
export declare const TYPERT_REMOTE: TypertRemoteInfo<{
    readonly 'backlinksConsole/batch': TypertRemoteMethod<{
        readonly batchId: number;
    }, BacklinkBatchDetail>;
    readonly 'backlinksConsole/batches': TypertRemoteMethod<Record<string, never>, readonly BacklinkBatchSummary[]>;
}>;
export default TYPERT_REMOTE;
