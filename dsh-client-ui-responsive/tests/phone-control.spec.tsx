// @vitest-environment jsdom
// 「手机控制」设置分区：屏幕范围 / 虚拟屏档位 / 浮窗开关 / 强制销毁三连点（0.14.0）；
// Shizuku 引导重做（0.14.1 用户定例）：状态源 + 两入口 + 教程外链 + 无障碍受限设置解锁。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  PhoneControlSection,
  settleLinkCall,
  settleUnlockCall,
  shizukuStateLabel,
  shizukuStepHint,
  rootGrantStateLabel,
  canToggleRootGrant,
  rootGrantChannelHint,
  rootAccessStateLabel,
  canRequestRoot,
  ROOT_GRANT_NOT_ROOT_TEXT,
} from '../src/client/dev-section/phone-control.tsx'
import { describeCallReason } from '../src/client/user-copy.ts'
import { DEV_SECTION_CSS } from '../src/client/dev-section/dev-section.css.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type Scope = 'virtual-only' | 'real-only' | 'all'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(bridge: Record<string, unknown>): Promise<HTMLElement> {
  window.androidBridge = bridge as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<PhoneControlSection {...({ close: () => {} } as never)} />) })
  return host
}

async function unmount(): Promise<void> {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
}

/** 壳侧 shizukuStatus() 的样本（字段名与 ShizukuTransport.status 一致）。 */
function shizukuJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    installed: true,
    running: true,
    granted: true,
    bound: true,
    binding: false,
    code: 'shizuku-ready',
    guidance: 'Shizuku shell UserService 已就绪（uid=2000）。',
    ...over,
  })
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((item) => item.textContent === text)
  expect(found, '按钮「' + text + '」必须在场').toBeTruthy()
  return found as HTMLButtonElement
}

/** 不带断言的查询（查"某按钮**不该**在场"时必须用它——`buttonByText` 自带"必须在场"断言 ✗）。 */
function queryButtonByText(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((item) => item.textContent === text) as HTMLButtonElement | undefined
}

function detailLine(el: HTMLElement, marker: string): string {
  const found = [...el.querySelectorAll('.dsh-screen-control-detail')]
    .map((node) => node.textContent ?? '')
    .find((text) => text.includes(marker))
  expect(found, '明细行「' + marker + '」必须在场').toBeTruthy()
  return found as string
}

beforeEach(() => {
  delete window.androidBridge
})

afterEach(async () => {
  await unmount()
  delete window.androidBridge
  vi.restoreAllMocks()
})

