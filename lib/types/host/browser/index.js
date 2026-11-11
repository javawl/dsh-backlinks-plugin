/**
 * Service Definition for the browser automation capability seam (`ctx.browser`).
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BrowserError } from "./types.js";
export { BrowserError } from "./types.js";
export class BrowserRuntime extends Service {
    static Config = z.object({
        provider: z.string(),
    });
    providers = new Map();
    providerId;
    session;
    sessionDisposer;
    opening;
    constructor(ctx, config = {}) {
        super(ctx, 'browser');
        this.providerId = config.provider ?? process.env.DSH_BROWSER_PROVIDER;
    }
    registerProvider(provider) {
        if (this.providers.has(provider.id)) {
            throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER');
        }
        const store = this.providers;
        const dispose = this.ctx.effect(function* () {
            store.set(provider.id, provider);
            yield () => store.delete(provider.id);
        }, 'browser.registerProvider()');
        return () => void dispose();
    }
    act(command, signal) {
        const run = async () => {
            const session = await this.ensureSession(signal);
            if (signal?.aborted)
                throw new BrowserError('browser command aborted before dispatch', 'BROWSER_ABORTED');
            try {
                return await session.act(command, signal);
            }
            catch (error) {
                if (error instanceof BrowserError) {
                    if (error.message.includes('has been closed') || error.message.includes('session is closed')) {
                        await this.discardSession();
                    }
                    throw error;
                }
                await this.discardSession();
                throw new BrowserError(`browser command "${command.kind}" failed: ${String(error instanceof Error ? error.message : error)}`, 'BROWSER_ACTION_FAILED', { cause: error });
            }
        };
        return run();
    }
    async closeSession() {
        await this.opening;
        await this.discardSession();
    }
    ensureSession(signal) {
        if (this.session)
            return Promise.resolve(this.session);
        this.opening ??= this.launchSession(signal).then((session) => {
            this.opening = undefined;
            return session;
        }, (error) => {
            this.opening = undefined;
            throw error;
        });
        return this.opening;
    }
    async launchSession(signal) {
        const provider = resolveProvider({
            providers: this.providers,
            ...(this.providerId !== undefined ? { configuredId: this.providerId } : {}),
        });
        if (signal?.aborted)
            throw new BrowserError('browser launch aborted', 'BROWSER_ABORTED');
        let session;
        try {
            session = await provider.open(signal);
        }
        catch (error) {
            if (error instanceof BrowserError)
                throw error;
            throw new BrowserError(`browser provider "${provider.id}" failed to open a session: ${String(error instanceof Error ? error.message : error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error });
        }
        const dispose = this.ctx.effect(function* () {
            yield () => {
                void session.close().catch(() => undefined);
            };
        }, 'browser.session');
        this.session = session;
        this.sessionDisposer = () => void dispose();
        return session;
    }
    async discardSession() {
        this.sessionDisposer?.();
        this.sessionDisposer = undefined;
        const session = this.session;
        this.session = undefined;
        try {
            await session?.close();
        }
        catch {
            // swallow: closing an already-dead browser
        }
    }
}
function resolveProvider(selection) {
    const { configuredId, providers } = selection;
    if (configuredId !== undefined) {
        const provider = providers.get(configuredId);
        if (!provider) {
            throw new BrowserError(`configured browser provider "${configuredId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING');
        }
        if (!provider.available()) {
            throw new BrowserError(`configured browser provider "${configuredId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE');
        }
        return provider;
    }
    const usable = [...providers.values()].filter(provider => provider.available());
    const [single] = usable;
    if (single === undefined) {
        throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE');
    }
    if (usable.length > 1) {
        const ids = usable.map(provider => provider.id).join(', ');
        throw new BrowserError(`multiple usable browser providers are registered (${ids}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS');
    }
    return single;
}
export default BrowserRuntime;
