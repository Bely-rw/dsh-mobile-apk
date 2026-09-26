#!/usr/bin/env node
// Source-build replacement for check-engine-overlay.mjs: inspect the final
// snapshot's pnpm links and source package versions instead of legacy npm paths.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { checkDshRuntimeDependencies } from './check-dsh-runtime-dependencies.mjs'
import { checkAndroidNativeRuntimePackages } from './check-android-native-runtime-packages.mjs'

const snapshotArg = process.argv[2]
if (!snapshotArg) {
  console.error('usage: node check-dsh-source-snapshot.mjs <snapshot.tar.xz>')
  process.exit(2)
}

const snapshot = resolve(snapshotArg)
const sourceBuildRoot = resolve('.deploy-tmp/source-build')
const sourceManifestPath = resolve('.deploy-tmp/engine-overlay/source-build-manifest.json')
const reportPath = join(sourceBuildRoot, 'source-engine-snapshot-check.json')
const packageCache = resolve('.deploy-tmp/engine-overlay')
const expectedCommit = '477b4f420553e8a52c2fbccc464d7561b239c443'
const packagePrefix = 'usr/lib/node_modules/@deepseek-ai/dsh'
const overlayPath = join(sourceBuildRoot, 'engine-overlay.original.json')
const overridePath = join(sourceBuildRoot, 'harness-vendor-overrides.json')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const within = (root, candidate) => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
if (sourceManifest.commit !== expectedCommit) throw new Error(`unexpected Harness source commit: ${sourceManifest.commit}`)
const sourceOverlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
const expectedPackages = new Map(Object.entries(sourceOverlay.packages ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/')))
expectedPackages.set(sourceOverlay.rootPackage.name, sourceOverlay.rootPackage.version)
if (sourceManifest.packageCount !== sourceManifest.packages?.length || sourceManifest.packageCount !== expectedPackages.size) {
  throw new Error(`source package manifest is incomplete: ${sourceManifest.packageCount}, expected ${expectedPackages.size}`)
}
const overrideReport = JSON.parse(readFileSync(overridePath, 'utf8'))
if (overrideReport.harnessSourceCommit !== expectedCommit) throw new Error('Harness vendor source overrides target the wrong source commit')
const overrideByPackage = new Map((overrideReport.overrides ?? []).map((item) => [item.package, item]))
const sourcePackageNames = new Set()
for (const item of sourceManifest.packages) {
  if (sourcePackageNames.has(item.name)) throw new Error(`duplicate source package entry: ${item.name}`)
  sourcePackageNames.add(item.name)
  if (expectedPackages.get(item.name) !== item.version) {
    throw new Error(`source manifest has an unexpected overlay package: ${item.name}@${item.version}`)
  }
  const override = overrideByPackage.get(item.name)
  if ((override?.sourceCommit ?? expectedCommit) !== item.sourceCommit) {
    throw new Error(`source manifest commit mismatch for ${item.name}: ${item.sourceCommit}`)
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-source-snapshot-'))
try {
  const decoder = spawn('xz', ['-d', '-T0', '-c', snapshot], { stdio: ['ignore', 'pipe', 'inherit'] })
  const extractor = spawn('tar', [
    '-xf', '-',
    '-C', tempRoot,
    '--no-same-owner',
    '--no-same-permissions',
    packagePrefix,
    'home/.dsh/profiles/web/node_modules/@napi-rs/canvas-android-arm64',
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  decoder.stdout.pipe(extractor.stdin)
  extractor.stdin.on('error', () => {}) // tar can close early after an extraction failure.
  const successful = (child, name) => new Promise((accept, reject) => {
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? accept() : reject(new Error(`${name} exited ${code}`)))
  })
  await Promise.all([successful(decoder, 'xz'), successful(extractor, 'tar')])
  const engineRoot = join(tempRoot, packagePrefix)
  const physicalEngineRoot = realpathSync(engineRoot)
  const packageChecks = []
  for (const item of sourceManifest.packages) {
    const packageDir = item.name === '@deepseek-ai/dsh'
      ? engineRoot
      : join(engineRoot, 'node_modules', ...item.name.split('/'))
    const packageJson = join(packageDir, 'package.json')
    if (!existsSync(packageJson)) throw new Error(`snapshot is missing source package ${item.name}@${item.version}`)
    const physicalPackageDir = realpathSync(packageDir)
    if (!within(physicalEngineRoot, physicalPackageDir)) throw new Error(`${item.name} link escapes the source engine tree`)
    const manifest = JSON.parse(readFileSync(packageJson, 'utf8'))
    if (manifest.name !== item.name || manifest.version !== item.version) {
      throw new Error(`${item.name} snapshot identity mismatch: ${manifest.name}@${manifest.version}, expected ${item.version}`)
    }
    const archive = join(packageCache, item.file)
    if (!existsSync(archive) || sha256(readFileSync(archive)) !== item.sha256) {
      throw new Error(`${item.name}@${item.version} source tarball hash mismatch`)
    }
    packageChecks.push({
      name: item.name,
      version: item.version,
      sourceCommit: item.sourceCommit,
      sourceTarballSha256: item.sha256,
    })
  }

  const dependencyCheck = checkDshRuntimeDependencies(engineRoot)
  const nativeCheck = checkAndroidNativeRuntimePackages(engineRoot)
  const ptyBuild = JSON.parse(readFileSync(join(sourceBuildRoot, 'node-pty-android-build.json'), 'utf8'))
  if (nativeCheck.nodePty.androidBinding.sha256 !== ptyBuild.output.sha256) {
    throw new Error('snapshot node-pty Android binary differs from the local source build')
  }
  const canvasRoot = join(tempRoot, 'home/.dsh/profiles/web/node_modules/@napi-rs/canvas-android-arm64')
  const canvasManifest = JSON.parse(readFileSync(join(canvasRoot, 'package.json'), 'utf8'))
  if (canvasManifest.name !== '@napi-rs/canvas-android-arm64' || canvasManifest.version !== '1.0.8') {
    throw new Error(`unexpected Android Canvas package ${canvasManifest.name}@${canvasManifest.version}`)
  }
  const canvasFile = join(canvasRoot, 'skia.android-arm64.node')
  const canvasBytes = readFileSync(canvasFile)
  if (canvasBytes.length < 20 || canvasBytes[0] !== 0x7f || canvasBytes[1] !== 0x45
    || canvasBytes[2] !== 0x4c || canvasBytes[3] !== 0x46 || canvasBytes[4] !== 2
    || canvasBytes[5] !== 1 || canvasBytes.readUInt16LE(18) !== 183) {
    throw new Error('Canvas Android module is not an AArch64 ELF file')
  }
  const launcher = readFileSync('app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt', 'utf8')
  if (!launcher.includes('"--expose-internals"')) {
    throw new Error('the Android engine no longer exposes Node internals for the JavaScript loader fallback')
  }
  const patchRegistry = JSON.parse(readFileSync('scripts/patches/registry.json', 'utf8'))
  const patchChecks = []
  const runtimePrefix = `${packagePrefix}/`
  for (const patch of patchRegistry.patches.filter((item) => item.scope === 'engine' && item.overlayCheck !== false)) {
    const marker = String(patch.marker ?? '').replace(/（.*$/, '').trim()
    if (!marker) continue
    if (!patch.target.startsWith(runtimePrefix)) throw new Error(`engine patch target escaped the source runtime: ${patch.target}`)
    const target = resolve(engineRoot, patch.target.slice(runtimePrefix.length))
    if (!within(engineRoot, target) || !existsSync(target)) throw new Error(`source snapshot patch target missing: ${patch.id}`)
    const physicalTarget = realpathSync(target)
    if (!within(physicalEngineRoot, physicalTarget)) throw new Error(`source snapshot patch target link escaped: ${patch.id}`)
    const content = readFileSync(target, 'utf8')
    if (!content.includes(marker)) throw new Error(`source snapshot patch marker missing: ${patch.id} (${marker})`)
    patchChecks.push({ id: patch.id, target: patch.target, marker })
  }

  const presetsRoot = join(engineRoot, 'node_modules/@deepseek-ai/dsh-agent-presets/presets')
  const presetCount = existsSync(presetsRoot) ? readdirSync(presetsRoot).length : 0
  if (presetCount < 1) throw new Error('source snapshot has no built-in dsh-agent-presets entries')

  const report = {
    source: sourceManifest.source,
    sourceCommit: sourceManifest.commit,
    sourceLockfileSha256: sourceManifest.lockfileSha256,
    vendorSourceOverrides: overrideReport.overrides.map(({ package: name, version, sourceCommit, sourceTree }) => ({
      package: name,
      version,
      sourceCommit,
      sourceTree,
    })),
    snapshotSha256: await sha256File(snapshot),
    packageCount: packageChecks.length,
    packages: packageChecks,
    dependencyCheck,
    nativeCheck,
    canvasAndroidArm64: { version: canvasManifest.version, size: canvasBytes.length, sha256: sha256(canvasBytes) },
    patchChecks,
    builtInPresetCount: presetCount,
  }
  mkdirSync(sourceBuildRoot, { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`source snapshot check passed: ${packageChecks.length} pinned packages, ${dependencyCheck.dependencyCount} dependency links, ${patchChecks.length} engine patch markers, ${presetCount} presets`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