describe('PhoneControlSection（手机控制设置页）', () => {
  it('开放屏幕范围：壳值优先，切换后写壳桥并回读', async () => {
    const state: { scope: Scope } = { scope: 'virtual-only' }
    const setScreenScope = vi.fn((scope: Scope) => { state.scope = scope })
    const getScreenScope = vi.fn(() => state.scope)
    const el = await render({ getScreenScope, setScreenScope })
    const select = el.querySelector('select[aria-label="开放屏幕范围"]') as HTMLSelectElement
    expect(select, '开放屏幕范围选择器必须在场').toBeTruthy()
    expect(select.value).toBe('virtual-only')
    await act(async () => {
      select.value = 'all'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(setScreenScope).toHaveBeenCalledWith('all')
    expect(getScreenScope).toHaveBeenCalled()
  })

  it('开放屏幕范围：壳桥缺失时回落安全默认 virtual-only', async () => {
    const el = await render({})
    const select = el.querySelector('select[aria-label="开放屏幕范围"]') as HTMLSelectElement
    expect(select.value).toBe('virtual-only')
  })

  it('虚拟屏档位：读壳值并写壳桥（0.5 / 0.75 / 1）', async () => {
    let scale = 0.5
    const getVdisplayScale = vi.fn(() => scale)
    const setVdisplayScale = vi.fn((value: number) => { scale = value })
    const el = await render({ getVdisplayScale, setVdisplayScale })
    const select = el.querySelector('select[aria-label="虚拟屏分辨率档位"]') as HTMLSelectElement
    expect(select.value).toBe('0.5')
    await act(async () => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(setVdisplayScale).toHaveBeenCalledWith(1)
    expect((el.querySelector('select[aria-label="虚拟屏分辨率档位"]') as HTMLSelectElement).value).toBe('1')
  })

  it('虚拟屏浮窗：默认开，关闭写壳桥并回读', async () => {
    let enabled = true
    const getVdisplayFloatEnabled = vi.fn(() => enabled)
    const setVdisplayFloatEnabled = vi.fn((next: boolean) => { enabled = next })
    const el = await render({ getVdisplayFloatEnabled, setVdisplayFloatEnabled })
    const toggle = el.querySelector('input[aria-label="虚拟屏浮窗（退后台自动显示）"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    await act(async () => { toggle.click() })
    expect(setVdisplayFloatEnabled).toHaveBeenCalledWith(false)
    expect((el.querySelector('input[aria-label="虚拟屏浮窗（退后台自动显示）"]') as HTMLInputElement).checked).toBe(false)
  })

  // P5-6：与开发者选项里的「悬浮球」去混淆——两处都叫「浮」，必须各说各是什么，
  // 且其中一处要点名另一处，否则用户在两个设置页之间对不上号。
  it('P5-6：浮窗命名必须点名「悬浮球」以示区分', async () => {
    const el = await render({})
    const text = el.textContent ?? ''
    expect(text).toContain('虚拟屏浮窗')
    expect(text, '必须点名开发者选项里的「悬浮球」是另一个东西').toContain('悬浮球')
    expect(text, '必须说清它显示的是什么').toContain('虚拟屏画面')
  })

  it('强制销毁：前两次点击只确认，第三次才调用壳桥', async () => {
    const forceDestroyVdisplay = vi.fn(() => JSON.stringify({ ok: true, code: 'vdisplay-destroyed' }))
    const el = await render({ forceDestroyVdisplay })
    const button = buttonByText(el, '强制销毁虚拟屏')
    await act(async () => { button.click() })
    expect(forceDestroyVdisplay).not.toHaveBeenCalled()
    expect(button.textContent).toContain('1/3')
    await act(async () => { button.click() })
    expect(forceDestroyVdisplay).not.toHaveBeenCalled()
    expect(button.textContent).toContain('2/3')
    await act(async () => { button.click() })
    expect(forceDestroyVdisplay).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('已强制销毁全部虚拟屏')
  })

  // P5-5：破坏性按钮必须与同页普通按钮**看得出区别**，且进入确认态后必须能退出。
  // 反证：把 className 的 danger 分支删掉、或删掉「取消」按钮，本组用例即判红。
  it('P5-5：确认态必须带危险样式，未进入确认态不得带', async () => {
    const el = await render({ forceDestroyVdisplay: () => JSON.stringify({ ok: true }) })
    const button = buttonByText(el, '强制销毁虚拟屏')
    expect(button.className, '未确认时是普通按钮').not.toContain('dsh-dev-danger')
    expect(button.getAttribute('data-armed')).toBe('false')
    await act(async () => { button.click() })
    expect(button.className, '进入确认态必须换成危险样式').toContain('dsh-dev-danger')
    expect(button.getAttribute('data-armed')).toBe('true')
    expect(button.getAttribute('data-stage')).toBe('1')
  })

  it('P5-5：确认态必须给取消途径，取消后不得调用壳桥', async () => {
    const forceDestroyVdisplay = vi.fn(() => JSON.stringify({ ok: true }))
    const el = await render({ forceDestroyVdisplay })
    const button = buttonByText(el, '强制销毁虚拟屏')
    await act(async () => { button.click() })
    const cancel = buttonByText(el, '取消')
    await act(async () => { cancel.click() })
    expect(forceDestroyVdisplay, '取消后一次都不该调用').not.toHaveBeenCalled()
    expect(button.className, '取消后回到普通样式').not.toContain('dsh-dev-danger')
    expect(button.textContent).toBe('强制销毁虚拟屏')
    // 取消是真的撤臂：再点一下只回到 1/3，而不是直接执行。
    await act(async () => { button.click() })
    expect(forceDestroyVdisplay).not.toHaveBeenCalled()
    expect(button.textContent).toContain('1/3')
  })

  // ── Shizuku 区块：状态源（0.14.1 缺陷本体）────────────────────

  it('Shizuku 状态读的是 shizukuStatus()，不是 vdisplayStatus()', async () => {
    const shizukuStatus = vi.fn(() => shizukuJson())
    const vdisplayStatus = vi.fn(() => JSON.stringify({
      ok: true, state: 'active', code: 'vdisplay-active', guidance: '虚拟屏幕 1 已激活（Android displayId=1）。', displayId: 1,
    }))
    const el = await render({ shizukuStatus, vdisplayStatus })
    expect(shizukuStatus).toHaveBeenCalled()
    expect(el.textContent).toContain('通道就绪')
    // 虚拟屏状态归页头那枚胶囊（data-state 是状态源），Shizuku 行不得出现虚拟屏的状态码。
    const chip = el.querySelector('.dsh-screen-control-state') as HTMLElement
    expect(chip.dataset.state).toBe('active')
    expect(chip.textContent).toBe('已激活')
    expect(detailLine(el, 'Shizuku 特权通道'), 'Shizuku 行不得出现虚拟屏的状态码').not.toContain('vdisplay-active')
    // displayId 是诊断信息：进 data 属性，不再由页面自己拼一行「Android displayId = N」上屏
    // （0.14.1 UI 审查：内部标识不上用户面）。壳侧 guidance 里自带的 displayId 属另一处文案，
    // 未在本次改动范围内。
    expect((el.querySelector('.dsh-screen-control-card') as HTMLElement).dataset.displayId).toBe('1')
    expect(el.textContent).not.toContain('Android displayId =')
  })

  it('虚拟屏 guidance 与 Shizuku guidance 相同时只显示一次（设备实测到过逐字重复）', async () => {
    const same = '未检测到 Shizuku；虚拟屏需要用户安装、启动并授权 Shizuku。'
    const el = await render({
      shizukuStatus: () => shizukuJson({ installed: false, running: false, granted: false, bound: false, guidance: same }),
      vdisplayStatus: () => JSON.stringify({ ok: false, state: 'blocked', code: 'shizuku-absent', guidance: same }),
    })
    const hits = el.textContent!.split(same).length - 1
    expect(hits, '同一句话不得在页面上出现两次').toBe(1)
  })

  it('反证：只提供 vdisplayStatus 时 Shizuku 区报「状态不可读」，不冒充未安装/就绪', async () => {
    const vdisplayStatus = vi.fn(() => JSON.stringify({
      ok: true, state: 'ready', code: 'vdisplay-ready', guidance: 'Shizuku 已授权且 shell UserService 已就绪；可创建虚拟屏幕 1。',
    }))
    const el = await render({ vdisplayStatus })
    expect(detailLine(el, 'Shizuku 特权通道')).toContain('状态不可读')
    expect(el.textContent).not.toContain('通道就绪')
    expect(buttonByText(el, '打开 Shizuku').disabled).toBe(true)
  })

  // ── Shizuku 区块：两个入口（用户定例：左下载右跳转，未装不可跳）──

  it('未安装时「打开 Shizuku」不可点；已安装时可点并拉起 Shizuku', async () => {
    const absent = await render({
      shizukuStatus: () => shizukuJson({ installed: false, running: false, granted: false, bound: false, code: 'shizuku-absent' }),
    })
    expect(absent.textContent).toContain('未安装')
    expect(buttonByText(absent, '打开 Shizuku').disabled).toBe(true)
    await unmount()

    const openShizukuManager = vi.fn(() => JSON.stringify({ ok: true }))
    const installed = await render({
      shizukuStatus: () => shizukuJson({ running: false, granted: false, bound: false, code: 'shizuku-not-running' }),
      openShizukuManager,
    })
    const jump = buttonByText(installed, '打开 Shizuku')
    expect(jump.disabled).toBe(false)
    await act(async () => { jump.click() })
    expect(openShizukuManager).toHaveBeenCalledTimes(1)
    expect(installed.textContent).toContain('已打开 Shizuku')
  })

  it('「下载 Shizuku」走外链通道 key=shizuku-download（两入口共用一条通道）', async () => {
    const openExternalLink = vi.fn(() => JSON.stringify({ ok: true }))
    const el = await render({ shizukuStatus: () => shizukuJson(), openExternalLink })
    await act(async () => { buttonByText(el, '下载 Shizuku').click() })
    expect(openExternalLink).toHaveBeenCalledWith('shizuku-download')
    expect(el.textContent).toContain('已打开 Shizuku 发布页')
  })

  // ── Shizuku 区块：重置链接（0.14.2 P1，用户现场「重启 App 也不行」）──────────

  it('「重置链接」与「刷新状态」同一行，并且真的调壳桥 resetShizukuConnection', async () => {
    const resetShizukuConnection = vi.fn(() => shizukuJson({ bound: false, binding: false, code: 'shizuku-user-service-reset' }))
    const el = await render({ shizukuStatus: () => shizukuJson(), resetShizukuConnection })
    const reset = buttonByText(el, '重置链接')
    const refresh = buttonByText(el, '刷新状态')
    // 同一行：两者父节点相同（「与刷新状态并列，都是非破坏性」）。
    expect(reset.parentElement).toBe(refresh.parentElement)
    await act(async () => { reset.click() })
    expect(resetShizukuConnection).toHaveBeenCalledTimes(1)
    // 即时回执必须说清「做了什么 + 现在什么态 + 谁来收敛」（三态诚实，不过度承诺）。
    expect(el.textContent).toContain('已重置 Shizuku 连接')
    expect(el.textContent).toContain('正在重新建立通道')
    expect(el.textContent).toContain('每 2 秒自动重扫')
  })

  it('重置成功立即回读一次状态（不靠等下一拍轮询）', async () => {
    const resetShizukuConnection = vi.fn(() => shizukuJson({ bound: false, code: 'shizuku-user-service-reset' }))
    const shizukuStatus = vi.fn(() => shizukuJson())
    const el = await render({ shizukuStatus, resetShizukuConnection })
    const before = shizukuStatus.mock.calls.length
    await act(async () => { buttonByText(el, '重置链接').click() })
    expect(shizukuStatus.mock.calls.length).toBeGreaterThan(before)
  })

  it('重置失败如实报原因与下一步，不静默也不把机器码印进正文（P3-1/P3-6）', async () => {
    const resetShizukuConnection = vi.fn(() => JSON.stringify({ ok: false, reason: 'not-installed' }))
    const el = await render({ shizukuStatus: () => shizukuJson(), resetShizukuConnection })
    await act(async () => { buttonByText(el, '重置链接').click() })
    expect(el.textContent).toContain('重置 Shizuku 连接失败')
    expect(el.textContent).toContain('下载 Shizuku')
    expect(el.textContent).not.toContain('not-installed')
  })

  it('反证：壳桥抛错时必须给人话，不得冒泡也不得静默', async () => {
    const resetShizukuConnection = vi.fn(() => { throw new Error('bridge down') })
    const el = await render({ shizukuStatus: () => shizukuJson(), resetShizukuConnection })
    await act(async () => { buttonByText(el, '重置链接').click() })
    // 抛错 => raw 为 undefined => settleLinkCall 走失败支（原因未登记 -> 兜底人话）。
    expect(el.textContent).toContain('重置 Shizuku 连接失败')
  })

  it('反证：旧壳没有 resetShizukuConnection 时按钮必须在场且点了给人话（不得点了没反应）', async () => {
    const el = await render({ shizukuStatus: () => shizukuJson() })
    const reset = buttonByText(el, '重置链接')
    await act(async () => { reset.click() })
    expect(el.textContent).toContain('重置 Shizuku 连接失败')
  })

  it('反证：重置不得新开定时器（新增常驻轮询与 T1 的 CPU 前科同族）', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      resetShizukuConnection: vi.fn(() => shizukuJson({ bound: false })),
    })
    const baselineIntervals = setIntervalSpy.mock.calls.length
    const baselineTimeouts = setTimeoutSpy.mock.calls.length
    await act(async () => { buttonByText(el, '重置链接').click() })
    expect(setIntervalSpy.mock.calls.length, '重置不得新增常驻轮询').toBe(baselineIntervals)
    expect(setTimeoutSpy.mock.calls.length, '重置不得新增定时器').toBe(baselineTimeouts)
  })

  it('反证：重置成功也不能写成「一定能修好」这类过度承诺', async () => {
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      resetShizukuConnection: vi.fn(() => shizukuJson({ bound: false })),
    })
    await act(async () => { buttonByText(el, '重置链接').click() })
    const text = el.textContent ?? ''
    for (const overPromise of ['一定能', '必定', '保证修好', '一定修好']) {
      expect(text, '不得出现过度承诺词: ' + overPromise).not.toContain(overPromise)
    }
  })
  it('「点击查看教程」是外链 key=shizuku-tutorial，且样式为蓝字下划线', async () => {
    const openExternalLink = vi.fn(() => JSON.stringify({ ok: true }))
    const el = await render({ shizukuStatus: () => shizukuJson(), openExternalLink })
    const link = buttonByText(el, '点击查看教程')
    expect(link.className).toContain('dsh-dev-link')
    await act(async () => { link.click() })
    expect(openExternalLink).toHaveBeenCalledWith('shizuku-tutorial')
    expect(el.textContent).toContain('已用浏览器打开视频教程')
    // 样式契约：用户定例「标蓝 + 下划线」，CSS 在 dev-section.css.ts 里——断其在场。
    expect(DEV_SECTION_CSS).toMatch(/\.dsh-dev-link\s*\{[^}]*text-decoration:\s*underline/)
    expect(DEV_SECTION_CSS).toMatch(/\.dsh-dev-link\s*\{[^}]*color:\s*#4d6bfe/i)
    // 两个并列按钮必须等宽平分（用户定例：并列半行宽）。
    expect(DEV_SECTION_CSS).toMatch(/\.dsh-dev-split\s*>\s*\.dsh-dev-btn\s*\{[^}]*flex:\s*1 1 0/)
  })

  it('外链失败给人话与下一步，不把机器码抛给用户', async () => {
    const openExternalLink = vi.fn(() => JSON.stringify({ ok: false, reason: 'no-handler' }))
    const el = await render({ shizukuStatus: () => shizukuJson(), openExternalLink })
    await act(async () => { buttonByText(el, '下载 Shizuku').click() })
    expect(el.textContent).toContain('设备上没有能打开它的应用')
    expect(el.textContent, '机器码不得上屏').not.toContain('no-handler')
    expect(el.textContent).not.toContain('no-handler')
  })

  // ── 无障碍：受限设置解锁入口（0.14.1 把无调用点的能力接上）────

  it('Android 13+ 未开启且受限设置生效时，出现「解锁受限设置」并显示结果', async () => {
    const a11yStatus = vi.fn(() => JSON.stringify({
      enabled: false,
      label: 'DSH 设备控制',
      restrictedSettingsApplies: true,
      hint: '未开启：到 系统设置 → 无障碍 → 已下载的服务 里开启「DSH 设备控制」',
    }))
    const unlockRestrictedSettings = vi.fn(() => JSON.stringify({ ok: true, message: '已解锁受限设置（Shizuku 特权 shell）' }))
    const el = await render({ a11yStatus, unlockRestrictedSettings })
    expect(el.textContent).toContain('未开启（推荐开启）')
    expect(el.textContent).toContain('受限设置')
    const unlock = buttonByText(el, '解锁受限设置')
    await act(async () => { unlock.click() })
    expect(unlockRestrictedSettings).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('已解锁受限设置')
  })

  it('无障碍已开启时不显示解锁按钮（不给用户一个不必要的特权动作）', async () => {
    const a11yStatus = vi.fn(() => JSON.stringify({ enabled: true, restrictedSettingsApplies: true, hint: '无障碍服务已开启' }))
    const el = await render({ a11yStatus })
    expect(el.textContent).toContain('已开启（语义读取/点击/输入）')
    expect([...el.querySelectorAll('button')].some((item) => item.textContent === '解锁受限设置')).toBe(false)
  })

  it('无障碍状态读不到时如实报「状态不可读」，不冒充「未开启」', async () => {
    const el = await render({})
    const detail = detailLine(el, '无障碍通道')
    expect(detail).toContain('状态不可读')
    expect(detail).not.toContain('未开启')
  })
})

