/**
 * 「手机控制」设置分区（0.14.0 用户定例：把手机控制单独开一个设置页）。
 *
 * 内容：Shizuku 特权通道（状态 + 下载/打开入口 + 视频教程）/ 开放屏幕范围 / 虚拟屏分辨率档位 /
 * 虚拟屏浮窗（退后台自动显示）/ 无障碍入口（含 Android 13+ 受限设置解锁）/ 强制销毁（连点三次确认）。
 *
 * 数据面纪律：全部经 window.androidBridge 只读回读 + 写后回读；桥不可用/抛错一律**如实报不可读**，
 * 不用安全默认值冒充事实（0.14.1 UI 审查：桥缺席时页面显示「未开启 / 0.75 / 仅虚拟屏幕」这些
 * 看起来像事实的值，改完还会自己弹回）。
 *
 * 0.14.1 Shizuku 面重做（用户 2026-09-22 定例，UI 审查 P0）：
 *  - **状态源换掉**：旧实现读的是 `vdisplayStatus()`——标题写「Shizuku 特权通道」，内容却是虚拟屏
 *    状态码与 displayId（只有虚拟屏 blocked 时才顺带透出 Shizuku 的 guidance）。现在读 `shizukuStatus()`，
 *    虚拟屏状态另起一行、名字也改对。
 *  - **两个入口**：左「下载 Shizuku」右「打开 Shizuku」，并列半行宽；**未安装时「打开 Shizuku」不可点**
 *    （旧态是「模型让用户去设置页安装、启动并授权 Shizuku」，而那一页一个入口都没有——死循环）。
 *  - **两个外链共用一条壳侧通道**：下载页与视频教程都只是跳出去，页面只传 key，URL 表在壳侧
 *    （`ExternalLinks`），页面拿不到「打开任意地址」的能力。
 *  - **授权只能由用户在 Shizuku 内完成**（被提权方不得自改授权），壳侧只负责把人送到界面；
 *    回到本页每 2 秒轮询一次状态，授权完成会自动收敛，不需要用户手动点刷新。
 */
import { useCallback, useEffect, useState } from 'react'
import { useShellState } from '../mobile/use-shell-state.ts'
import { describeCallReason } from '../user-copy.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../android-bridge.ts'

type ScreenScope = 'virtual-only' | 'real-only' | 'all'
const SCOPES: readonly ScreenScope[] = ['virtual-only', 'real-only', 'all']
const SCALE_OPTIONS: readonly number[] = [0.5, 0.75, 1]

/** 外链 key（与壳侧 `ExternalLinks` 的登记名逐字一致）。 */
const LINK_DOWNLOAD = 'shizuku-download'
const LINK_TUTORIAL = 'shizuku-tutorial'

type VdisplayState = 'disabled' | 'blocked' | 'ready' | 'active'
interface VdisplayStatus {
  state: VdisplayState
  code: string
  guidance: string
  displayId?: number
}
interface A11yStatus {
  /** 状态是否真的读到了（false = 桥缺席/解析失败，界面不得冒充「未开启」）。 */
  readable: boolean
  enabled: boolean
  hint: string
  restrictedSettingsApplies: boolean
}
interface ShizukuStatus {
  /** 状态是否真的读到了（false = 桥缺席/解析失败）。 */
  readable: boolean
  installed: boolean
  running: boolean
  granted: boolean
  bound: boolean
  binding: boolean
  guidance: string
}

/**
 * issue #262「AI root 权限」开关状态（壳侧 [RootGrant.state] 的同构面）。
 *
 * 判据要点：`channelRoot` 是**通道身份**（Shizuku 服务端 uid==0），不是「设备是否 root」——
 * 已 root 但 Shizuku 以 ADB 启动的设备此值为 false，开关必须置灰（假绿是 issue 点名的缺陷形态）。
 */
interface RootGrantStatus {
  /** 状态是否真的读到了（false = 桥缺席/解析失败，界面不得冒充「未授权」以外的任何状态）。 */
  readable: boolean
  granted: boolean
  /** 「已阅读」同意是否对**当前版本**有效（与 versionCode 绑定，升级后需重新确认）。 */
  consentValid: boolean
  /** 通道身份 uid（读不到 = -1）。 */
  channelUid: number
  /** 通道身份是否 root（== 开关是否具备开启资格）。 */
  channelRoot: boolean
  /** 应用级 root 授权（Root 管理器）是否已获得——开关放行的第三道门（2026-09-30 主人定例）。 */
  rootGranted: boolean
  /** 应用级 root 授权状态词（unknown/requesting/granted/denied/timeout/no-su）。 */
  rootState: string
  /** 壳侧诚实性说明（策略门 ≠ 技术沙箱）。 */
  honesty: string
}

/**
 * 应用级 root 授权面（壳侧 [RootAccess.state] 的同构面，2026-09-30 主人定例）。
 *
 * 「这个开关应该调用一下 root 弹窗，并且检测 root 是否授权，如果没有，请写好引导去
 * Root 管理器，授予 root」——本面就是那条流程的读面：状态 + 管理器 + 引导语。
 */
interface RootAccessStatus {
  readable: boolean
  /** 本机是否存在可执行的 su（未 root / 未装管理器时为 false）。 */
  suExists: boolean
  /** unknown | requesting | granted | denied | timeout | no-su */
  state: string
  uid: number
  granted: boolean
  /** 请求在飞（弹窗已弹出、等用户在管理器上点「允许」）。 */
  requesting: boolean
  /** Root 管理器（KernelSU / Magisk / APatch）。 */
  managerLabel: string
  managerInstalled: boolean
  /** 壳侧引导语（每态都能说清「下一步做什么」）。 */
  guidance: string
}

