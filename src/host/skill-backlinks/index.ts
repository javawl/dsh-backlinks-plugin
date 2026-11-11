/**
 * Bundled skill provider mounting the plugin's own `skills/` directory
 * (`backlink-publish` with its references/playbooks, and `google-session`)
 * into `ctx.skills` independent of `process.cwd()`.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'skill-backlinks'
export const inject = ['skills']

export interface Config {
  readonly providerName?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('backlink-operator'),
})

export function resolveBundledSkillsDir(): string {
  const fromLib = fileURLToPath(new URL('../skills', import.meta.url))
  if (existsSync(fromLib)) return fromLib
  const fromSrc = fileURLToPath(new URL('../../../skills', import.meta.url))
  return fromSrc
}

export function apply(ctx: Context, config: Config = {}): void {
  const skillsDir = resolveBundledSkillsDir()
  ctx.plugin(SkillFilesystem, {
    providerName: config.providerName ?? 'backlink-operator',
    includeDefaultRoots: false,
    watch: false,
    customSkillDirs: [skillsDir],
  })
}