describe('手机控制纯函数（文案口径）', () => {
  const ready = {
    readable: true, installed: true, running: true, granted: true, bound: true, binding: false, guidance: '',
  }

  it('shizukuStateLabel 走真实推进顺序，各态互不相同', () => {
    expect(shizukuStateLabel({ ...ready, readable: false })).toBe('状态不可读')
    expect(shizukuStateLabel({ ...ready, installed: false })).toBe('未安装')
    expect(shizukuStateLabel({ ...ready, running: false })).toBe('已安装，Shizuku 未启动')
    expect(shizukuStateLabel({ ...ready, granted: false })).toBe('已启动，尚未授权')
    expect(shizukuStateLabel({ ...ready, bound: false, binding: true })).toBe('已授权，通道建立中')
    expect(shizukuStateLabel({ ...ready, bound: false, binding: false })).toBe('已授权，通道未建立')
    expect(shizukuStateLabel(ready)).toBe('通道就绪')
  })

  it('每一态都给出「下一步做什么」，没有只报状态的死句', () => {
    for (const state of [
      { ...ready, readable: false },
      { ...ready, installed: false },
      { ...ready, running: false },
      { ...ready, granted: false },
      { ...ready, bound: false },
      ready,
    ]) {
      expect(shizukuStepHint(state).length).toBeGreaterThan(8)
    }
  })

  it('失败原因一律经唯一真源翻成人话（P3-1）', () => {
    // 本文件原有的局部表 LINK_REASON_LABEL 已删除——断言改指向唯一真源，避免又长出第二张表。
    expect(describeCallReason('unknown-key')).toContain('没有在本版登记')
    expect(describeCallReason('not-installed')).toContain('下载 Shizuku')
  })

  it('未知原因不得原样带出机器码（旧断言把缺陷当契约，已按 P3-1 反向）', () => {
    const text = describeCallReason('something-new')
    expect(text).not.toContain('something-new')
    expect(text.length).toBeGreaterThan(8)
  })

  it('settleLinkCall / settleUnlockCall：只有 ok 才算成功，失败必带原因', () => {
    expect(settleLinkCall(JSON.stringify({ ok: true }), '成功', '失败')).toEqual({ ok: true, text: '成功' })
    const refused = settleLinkCall(JSON.stringify({ ok: false, reason: 'insecure-url' }), '成功', '打开失败')
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('https')
    // 桥缺席（undefined）不得当成成功——静默成功正是本轮在清的缺陷形态。
    expect(settleLinkCall(undefined, '成功', '打开失败').ok).toBe(false)
    expect(settleUnlockCall(JSON.stringify({ ok: true, message: '已解锁' }))).toEqual({ ok: true, text: '已解锁' })
    expect(settleUnlockCall(JSON.stringify({ ok: false, message: '解锁失败（权限不足）' })).text).toContain('权限不足')
  })
})

