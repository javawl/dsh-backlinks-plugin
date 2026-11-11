import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

interface PackageManifest {
  readonly name: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly dsh?: { readonly client?: { readonly external?: readonly string[] } }
}

const manifest = JSON.parse(
  readFileSync(resolvePath(import.meta.dirname, 'package.json'), 'utf8'),
) as PackageManifest

const PACKAGE_ID = manifest.name

/** Shared browser modules provided by the DeepSeek Harness Web/Desktop shell. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const hostExternals = [
  ...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]),
].map(dep => new RegExp(`^${escapeRegex(dep)}(/|$)`))

const isHostExternal = (specifier: string): boolean =>
  hostExternals.some(pattern => pattern.test(specifier))

const clientExternals = new Set<string>([
  ...PLATFORM_MODULES,
  ...(manifest.dsh?.client?.external ?? []),
])

const isClientExternal = (specifier: string): boolean => clientExternals.has(specifier)

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

const hostConfig: UserConfig = {
  name: `${PACKAGE_ID}/host`,
  entry: {
    index: 'lib/types/host/index.js',
    'typert.host': 'lib/types/host/typert-host.js',
    'typert.remote-client': 'lib/types/shared/typert-remote.js',
    backlinks: 'lib/types/host/backlinks/index.js',
    supermanager: 'lib/types/host/supermanager/index.js',
    'cloud-mail': 'lib/types/host/cloud-mail/index.js',
    'tool-backlinks': 'lib/types/host/tool-backlinks/index.js',
    browser: 'lib/types/host/browser/index.js',
    'browser-playwright': 'lib/types/host/browser-playwright/index.js',
    'tool-browser': 'lib/types/host/tool-browser/index.js',
    'skill-backlinks': 'lib/types/host/skill-backlinks/index.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    onlyBundle: false,
    neverBundle: isHostExternal,
    alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isHostExternal(specifier),
  },
}

const clientConfig: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: {
    client: 'lib/types/client/index.js',
  },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    onlyBundle: false,
    neverBundle: isClientExternal,
    alwaysBundle: (specifier: string) => !isClientExternal(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['production', 'browser', 'import', 'module', 'default'],
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [
    {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        if (importer === undefined) return CSS_VIRTUAL_PREFIX + source + CSS_VIRTUAL_SUFFIX
        let abs = resolvePath(dirname(importer), source)
        if (!existsSync(abs)) {
          abs = abs.replace('/lib/types/', '/src/')
        }
        const rel = relative(import.meta.dirname, abs).replace(/\\/g, '/')
        return CSS_VIRTUAL_PREFIX + rel + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const rel = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        const fileId = resolvePath(import.meta.dirname, rel)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        const exportEntries = Object.entries(cssExports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, exp] of exportEntries) classMap[local] = exp.name
        return styleInjectionModule(PACKAGE_ID, fileId, code.toString(), classMap)
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    sourcemapExcludeSources: false,
    banner: (chunk) =>
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, ${
        chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `
      }factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([hostConfig, clientConfig])
