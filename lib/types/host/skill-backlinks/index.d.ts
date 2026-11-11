/**
 * Bundled skill provider mounting the plugin's own `skills/` directory
 * (`backlink-publish` with its references/playbooks, and `google-session`)
 * into `ctx.skills` independent of `process.cwd()`.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "skill-backlinks";
export declare const inject: string[];
export interface Config {
    readonly providerName?: string;
}
export declare const Config: z<Config>;
export declare function resolveBundledSkillsDir(): string;
export declare function apply(ctx: Context, config?: Config): void;