/** 壳侧 rootGrantState() 的样本（字段与 RootGrant.state 一致）。 */
function rootGrantJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    granted: false,
    consentValid: false,
    consentVersionCode: 0,
    currentVersionCode: 100,
    channelUid: 0,
    channelRoot: true,
    canToggle: true,
    rootGranted: true,
    rootState: 'granted',
    honesty: '本开关是策略门与知情同意门，不是技术沙箱。',
    ...over,
  })
}

/** 壳侧 rootAccessState() 的样本（字段与 RootAccess.state 一致）。 */
function rootAccessJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    suExists: true,
    suPath: '/system/bin/su',
    state: 'unknown',
    uid: -1,
    granted: false,
    requesting: false,
    manager: { package: 'me.weishu.kernelsu', label: 'KernelSU', installed: true },
    guidance: '尚未检测——点「检测 root 授权」会尝试取一次 root 身份（多数管理器不会自动弹授权框，需你在管理器里允许）。',
    ...over,
  })
}

describe('AI root 权限开关（issue #262 方案 A）', () => {
  const grantedInput = (el: HTMLElement) =>
    el.querySelector('input[aria-label="授权 AI 使用 root"]') as HTMLInputElement
  const consentInput = (el: HTMLElement) =>
    el.querySelector('input[aria-label="已阅读免责声明"]') as HTMLInputElement

  it('真未 root（通道读不到/非 shell）：开关置灰 + 红字文案逐字在场（用户指定文案）', async () => {
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson({ channelUid: -1, channelRoot: false, canToggle: false }),
    })
    expect(grantedInput(el).disabled).toBe(true)
    expect(consentInput(el).disabled).toBe(true)
    const red = el.querySelector('.dsh-dev-error[data-code="not-root-channel"]')
    expect(red, '红字必须在场').toBeTruthy()
    expect(red!.textContent).toBe(ROOT_GRANT_NOT_ROOT_TEXT)
    expect(ROOT_GRANT_NOT_ROOT_TEXT).toBe('无法在未 root 的设备上赋予该权限')
  })

  it('Shizuku 以 ADB 启动（uid 2000）：置灰 + 引导「以 root 启动」（不是未 root 红字）', async () => {
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson({ channelUid: 2000, channelRoot: false, canToggle: false }),
    })
    expect(grantedInput(el).disabled).toBe(true)
    const hint = el.querySelector('[data-code="shizuku-shell-identity"]')
    expect(hint, 'shell 身份引导必须在场').toBeTruthy()
    expect(hint!.textContent).toContain('以 root 启动')
    expect(el.querySelector('.dsh-dev-error[data-code="not-root-channel"]')).toBe(null)
  })

  it('root 通道 + 未确认：开关在场但不可开启（issue：未勾选时不可开启）', async () => {
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson({ consentValid: false }),
    })
    expect(grantedInput(el).disabled).toBe(true)
    expect(grantedInput(el).checked).toBe(false)
    expect(consentInput(el).disabled).toBe(false)
    expect(el.querySelector('.dsh-dev-error[data-code="not-root-channel"]')).toBe(null)
  })

  it('root 通道 + 已确认：开关可点，切换走桥并回读', async () => {
    const state = { granted: false, consent: true }
    const setRootGranted = vi.fn((on: boolean) => { state.granted = on })
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson({
        granted: state.granted,
        consentValid: state.consent,
      }),
      setRootGranted,
    })
    expect(grantedInput(el).disabled).toBe(false)
    // jsdom + React：checkbox 的 onChange 由 click 派发（change 只对 select 生效）。
    await act(async () => { grantedInput(el).click() })
    expect(setRootGranted).toHaveBeenCalledWith(true)
  })

  it('已授权态：开关显示为已开启', async () => {
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson({ granted: true, consentValid: true }),
    })
    expect(grantedInput(el).checked).toBe(true)
    expect(grantedInput(el).disabled).toBe(false)
  })

  it('勾选/取消「已阅读」走桥；取消即撤销（壳侧连带关开关）', async () => {
    const setRootConsent = vi.fn()
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson(),
      setRootConsent,
    })
    await act(async () => { consentInput(el).click() })
    expect(setRootConsent).toHaveBeenCalledWith(true)
  })

  // ── 2026-09-30 用户实测缺陷的回归钉（撤销同意显示「失败：原因未在本版登记」）──
  // 真因：壳侧 setConsent 回包缺 ok 字段 ⇒ settleLinkCall 判失败；拒收码又不在
  // CALL_REASON 表 ⇒ describeCallReason 落兜底。两条桩各自钉一面：
  it('结算只认 ok===true：壳侧回包缺 ok 时如实报失败（不假装成功）', () => {
    const parsed = JSON.parse(rootGrantJson({ consentValid: true, consentVersionCode: 100 })) as Record<string, unknown>
    delete parsed.ok
    const settled = settleLinkCall(JSON.stringify(parsed), '已撤销同意', '撤销同意失败')
    expect(settled.ok).toBe(false)
    expect(settled.text).toContain('撤销同意失败')
  })

  it('勾选/撤销的成功回执与拒收翻译都走真源（不再出现「未在本版登记」）', () => {
    // 成功形状（壳侧 setConsent 修后）：state + ok:true
    const ok = settleLinkCall(rootGrantJson({ ok: true, consentValid: true }), '已记录「已阅读」', '记录失败')
    expect(ok.ok).toBe(true)
    expect(ok.text).toBe('已记录「已阅读」')
    // 拒收形状（setRootGranted 未确认就开）：ok:false + reason=consent-required → 人话翻译
    const refused = settleLinkCall(
      rootGrantJson({ ok: false, reason: 'consent-required' }),
      '已开启', '开启 AI root 权限失败',
    )
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('免责声明')
    expect(refused.text).not.toContain('未在本版登记')
    // 非 root 通道拒收同理
    const notRoot = settleLinkCall(
      rootGrantJson({ ok: false, reason: 'not-root-channel', channelRoot: false }),
      '已开启', '开启 AI root 权限失败',
    )
    expect(notRoot.text).toContain('root 身份')
    expect(notRoot.text).not.toContain('未在本版登记')
  })

  it('免责声明链接点开走本地文档通道', async () => {
    const openRootDisclaimer = vi.fn(() => JSON.stringify({ ok: true }))
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson(),
      openRootDisclaimer,
    })
    const link = buttonByText(el, '《AI root 权限免责声明》')
    await act(async () => { link.click() })
    expect(openRootDisclaimer).toHaveBeenCalled()
  })

  it('状态不可读：开关置灰且不冒充任何状态（fail-closed 呈现）', async () => {
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      // 壳桥缺席 → readRootGrant 回落 ROOT_GRANT_UNREADABLE
    })
    expect(grantedInput(el).disabled).toBe(true)
    expect(el.textContent).toContain('状态不可读')
  })
})

