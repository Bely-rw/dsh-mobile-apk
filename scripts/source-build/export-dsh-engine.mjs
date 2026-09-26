#!/usr/bin/env node
// Package the pinned DeepSeek Harness workspace after its source build. This
// creates the cache layout consumed by build-snapshot-013.mjs, without npm
// release tarballs for first-party @deepseek-ai packages.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '')
const cache = resolve(process.argv[3] ?? '')
const expectedCommit = '477b4f420553e8a52c2fbccc464d7561b239c443'
const overlayPath = resolve('scripts/snapshot-config/engine-overlay.json')
if (!process.argv[2] || !process.argv[3]) {
  console.error('usage: node scripts/source-build/export-dsh-engine.mjs <dsh-source-root> <overlay-cache>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const commit = git('rev-parse', 'HEAD')
if (commit !== expectedCommit) throw new Error(`unexpected DeepSeek Harness commit: ${commit}`)

const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
const sourcePackage = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const lockfilePath = join(repo, 'pnpm-lock.yaml')
if (!existsSync(lockfilePath)) throw new Error('pinned Harness source is missing pnpm-lock.yaml')
const vendorOverridePath = resolve('.deploy-tmp/source-build/harness-vendor-overrides.json')
const vendorOverrideReport = JSON.parse(readFileSync(vendorOverridePath, 'utf8'))
if (vendorOverrideReport.harnessSourceCommit !== expectedCommit) {
  throw new Error(`vendor source overrides target ${vendorOverrideReport.harnessSourceCommit}, expected ${expectedCommit}`)
}
const packageSourceCommits = new Map((vendorOverrideReport.overrides ?? []).map((item) => [item.package, item.sourceCommit]))
const wanted = new Map(Object.entries(overlay.packages).filter(([name]) => name.startsWith('@deepseek-ai/')))
wanted.set(overlay.rootPackage.name, overlay.rootPackage.version)

const manifests = new Map()
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.name === 'package.json') {
      let manifest
      try { manifest = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      if (typeof manifest.name === 'string') manifests.set(manifest.name, { file, manifest })
    }
  }
}
walk(repo)

for (const [name, sourceCommit] of packageSourceCommits) {
  if (!wanted.has(name)) throw new Error(`source override is not present in the engine overlay: ${name}`)
  if (!sourceCommit || !/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`invalid source commit for ${name}`)
}

rmSync(cache, { recursive: true, force: true })
mkdirSync(cache, { recursive: true })
const tmp = join(cache, '.pack')
mkdirSync(tmp, { recursive: true })
const packed = []
for (const [name, version] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
  const entry = manifests.get(name)
  if (!entry) throw new Error(`missing source package: ${name}`)
  // Every overlay pin must match the tree as staged: the vendor source overrides
  // replace the pinned Cordis packages before this runs, so no version rewriting
  // happens here and the packed manifests stay exactly as their source commits
  // published them.
  if (entry.manifest.version !== version) {
    throw new Error(`${name} source version ${entry.manifest.version} does not match overlay pin ${version}`)
  }

  const dir = dirname(entry.file)
  for (const file of readdirSync(tmp)) rmSync(join(tmp, file), { recursive: true, force: true })
  execFileSync('pnpm', ['--dir', dir, 'pack', '--pack-destination', tmp], { cwd: repo, stdio: 'inherit' })
  const candidates = readdirSync(tmp).filter((file) => file.endsWith('.tgz'))
  if (candidates.length !== 1) throw new Error(`${name}: expected one pack output, got ${candidates.length}`)
  const outName = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
  const outPath = join(cache, outName)
  renameSync(join(tmp, candidates[0]), outPath)
  const digest = createHash('sha256').update(readFileSync(outPath)).digest('hex')
  packed.push({
    name,
    version,
    sourceCommit: packageSourceCommits.get(name) ?? commit,
    sourcePath: relative(repo, dir).replaceAll('\\', '/'),
    sha256: digest,
    file: outName,
  })
  console.log(`source-pack ${name}@${version} ${digest}`)
}
rmSync(tmp, { recursive: true, force: true })
writeFileSync(join(cache, 'source-build-manifest.json'), JSON.stringify({
  source: 'https://github.com/deepseek-ai/deepseek-harness',
  commit,
  packageManager: sourcePackage.packageManager,
  lockfileSha256: createHash('sha256').update(readFileSync(lockfilePath)).digest('hex'),
  vendorSourceOverrides: vendorOverrideReport.overrides.map(({ package: name, path, version, sourceCommit, sourceTree, sourceManifestSha256 }) => ({
    package: name,
    path,
    version,
    sourceCommit,
    sourceTree,
    sourceManifestSha256,
  })),
  packageCount: packed.length,
  packages: packed,
}, null, 2) + '\n')
