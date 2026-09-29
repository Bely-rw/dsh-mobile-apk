package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject

/**
 * 「AI root 权限」授权门（issue #262 方案 A：策略门 + 免责确认门 + 通道身份探测）。
 *
 * ── 本开关**不授予任何能力**（诚实性要求，issue 原文）────────────────────────────
 * root 能力来自「Shizuku 服务端以 root 启动」（通道身份 uid=0），不是本开关给的。
 * 本开关真实的作用只有两件：
 *  1. **策略门**：通道身份为 root 且未授权时，特权执行面整体拒绝（见 [ShizukuTransport]
 *     的 rootGateRefusal）——不是按 op 分类放行（uid 0 下 `shExec` 是任意 shell，
 *     op 白名单挡不住引号逃逸，分类隔离是假的，故整体 fail-closed）。
 *  2. **知情同意与免责**：开启前必须勾选「已阅读」并打开过免责声明；同意与当前
 *     versionCode 绑定，升级后需重新确认。
 *
 * ── 通道身份 ≠ 设备是否 root（探测判据，issue 原文）────────────────────────────
 * 已 root 但 Shizuku 以 ADB（uid 2000）启动的设备，通道只有 shell 权限——此时本开关
 * **置灰**并显示红字「无法在未 root 的设备上赋予该权限」（用户指定文案，逐字保留），
 * 引导「在 Shizuku 内以 root 启动」。判据只认通道 uid，不猜设备。
 *
 * ── 纯逻辑与持久化分离（与 [ShizukuBindState] 同纪律）──────────────────────────
 * 决策核心 [decision] 是纯函数（JVM 可测，不需要 Robolectric）：
 *  - 未勾选/同意过期 → 不许开启（`consent-required`）；
 *  - 通道身份非 root → 不许开启（`not-root-channel`，界面对应置灰+红字）；
 *  - 取消勾选「已阅读」→ 撤销同意并**同时关闭开关**（不留「已授权但未同意」的矛盾态）。
 * 持久化是薄壳：`granted` 与 `consentVersionCode` 存私有 SharedPreferences；
 * 同意与 versionCode 绑定 ⇒ 升级后 consentValid() 自然为 false，无需迁移逻辑。
 */
object RootGrant {

  /** 拒绝码：通道身份不是 root（uid≠0），开关应当置灰。 */
  const val CODE_NOT_ROOT_CHANNEL = "not-root-channel"

  /** 拒绝码：免责确认（勾选「已阅读」）缺失或已随版本升级过期。 */
  const val CODE_CONSENT_REQUIRED = "consent-required"

  /**
   * 拒绝码：应用自身尚未从 Root 管理器获得 root 授权（2026-09-30 主人定例）。
   * 这一支会**顺带触发 Root 管理器的授权弹窗**（[RootAccess.requestGrant]），
   * 引导语里如实说明「弹窗已弹出 / 请去管理器授予」。
   */
  const val CODE_ROOT_NOT_GRANTED = "root-not-granted"

  /** 通道 uid 的 root 判据（与 [ShizukuProbe]/[ShizukuTransport.status] 的 identity 同源）。 */
  const val ROOT_UID = 0

  private const val PREFS = "dsh_root_grant"
  private const val KEY_GRANTED = "granted"
  private const val KEY_CONSENT_VC = "consentVersionCode"

  /**
   * 开关决策（纯函数）。
   *
   * @param channelUid Shizuku 通道身份（服务端 uid；读不到时传 -1，按非 root 处理——fail-closed）。
   * @param granted 当前开关位。
   * @param consentVersionCode 已记录的「已阅读」同意所绑定的 versionCode；0 = 从未同意。
   * @param currentVersionCode 当前构建的 versionCode。
   * @param wantOn 用户想要开启还是关闭。
   * @return `null` = 允许按 [wantOn] 变更；非空 = 结构化拒绝（code 见上方常量）。
   */
   fun decision(
    channelUid: Int,
    rootGranted: Boolean,
    granted: Boolean,
    consentVersionCode: Int,
    currentVersionCode: Int,
    wantOn: Boolean,
  ): JSONObject? {
    if (!wantOn) return null // 关闭永远允许（撤销不是需要资格的动作）
    if (channelUid != ROOT_UID) {
      return JSONObject().put("ok", false).put("code", CODE_NOT_ROOT_CHANNEL)
        .put("guidance", "无法在未 root 的设备上赋予该权限")
    }
    if (consentVersionCode <= 0 || consentVersionCode != currentVersionCode) {
      return JSONObject().put("ok", false).put("code", CODE_CONSENT_REQUIRED)
        .put("guidance", "先勾选「已阅读」并查看免责声明，才能开启 AI root 权限（升级后需重新确认）。")
    }
    // 主人定例（2026-09-30）：开关要真走 root 授权流程——未获 Root 管理器授权就不放行，
    // 由调用方顺带弹出授权框（见 setGranted），页面据 RootAccess.state 显示进度与引导。
    if (!rootGranted) {
      return JSONObject().put("ok", false).put("code", CODE_ROOT_NOT_GRANTED)
        .put("guidance", "尚未获得 root 授权——授权框已弹出，请在手机上点「允许」；" +
          "若没有弹出，请点「打开 Root 管理器」手动允许本应用使用 root。")
    }
    return null
  }

  /** 「已阅读」同意是否对当前构建有效（与 versionCode 绑定；**0 不算同意**——fail-closed）。 */
  fun consentValid(context: Context): Boolean {
    val consent = prefs(context).getInt(KEY_CONSENT_VC, 0)
    return consent > 0 && consent == BuildConfig.VERSION_CODE
  }

