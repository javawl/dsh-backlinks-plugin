/**
 * Lightweight zero-dependency coded error base class shared by both the DSH
 * Cordis host plugin and the standalone Stdio MCP server.
 */
export declare class CodedError<Code extends string = string> extends Error {
    readonly code: Code;
    constructor(message: string, code: Code, options?: ErrorOptions);
}
