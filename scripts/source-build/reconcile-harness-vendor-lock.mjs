#!/usr/bin/env node
// Align only the five pinned vendor importers with their archived manifests.
// Keep every existing package resolution and integrity entry unchanged.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function reconcileImporter(importer, manifest, path, overrides = {}) {
  if (!importer || typeof importer !== 'object') throw new Error(`missing lock importer: ${path}`)
  const declared = new Map()
  for (const section of SECTIONS) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      const override = overrides[name]
      const effective = typeof override === 'string' && override.startsWith('link:')
        ? `link:${posix.relative(path, override.slice('link:'.length))}`
        : specifier
      if (declared.has(name) && declared.get(name) !== effective) {
        throw new Error(`${path}: conflicting manifest specifier for ${name}`)
      }
      declared.set(name, effective)
    }
  }

  const seen = new Set()
  const edits = []
  for (const section of SECTIONS) {
    for (const [name, entry] of Object.entries(importer[section] ?? {})) {
      if (!entry || typeof entry !== 'object' || typeof entry.version !== 'string') {
        throw new Error(`${path}: invalid locked resolution for ${name}`)
      }
      if (!declared.has(name)) {
        edits.push({ section, name, oldSpecifier: entry.specifier, newSpecifier: null, lockedVersion: entry.version })
        delete importer[section][name]
        continue
      }
      seen.add(name)
      const expected = declared.get(name)
      if (entry.specifier !== expected) {
        edits.push({ section, name, oldSpecifier: entry.specifier, newSpecifier: expected, lockedVersion: entry.version })
        entry.specifier = expected
      }
    }
  }
  for (const name of declared.keys()) {
    if (!seen.has(name)) throw new Error(`${path}: pinned manifest dependency ${name} lacks a locked resolution`)
  }
  return edits
}

function main() {
  const [sourceArg, overrideReportArg, outputReportArg] = process.argv.slice(2)
  if (!sourceArg || !overrideReportArg || !outputReportArg) {
    throw new Error('usage: reconcile-harness-vendor-lock.mjs <harness-source-root> <harness-vendor-overrides.json> <report.json>')
  }
  const sourceRoot = resolve(sourceArg)
  const reportPath = resolve(outputReportArg)
  const lockPath = join(sourceRoot, 'pnpm-lock.yaml')
  const originalPath = join(dirname(reportPath), 'harness-pnpm-lock.original.yaml')
  const overrideReport = JSON.parse(readFileSync(resolve(overrideReportArg), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  if (overrideReport.harnessSourceCommit !== commit || overrideReport.overrides?.length !== 5) {
    throw new Error('vendor override report does not match the pinned Harness checkout or package count')
  }

  const requireFromHarness = createRequire(join(sourceRoot, 'apps', 'cli', 'package.json'))
  const yaml = requireFromHarness('js-yaml')
  const original = readFileSync(lockPath)
  const lock = yaml.load(original.toString('utf8'))
  const workspace = yaml.load(readFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8'))
  const edits = []
  for (const item of overrideReport.overrides) {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, item.path, 'package.json'), 'utf8'))
    if (manifest.name !== item.package || manifest.version !== item.version) {
      throw new Error(`${item.path}: staged manifest differs from the verified source override`)
    }
    edits.push(...reconcileImporter(lock.importers?.[item.path], manifest, item.path, workspace.overrides ?? {})
      .map((edit) => ({ path: item.path, ...edit })))
  }
  if (!edits.length) throw new Error('expected pinned vendor manifest specifier differences, found none')

  const adjusted = Buffer.from(yaml.dump(lock, { lineWidth: -1, noRefs: true, quotingType: "'" }))
  copyFileSync(lockPath, originalPath)
  writeFileSync(lockPath, adjusted)
  const report = {
    harnessSourceCommit: commit,
    originalLockfile: originalPath,
    originalLockfileSha256: sha256(original),
    adjustedLockfileSha256: sha256(adjusted),
    importerEdits: edits,
    reason: 'Pinned Cordis manifests predate the Harness lock importers. Importer specifiers follow the workspace link overrides; only those specifiers and obsolete importer entries change, with all locked package resolutions fixed.',
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`reconciled ${edits.length} pinned vendor lock importer entries without resolving packages`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
