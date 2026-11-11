/**
 * Staged settings form controller over `backlinks-supermanager` / `backlinks-cloud-mail`.
 */
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import { type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives';
export declare const BACKLINKS_SUPERMANAGER_NS = "backlinks-supermanager";
export declare const BACKLINKS_CLOUD_MAIL_NS = "backlinks-cloud-mail";
export interface BacklinksSettings {
    readonly baseUrl?: string;
    readonly token?: string;
}
export interface BacklinksCardState extends SettingsFormShell {
    baseUrl: SettingsFieldState;
    token: SettingsFieldState;
    tokenConfigured: boolean;
}
export interface BacklinksCardFace extends SettingsFormActions {
    hooks: {
        backlinksCard: SnapshotStore<BacklinksCardState>;
    };
}
export declare class BacklinksCardController {
    private readonly describe;
    private readonly ns;
    private readonly form;
    private readonly store;
    private readonly unsubscribe;
    private configured;
    constructor(scope: SettingsFormScope<BacklinksSettings>, describe: SettingsDescribeFace, ns: string);
    dispose(): void;
    private projection;
    private readConfigured;
    inject(): BacklinksCardFace;
    private static writeToken;
}
