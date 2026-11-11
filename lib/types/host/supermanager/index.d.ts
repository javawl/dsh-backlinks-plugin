/**
 * Service Provider for the supermanager batch work-source seam.
 * Settings namespace: `backlinks-supermanager`.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "backlinks-supermanager";
export declare const inject: string[];
export declare const BACKLINKS_SUPERMANAGER_SETTINGS_NAMESPACE = "backlinks-supermanager";
export interface Config {
    readonly baseUrl: Volatile<string>;
    readonly token: Volatile<string | undefined>;
    readonly requestTimeoutMs: Volatile<number>;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    baseUrl: z<string, string, "volatile-defined">;
    token: z<string, string, "volatile">;
    requestTimeoutMs: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    baseUrl: z<string, string, "volatile-defined">;
    token: z<string, string, "volatile">;
    requestTimeoutMs: z<number, number, "volatile-defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: Config): void;
export { SUPERMANAGER_BATCH_SOURCE_ID, SupermanagerBatchSource } from './provider.ts';