const STATUS_LABEL: Record<VdisplayState, string> = {
  disabled: '已关闭',
  blocked: '需要准备',
  ready: '可创建',
  active: '已激活',
}

const A11Y_UNREADABLE: A11yStatus = {
  readable: false,
  enabled: false,
  hint: '',
  restrictedSettingsApplies: false,
}

const SHIZUKU_UNREADABLE: ShizukuStatus = {
  readable: false,
  installed: false,
  running: false,
  granted: false,
  bound: false,
  binding: false,
  guidance: '',
}

const ROOT_GRANT_UNREADABLE: RootGrantStatus = {
  readable: false,
  granted: false,
  consentValid: false,
  channelUid: -1,
  channelRoot: false,
  rootGranted: false,
  rootState: 'unknown',
  honesty: '',
}

const ROOT_ACCESS_UNREADABLE: RootAccessStatus = {
  readable: false,
  suExists: false,
  state: 'unknown',
  uid: -1,
  granted: false,
  requesting: false,
  managerLabel: '',
  managerInstalled: false,
  guidance: '',
}

/** issue #262 用户指定文案（**逐字保留**，未 root 通道下的红字）。 */
export const ROOT_GRANT_NOT_ROOT_TEXT = '无法在未 root 的设备上赋予该权限'

/**
 * 外链/拉起失败原因的中文口径在**唯一真源** `../user-copy.ts`（0.14.1 批 3 / P3-1）。
 *
 * 本文件此前自带一张 `LINK_REASON_LABEL` 局部表——与本页其它面、以及壳侧各自的局部表并存，
 * 于是同一个码在不同界面说法不同。局部表已删除：翻译只此一处，码本身只进 `data-*`。
 */

/**
 * Shizuku 通道状态 → 中文状态词。
 *
 * 五态与壳侧 `ShizukuTransport.status()` 的字段一一对应；顺序即真实推进顺序
 * （未安装 → 未启动 → 未授权 → 未绑定 → 就绪），用户据此知道自己在第几步。
 */
export function shizukuStateLabel(status: ShizukuStatus): string {
  if (!status.readable) return '状态不可读'
  if (!status.installed) return '未安装'
  if (!status.running) return '已安装，Shizuku 未启动'
  if (!status.granted) return '已启动，尚未授权'
  if (!status.bound) return status.binding ? '已授权，通道建立中' : '已授权，通道未建立'
  return '通道就绪'
}

/** 壳侧 guidance 缺失时的兜底说明（每态都能说清「下一步做什么」）。 */
export function shizukuStepHint(status: ShizukuStatus): string {
  if (!status.readable) return '读不到 Shizuku 状态：壳侧桥未装配或解析失败。'
  if (!status.installed) return '点「下载 Shizuku」到发布页装好，再回来点「打开 Shizuku」。'
  if (!status.running) return '点「打开 Shizuku」，在应用内按提示用无线调试启动它（重启设备后需要重做一次）。'
  if (!status.granted) return '点「打开 Shizuku」，在里面允许本应用使用 Shizuku——授权只能由你亲手完成。'
  if (!status.bound) return '状态每 2 秒自动刷新，稍等即可；一直停在这里可以点「打开 Shizuku」重进一次。'
  return '特权通道已就绪，虚拟屏与特权 shell 可以用了。'
}

interface BridgeAnswer {
  ok?: boolean
  reason?: string
  message?: string
}

function parseAnswer(raw: string | undefined): BridgeAnswer | undefined {
  if (raw === undefined || raw === '') return undefined
  try {
    return JSON.parse(raw) as BridgeAnswer
  } catch {
    return undefined
  }
}

/** 外链/拉起类调用统一结算：成功给人话，失败给「原因 + 下一步」，绝不静默。 */
export function settleLinkCall(
  raw: string | undefined,
  okText: string,
  failLead: string,
): { ok: boolean; text: string } {
  const answer = parseAnswer(raw)
  if (answer?.ok === true) return { ok: true, text: okText }
  return { ok: false, text: failLead + '：' + describeCallReason(answer?.reason) }
}

/** 受限设置解锁结算（壳侧回 `{ok, message}`，message 已是人话）。 */
export function settleUnlockCall(raw: string | undefined): { ok: boolean; text: string } {
  const answer = parseAnswer(raw)
  if (answer?.ok === true) {
    return { ok: true, text: answer.message ?? '已解锁受限设置，现在可以回系统页开启无障碍服务。' }
  }
  return {
    ok: false,
    text: '解锁失败：' + (answer?.message ?? describeCallReason(answer?.reason)),
  }
}

function readScope(): ScreenScope {
  try {
    const raw = window.androidBridge?.getScreenScope?.()
    if (SCOPES.includes(raw as ScreenScope)) return raw as ScreenScope
  } catch {
    /* old/desktop shells retain the safe default */
  }
  return 'virtual-only'
}

function readVdisplay(): VdisplayStatus {
  try {
    const raw = window.androidBridge?.vdisplayStatus?.()
    const parsed = raw ? JSON.parse(raw) as Partial<VdisplayStatus> : undefined
    const state = parsed?.state
    return {
      state: state === 'disabled' || state === 'blocked' || state === 'ready' || state === 'active' ? state : 'blocked',
      code: typeof parsed?.code === 'string' ? parsed.code : 'vdisplay-status-unavailable',
      guidance: typeof parsed?.guidance === 'string' ? parsed.guidance : '虚拟屏状态暂不可读；不会把虚拟屏请求回退到真实屏幕。',
      ...(typeof parsed?.displayId === 'number' ? { displayId: parsed.displayId } : {}),
    }
  } catch {
    // P3-6：旧文案是「虚拟屏状态读取失败（fail-closed）。」——`fail-closed` 是内部策略词，
    // 对用户没有意义；这里说清「读不到 + 不会做什么 + 能做什么」，策略词只留在 code 里。
    return { state: 'blocked', code: 'vdisplay-status-unavailable', guidance: '读不到虚拟屏状态：应用内桥未接好或解析失败。重新打开应用再试；读不到时不会把虚拟屏请求回退到真实屏幕。' }
  }
}