  /** 当前开关位（默认 false——fail-closed：装完/升级后 root 通道保持关闭）。 */
  fun isGranted(context: Context): Boolean = prefs(context).getBoolean(KEY_GRANTED, false)

  /**
   * 勾选/取消「已阅读」。
   *
   * 勾选 = 记录同意并绑定当前 versionCode；**取消勾选即撤销同意并同时关闭开关**
   * （issue 用户指定语义，不留矛盾态）。返回写后读回的状态 JSON。
   *
   * 回包必须带 `ok:true`：页面结算（settleLinkCall）只认 `ok === true`，缺这个字段会把
   * 已成功的写入渲染成失败（2026-09-30 用户实测「撤销同意失败」——状态其实已生效）。
   */
  fun setConsent(context: Context, on: Boolean): JSONObject {
    val app = context.applicationContext
    if (on) {
      prefs(app).edit().putInt(KEY_CONSENT_VC, BuildConfig.VERSION_CODE).apply()
    } else {
      // 撤销同意必须连带关开关：只清同意而留着 granted=true 会让「未同意但已授权」
      // 成为可达状态，而那个状态正是免责门要杜绝的。
      prefs(app).edit().putInt(KEY_CONSENT_VC, 0).putBoolean(KEY_GRANTED, false).apply()
    }
    return state(app, channelUidNow(app)).put("ok", true)
  }

  /**
   * 开/关开关。[decision] 判据全部满足才写入；关闭无需资格。
   * 返回写后读回的状态 JSON（拒绝时带 code/guidance，界面据此说话）。
   */
  fun setGranted(context: Context, on: Boolean): JSONObject {
    val app = context.applicationContext
    val uid = channelUidNow(app)
    val refusal = decision(
      channelUid = uid,
      rootGranted = RootAccess.isGranted(app),
      granted = isGranted(app),
      consentVersionCode = prefs(app).getInt(KEY_CONSENT_VC, 0),
      currentVersionCode = BuildConfig.VERSION_CODE,
      wantOn = on,
    )
    if (refusal == null) {
      prefs(app).edit().putBoolean(KEY_GRANTED, on).apply()
    } else if (refusal.optString("code") == CODE_ROOT_NOT_GRANTED) {
      // 主人定例：开关要「调用一下 root 弹窗」——被本门拦住时**当场触发授权请求**，
      // 弹窗随即出现；页面靠既有 2s 轮询看到 requesting/granted，并在授权后自动续开
      // （见 phone-control.tsx 的 pendingEnable）。
      RootAccess.requestGrant(app)
      // 2026-09-30 复核补：这一支**不是失败**，是「请求进行中」——回包必须如实这么说，
      // 否则页面先弹「开启失败」红字、2 秒后又自己开起来（提示与实际结果自相矛盾）。
      val started = RootAccess.state(app)
      return state(app, uid)
        .put("ok", false)
        .put("code", "request-started")
        .put("reason", "request-started")
        .put("requesting", true)
        .put("guidance", "root 授权框已弹出，请在手机上点「允许」——授权后本页会自动续开开关。")
        .put("rootState", started.optString("state"))
    }
    // 拒绝回包同时带 `reason`（= code）：页面结算的人话翻译只读 reason（user-copy.ts 的
    // CALL_REASON 唯一真源），code 留给 data-code/grep。两个都不带会落「未在本版登记」兜底。
    return state(app, uid).let {
      if (refusal != null) {
        it.put("ok", false).put("code", refusal.optString("code"))
          .put("reason", refusal.optString("code"))
          .put("guidance", refusal.optString("guidance"))
      } else {
        it.put("ok", true)
      }
    }
  }

  /**
   * 设置页读面：授权位 + 同意有效性 + 通道身份三件事一次带出。
   *
   * `channelRoot=false` ⇒ 界面把开关置灰并显示红字文案（[CODE_NOT_ROOT_CHANNEL] 同源）。
   * 通道 uid 读不到（未装/未跑/未授权）按 -1 处理——同样置灰，不猜。
   */
  fun state(context: Context, channelUid: Int): JSONObject {
    val consent = prefs(context).getInt(KEY_CONSENT_VC, 0)
    val valid = consent > 0 && consent == BuildConfig.VERSION_CODE
    return JSONObject()
      .put("granted", prefs(context).getBoolean(KEY_GRANTED, false))
      .put("consentValid", valid)
      .put("consentVersionCode", consent)
      .put("currentVersionCode", BuildConfig.VERSION_CODE)
      .put("channelUid", channelUid)
      .put("channelRoot", channelUid == ROOT_UID)
      .put("canToggle", channelUid == ROOT_UID)
      // 应用级 root 授权（Root 管理器）——开关放行的第三道门，UI 单独一行展示进度与引导。
      .put("rootGranted", RootAccess.isGranted(context))
      .put("rootState", RootAccess.state(context).optString("state"))
      // 诚实性说明（issue 要求：做不到技术隔离时不得把不成立的隔离写成事实）：
      .put(
        "honesty",
        "本开关是策略门与知情同意门，不是技术沙箱：通道以 root 运行时，任意 shell 命令在该通道下本就无限制。",
      )
  }

  /** 当前 Shizuku 通道的服务端 uid（读不到 = -1，不阻塞、不抛出）。 */
  internal fun channelUidNow(context: Context): Int =
    runCatching { rikka.shizuku.Shizuku.getUid() }.getOrDefault(-1)

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
