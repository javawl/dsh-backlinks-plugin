/**
 * Settings cards for `Supermanager` and `Cloud-mail` under Settings -> Plugins.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { type BacklinksSettingsLocaleKey } from './locales.ts';
import type { BacklinksCardFace } from './backlinks-card-controller.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'settings.backlinks': BacklinksSettingsLocaleKey;
    }
}
export interface BacklinksCardCopy {
    readonly title: BacklinksSettingsLocaleKey;
    readonly description: BacklinksSettingsLocaleKey;
    readonly baseUrlLabel: BacklinksSettingsLocaleKey;
    readonly baseUrlHint: BacklinksSettingsLocaleKey;
    readonly tokenLabel: BacklinksSettingsLocaleKey;
    readonly tokenHint: BacklinksSettingsLocaleKey;
    readonly tokenSet: BacklinksSettingsLocaleKey;
    readonly tokenUnset: BacklinksSettingsLocaleKey;
}
export type BacklinksProviderCardProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.backlinks'> & InjectFace<BacklinksCardFace>;
export declare function BacklinksProviderCard(props: BacklinksProviderCardProps & {
    copy: BacklinksCardCopy;
}): string | import("react").JSX.Element;
export declare function SupermanagerCard(props: BacklinksProviderCardProps): import("react").JSX.Element;
export declare function CloudMailCard(props: BacklinksProviderCardProps): import("react").JSX.Element;