function readScale(): number {
  try {
    const value = window.androidBridge?.getVdisplayScale?.()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  } catch {
    /* fall through to the default tier */
  }
  return 0.75
}

function readFloat(): boolean {
  try {
    return window.androidBridge?.getVdisplayFloatEnabled?.() ?? true
  } catch {
    return true
  }
}

/**
 * Shizuku 通道状态（**唯一**「装没装」的事实来源）。
 *
 * `installed` 字段决定「打开 Shizuku」是否可点：拿不到状态时按**未安装**处理（复用
 * [SHIZUKU_UNREADABLE]），于是按钮不可点而不是点了没反应——死路形态在本页被结构性排除。
 */
export function readShizuku(): ShizukuStatus {
  try {
    const raw = window.androidBridge?.shizukuStatus?.()
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    if (parsed === undefined || typeof parsed.installed !== 'boolean') return SHIZUKU_UNREADABLE
    return {
      readable: true,
      installed: parsed.installed === true,
      running: parsed.running === true,
      granted: parsed.granted === true,
      bound: parsed.bound === true,
      binding: parsed.binding === true,
      guidance: typeof parsed.guidance === 'string' ? parsed.guidance : '',
    }
  } catch {
    return SHIZUKU_UNREADABLE
  }
}

/**
 * issue #262「AI root 权限」读面（壳侧 [RootGrant.state] 的桥接）。
 *
 * 读不到一律回落 [ROOT_GRANT_UNREADABLE]（`readable:false`）：界面据此显示「状态不可读」
 * 而不是冒充「未授权」或「可开启」——与 [readShizuku] 同纪律。
 */
export function readRootGrant(): RootGrantStatus {
  try {
    const raw = window.androidBridge?.rootGrantState?.()
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    if (parsed === undefined || typeof parsed.granted !== 'boolean') return ROOT_GRANT_UNREADABLE
    return {
      readable: true,
      granted: parsed.granted === true,
      consentValid: parsed.consentValid === true,
      channelUid: typeof parsed.channelUid === 'number' ? parsed.channelUid : -1,
      channelRoot: parsed.channelRoot === true,
      rootGranted: parsed.rootGranted === true,
      rootState: typeof parsed.rootState === 'string' ? parsed.rootState : 'unknown',
      honesty: typeof parsed.honesty === 'string' ? parsed.honesty : '',
    }
  } catch {
    return ROOT_GRANT_UNREADABLE
  }
}

/**
 * 应用级 root 授权读面（壳侧 [RootAccess.state] 的桥接）。
 *
 * 读不到一律回落 [ROOT_ACCESS_UNREADABLE]（`readable:false`）：界面据此显示「状态不可读」
 * 而不是冒充「未授权」或「已授权」——与 [readRootGrant] 同纪律。
 */
export function readRootAccess(): RootAccessStatus {
  try {
    const raw = window.androidBridge?.rootAccessState?.()
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    if (parsed === undefined || typeof parsed.state !== 'string') return ROOT_ACCESS_UNREADABLE
    const manager = (parsed.manager ?? {}) as Record<string, unknown>
    return {
      readable: true,
      suExists: parsed.suExists === true,
      state: parsed.state,
      uid: typeof parsed.uid === 'number' ? parsed.uid : -1,
      granted: parsed.granted === true,
      requesting: parsed.requesting === true,
      managerLabel: typeof manager.label === 'string' ? manager.label : '',
      managerInstalled: manager.installed === true,
      guidance: typeof parsed.guidance === 'string' ? parsed.guidance : '',
    }
  } catch {
    return ROOT_ACCESS_UNREADABLE
  }
}

/** 应用级 root 授权状态 → 中文状态词（与壳侧 RootAccess 的状态常量一一对应）。 */
export function rootAccessStateLabel(status: RootAccessStatus): string {
  if (!status.readable) return '状态不可读'
  switch (status.state) {
    case 'granted': return '已授权（uid 0）'
    case 'requesting': return '请求中…请在手机上点「允许」'
    case 'denied': return '已拒绝'
    case 'timeout': return '授权框未响应'
    case 'no-su': return '本机没有可用的 su'
    default: return '未检测'
  }
}

/** 请求按钮可否点：有 su 且没有请求在飞。 */
export function canRequestRoot(status: RootAccessStatus): boolean {
  return status.readable && status.suExists && !status.requesting
}

/**
 * 开关状态 → 中文状态词（与壳侧字段一一对应，供测试直接断言）。
 *
 * 顺序即真实判据顺序：读不到 → 通道非 root（置灰）→ 未授权 → 已授权。
 */
export function rootGrantStateLabel(status: RootGrantStatus): string {
  if (!status.readable) return '状态不可读'
  if (!status.channelRoot) return '通道不是 root，无法授权'
  if (!status.granted) return '未授权'
  return '已授权（AI 可用 root）'
}

/** 开关可否点击：只有**通道身份确为 root**才可点（读不到/非 root 一律不可点）。 */
export function canToggleRootGrant(status: RootGrantStatus): boolean {
  return status.readable && status.channelRoot
}

/** Shizuku 以 ADB（shell）身份启动时的通道 uid（issue #262 点名的分流判据）。 */
export const SHIZUKU_SHELL_UID = 2000

