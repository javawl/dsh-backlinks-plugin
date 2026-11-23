// lib/types/shared/errors.js
/**
* Lightweight zero-dependency coded error base class shared by both the DSH
* Cordis host plugin and the standalone Stdio MCP server.
*/
var CodedError = class extends Error {
	code;
	constructor(message, code, options) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
};
export { CodedError as t };