describe('AI root 权限纯函数（文案与判据口径）', () => {
  const base = {
    readable: true, granted: false, consentValid: false, channelUid: 0, channelRoot: true,
    rootGranted: false, rootState: 'unknown', honesty: '',
  }

  it('rootGrantStateLabel 各态互不相同，顺序即判据顺序', () => {
    expect(rootGrantStateLabel({ ...base, readable: false })).toBe('状态不可读')
    expect(rootGrantStateLabel({ ...base, channelRoot: false })).toBe('通道不是 root，无法授权')
    expect(rootGrantStateLabel(base)).toBe('未授权')
    expect(rootGrantStateLabel({ ...base, granted: true })).toBe('已授权（AI 可用 root）')
  })

  it('canToggleRootGrant 只认通道身份：读不到或非 root 一律不可点', () => {
    expect(canToggleRootGrant(base)).toBe(true)
    expect(canToggleRootGrant({ ...base, readable: false })).toBe(false)
    expect(canToggleRootGrant({ ...base, channelRoot: false, channelUid: 2000 })).toBe(false)
  })

  // issue #262 对账补（2026-09-30）：非 root 通道要**按通道身份分流**引导——
  // uid 2000 = Shizuku 以 ADB 启动（设备可能已 root）⇒ 引导「在 Shizuku 内以 root 启动」；
  // 其它 = 真未 root ⇒ 用户指定红字（逐字）。
  it('rootGrantChannelHint 按通道身份分流（2000 → 引导重启为 root；其它 → 指定红字）', () => {
    expect(rootGrantChannelHint({ ...base, channelRoot: true }).kind).toBe('none')
    const shell = rootGrantChannelHint({ ...base, channelRoot: false, channelUid: 2000 })
    expect(shell.kind).toBe('shell-identity')
    expect(shell.text).toContain('以 root 启动')
    expect(shell.text).not.toContain(ROOT_GRANT_NOT_ROOT_TEXT)
    const notRoot = rootGrantChannelHint({ ...base, channelRoot: false, channelUid: -1 })
    expect(notRoot.kind).toBe('not-root')
    expect(notRoot.text).toBe(ROOT_GRANT_NOT_ROOT_TEXT)
    expect(rootGrantChannelHint({ ...base, readable: false, channelRoot: false }).kind).toBe('none')
  })
})

