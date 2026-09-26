#!/usr/bin/env node
// Apply the registered marketplace patches to source-built output while keeping
// the shared patch runner byte-identical to the coordination repository.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
if (args.length < 1) {
  console.error('usage: node apply-source-marketplace-patches.mjs <vendorRoot> [patch arguments]')
  process.exit(2)
}

const sourcePath = resolve('scripts/patches/apply-patches.mjs')
const source = readFileSync(sourcePath, 'utf8')
const newline = source.includes('\r\n') ? '\r\n' : '\n'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const adapterSource = readFileSync(fileURLToPath(import.meta.url))
const oldBlock = [
  "      if (!s.includes(')});return n()}}') && s.includes('join(`\\n`)}}')) {",
  "        s = s.replace('join(`\\n`)}}', 'join(`\\n`)});return n()}}')",
  '        changed++',
  '      }',
].join(newline)
const sourceBlock = [
  "      if (!s.includes(')});return n()}}')) {",
  "        if (s.includes('join(`\\n`)}}')) {",
  "          s = s.replace('join(`\\n`)}}', 'join(`\\n`)});return n()}}')",
  '          changed++',
  "        } else if (s.includes('join(`\\n`)})}}')) {",
  "          // Source-built esbuild output also closes the optional requireApproval call.",
  "          s = s.replace('join(`\\n`)})}}', 'join(`\\n`)});return n()}}')",
  '          changed++',
  '        }',
  '      }',
].join(newline)
const hereLine = 'const HERE = dirname(fileURLToPath(import.meta.url))'
if (source.split(oldBlock).length !== 2 || source.split(hereLine).length !== 2) {
  throw new Error('shared patch runner changed; review the source-build marketplace adapter before updating it')
}
const adapted = source
  .replace(hereLine, "const HERE = join(process.cwd(), 'scripts', 'patches')")
  .replace(oldBlock, sourceBlock)

const reportRoot = resolve('.deploy-tmp/source-build')
mkdirSync(reportRoot, { recursive: true })
const generatedPath = join(reportRoot, 'apply-patches-source.mjs')
writeFileSync(generatedPath, adapted)
const result = spawnSync(process.execPath, [generatedPath, ...args], { cwd: process.cwd(), stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const target = resolve(args[0], 'dshmarketplace-plugin/lib/index.js')
const report = {
  sharedPatchRunner: 'scripts/patches/apply-patches.mjs',
  sharedPatchRunnerSha256: sha256(source),
  generatedPatchRunner: '.deploy-tmp/source-build/apply-patches-source.mjs',
  generatedPatchRunnerSha256: sha256(adapted),
  sourceAdapter: 'scripts/source-build/apply-source-marketplace-patches.mjs',
  sourceAdapterSha256: sha256(adapterSource),
  registrySha256: sha256(readFileSync('scripts/patches/registry.json')),
  marketplacePatchOutput: args[0] + '/dshmarketplace-plugin/lib/index.js',
  marketplacePatchOutputSha256: sha256(readFileSync(target)),
  arguments: args,
  sourceBuildOnlyRule: "Accept the pinned marketplace source build's optional requireApproval closure shape for registered market-A patch A-3.",
}
writeFileSync(join(reportRoot, 'marketplace-patch-adapter.json'), JSON.stringify(report, null, 2) + '\n')
console.log('source-built marketplace patches applied with a generated, source-only runner adapter')
