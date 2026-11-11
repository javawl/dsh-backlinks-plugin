/**
 * Service Provider for the supermanager batch work-source seam.
 * Settings namespace: `backlinks-supermanager`.
 */
import z from '@deepseek-ai/schemastery';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { SupermanagerBatchSource } from "./provider.js";
export const name = 'backlinks-supermanager';
export const inject = ['backlinks'];
export const BACKLINKS_SUPERMANAGER_SETTINGS_NAMESPACE = 'backlinks-supermanager';
export const Config = z.object({
    baseUrl: z.string().default('').volatile(),
    token: z.string().role('secret').volatile(),
    requestTimeoutMs: z.number().default(15_000).volatile(),
});
function assertHttpBaseUrl(baseUrl) {
    if (baseUrl.length > 0 && !/^https?:\/\//u.test(baseUrl)) {
        throw new Error(`backlinks-supermanager: baseUrl must be an http(s) URL, got ${baseUrl}`);
    }
}
export function apply(ctx, config) {
    const resolve = () => {
        const requestTimeoutMs = config.requestTimeoutMs.get();
        if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
            throw new Error(`backlinks-supermanager: requestTimeoutMs must be a positive integer, got ${requestTimeoutMs}`);
        }
        const baseUrl = config.baseUrl.get();
        assertHttpBaseUrl(baseUrl);
        const declared = config.token.get();
        const token = declared !== undefined && declared.length > 0
            ? declared
            : launchEnvironmentOf(ctx).get('SUPERMANAGER_TOKEN')?.value ?? '';
        return { baseUrl, token, requestTimeoutMs };
    };
    ctx.effect(() => ctx.backlinks.registerBatchSourceProvider(new SupermanagerBatchSource(resolve)), 'backlinks-supermanager: provider');
}
export { SUPERMANAGER_BATCH_SOURCE_ID, SupermanagerBatchSource } from "./provider.js";