describe('应用级 Root 授权面（2026-09-30 主人定例）', () => {
  it('各态状态词与判据（含 no-su / requesting / denied / timeout）', () => {
    const base = {
      readable: true, suExists: true, state: 'unknown', uid: -1, granted: false,
      requesting: false, managerLabel: 'KernelSU', managerInstalled: true, guidance: '',
    }
    expect(rootAccessStateLabel({ ...base, readable: false })).toBe('状态不可读')
    expect(rootAccessStateLabel(base)).toBe('未检测')
    expect(rootAccessStateLabel({ ...base, state: 'granted', uid: 0, granted: true })).toBe('已授权（uid 0）')
    expect(rootAccessStateLabel({ ...base, state: 'requesting', requesting: true })).toContain('允许')
    expect(rootAccessStateLabel({ ...base, state: 'denied' })).toBe('已拒绝')
    expect(rootAccessStateLabel({ ...base, state: 'timeout' })).toBe('授权框未响应')
    expect(rootAccessStateLabel({ ...base, state: 'no-su', suExists: false })).toContain('su')
  })

  it('请求按钮判据：有 su 且无请求在飞才可点', () => {
    const base = {
      readable: true, suExists: true, state: 'unknown', uid: -1, granted: false,
      requesting: false, managerLabel: '', managerInstalled: true, guidance: '',
    }
    expect(canRequestRoot(base)).toBe(true)
    expect(canRequestRoot({ ...base, suExists: false })).toBe(false)
    expect(canRequestRoot({ ...base, requesting: true })).toBe(false)
    expect(canRequestRoot({ ...base, readable: false })).toBe(false)
  })

  it('页面渲染：授权行 + 三个入口在场，未检测时显示引导', async () => {
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson({ rootGranted: false, rootState: 'unknown' }),
      rootAccessState: () => rootAccessJson(),
    })
    expect(el.textContent).toContain('Root 授权（应用自身）')
    expect(el.textContent).toContain('未检测')
    expect(el.textContent).toContain('KernelSU')
    expect(buttonByText(el, '检测 root 授权')).toBeTruthy()
    expect(buttonByText(el, '修复文件属主')).toBeTruthy()
    // 2026-09-30 主人指正：**不做「打开 Root 管理器」入口**（各家管理器包名/入口不一，打开不保证成功）
    expect(queryButtonByText(el, '打开 Root 管理器')).toBeUndefined()
    expect(el.textContent).toContain('多数管理器不会自动弹授权框')
  })

  it('检测授权走桥；无 su 时按钮禁用', async () => {
    const requestRootAccess = vi.fn(() => JSON.stringify({ ok: true, code: 'request-started' }))
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson(),
      rootAccessState: () => rootAccessJson({ state: 'denied' }),
      requestRootAccess,
    })
    await act(async () => { buttonByText(el, '检测 root 授权').click() })
    expect(requestRootAccess).toHaveBeenCalled()

    const el2 = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson(),
      rootAccessState: () => rootAccessJson({
        state: 'no-su', suExists: false,
        manager: { package: '', label: '', installed: false },
      }),
    })
    expect(buttonByText(el2, '检测 root 授权').disabled).toBe(true)
    expect(el2.textContent).toContain('未检测到已知 Root 管理器')
    expect(el2.textContent).toContain('若你用的是别的管理器或 ROM 内置 su')
  })

  it('修复文件属主回执带真实计数（不谎报「已修复」）', async () => {
    const repairRootOwnership = vi.fn(() => JSON.stringify({
      ok: true, channelUid: 0, checked: 42, healed: 3,
    }))
    const el = await render({
      shizukuStatus: () => shizukuJson(),
      rootGrantState: () => rootGrantJson(),
      rootAccessState: () => rootAccessJson({ state: 'granted', granted: true, uid: 0 }),
      repairRootOwnership,
    })
    await act(async () => { buttonByText(el, '修复文件属主').click() })
    expect(repairRootOwnership).toHaveBeenCalled()
    expect(el.textContent).toContain('已检查 42 个顶层条目')
    expect(el.textContent).toContain('修复 3 个属主条目')
  })
})
