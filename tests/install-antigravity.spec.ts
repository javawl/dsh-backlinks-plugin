import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installAntigravity, parseCliArgs } from '../scripts/install-antigravity.mjs'

const tempHomes: string[] = []
const repoRoot = resolve(import.meta.dirname, '..')

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ag-install-test-'))
  tempHomes.push(dir)
  return dir
}

afterEach(() => {
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('scripts/install-antigravity.mjs', () => {
  it('installs plugin mode into <home>/.gemini/config/plugins/backlinks-publisher/', () => {
    const home = makeTempHome()
    const result = installAntigravity({ target: 'plugin', homeDir: home, repoRoot })

    expect(result.targets).toEqual(['plugin'])
    const pluginDir = join(home, '.gemini', 'config', 'plugins', 'backlinks-publisher')
    expect(existsSync(join(pluginDir, 'plugin.json'))).toBe(true)
    expect(existsSync(join(pluginDir, 'rules', 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(pluginDir, 'skills', 'backlink-publish', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(pluginDir, 'skills', 'google-session', 'SKILL.md'))).toBe(true)
    for (const kind of ['article', 'blog', 'directory', 'forum', 'gaming', 'tools']) {
      expect(existsSync(join(pluginDir, 'skills', 'backlink-publish', 'references', 'playbooks', `playbook-${kind}.md`))).toBe(true)
    }

    const mcpConfig = JSON.parse(readFileSync(join(pluginDir, 'mcp_config.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
    }
    expect(mcpConfig.mcpServers['backlinks-publisher']?.args).toEqual([join(repoRoot, 'lib', 'mcp-server.mjs')])
    expect(mcpConfig.mcpServers['backlinks-publisher']?.env.SUPERMANAGER_TOKEN).toBe('<YOUR_SUPERMANAGER_AGENT_TOKEN>')
  })

  it('installs app mode safely, preserving other MCP servers, existing non-placeholder secrets, and other skills', () => {
    const home = makeTempHome()
    const appDir = join(home, '.gemini', 'antigravity')
    const skillsDir = join(appDir, 'skills')
    mkdirSync(join(skillsDir, 'custom-user-skill'), { recursive: true })
    writeFileSync(join(skillsDir, 'custom-user-skill', 'SKILL.md'), '# keep me\n', 'utf8')

    writeFileSync(
      join(appDir, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'other-server': { command: 'npx', args: ['-y', 'other-mcp'] },
          'backlinks-publisher': {
            command: 'C:\\Program Files\\nodejs\\node.exe',
            args: ['C:\\old\\path\\mcp-server.mjs'],
            disabled: false,
            env: {
              SUPERMANAGER_BASE_URL: 'https://sm.prod.example',
              SUPERMANAGER_TOKEN: 'smag_existing_token_value',
              CLOUDMAIL_TOKEN: '<OPTIONAL_CLOUDMAIL_TOKEN>',
              CUSTOM_FLAG: 'keep-custom',
            },
          },
        },
      }, null, 2),
      'utf8',
    )

    const result = installAntigravity({ target: 'app', homeDir: home, repoRoot })
    expect(result.targets).toEqual(['app'])

    const merged = JSON.parse(readFileSync(join(appDir, 'mcp_config.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; disabled?: boolean; env: Record<string, string> }>
    }
    expect(merged.mcpServers['other-server']).toEqual({ command: 'npx', args: ['-y', 'other-mcp'] })

    const entry = merged.mcpServers['backlinks-publisher']!
    expect(entry.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(entry.args).toEqual([join(repoRoot, 'lib', 'mcp-server.mjs')])
    expect(entry.disabled).toBe(false)
    expect(entry.env.SUPERMANAGER_BASE_URL).toBe('https://sm.prod.example')
    expect(entry.env.SUPERMANAGER_TOKEN).toBe('smag_existing_token_value')
    expect(entry.env.CLOUDMAIL_TOKEN).toBe('<OPTIONAL_CLOUDMAIL_TOKEN>')
    expect(entry.env.CLOUDMAIL_BASE_URL).toBe('https://mail.screwdom.org/api')
    expect(entry.env.CUSTOM_FLAG).toBe('keep-custom')

    expect(readFileSync(join(skillsDir, 'custom-user-skill', 'SKILL.md'), 'utf8')).toBe('# keep me\n')
    expect(existsSync(join(skillsDir, 'backlink-publish', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(skillsDir, 'google-session', 'SKILL.md'))).toBe(true)
  })

  it('supports both and auto detection modes plus --dry-run without mutating disk', () => {
    const emptyHome = makeTempHome()
    const dryRes = installAntigravity({ target: 'both', homeDir: emptyHome, repoRoot, dryRun: true })
    expect(dryRes.targets).toEqual(['plugin', 'app'])
    expect(existsSync(join(emptyHome, '.gemini'))).toBe(false)

    const bothRes = installAntigravity({ target: 'both', homeDir: emptyHome, repoRoot })
    expect(bothRes.targets).toEqual(['plugin', 'app'])
    expect(existsSync(join(emptyHome, '.gemini', 'config', 'plugins', 'backlinks-publisher', 'mcp_config.json'))).toBe(true)
    expect(existsSync(join(emptyHome, '.gemini', 'antigravity', 'mcp_config.json'))).toBe(true)

    const appOnlyHome = makeTempHome()
    mkdirSync(join(appOnlyHome, '.gemini', 'antigravity'), { recursive: true })
    expect(installAntigravity({ target: 'auto', homeDir: appOnlyHome, repoRoot }).targets).toEqual(['app'])

    const pluginOnlyHome = makeTempHome()
    mkdirSync(join(pluginOnlyHome, '.gemini', 'config'), { recursive: true })
    expect(installAntigravity({ target: 'auto', homeDir: pluginOnlyHome, repoRoot }).targets).toEqual(['plugin'])

    const dualHome = makeTempHome()
    mkdirSync(join(dualHome, '.gemini', 'antigravity'), { recursive: true })
    mkdirSync(join(dualHome, '.gemini', 'config'), { recursive: true })
    expect(installAntigravity({ target: 'auto', homeDir: dualHome, repoRoot }).targets).toEqual(['plugin', 'app'])
  })

  it('parses CLI flags including pnpm pass-through -- separator', () => {
    expect(parseCliArgs(['--', '--target', 'app', '--dry-run'])).toEqual({
      target: 'app',
      homeDir: undefined,
      dryRun: true,
      help: false,
    })
  })

  it('fails cleanly when existing mcp_config.json is malformed without overwriting it', () => {
    const home = makeTempHome()
    const appDir = join(home, '.gemini', 'antigravity')
    mkdirSync(appDir, { recursive: true })
    const configPath = join(appDir, 'mcp_config.json')
    writeFileSync(configPath, '{broken json', 'utf8')

    expect(() => installAntigravity({ target: 'app', homeDir: home, repoRoot })).toThrow(/Failed to parse existing JSON/)
    expect(readFileSync(configPath, 'utf8')).toBe('{broken json')
  })
})
