export declare const VISIBLE_CONTROLS_SCRIPT: string;
interface Control {
    tag: string;
    role: string;
    inputType: string;
    text: string;
    value: string;
    ariaLabel: string;
    title: string;
    alt: string;
    imageAlt: string;
    imageSrc: string;
    href: string;
    src: string;
    id: string;
    classes: string;
    data: string;
    background: string;
    formAction: string;
    selector: string;
    x: number;
    y: number;
    inViewport: boolean;
    hasImage: boolean;
    hasSvg: boolean;
    inBoilerplate?: boolean;
    name?: string;
    placeholder?: string;
}
interface PageControls {
    controls: Control[];
    passwordFields: number;
    emailFields: number;
    forms: number;
    emailLinks: number;
    truncated: boolean;
}
export declare function parseControlReport(report: unknown): PageControls;
export declare function readSignIn(control: Control): {
    provider: string;
    strength: 'auth' | 'provider';
} | undefined;
export declare function renderPageControls(title: string, report: PageControls, options?: {
    readonly compact?: boolean;
}): string;
export {};
