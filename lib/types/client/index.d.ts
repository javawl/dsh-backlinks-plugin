/**
 * Unified Web/Desktop client entry for `@javawl/dsh-backlinks-bundle`:
 * 1. Dynamically mounts `TYPERT_REMOTE` (`backlinksConsole`) onto `ctx.remote.$mount(...)`
 *    without modifying `@deepseek-ai/dsh-api-remotes`.
 * 2. Registers the sidebar Publish Batches panel (`sidebar.panellist` + `main`).
 * 3. Registers the `Supermanager` and `Cloud-mail` settings cards into `plugins.item`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
export declare const CONSOLE_NS = "backlinksConsole";
export declare const SETTINGS_NS = "settings.backlinks";
export declare const PANEL_ID: MainPanelId;
export declare const inject: string[];
export declare function apply(ctx: ClientContext): Promise<() => Promise<void>>;
