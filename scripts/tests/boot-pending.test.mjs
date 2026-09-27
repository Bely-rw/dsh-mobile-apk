#!/usr/bin/env node
/**
 * dsh-app-boot 启动审计回归。
 *
 * 固定 Harness 0.1.7-rc.2 导出 auditStartupEntries：全局必需 id 未激活时
 * 启动失败，其他条目未激活时报告告警。直接调用产物导出并注入最小 Loader stub。
 *
 * 用法：node scripts/tests/boot-pending.test.mjs [--boot <path>]
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const DEFAULT_BOOT = '.deploy-tmp/snapshot-013/x86_64/stage/root/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'

const argv = process.argv.slice(2)
const flagIndex = argv.indexOf('--boot')
const target = resolve(flagIndex >= 0 && argv[flagIndex + 1] ? argv[flagIndex + 1] : (process.env.DSH_BOOT_FILE ?? DEFAULT_BOOT))

if (!existsSync(target)) {
  console.log(`[skip] dsh-app-boot 目标文件不在场：${target}`)
  process.exit(0)
}

const { auditStartupEntries } = await import(pathToFileURL(target).href)
assert.equal(typeof auditStartupEntries, 'function', '固定 dsh-app-boot 必须导出 auditStartupEntries')

const ACTIVE = 2
const PENDING = 0
const FAILED = 3

function entry(id, name, state, { missingService = 'uiConversation', error } = {}) {
  return {
    options: { id, name },
    disabled: false,
    fiber: {
      state,
      inject: state === PENDING ? { [missingService]: true } : {},
      ctx: { get: () => undefined },
      await: async () => { if (error) throw error },
    },
  }
}

function ctxOf(entries) {
  return { loader: { entries: () => entries } }
}

async function capture(entries) {
  const warnings = []
  try {
    await auditStartupEntries(ctxOf(entries), 'web boot', (line) => warnings.push(line))
    return { threw: undefined, warnings }
  } catch (error) {
    return { threw: error, warnings }
  }
}

test('第三方 pending 不阻断 boot，并留下点名告警', async () => {
  const { threw, warnings } = await capture([
    entry('agent-loop', '@deepseek-ai/dsh-base', ACTIVE),
    entry('third-party', '@nanmicoder/dsh-agent-teams', PENDING),
  ])
  assert.equal(threw, undefined)
  assert.ok(warnings.some((line) => line.includes('@nanmicoder/dsh-agent-teams')))
  assert.ok(warnings.some((line) => line.includes('warning: 1 entry did not activate')))
})

test('必需 id pending 仍然致命', async () => {
  const { threw, warnings } = await capture([entry('webserver', '@deepseek-ai/dsh-web-app', PENDING)])
  assert.equal(threw?.name, 'Error')
  assert.match(threw.message, /1 required plugin did not activate/)
  assert.match(threw.message, /webserver/)
  assert.equal(warnings.length, 0)
})

test('可选第三方 FAILED 产生告警，必需 id FAILED 致命', async () => {
  const optional = await capture([entry('third-party', '@third/party', FAILED, { error: new Error('boom') })])
  assert.equal(optional.threw, undefined)
  assert.ok(optional.warnings.some((line) => line.includes('boom')))
  const required = await capture([entry('webserver', '@deepseek-ai/dsh-web-app', FAILED, { error: new Error('boom') })])
  assert.ok(required.threw)
  assert.match(required.threw.message, /1 required plugin did not activate/)
})

test('全部 active 时既不抛错也不告警', async () => {
  const { threw, warnings } = await capture([
    entry('webserver', '@deepseek-ai/dsh-web-app', ACTIVE),
    entry('third-party', '@third/party', ACTIVE),
  ])
  assert.equal(threw, undefined)
  assert.equal(warnings.length, 0)
})

test('第三方 pending 与必需 id pending 混合时保留两条诊断', async () => {
  const { threw, warnings } = await capture([
    entry('third-party', '@third/party', PENDING),
    entry('webserver', '@deepseek-ai/dsh-web-app', PENDING),
  ])
  assert.ok(threw)
  assert.match(threw.message, /third-party/)
  assert.match(threw.message, /webserver/)
  assert.equal(threw.entries.length, 2)
  assert.ok(threw.entries.some((item) => item.module === '@third/party'))
  assert.equal(threw.entries.filter((item) => item.required).length, 1)
  assert.equal(warnings.length, 0)
})
