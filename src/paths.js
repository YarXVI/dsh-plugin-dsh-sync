// Path resolution and sync-set definitions.
//
// A "set" is one coherent slice of the DSH data directory with its own merge
// mode. Everything the engine copies is addressed as `<setId>:<relative path>`
// and never escapes the set root.
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured) return resolve(configured)
  return join(homedir(), '.dsh')
}

export function displayHome(home) {
  const base = join(homedir(), '.dsh')
  return resolve(home) === resolve(base) ? '~/.dsh' : '$DSH_HOME'
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'logs', 'backups', 'dsh-sync',
  '.plugin-manager', 'conflicts', '__pycache__', '.cache', '.tmp',
])

const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', 'session.lock', '.modules.yaml',
])

const IGNORE_SUFFIXES = ['.tmp', '.temp', '.swp', '.part', '.crdownload', '.lock']
const IGNORE_INFIX = ['.bak', '.conflict-', '.sync-tmp-']

/** True when a set-relative path must never be synced. */
export function isIgnored(relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean)
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return true
    if (IGNORE_FILES.has(part)) return true
    if (IGNORE_SUFFIXES.some((s) => part.endsWith(s))) return true
    if (IGNORE_INFIX.some((s) => part.includes(s))) return true
  }
  return false
}

/**
 * Set-aware ignore check.
 *
 * `node_modules` is ignored for every set except `modules`, which mirrors
 * `profiles/<profile>/node_modules` on purpose because plugin dependencies are
 * not installed on the peer. For that set the `node_modules/` segment is
 * stripped and the ordinary rules still apply, so `.bak-*`, `.sync-tmp-*`,
 * nested `node_modules` bookkeeping and secrets stay excluded.
 */
export function isIgnoredForSet(relPath, set = null) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!set?.allowNodeModules) return isIgnored(rel)
  const parts = rel.split('/').filter((part) => part && part !== '.')
  if (!parts.length) return false
  // Drop every `node_modules` segment (top-level and nested for hoisted version
  // conflicts) and apply the ordinary rules to what is left.
  const rest = parts.filter((part) => part !== 'node_modules').join('/')
  if (!rest) return false
  return isIgnored(rest)
}

/** True when `child` is inside `root` (both resolved). */
export function isInside(root, child) {
  const r = resolve(root)
  const c = resolve(child)
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Build the sync sets for one DSH home.
 * `profile` defaults to $DSH_PROFILE, then "desktop".
 */
export function buildSets({ home, profile = process.env.DSH_PROFILE || 'desktop', sets: enabled } = {}) {
  const root = resolve(home || resolveDshHome())
  const prof = String(profile || 'desktop')
  const all = [
    {
      id: 'sessions',
      label: '会话记录',
      detail: 'session.v*.jsonl.zstd 追加日志',
      mode: 'append',
      root: join(root, 'sessions'),
    },
    {
      id: 'workspace',
      label: '工作区索引',
      detail: 'storages/workspace.json 结构化合并',
      mode: 'merge-workspace',
      root: join(root, 'storages'),
      include: ['workspace.json'],
    },
    {
      id: 'storages',
      label: '其它设置数据',
      detail: 'schedule.json 等 storages 下的数据',
      mode: 'lww',
      root: join(root, 'storages'),
      exclude: ['workspace.json', 'session_projcache'],
    },
    {
      id: 'profile',
      label: '配置与插件',
      detail: 'package.json 合并依赖；cordis.patch.yml 只合并模型块；plugins 目录镜像（含一级 junction 解引用）',
      mode: 'profile',
      root: join(root, 'profiles', prof),
      include: ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'plugins'],
      // Plugin sources are often first-level junctions into a developer
      // checkout (`plugins/<name>` -> D:\work\<name>). Dereference exactly one
      // level so the peer receives real files.
      dereferencePluginLinks: true,
      exclude: [
        'plugins/**/node_modules/**',
        'plugins/**/.git/**',
        'plugins/**/*.node',
        'plugins/**/*.dll',
        'plugins/**/*.so',
        'plugins/**/*.dylib',
        'plugins/**/*.exe',
        'plugins/**/*.map',
      ],
    },
    {
      id: 'modules',
      label: '插件依赖',
      detail: 'profile node_modules 中可移植的包（跳过链接与原生二进制）',
      mode: 'lww',
      root: join(root, 'profiles', prof),
      include: ['node_modules'],
      // `node_modules` is ignored globally; this set opts out (see isIgnoredForSet).
      allowNodeModules: true,
      defaultEnabled: true,
      exclude: [
        'node_modules/.pnpm',
        'node_modules/.bin',
        'node_modules/.ignored',
        'node_modules/.modules.yaml',
        'node_modules/.pnpm-workspace-state-v1.json',
        '**/.pnpm',
        // `**/.bin` would also match ordinary resources such as
        // `pkg/dist/assets/tool.bin` (glob `**/` compiles to `.*`), so only the
        // *contents* of a `.bin` directory are excluded here; the top-level
        // `node_modules/.bin` is covered by the exact entry above.
        '**/.bin/**',
        '**/.ignored',
        '**/.modules.yaml',
        '**/.pnpm-workspace-state-v1.json',
        '**/*.node',
        '**/*.dll',
        '**/*.so',
        '**/*.dylib',
        '**/*.exe',
        '**/*.map',
        '**/.DS_Store',
        '**/Thumbs.db',
      ],
    },
    {
      id: 'credentials',
      label: '模型 API 密钥',
      detail: 'profiles 引用的 apiKeyEnv 凭据（仅 *API_KEY，经加密通道）',
      mode: 'merge-credentials',
      root,
      include: ['.credentials.yaml'],
      defaultEnabled: true,
    },
    {
      id: 'attachments',
      label: '附件',
      detail: '用户上传与粘贴的文件',
      mode: 'lww',
      root: join(root, 'attachments'),
    },
    {
      id: 'cache',
      label: '缓存',
      detail: 'cache 目录下的可再生数据',
      mode: 'lww',
      root: join(root, 'cache'),
      defaultEnabled: false,
    },
  ]
  const wanted = enabled == null ? null : new Set(enabled)
  return all.map((set) => ({ ...set, enabled: wanted ? wanted.has(set.id) : set.defaultEnabled !== false }))
}

export function stateDirFor(home) {
  return join(resolve(home || resolveDshHome()), 'dsh-sync')
}

/** Map an absolute file inside a set root to its set-relative path. */
export function toRelative(set, absPath) {
  const r = resolve(set.root)
  const a = resolve(absPath)
  if (!isInside(r, a)) return null
  return a.slice(r.length).replace(/^[\\/]+/, '')
}

export function joinInside(set, relPath) {
  const raw = String(relPath).replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) return null
  const parts = raw.split('/').filter((p) => p && p !== '.')
  if (!parts.length || parts.includes('..')) return null
  const abs = resolve(set.root, ...parts)
  return isInside(set.root, abs) ? abs : null
}
