/** Locale bundles for the backlinks providers' settings pages. */
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives';
export type BacklinksSettingsLocaleKey = 'supermanagerTitle' | 'supermanagerDescription' | 'supermanagerBaseUrl' | 'supermanagerBaseUrlHint' | 'supermanagerToken' | 'supermanagerTokenHint' | 'supermanagerTokenSet' | 'supermanagerTokenUnset' | 'cloudMailTitle' | 'cloudMailDescription' | 'cloudMailBaseUrl' | 'cloudMailBaseUrlHint' | 'cloudMailToken' | 'cloudMailTokenHint' | 'cloudMailTokenSet' | 'cloudMailTokenUnset' | 'overridden' | 'reset' | 'readOnly' | 'unavailable' | 'save' | 'saving' | 'saveFailed' | 'invalidNumber';
export declare const en: Record<BacklinksSettingsLocaleKey, string>;
export declare const zh: Record<BacklinksSettingsLocaleKey, string>;
export declare function formLabels(t: (key: BacklinksSettingsLocaleKey) => string): SettingsFormLabels;
