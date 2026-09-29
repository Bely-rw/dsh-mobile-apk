package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 「AI root 权限」授权门（issue #262 方案 A）的决策回归。
 *
 * 测的是纯函数 [RootGrant.decision]——与 [ShizukuBindStateTest] 同纪律：
 * 生产面不存在测试注入点，持久化薄壳不进 JVM 测试（无 Robolectric）。
 * 判据全部来自 issue #262 的已确证前提：
 *  - 探测判据用**通道身份**（uid==0）而不是「设备是否 root」；
 *  - 打开前必须先过免责确认门（同意与 versionCode 绑定）；
 *  - 关闭永远允许（撤销不是需要资格的动作）。
 */
class RootGrantTest {

  private fun decision(
    channelUid: Int,
    consentVersionCode: Int,
    currentVersionCode: Int = 100,
    wantOn: Boolean = true,
    rootGranted: Boolean = true,
  ): JSONObject? = RootGrant.decision(
    channelUid = channelUid,
    rootGranted = rootGranted,
    granted = false,
    consentVersionCode = consentVersionCode,
    currentVersionCode = currentVersionCode,
    wantOn = wantOn,
  )

  @Test
  fun `root channel with valid consent allows turning on`() {
    assertNull(decision(channelUid = 0, consentVersionCode = 100))
  }

  @Test
  fun `non-root channel is refused even with consent`() {
    // 通道身份 ≠ 设备是否 root：uid 2000（Shizuku 以 ADB 启动）与读不到（-1）都算非 root，
    // 假绿（已 root 设备上按设备判据放行）是 issue 点名的缺陷形态。
    for (uid in listOf(2000, -1, 10241)) {
      val refusal = decision(channelUid = uid, consentVersionCode = 100)
      assertNotNull("uid=$uid 必须拒绝", refusal)
      assertEquals(RootGrant.CODE_NOT_ROOT_CHANNEL, refusal!!.opt("code"))
    }
  }

  @Test
  fun `missing or stale consent is refused on root channel`() {
    val never = decision(channelUid = 0, consentVersionCode = 0)
    assertNotNull(never)
    assertEquals(RootGrant.CODE_CONSENT_REQUIRED, never!!.opt("code"))

    // 同意与 versionCode 绑定：升级（currentVersionCode 变化）后旧同意失效，需重新确认。
    val upgraded = decision(channelUid = 0, consentVersionCode = 99, currentVersionCode = 100)
    assertNotNull(upgraded)
    assertEquals(RootGrant.CODE_CONSENT_REQUIRED, upgraded!!.opt("code"))
  }

  @Test
  fun `turning off is always allowed regardless of channel or consent`() {
    assertNull(decision(channelUid = 2000, consentVersionCode = 0, wantOn = false))
    assertNull(decision(channelUid = -1, consentVersionCode = 0, wantOn = false))
    assertNull(decision(channelUid = 0, consentVersionCode = 0, wantOn = false))
    assertNull(decision(channelUid = 0, consentVersionCode = 100, wantOn = false, rootGranted = false))
  }

  /**
   * 第三道门（2026-09-30 主人定例）：应用自身未从 Root 管理器获得授权 ⇒ 开关不放行，
   * 由调用方（[RootGrant.setGranted]）顺带弹出授权框，页面据 [RootAccess.state] 显示进度。
   */
  @Test
  fun `root channel with valid consent still requires app-level root grant`() {
    val refusal = decision(channelUid = 0, consentVersionCode = 100, rootGranted = false)
    assertNotNull("未获 Root 管理器授权时必须拒绝", refusal)
    assertEquals(RootGrant.CODE_ROOT_NOT_GRANTED, refusal!!.opt("code"))
    assertTrue(
      "拒绝语必须说清「授权框已弹出 / 去管理器」",
      refusal.optString("guidance").contains("授权框") && refusal.optString("guidance").contains("Root 管理器"),
    )
    // 三道门都过才放行
    assertNull(decision(channelUid = 0, consentVersionCode = 100, rootGranted = true))
  }

