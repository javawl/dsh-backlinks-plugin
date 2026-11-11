/**
 * Package root Host entry: mounts `BacklinksConsoleRuntime` (`ctx.backlinksConsole`)
 * over `ctx.backlinks` while the Web/Desktop half of the same root entry loads `./client`.
 */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { BacklinkBatchDetail, BacklinkBatchSummary } from '../shared/backlinks-types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        backlinksConsole: BacklinksConsoleRuntime;
    }
}
export declare const inject: string[];
export declare class BacklinksConsoleRuntime extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    batches(): Promise<readonly BacklinkBatchSummary[]>;
    batch(batchId: number): Promise<BacklinkBatchDetail>;
}
export default BacklinksConsoleRuntime;
