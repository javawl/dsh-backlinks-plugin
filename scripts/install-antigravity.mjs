#!/usr/bin/env node
/**
 * Cross-platform installer for `backlinks-publisher` Antigravity plugin & Classic Desktop App layout.
 *
 * Supports:
 * - `--target plugin`: installs into `<home>/.gemini/config/plugins/backlinks-publisher/`
 * - `--target app`:    merges into `<home>/.gemini/antigravity/mcp_config.json` and syncs `<home>/.gemini/antigravity/skills/`
 * - `--target both`:   installs both layouts
 * - `--target auto`:   auto-detects existing `.gemini/antigravity` and `.gemini/config` directories (default)
 * - `--home <dir>`:    override target home directory (useful for testing)
 * - `--dry-run`:       preview actions without touching disk
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = 'backlinks-publisher'
export const SKILL_NAMES = ['backlink-publish', 'google-session']
export const VALID_TARGETS = ['auto', 'plugin', 'app', 'both']

const PLACEHOLDER_PATTERNS = [
  /^<[^>]+>$/u,
  /^REPLACE_WITH_/iu,
  /YOUR_[A-Z0-9_]+/u,
]

export function isPlaceholderValue(value) {
  if (typeof value !== 'string') return true
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(trimmed))
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCliArgs(argv) {
  let target = 'auto'
  let homeDir
  let dryRun = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      continue
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--target') {
      const next = argv[++i]
      if (!next || next.startsWith('-')) {
        throw new Error('--target requires a value: auto, plugin, app, or both')
      }
      target = next
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
    } else if (arg === '--home') {
      const next = argv[++i]
      if (!next) {
        throw new Error('--home requires a directory path')
      }
      homeDir = next
    } else if (arg.startsWith('--home=')) {
      homeDir = arg.slice('--home='.length)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!VALID_TARGETS.includes(target)) {
    throw new Error(`Invalid --target "${target}". Expected one of: ${VALID_TARGETS.join(', ')}`)
  }

  return { target, homeDir, dryRun, help }
}

export function detectAutoTargets(homeDir) {
  const hasApp = existsSync(path.join(homeDir, '.gemini', 'antigravity'))
  const hasPlugin = existsSync(path.join(homeDir, '.gemini', 'config'))
  if (hasApp && hasPlugin) return ['plugin', 'app']
  if (hasApp) return ['app']
  return ['plugin']
}

export function resolveTargets(target, homeDir) {
  if (target === 'both') return ['plugin', 'app']
  if (target === 'plugin') return ['plugin']
  if (target === 'app') return ['app']
  return detectAutoTargets(homeDir)
}

export function buildMcpServerEntry(mcpServerPath) {
  return {
    command: 'node',
    args: [mcpServerPath],
    env: {
      SUPERMANAGER_BASE_URL: '<YOUR_SUPERMANAGER_BASE_URL>',
      SUPERMANAGER_TOKEN: '<YOUR_SUPERMANAGER_AGENT_TOKEN>',
      CLOUDMAIL_BASE_URL: 'https://mail.screwdom.org/api',
      CLOUDMAIL_TOKEN: '<OPTIONAL_CLOUDMAIL_TOKEN>',
      DSH_BACKLINK_BROWSER_PROFILE: '~/.dsh/backlink-browser-profile',
      BACKLINKS_MAX_OUTPUT_CHARS: '16000',
    },
  }
}

export function mergeMcpConfig(existingRoot, serverName, templateEntry) {
  const root = existingRoot === undefined || existingRoot === null ? {} : existingRoot
  if (!isPlainObject(root)) {
    throw new Error('Existing mcp_config.json root must be a JSON object')
  }

  const existingServers = root.mcpServers === undefined ? {} : root.mcpServers
  if (!isPlainObject(existingServers)) {
    throw new Error('Existing mcp_config.json "mcpServers" must be a JSON object')
  }

  const currentServer = existingServers[serverName]
  if (currentServer !== undefined && !isPlainObject(currentServer)) {
    throw new Error(`Existing mcpServers["${serverName}"] must be a JSON object`)
  }

  const mergedEnv = { ...(templateEntry.env ?? {}) }
  if (isPlainObject(currentServer?.env)) {
    for (const [key, value] of Object.entries(currentServer.env)) {
      if (typeof value !== 'string') continue
      if (key in mergedEnv) {
        if (!isPlaceholderValue(value)) {
          mergedEnv[key] = value
        }
      } else {
        mergedEnv[key] = value
      }
    }
  }

  const preservedCommand = typeof currentServer?.command === 'string' && !isPlaceholderValue(currentServer.command)
    ? currentServer.command
    : templateEntry.command

  const nextServer = {
    ...(currentServer ?? {}),
    command: preservedCommand,
    args: [...templateEntry.args],
    env: mergedEnv,
  }

  return {
    ...root,
    mcpServers: {
      ...existingServers,
      [serverName]: nextServer,
    },
  }
}

function readJsonFileOrUndefined(filePath) {
  if (!existsSync(filePath)) return undefined
  const raw = readFileSync(filePath, 'utf8')
  if (raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse existing JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function syncSkillDirs(sourceSkillsRoot, targetSkillsRoot, dryRun) {
  const synced = []
  for (const skillName of SKILL_NAMES) {
    const srcDir = path.join(sourceSkillsRoot, skillName)
    if (!existsSync(srcDir)) {
      throw new Error(`Missing plugin skill directory: ${srcDir}`)
    }
    const destDir = path.join(targetSkillsRoot, skillName)
    synced.push({ srcDir, destDir })
    if (!dryRun) {
      mkdirSync(targetSkillsRoot, { recursive: true })
      rmSync(destDir, { recursive: true, force: true })
      cpSync(srcDir, destDir, { recursive: true })
    }
  }
  return synced
}

export function installAntigravity(options = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(options.repoRoot ?? path.join(here, '..'))
  const homeDir = path.resolve(options.homeDir ?? homedir())
  const target = options.target ?? 'auto'
  const dryRun = options.dryRun === true

  if (!VALID_TARGETS.includes(target)) {
    throw new Error(`Invalid target "${target}". Expected one of: ${VALID_TARGETS.join(', ')}`)
  }

  const pluginSourceDir = path.join(repoRoot, 'antigravity-plugin', PLUGIN_NAME)
  const mcpServerPath = path.join(repoRoot, 'lib', 'mcp-server.mjs')

  if (!existsSync(pluginSourceDir)) {
    throw new Error(`Missing plugin source directory: ${pluginSourceDir}`)
  }
  if (!dryRun && !existsSync(mcpServerPath)) {
    throw new Error(`Built MCP server entry not found at ${mcpServerPath}. Run "pnpm run build" first.`)
  }

  const resolvedTargets = resolveTargets(target, homeDir)
  const templateEntry = buildMcpServerEntry(mcpServerPath)
  const actions = []

  if (resolvedTargets.includes('plugin')) {
    const pluginDestDir = path.join(homeDir, '.gemini', 'config', 'plugins', PLUGIN_NAME)
    const pluginMcpConfigPath = path.join(pluginDestDir, 'mcp_config.json')
    const existingPluginConfig = readJsonFileOrUndefined(pluginMcpConfigPath)
    const nextPluginConfig = mergeMcpConfig(existingPluginConfig, PLUGIN_NAME, templateEntry)

    if (!dryRun) {
      mkdirSync(pluginDestDir, { recursive: true })
      for (const file of ['plugin.json', 'mcp_config.template.json']) {
        cpSync(path.join(pluginSourceDir, file), path.join(pluginDestDir, file))
      }
      for (const dir of ['rules', 'skills']) {
        const destSubdir = path.join(pluginDestDir, dir)
        rmSync(destSubdir, { recursive: true, force: true })
        cpSync(path.join(pluginSourceDir, dir), destSubdir, { recursive: true })
      }
      writeFileSync(pluginMcpConfigPath, `${JSON.stringify(nextPluginConfig, null, 2)}\n`, 'utf8')
    }

    actions.push({
      mode: 'plugin',
      pluginDir: pluginDestDir,
      mcpConfigPath: pluginMcpConfigPath,
      hadExistingConfig: existingPluginConfig !== undefined,
    })
  }

  if (resolvedTargets.includes('app')) {
    const appRootDir = path.join(homeDir, '.gemini', 'antigravity')
    const appMcpConfigPath = path.join(appRootDir, 'mcp_config.json')
    const appSkillsDir = path.join(appRootDir, 'skills')
    const existingAppConfig = readJsonFileOrUndefined(appMcpConfigPath)
    const nextAppConfig = mergeMcpConfig(existingAppConfig, PLUGIN_NAME, templateEntry)

    if (!dryRun) {
      mkdirSync(appRootDir, { recursive: true })
      writeFileSync(appMcpConfigPath, `${JSON.stringify(nextAppConfig, null, 2)}\n`, 'utf8')
    }

    const syncedSkills = syncSkillDirs(path.join(pluginSourceDir, 'skills'), appSkillsDir, dryRun)
    actions.push({
      mode: 'app',
      appDir: appRootDir,
      mcpConfigPath: appMcpConfigPath,
      skillsDir: appSkillsDir,
      skills: syncedSkills.map(item => item.destDir),
      hadExistingConfig: existingAppConfig !== undefined,
    })
  }

  return {
    dryRun,
    homeDir,
    repoRoot,
    mcpServerPath,
    targets: resolvedTargets,
    actions,
  }
}

function printHelp() {
  console.log([
    'Usage: node scripts/install-antigravity.mjs [options]',
    '',
    'Options:',
    '  --target <auto|plugin|app|both>  Installation layout (default: auto)',
    '  --home <dir>                     Override user home directory',
    '  --dry-run                        Preview changes without writing files',
    '  -h, --help                       Show this help message',
  ].join('\n'))
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  const selfPath = path.resolve(fileURLToPath(import.meta.url))
  const entryPath = path.resolve(entry)
  return process.platform === 'win32'
    ? selfPath.toLowerCase() === entryPath.toLowerCase()
    : selfPath === entryPath
}

if (isMainModule()) {
  try {
    const parsed = parseCliArgs(process.argv.slice(2))
    if (parsed.help) {
      printHelp()
      process.exit(0)
    }
    const result = installAntigravity({
      target: parsed.target,
      homeDir: parsed.homeDir,
      dryRun: parsed.dryRun,
    })
    const prefix = result.dryRun ? '[dry-run] ' : ''
    console.log(`${prefix}backlinks-publisher MCP entry: ${result.mcpServerPath}`)
    console.log(`${prefix}targets: ${result.targets.join(', ')}`)
    for (const action of result.actions) {
      if (action.mode === 'plugin') {
        console.log(`${prefix}[plugin] installed plugin -> ${action.pluginDir}`)
        console.log(`${prefix}[plugin] mcp config -> ${action.mcpConfigPath}`)
      } else {
        console.log(`${prefix}[app] merged mcp config -> ${action.mcpConfigPath}`)
        console.log(`${prefix}[app] synced skills -> ${action.skills.join(', ')}`)
      }
    }
    console.log(`${prefix}Next: fill SUPERMANAGER_BASE_URL and a dedicated smag_ SUPERMANAGER_TOKEN in mcp_config.json.`)
  } catch (error) {
    console.error(`install-antigravity failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