/**
 * 非 root 通道下的引导语（issue #262 要求**按通道身份分流**，2026-09-30 对账补）：
 *  - 通道 uid == 2000（Shizuku 以 ADB 启动，设备**可能已 root**）⇒ 引导「在 Shizuku 内以 root 启动」；
 *  - 其它（无通道 / 未 root）⇒ 用户指定红字「无法在未 root 的设备上赋予该权限」（逐字）。
 *
 * 两者都置灰开关；区别只在**用户下一步该做什么**——把已 root 的设备误报成「未 root」会让人
 * 去折腾设备 root，而真正要做的是重启 Shizuku 的启动方式。
 */
export function rootGrantChannelHint(status: RootGrantStatus): { text: string; kind: 'shell-identity' | 'not-root' | 'none' } {
  if (!status.readable) return { text: '', kind: 'none' }
  if (status.channelRoot) return { text: '', kind: 'none' }
  if (status.channelUid === SHIZUKU_SHELL_UID) {
    return {
      text: 'Shizuku 当前以 shell（uid 2000）身份运行——请在 Shizuku 内以 root 启动它，再回到本页开启。',
      kind: 'shell-identity',
    }
  }
  return { text: ROOT_GRANT_NOT_ROOT_TEXT, kind: 'not-root' }
}

/** 无障碍通道状态；读不到时如实报不可读，不冒充「未开启」（0.14.1 UI 审查 P1）。 */
export function readA11y(): A11yStatus {
  try {
    const raw = window.androidBridge?.a11yStatus?.()
    if (typeof raw === 'string' && raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return {
        readable: true,
        enabled: parsed.enabled === true,
        hint: typeof parsed.hint === 'string' ? parsed.hint : '',
        restrictedSettingsApplies: parsed.restrictedSettingsApplies === true,
      }
    }
  } catch {
    /* bridge absent: report unavailable rather than guessing */
  }
  return A11Y_UNREADABLE
}

/**
 * 渲染「手机控制」设置分区。
 * @returns 分区元素树。
 */
