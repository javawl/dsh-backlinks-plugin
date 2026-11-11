/**
 * The cloud-mail implementation of the mailbox seam (`POST /public/addUser`, `POST /public/emailList`).
 */
import type { MailboxAddress, MailboxProvider, MailPollOptions, VerificationMail } from '../backlinks/index.ts';
export declare const CLOUD_MAIL_MAILBOX_ID = "cloud-mail";
export interface ResolvedCloudMailConfig {
    readonly baseUrl: string;
    readonly token: string;
    readonly requestTimeoutMs: number;
}
export declare class CloudMailMailbox implements MailboxProvider {
    private readonly resolveConfig;
    readonly id = "cloud-mail";
    constructor(resolveConfig: () => ResolvedCloudMailConfig);
    available(): boolean;
    createMailbox(options: {
        readonly localPart: string;
        readonly domain: string;
    }, signal?: AbortSignal): Promise<MailboxAddress>;
    pollMail(address: MailboxAddress, options: MailPollOptions, signal?: AbortSignal): Promise<VerificationMail | null>;
    private fetchMailRows;
    private matches;
    private requestJson;
}
