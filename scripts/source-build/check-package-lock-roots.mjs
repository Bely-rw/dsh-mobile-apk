import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function normalized(value) {
  return JSON.stringify(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)))
}

export function checkPackageLockRoot(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
  const root = lock.packages?.['']
  if (!root) return [`${directory}: package-lock.json 缺少 packages[""]`]

  const errors = []
  for (const field of ['name', 'version']) {
    if (manifest[field] !== root[field]) {
      errors.push(`${directory}: ${field} 不一致 (${manifest[field]} != ${root[field]})`)
    }
  }
  for (const field of dependencyFields) {
    if (normalized(manifest[field]) !== normalized(root[field])) {
      errors.push(`${directory}: ${field} 与 package-lock.json 根声明不一致`)
    }
  }
  return errors
}

export function packageDirectories(repoRoot) {
  const candidates = ['dsh-client-ui-responsive', 'dsh-shell-termux']
  const pluginRoot = path.join(repoRoot, 'plugins')
  for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join('plugins', entry.name))
  }
  return candidates
    .map((relative) => path.join(repoRoot, relative))
    .filter((directory) => fs.existsSync(path.join(directory, 'package-lock.json')))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(process.argv[2] ?? '.')
  const directories = packageDirectories(repoRoot)
  const errors = directories.flatMap(checkPackageLockRoot)
  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
  } else {
    console.log(`package-lock 根声明一致: ${directories.length} 个目录`)
  }
}
