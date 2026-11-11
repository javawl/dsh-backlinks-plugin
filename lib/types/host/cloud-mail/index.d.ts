/**
 * Service Provider for the cloud-mail mailbox seam.
 * Settings namespace: `backlinks-cloud-mail`.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "backlinks-cloud-mail";
export declare const inject: string[];
export declare const BACKLINKS_CLOUD_MAIL_SETTINGS_NAMESPACE = "backlinks-cloud-mail";
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
export { CLOUD_MAIL_MAILBOX_ID, CloudMailMailbox } from './provider.ts';
