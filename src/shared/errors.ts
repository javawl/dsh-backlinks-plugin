/**
 * Lightweight zero-dependency coded error base class shared by both the DSH
 * Cordis host plugin and the standalone Stdio MCP server.
 */

export class CodedError<Code extends string = string> extends Error {
  readonly code: Code

  constructor(message: string, code: Code, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}