  @Test
  fun `refusals carry guidance`() {
    // 结构化拒绝必须带人话 guidance（页面直接展示，不静默）。
    val refusal = decision(channelUid = 0, consentVersionCode = 0)
    assertTrue(refusal!!.optString("guidance").isNotBlank())
    assertEquals(false, refusal.opt("ok"))
  }

  // ── 源码契约：门的接线不得被无声拆除 ────────────────────────────

  /**
   * [ShizukuTransport] 的**两个**执行面入口（readyService 覆盖 runShell/pull/push/remove，
   * runController 覆盖虚拟屏控制器命令）都必须在进任何绑定/执行之前过 rootGateRefusal。
   * 单边改动不会有编译错误——只能用源码契约钉住。
   */
  @Test
  fun `transport execution surfaces call the root gate`() {
    val source = listOf(
      File("src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt"),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 ShizukuTransport.kt")
    val text = source.readText()
    assertTrue(
      "readyService 必须过 rootGateRefusal（runShell/pullFile/pushFile/removeRemote 的共同入口）",
      Regex("readyService\\(context: Context, applyGate: Boolean = true\\)[\\s\\S]{0,700}?if \\(applyGate\\) rootGateRefusal").containsMatchIn(text),
    )
    assertTrue(
      "策略门只许被应用自愈面（repairOwnership）以 applyGate=false 绕过——模型执行面一律带门",
      Regex("readyService\\(context, applyGate = false\\)").findAll(text).count() == 1,
    )
    assertTrue(
      "runController 必须过 rootGateRefusal（虚拟屏控制器命令入口）",
      Regex("fun runController\\(context: Context, argv: Array<String>\\): JSONObject \\{[\\s\\S]{0,400}?rootGateRefusal").containsMatchIn(text),
    )
  }

  /**
   * 免责文档必须在 APK assets 里真实存在（LocalDocs 登记表指向的路径打包漏了 = 白屏，
   * fail-closed 的 missing-asset 分支只有用户真打开时才会暴露——打包期就该钉住）。
   */
  @Test
  fun `disclaimer asset exists in the apk`() {
    val asset = listOf(
      File("src/main/assets/docs/root-disclaimer.html"),
      File("app/src/main/assets/docs/root-disclaimer.html"),
    ).firstOrNull { it.isFile }
    assertNotNull("assets/docs/root-disclaimer.html 必须随包（issue #262 免责门）", asset)
    assertTrue("免责声明不能是空文档", (asset!!.length() > 1024L))
  }

  // ── 回包形状契约（2026-09-30 用户实测：撤销同意显示「失败：原因未在本版登记」）─────

  /**
   * [RootGrant.setConsent] 的回包必须带 `ok: true`：页面结算（settleLinkCall）只认
   * `ok === true`，缺字段会把已成功的写入渲染成失败。持久化面无法在 JVM 直测
   * （SharedPreferences 需要 Context），以源码契约钉住形状——与包名同源契约同款。
   */
  @Test
  fun `setConsent answer carries ok true`() {
    val source = listOf(
      File("src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 RootGrant.kt")
    val text = source.readText()
    val body = Regex("fun setConsent[\\s\\S]*?\\n  \\}")
      .find(text)?.value ?: throw AssertionError("找不到 setConsent 函数体")
    assertTrue(
      "setConsent 的 return 必须显式 put(\"ok\", true)——页面结算只认 ok===true",
      body.contains("put(\"ok\", true)"),
    )
  }

  /**
   * [RootGrant.setGranted] 的拒绝回包必须同时带 `reason`（= code）：人话翻译只读 reason
   * （user-copy.ts 的 CALL_REASON 唯一真源），只带 code 会落「未在本版登记」兜底。
   */
  @Test
  fun `setGranted refusal carries reason for the copy table`() {
    val source = listOf(
      File("src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 RootGrant.kt")
    val text = source.readText()
    val body = Regex("fun setGranted[\\s\\S]*?\\n  \\}")
      .find(text)?.value ?: throw AssertionError("找不到 setGranted 函数体")
    assertTrue(
      "拒绝分支必须 put(\"reason\", ...)——CALL_REASON 表按 reason 翻译",
      body.contains("put(\"reason\""),
    )
  }
}
