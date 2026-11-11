/**
 * The publish console as a global panel page: batch rows with status chips,
 * inline item details, search, auto-refresh, and multi-batch selection.
 */
import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConsoleKey } from './locales.ts';
import type { ConsoleStore } from './store.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        backlinksConsole: ConsoleKey;
    }
}
export type SidebarConsolePanelProps = PropsLocale<'backlinksConsole'> & {
    store: ConsoleStore;
};
export declare function BacklinksConsoleIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode;
export declare function SidebarConsolePanel(props: SidebarConsolePanelProps): import("react").JSX.Element;
