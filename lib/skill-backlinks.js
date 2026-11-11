import z from "@deepseek-ai/schemastery";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as SkillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
// lib/types/host/skill-backlinks/index.js
/**
* Bundled skill provider mounting the plugin's own `skills/` directory
* (`backlink-publish` with its references/playbooks, and `google-session`)
* into `ctx.skills` independent of `process.cwd()`.
*/
const name = "skill-backlinks";
const inject = ["skills"];
const Config = z.object({ providerName: z.string().min(1).default("backlink-operator") });
function resolveBundledSkillsDir() {
	const fromLib = fileURLToPath(new URL("../skills", import.meta.url));
	if (existsSync(fromLib)) return fromLib;
	return fileURLToPath(new URL("../../../skills", import.meta.url));
}
function apply(ctx, config = {}) {
	const skillsDir = resolveBundledSkillsDir();
	ctx.plugin(SkillFilesystem, {
		providerName: config.providerName ?? "backlink-operator",
		includeDefaultRoots: false,
		watch: false,
		customSkillDirs: [skillsDir]
	});
}
export { Config, apply, inject, name, resolveBundledSkillsDir };
