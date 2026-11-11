/**
 * Service Definition for the browser automation capability seam (`ctx.browser`).
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { BrowserAutomationProvider, BrowserCommand, BrowserResult } from './types.ts';
export { BrowserError } from './types.ts';
export type * from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        browser: BrowserRuntime;
    }
}
export interface BrowserRuntimeConfig {
    readonly provider?: string;
}
export declare class BrowserRuntime extends Service {
    static Config: z<BrowserRuntimeConfig>;
    private providers;
    private readonly providerId;
    private session;
    private sessionDisposer;
    private opening;
    constructor(ctx: Context, config?: BrowserRuntimeConfig);
    registerProvider(provider: BrowserAutomationProvider): () => void;
    act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
    closeSession(): Promise<void>;
    private ensureSession;
    private launchSession;
    private discardSession;
}
export default BrowserRuntime;
