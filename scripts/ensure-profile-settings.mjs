#!/usr/bin/env node
// 将 profile-settings.yml 中缺失的模型路由条目增量写入目标 profile 的 cordis.patch.yml（已有配置绝不覆盖）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, '..', 'profile-settings.yml')
const profile = process.argv[2] ?? 'web'
if (process.argv.length > 3 || profile.startsWith('-')) {
  console.error('用法: dsh-backlinks-init-models [profile名]（缺省 web，桌面版可传 desktop）')
  process.exit(1)
}
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const targetPath = join(home, 'profiles', profile, 'cordis.patch.yml')

const HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

function entryBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let current = []
  for (const line of lines) {
    if (/^- /.test(line) && current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.some(line => line.trim().length > 0)) blocks.push(current.join('\n'))
  return blocks.map(block => `${block.replace(/^\n+/, '').trimEnd()}\n`)
    .filter(block => /^- id:/.test(block))
}

const blocks = entryBlocks(readFileSync(sourcePath, 'utf8'))
const rawExisting = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined
// 若现有文件仅为 `[]` 空数组占位，则替换为列表形式
const existing = rawExisting !== undefined && /^\s*\[\s*\]\s*$/.test(rawExisting.replace(/^#.*$/gm, ''))
  ? HEADER
  : rawExisting

const missing = blocks.filter((block) => {
  const id = /^- id:\s*['"]?([\w.-]+)/.exec(block)?.[1]
  if (id === undefined) return false
  return !new RegExp(`^\\s*-?\\s*id:\\s*['"]?${id}['"]?\\s*$`, 'm').test(existing ?? '')
})

if (missing.length === 0) {
  console.log(`dsh-backlinks-init-models: ${targetPath} 已包含全部模型路由条目，未改动。`)
  process.exit(0)
}

if (existing === undefined) {
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, `${HEADER}\n${missing.join('\n')}`)
} else {
  const prefix = existing.endsWith('\n') ? existing : `${existing}\n`
  writeFileSync(targetPath, `${prefix}\n${missing.join('\n')}`)
}
const ids = missing.map(block => /^- id:\s*['"]?([\w.-]+)/.exec(block)?.[1]).join('、')
console.log(`dsh-backlinks-init-models: 已写入 ${ids} → ${targetPath}`)
