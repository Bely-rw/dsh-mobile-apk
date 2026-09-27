#!/usr/bin/env node
// Verify the installed package links in a deployed DSH tree. A package root
// need not itself be importable when its exports intentionally expose subpaths.
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const within = (root, candidate) => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function findInstalledPackage(engineRoot, fromDir, specifier) {
  const parts = specifier.startsWith('@') ? specifier.split('/').slice(0, 2) : [specifier.split('/')[0]]
  if (parts.length !== (specifier.startsWith('@') ? 2 : 1) || parts.some((part) => !part)) return null
  let current = fromDir
  while (within(engineRoot, current)) {
    const candidate = join(current, 'node_modules', ...parts)
    if (existsSync(join(candidate, 'package.json'))) {
      const physicalPackage = realpathSync(candidate)
      if (!within(engineRoot, physicalPackage)) return null
      return candidate
    }
    const parent = dirname(current)
    if (parent === current || !within(engineRoot, parent)) break
    current = parent
  }
  return null
}

export function checkDshRuntimeDependencies(engineRootArg) {
  const engineRoot = realpathSync(resolve(engineRootArg))
  const scopeRoot = join(engineRoot, 'node_modules', '@deepseek-ai')
  const failures = []
  const resolvedDependencies = []
  let dependencyCount = 0
  const packageFiles = [join(engineRoot, 'package.json')]
  for (const name of readdirSync(scopeRoot)) packageFiles.push(join(scopeRoot, name, 'package.json'))

  let packageCount = 0
  for (const packageFile of packageFiles) {
    if (!existsSync(packageFile)) continue
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
    packageCount++
    const peerDependencies = Object.keys(manifest.peerDependencies ?? {})
      .filter((dependency) => !manifest.peerDependenciesMeta?.[dependency]?.optional)
    const dependencies = [...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...peerDependencies,
    ])]
    const packageDir = dirname(realpathSync(packageFile))
    for (const dependency of dependencies) {
      dependencyCount++
      const installedPath = findInstalledPackage(engineRoot, packageDir, dependency)
      if (!installedPath) {
        failures.push(`${manifest.name ?? packageFile} -> ${dependency}: no installed package.json in the deploy tree`)
        continue
      }
      resolvedDependencies.push({
        importer: manifest.name ?? packageFile,
        dependency,
        deployPath: relative(engineRoot, installedPath).replaceAll(sep, '/'),
      })
    }
  }
  // 地板值与同链的 materialize-dsh-pnpm-packages.mjs:21 同源（那条断言 >= 266 个钉住的第一方
  // 工作区包；本函数数的是同一群体 + 引擎根包自身，故口径相同）。旧值 200 比真实值（316/317）
  // 低太多：静默少掉一百多个包也照样判绿，而这条门禁的名字正是「装饰链接都在场」。
  // 另外 scopeRoot 下的**悬空符号链接**在 :42 被 `existsSync` 静默 continue——那正是「包没装上」
  // 的形态，它既不计入 packageCount 也不产生 failure，所以地板值就是这类缺损的唯一兜底。
  if (packageCount < 266) throw new Error(`expected at least 266 deployed first-party packages, found ${packageCount}`)

  const report = {
    engineRoot: engineRootArg,
    packageCount,
    dependencyCount,
    missingDependencyCount: failures.length,
    dependencyPresence: failures.length ? 'failed' : 'passed',
    resolvedDependencies,
    failures,
  }
  if (failures.length) {
    console.error(failures.join('\n'))
    throw new Error(`source-built runtime dependency presence failed (${failures.length})`)
  }
  return report
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const [engineRoot, reportPath] = process.argv.slice(2)
  if (!engineRoot) {
    console.error('usage: node check-dsh-runtime-dependencies.mjs <engine-root> [report.json]')
    process.exit(2)
  }
  const report = checkDshRuntimeDependencies(engineRoot)
  if (reportPath) writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n')
  console.log(`runtime dependency links passed: ${report.packageCount} packages, ${report.dependencyCount} required dependency links`)
}