export function PhoneControlSection(_props: PropsRuntime<'settings.section'>) {
  const [scope, refreshScope] = useShellState<ScreenScope>(readScope)
  const [vdisplay, refreshVdisplay] = useShellState<VdisplayStatus>(readVdisplay, { pollMs: 2_000 })
  const [shizuku, refreshShizuku] = useShellState<ShizukuStatus>(readShizuku, { pollMs: 2_000 })
  const [scale, refreshScale] = useShellState<number>(readScale)
  const [floatOn, refreshFloat] = useShellState<boolean>(readFloat)
  const [a11y, refreshA11y] = useShellState<A11yStatus>(readA11y, { pollMs: 3_000 })
  // issue #262：root 授权面（2s 轮询与 Shizuku 面同拍——开关资格取决于通道身份，二者必须同源同拍）。
  const [rootGrant, refreshRootGrant] = useShellState<RootGrantStatus>(readRootGrant, { pollMs: 2_000 })
  // 2026-09-30 主人定例：应用级 root 授权面（2s 同拍——开关资格与授权状态必须同源同拍）。
  const [rootAccess, refreshRootAccess] = useShellState<RootAccessStatus>(readRootAccess, { pollMs: 2_000 })
  /** 用户尝试开启开关但 root 未授权：壳侧已弹授权框，授权一到就自动续开（见下方 effect）。 */
  const [pendingEnable, setPendingEnable] = useState(false)
  const [rootMsg, setRootMsg] = useState<string | null>(null)
  const [rootOk, setRootOk] = useState<boolean | null>(null)
  const [confirmStage, setConfirmStage] = useState(0)
  // 失败回执带 `code`：码只进 `data-code`（可 grep / 可截图给维护方），不进正文（P3-1/P3-6）。
  const [forceMsg, setForceMsg] = useState<{ ok: boolean; text: string; code?: string } | null>(null)
  const [shizukuMsg, setShizukuMsg] = useState<string | null>(null)
  const [shizukuOk, setShizukuOk] = useState<boolean | null>(null)
  const [a11yMsg, setA11yMsg] = useState<string | null>(null)
  const [a11yOk, setA11yOk] = useState<boolean | null>(null)

  // 三连点确认：4 秒内没有下一步就复位，避免「隔很久点一下」误触。
  useEffect(() => {
    if (confirmStage === 0) return undefined
    const timer = window.setTimeout(() => setConfirmStage(0), 4_000)
    return () => window.clearTimeout(timer)
  }, [confirmStage])

  const setScope = useCallback((next: ScreenScope) => {
    try { window.androidBridge?.setScreenScope?.(next) } catch { /* readback keeps the truth */ }
    refreshScope()
  }, [refreshScope])

  const setScale = useCallback((next: number) => {
    try { window.androidBridge?.setVdisplayScale?.(next) } catch { /* readback keeps the truth */ }
    refreshScale()
  }, [refreshScale])

  const setFloat = useCallback((enable: boolean) => {
    try { window.androidBridge?.setVdisplayFloatEnabled?.(enable) } catch { /* readback keeps the truth */ }
    refreshFloat()
  }, [refreshFloat])

  const openA11y = useCallback(() => {
    try { window.androidBridge?.openA11ySettings?.() } catch { /* bridge absent on desktop */ }
  }, [])

  const unlockA11y = useCallback(() => {
    let raw: string | undefined
    try { raw = window.androidBridge?.unlockRestrictedSettings?.() } catch { raw = undefined }
    const settled = settleUnlockCall(raw)
    setA11yOk(settled.ok)
    setA11yMsg(settled.text)
    refreshA11y()
  }, [refreshA11y])

  /** 外链与拉起的共同收口（两个入口共用一条通道，结算也共用）。 */
  const runShizukuAction = useCallback((
    call: (() => string) | undefined,
    okText: string,
    failLead: string,
  ) => {
    let raw: string | undefined
    try { raw = call?.() } catch { raw = undefined }
    const settled = settleLinkCall(raw, okText, failLead)
    setShizukuOk(settled.ok)
    setShizukuMsg(settled.text)
    refreshShizuku()
  }, [refreshShizuku])

  const downloadShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.openExternalLink
        ? () => window.androidBridge!.openExternalLink!(LINK_DOWNLOAD)
        : undefined,
      '已打开 Shizuku 发布页——下载 release 版 APK 装好后回到这里。',
      '打开下载页失败',
    )
  }, [runShizukuAction])

  const tutorialShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.openExternalLink
        ? () => window.androidBridge!.openExternalLink!(LINK_TUTORIAL)
        : undefined,
      '已用浏览器打开视频教程。',
      '打开教程失败',
    )
  }, [runShizukuAction])

  const openShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.openShizukuManager
        ? () => window.androidBridge!.openShizukuManager!()
        : undefined,
      '已打开 Shizuku——在那里启动并授权后，回到本页状态会自动刷新。',
      '打开 Shizuku 失败',
    )
  }, [runShizukuAction])

  /**
   * 2026-09-30：**显式请求 Shizuku 授权**。
   *
   * 实测缺陷：授权请求此前只在 `ensureBound` 的后台路径自动发起，而 Shizuku 的
   * `requestPermission` 需要前台 Activity 才能把对话框落到用户眼前 ⇒ 静默失败，
   * 管理器「应用管理」列表里根本没有本应用、状态恒 denied，用户没有任何可点的授权入口。
   * 本入口在 UI 线程发起请求，对话框随即出现。
   */
  const requestShizukuPermission = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.requestShizukuPermission
        ? () => window.androidBridge!.requestShizukuPermission!()
        : undefined,
      '已发起 Shizuku 授权请求——请在弹窗上点「允许」（本页每 2 秒自动刷新）。',
      '请求 Shizuku 授权失败',
    )
  }, [runShizukuAction])

  /**
   * 「重置链接」：强制移除 Shizuku 侧 UserService 并清空绑定态。
   *
   * 与「刷新状态」同一行（都是非破坏性只读/自愈动作），结算沿用既有 [runShizukuAction] →
   * [settleLinkCall]，**不新造结算口径**：壳侧回 {ok, code/guidance}，ok=false 走失败支并把人话原因说清。
   *
   * 「持续扫描链接」= 既有的 2 秒轮询（[runShizukuAction] 内部已调 refreshShizuku 立刻回读一次，
   * 之后交给 useShellState 的 2s 轮询自然收敛）。**不新开定时器**：新增常驻轮询=新增常驻 CPU，
   * 与 T1（dsh-model-capability 每 5s 全量 describe 造成 24-26% CPU）同族，明确禁止。
   */
  const resetShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.resetShizukuConnection
        ? () => window.androidBridge!.resetShizukuConnection!()
        : undefined,
      '已重置 Shizuku 连接，正在重新建立通道（本页每 2 秒自动重扫）。',
      '重置 Shizuku 连接失败',
    )
  }, [runShizukuAction])

  /**
   * issue #262：root 授权面三个动作（开关 / 「已阅读」确认 / 免责声明）的共同收口。
   *
   * 结算口径沿用 [settleLinkCall]（壳侧回 {ok, code/guidance}），写后立刻 [refreshRootGrant] 回读——
   * 不新造结算口径、不新开定时器（2s 轮询已由 useShellState 承担）。
   */
  const runRootAction = useCallback((
    call: (() => string) | undefined,
    okText: string,
    failLead: string,
    preRaw?: string,
  ) => {
    let raw: string | undefined = preRaw
    if (raw === undefined) {
      try { raw = call?.() } catch { raw = undefined }
    }
    const settled = settleLinkCall(raw, okText, failLead)
    setRootOk(settled.ok)
    setRootMsg(settled.text)
    refreshRootGrant()
    refreshRootAccess()
  }, [refreshRootGrant, refreshRootAccess])

  const toggleRootGrant = useCallback((next: boolean) => {
    // 尝试开启 ⇒ 记 pending：若壳侧因「root 未授权」拦下并弹出授权框，授权一到自动续开。
    if (next) setPendingEnable(true)
    else setPendingEnable(false)
    let raw: string | undefined
    try {
      raw = window.androidBridge?.setRootGranted ? window.androidBridge.setRootGranted(next) : undefined
    } catch { raw = undefined }
    // 「请求已发起」不是失败（2026-09-30 复核补）：壳侧在被第三道门拦下时当场弹授权框并回
    // `code=request-started`——渲染成「进行中」，否则用户先看到红字「开启失败」、2 秒后开关
    // 又自己开起来（提示与实际结果自相矛盾）。
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    if (next && parsed?.code === 'request-started') {
      setRootOk(true)
      setRootMsg('root 授权框已弹出，请在手机上点「允许」——授权后本页会自动续开开关。')
      refreshRootGrant()
      refreshRootAccess()
      return
    }
    runRootAction(
      undefined,
      next
        ? '已开启 AI root 权限：特权通道按 root 身份执行，请在需要时使用、用完即关。'
        : '已关闭 AI root 权限：特权通道已恢复整体拒绝。',
      next ? '开启 AI root 权限失败' : '关闭 AI root 权限失败',
      raw,
    )
  }, [runRootAction, refreshRootGrant, refreshRootAccess])

  /**
   * 检测 / 尝试获取 root 授权（壳侧后台跑一次 `su -c id`；本页 2s 轮询看到结果）。
   *
   * ★口径（2026-09-30 主人指正）：**多数 Root 管理器不再自动弹授权框**（除 Magisk 外，
   * 用户得自己打开管理器授予）✗ ⇒ 文案**不承诺"会弹窗"**，只承诺"取一次真实身份并如实回报" ✓。
   */
  const requestRoot = useCallback(() => {
    runRootAction(
      window.androidBridge?.requestRootAccess
        ? () => window.androidBridge!.requestRootAccess!()
        : undefined,
      '已取到 root 身份——授权已就绪（本页每 2 秒自动刷新）。',
      '检测 root 授权未通过',
    )
    refreshRootAccess()
  }, [runRootAction, refreshRootAccess])

  /**
   * root 通道写盘属主自愈（2026-09-30 主人定例「Root 属主这种 bug 也得找一找修一修」）。
   * 回执带真实计数（checked/healed），不是一句「已修复」——静默成功是本项目在清的缺陷形态。
   */
  const repairOwnership = useCallback(() => {
    let raw: string | undefined
    try { raw = window.androidBridge?.repairRootOwnership?.() } catch { raw = undefined }
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    if (parsed?.ok === true) {
      const skipped = parsed.skipped === 'channel-not-root'
      setRootOk(true)
      setRootMsg(
        skipped
          ? '当前通道不是 root，无需修复属主。'
          : '已检查 ' + String(parsed.checked ?? 0) + ' 个顶层条目，修复 ' + String(parsed.healed ?? 0) + ' 个属主条目。',
      )
    } else {
      // 失败时带**真实计数**（2026-09-30 复核补）：只报「失败」看不出修了多少、剩多少。
      const checked = String(parsed?.checked ?? 0)
      const healed = String(parsed?.healed ?? 0)
      const failures = String(parsed?.failures ?? 0)
      const reason = typeof parsed?.reason === 'string' ? parsed.reason : undefined
      setRootOk(false)
      setRootMsg(
        '修复文件属主未完成（检查 ' + checked + ' 项 / 修好 ' + healed + ' 项 / 失败 ' + failures + ' 项）：'
        + describeCallReason(reason),
      )
    }
  }, [])

  /**
   * 自动续开（2026-09-30 主人定例的体验闭环）：用户开开关 → 壳侧因「root 未授权」拦下并
   * **弹出授权框** → 用户点「允许」→ 本页 2s 轮询看到 `rootAccess.granted` → 自动把开关续开。
   * 用户只需点一次开关 + 在弹窗上点一次「允许」，不必回设置页再点一次。
   */
  useEffect(() => {
    if (!pendingEnable) return
    if (rootGrant.granted) {
      setPendingEnable(false)
      return
    }
    if (rootAccess.granted) {
      setPendingEnable(false)
      toggleRootGrant(true)
    }
  }, [pendingEnable, rootGrant.granted, rootAccess.granted, toggleRootGrant])

  const toggleRootConsent = useCallback((next: boolean) => {
    runRootAction(
      window.androidBridge?.setRootConsent
        ? () => window.androidBridge!.setRootConsent!(next)
        : undefined,
      next
        ? '已记录「已阅读」——与当前版本绑定，升级后需重新确认。'
        : '已撤销同意，并同时关闭了 AI root 权限。',
      next ? '记录「已阅读」失败' : '撤销同意失败',
    )
  }, [runRootAction])

  const openRootDisclaimer = useCallback(() => {
    runRootAction(
      window.androidBridge?.openRootDisclaimer
        ? () => window.androidBridge!.openRootDisclaimer!()
        : undefined,
      '已打开免责声明（APK 内置文档，离线可读）。',
      '打开免责声明失败',
    )
  }, [runRootAction])

  const tapForce = useCallback(() => {
    const next = confirmStage + 1
    if (next < 3) {
      setConfirmStage(next)
      setForceMsg(null)
      return
    }
    setConfirmStage(0)
    try {
      const raw = window.androidBridge?.forceDestroyVdisplay?.()
      const parsed = raw ? JSON.parse(raw) as { ok?: boolean; code?: string } : undefined
      const ok = parsed?.ok === true
      setForceMsg(ok
        ? { ok: true, text: '已强制销毁全部虚拟屏。' }
        : { ok: false, text: '销毁失败：' + describeCallReason(parsed?.code), code: String(parsed?.code ?? 'unknown') })
    } catch {
      setForceMsg({ ok: false, text: '销毁调用失败（应用内桥不可用）——请重新打开应用后重试。', code: 'bridge-threw' })
    }
    refreshVdisplay()
  }, [confirmStage, refreshVdisplay])

  const forceLabel = confirmStage === 0
    ? '强制销毁虚拟屏'
    : '再次点击确认（' + confirmStage + '/3）'
  // P5-5：进入确认态后必须给**取消途径**。旧实现没有任何退出通道——误点一下就只能
  // 「再点两下把它执行掉」或者等 4 秒超时（超时不可见，用户并不知道自己还能等）。
  const forceArmed = confirmStage > 0
  const cancelForce = useCallback(() => {
    setConfirmStage(0)
    setForceMsg(null)
  }, [])

  // 「打开 Shizuku」的可点条件：只有**确知已安装**才可点（读不到状态时按未安装处理）。
  const canOpenShizuku = shizuku.readable && shizuku.installed

  return (
    <section
      className="dsh-screen-control-card"
      aria-labelledby="dsh-phone-control-title"
      {...(vdisplay.displayId === undefined ? {} : { 'data-display-id': String(vdisplay.displayId) })}
    >
      <header className="dsh-screen-control-header">
        <span>
          <strong id="dsh-phone-control-title">手机控制</strong>
          <small>屏幕与特权通道的授权面；模型不能自行更改这里的任何设置。</small>
        </span>
        <span className="dsh-screen-control-state" data-state={vdisplay.state}>{STATUS_LABEL[vdisplay.state]}</span>
      </header>

      {/* 虚拟屏的状态说明：壳侧在 blocked 态把 Shizuku 的 guidance 原样透给 vdisplayStatus，
          于是这句话会和下面 Shizuku 区块**逐字重复**（0.14.1 设备实测）。按值去重——
          只是不重复同一句，不臆造替代文案。 */}
      {vdisplay.guidance !== shizuku.guidance ? (
        <p className="dsh-dev-hint">{vdisplay.guidance}</p>
      ) : null}

      <div className="dsh-screen-control-detail">
        <strong>Shizuku 特权通道</strong>
        <span data-code={shizuku.readable ? undefined : 'shizuku-status-unreadable'}>
          {shizukuStateLabel(shizuku)}
        </span>
      </div>
      <p className="dsh-dev-hint">
        {shizuku.guidance !== '' ? shizuku.guidance : shizukuStepHint(shizuku)}
      </p>
      <div className="dsh-dev-row dsh-dev-split">
        <button type="button" className="dsh-dev-btn" onClick={downloadShizuku}>下载 Shizuku</button>
        <button
          type="button"
          className="dsh-dev-btn"
          disabled={!canOpenShizuku}
          onClick={openShizuku}
        >
          打开 Shizuku
        </button>
      </div>
      <p className="dsh-dev-hint">
        两个入口都会跳到应用外（系统浏览器 / Shizuku 应用）。装好并授权后回到本页即可——
        状态每 2 秒自动刷新，不需要手动操作。授权只能在 Shizuku 内由你亲手完成。
      </p>
      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-link" onClick={tutorialShizuku}>点击查看教程</button>
        <button type="button" className="dsh-dev-btn" onClick={refreshShizuku}>刷新状态</button>
        <button type="button" className="dsh-dev-btn" onClick={resetShizuku}>重置链接</button>
      </div>
      {shizuku.granted ? null : (
        <div className="dsh-dev-row">
          <button
            type="button"
            className="dsh-dev-btn"
            disabled={!shizuku.readable || !shizuku.running}
            onClick={requestShizukuPermission}
          >
            请求 Shizuku 授权
          </button>
          <span className="dsh-dev-hint">
            授权框需要前台界面才能弹出——后台自动请求会静默失败（管理器里会看不到本应用）。
          </span>
        </div>
      )}
      {shizukuMsg === null ? null : (
        <p className={shizukuOk === true ? 'dsh-dev-hint' : 'dsh-dev-error'}>{shizukuMsg}</p>
      )}

      {/* issue #262 方案 A：AI root 权限授权开关（策略门 + 免责门 + 通道身份探测）。
          判据是**通道身份**（Shizuku 服务端 uid==0）而非「设备是否 root」——已 root 但 Shizuku
          以 ADB 启动的设备同样置灰 + 红字（用户指定文案，逐字保留），引导以 root 启动 Shizuku。 */}
      <div className="dsh-screen-control-detail">
        <strong>AI root 权限</strong>
        <span data-code={rootGrant.readable ? undefined : 'root-grant-unreadable'}>
          {rootGrantStateLabel(rootGrant)}
        </span>
      </div>
      {!rootGrant.readable ? (
        <p className="dsh-dev-hint">读不到授权状态：壳侧桥未装配或解析失败；特权通道按未授权处理。</p>
      ) : rootGrantChannelHint(rootGrant).kind === 'shell-identity' ? (
        <p className="dsh-dev-hint" data-code="shizuku-shell-identity">{rootGrantChannelHint(rootGrant).text}</p>
      ) : rootGrantChannelHint(rootGrant).kind === 'not-root' ? (
        <p className="dsh-dev-error" data-code="not-root-channel">{rootGrantChannelHint(rootGrant).text}</p>
      ) : null}
      <label className="dsh-screen-scope-row">
        <span>
          <strong>授权 AI 使用 root</strong>
          <small>
            {rootGrant.honesty !== ''
              ? rootGrant.honesty
              : '本开关是策略门与知情同意门，不是技术沙箱；开启后特权命令按通道身份（root）执行。'}
          </small>
        </span>
        <input
          type="checkbox"
          aria-label="授权 AI 使用 root"
          checked={rootGrant.granted}
          disabled={!canToggleRootGrant(rootGrant) || !rootGrant.consentValid}
          onChange={(event) => toggleRootGrant(event.target.checked)}
        />
      </label>
      <label className="dsh-screen-scope-row">
        <span>
          <strong>已阅读</strong>
          <small>
            我已阅读
            <button type="button" className="dsh-dev-link" onClick={openRootDisclaimer}>
              《AI root 权限免责声明》
            </button>
            ，理解开启后 AI 的破坏性操作由我自行承担，与开发者及本项目无关。勾选后才能开启上面的开关；
            取消勾选会同时关闭开关（升级后需重新确认）。
          </small>
        </span>
        <input
          type="checkbox"
          aria-label="已阅读免责声明"
          checked={rootGrant.consentValid}
          disabled={!canToggleRootGrant(rootGrant)}
          onChange={(event) => toggleRootConsent(event.target.checked)}
        />
      </label>
      {rootMsg === null ? null : (
        <p className={rootOk === true ? 'dsh-dev-hint' : 'dsh-dev-error'}>{rootMsg}</p>
      )}

      {/* 2026-09-30 主人定例：应用级 root 授权面——检测 + 诚实引导 + 属主自愈。
          ★主人指正（同日）：**不做「打开 Root 管理器」入口** ✗ —— 各家管理器包名/入口不一
          （还可能根本没有管理器 App，如部分 ROM 内置 su），打开不保证成功 ✗；而能刷 root 的用户
          自己会开管理器 ✓ ⇒ 只保留「检测 root 授权」＋ 把管理器名如实报出来 ✓。 */}
      <div className="dsh-screen-control-detail">
        <strong>Root 授权（应用自身）</strong>
        <span data-code={rootAccess.readable ? undefined : 'root-access-unreadable'}>
          {rootAccessStateLabel(rootAccess)}
        </span>
      </div>
      <p className="dsh-dev-hint">
        {rootAccess.guidance !== ''
          ? rootAccess.guidance
          : '点「检测 root 授权」会取一次真实 root 身份；未授权时上面的开关不会开启。'}
      </p>
      <div className="dsh-dev-row">
        <button
          type="button"
          className="dsh-dev-btn"
          disabled={!canRequestRoot(rootAccess)}
          onClick={requestRoot}
        >
          检测 root 授权
        </button>
      </div>
      <p className="dsh-dev-hint">
        {rootAccess.managerInstalled
          ? '检测到 Root 管理器：' + rootAccess.managerLabel + '。多数管理器不会自动弹授权框——请在它里面允许本应用使用 root。'
          : '未检测到已知 Root 管理器（KernelSU / Magisk / APatch）——若你用的是别的管理器或 ROM 内置 su，请在它里面允许本应用。'}
      </p>
      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-link" onClick={repairOwnership}>
          修复文件属主
        </button>
        <span className="dsh-dev-hint">
          root 通道写盘会把文件属主变成 root:root（应用读不回来）——这里做有界抽查与修复。
        </span>
      </div>

      <label className="dsh-screen-scope-row">
        <span>
          <strong>开放屏幕范围</strong>
          <small>默认仅虚拟屏幕。真实屏幕、截图与控制都遵守此范围和完全访问权限。</small>
        </span>
        <select aria-label="开放屏幕范围" value={scope} onChange={(event) => setScope(event.target.value as ScreenScope)}>
          <option value="virtual-only">仅虚拟屏幕</option>
          <option value="real-only">仅真实屏幕</option>
          <option value="all">全部开放</option>
        </select>
      </label>

      <label className="dsh-screen-scope-row">
        <span>
          <strong>虚拟屏分辨率档位</strong>
          <small>跟随真机比例并同比例缩放 densityDpi（下次建屏生效；默认 0.75，更省性能）。</small>
        </span>
        <select aria-label="虚拟屏分辨率档位" value={String(scale)} onChange={(event) => setScale(Number(event.target.value))}>
          {SCALE_OPTIONS.map((option) => (
            <option key={option} value={String(option)}>
              {option === 1 ? '原生' : String(Math.round(option * 100)) + '%'}
            </option>
          ))}
        </select>
      </label>

      <label className="dsh-screen-scope-row">
        <span>
          <strong>虚拟屏浮窗（退后台自动显示）</strong>
          {/* P5-6：与开发者选项里的「悬浮球」去混淆。两者都叫「浮」，但一个是**虚拟屏只读画面**，
              一个是**任务面板入口**——旧文案各说各的，用户在两页之间对不上号。 */}
          <small>只读浮窗：应用切到后台时显示虚拟屏画面；前台只在侧栏可见。与开发者选项里的「悬浮球」不是同一个东西（那个是任务面板入口）。</small>
        </span>
        <input
          aria-label="虚拟屏浮窗（退后台自动显示）"
          type="checkbox"
          checked={floatOn}
          onChange={(event) => setFloat(event.target.checked)}
        />
      </label>

      <div className="dsh-screen-control-detail">
        <strong>无障碍通道</strong>
        <span>
          {!a11y.readable
            ? '状态不可读'
            : (a11y.enabled ? '已开启（语义读取/点击/输入）' : '未开启（推荐开启）')}
        </span>
        {a11y.hint !== '' ? <span>{a11y.hint}</span> : null}
      </div>
      {a11y.readable && !a11y.enabled && a11y.restrictedSettingsApplies ? (
        <p className="dsh-dev-hint">
          Android 13 及以上对侧载应用默认开启「受限设置」：系统页里本应用的开关会是灰的。
          先点「解锁受限设置」（经 Shizuku 特权通道，只影响本应用这一项），再回去开启。
        </p>
      ) : null}
      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-btn" onClick={openA11y}>去开启无障碍服务</button>
        {a11y.readable && !a11y.enabled && a11y.restrictedSettingsApplies ? (
          <button type="button" className="dsh-dev-btn" onClick={unlockA11y}>解锁受限设置</button>
        ) : null}
      </div>
      {a11yMsg === null ? null : (
        <p className={a11yOk === true ? 'dsh-dev-hint' : 'dsh-dev-error'}>{a11yMsg}</p>
      )}

      <div className="dsh-screen-control-detail">
        <strong>强制销毁虚拟屏</strong>
        <span>销毁全部虚拟屏与其上的任务（无视会话归属）；需连续点击三次确认，点错可取消。</span>
      </div>
      {/* P5-5：破坏性按钮必须与同页的普通按钮**看得出区别**（dsh-dev-danger），
          并在确认态给「取消」。此前它长得和「刷新状态」一模一样，还紧邻其它按钮。 */}
      <div className="dsh-dev-row">
        <button
          type="button"
          className={forceArmed ? 'dsh-dev-btn dsh-dev-danger' : 'dsh-dev-btn'}
          data-stage={confirmStage}
          data-armed={forceArmed ? 'true' : 'false'}
          onClick={tapForce}
        >
          {forceLabel}
        </button>
        {forceArmed ? (
          <button type="button" className="dsh-dev-link" onClick={cancelForce}>取消</button>
        ) : null}
      </div>
      {forceMsg === null ? null : (
        <p
          className={forceMsg.ok ? 'dsh-dev-hint' : 'dsh-dev-error'}
          {...(forceMsg.code === undefined ? {} : { 'data-code': forceMsg.code })}
        >{forceMsg.text}</p>
      )}
    </section>
  )
}
