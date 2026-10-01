package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #309 的判据与接线回归测试（JVM，无需设备）。
 *
 * 为什么一个 issue 要单独一个测试类：本 issue 的形态是**两道闸门互锁导致自动路径为零**，
 * 而缺陷藏在「调用点在不在」「顺序对不对」这类地方——纯逻辑单测看不见，必须同时钉住接线。
 * 因此本类分两半：
 *   · 判据半：全部靠传参（本仓既有范式），反证不就地改生产源码；
 *   · 接线半：源码级断言调用点与相对顺序（与 ForegroundPageRecoveryWiringTest 同族）。
 */
class Issue309StartRecoveryTest {

  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  /** 去掉整行注释后再做顺序断言：注释里出现的标识符不得让断言假绿。 */
  private fun code(name: String): String = source(name).lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  private fun between(text: String, start: String, end: String): String {
    require(text.contains(start)) { "missing start: " + start }
    val remaining = text.substringAfter(start)
    require(remaining.contains(end)) { "missing end: " + end }
    return remaining.substringBefore(end)
  }

  // ── 判据半：证据分级 ──────────────────────────────────────────────────────

  /**
   * 核心反证 1：**只有低置信度条目命中时不得触发重抽取**。
   *
   * 为什么这条是核心：issue #309 明确告诫「不要贸然补全 REQUIRED_LIBS 表」，因为它是假阴性的
   * 来源（缺的可能是传递依赖）。若在这里放宽，误伤面是每次启动白付一次 8-12 分钟全量抽取，
   * 并且把现场抹掉——比不修更坏。
   */
  @Test
  fun `low confidence only missing entries must not spend the re-extract`() {
    val lowOnly = listOf("lib/libicuuc.so.78 (dangling link -> libicuuc.so.78.3)", "lib/libz.so.1")
    val confirmed = RuntimeTree.confirmedDamage(lowOnly)
    assertTrue("低置信度条目不得被算成确诊项：" + confirmed, confirmed.isEmpty())
    assertFalse(
      "只有低置信度条目时，自动路径必须拒绝（否则每次启动白付一次全量重抽取）",
      RuntimeTree.allowStartRecovery(confirmed, alreadyRecoveredThisRun = false),
    )
  }

  /** 核心反证 2：确诊项 + 预算未用 ⇒ 必须放行，否则本 issue 等于没修。 */
  @Test
  fun `confirmed missing entry with a fresh budget is allowed`() {
    val missing = listOf("bin/node", "lib/libz.so.1")
    val confirmed = RuntimeTree.confirmedDamage(missing)
    assertEquals("只有快照自身条目算确诊", listOf("bin/node"), confirmed)
    assertTrue(
      "确诊缺失 + 本次运行还没花过预算 ⇒ 必须放行（这就是本 issue 要的那个出口）",
      RuntimeTree.allowStartRecovery(confirmed, alreadyRecoveredThisRun = false),
    )
  }

  /** 确诊项齐全但预算已用 ⇒ 拒绝（防「重抽取 -> 再失败 -> 再重抽取」死循环）。 */
  @Test
  fun `spent budget blocks even a confirmed recovery`() {
    val confirmed = RuntimeTree.confirmedDamage(listOf("bin/node", "home/.dsh/profiles/web"))
    assertEquals(2, confirmed.size)
    assertFalse(
      "预算已用尽时一律拒绝，否则用户会被困在解压页",
      RuntimeTree.allowStartRecovery(confirmed, alreadyRecoveredThisRun = true),
    )
  }

  /**
   * 用户显式动作（错误页按钮）放行**证据分级**，但**不**放行预算。
   *
   * 为什么两条都要钉住：只钉前半条会让「点一次按钮就无限重抽取」通过；只钉后半条则等于
   * 没有手动出口——而 issue 的核心诉求正是「闸门 A 要有一个出口」。
   */
  @Test
  fun `user forced escape hatch bypasses grading but never the budget`() {
    assertTrue(
      "用户显式要求时必须能重做一次（否则仍是零出口）",
      RuntimeTree.allowStartRecovery(emptyList(), alreadyRecoveredThisRun = false, userForced = true),
    )
    assertFalse(
      "手动入口不得绕过预算（一次之后仍失败 = 不是一次重抽取能修的损伤）",
      RuntimeTree.allowStartRecovery(listOf("bin/node"), alreadyRecoveredThisRun = true, userForced = true),
    )
  }

  /** 确诊项必须落在快照抽取面内（usr 下的条目 + profile 目录），不可是任意字符串。 */
  @Test
  fun `confirmed set is the snapshot own entries only`() {
    assertEquals(
      listOf("bin/node", "lib/node_modules/@deepseek-ai/dsh/lib/bin.js", "home/.dsh/profiles/web"),
      RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES,
    )
    for (lib in RuntimeTree.REQUIRED_LIBS) {
      assertFalse(
        "库文件不得进入确诊集合（可能是传递依赖误报）：" + lib,
        RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES.contains("lib/" + lib),
      )
    }
  }

  /** 取证描述必须区分「被删」与「从未解压」：不存在与存在（带大小/mtime）两种形态。 */
  @Test
  fun `entry description distinguishes absent from present`() {
    val tmp = File.createTempFile("dsh-309", ".bin")
    try {
      tmp.writeText("abc")
      val present = RuntimeTree.describeEntry(tmp)
      assertTrue("在场条目必须带大小：" + present, present.contains("size=3"))
      assertTrue("在场条目必须带 mtime：" + present, present.contains("mtime="))
    } finally {
      tmp.delete()
    }
    assertTrue("不存在必须如实写 absent", RuntimeTree.describeEntry(File("definitely-missing-309")).startsWith("absent"))
  }

  // ── 接线半：互锁与出口 ────────────────────────────────────────────────────

  /**
   * 互锁的**结构性证据**：闸门 B 的判据是 engine.log 尾部，而闸门 A 拒启时不 spawn。
   *
   * 把这条钉住的意义：任何「把恢复只挂在闸门 B 上」的改法都会立刻在这里露馅——
   * 若 engine.log 不存在，闸门 B 的判据恒为假，自愈结构性不可达。
   */
  @Test
  fun `gate B judge reads the engine log which gate A never produces`() {
    val flow = code("EngineStartFlow.kt")
    val selfHeal = between(flow, "private fun maybeSelfHealDamagedRuntimeTree(", "private fun reportRecoveryRejectionIfAny(")
    assertTrue(
      "闸门 B 的判据必须是 engine.log 尾部 + 链接失败签名（这正是它被互锁的原因）",
      selfHeal.contains("readEngineLogTail") && selfHeal.contains("snapshotLinkFailure"),
    )
    val manager = code("EngineManager.kt")
    val gateA = between(manager, "if (!liveRuntimeComplete()) {", "lastStartRefusalCode = null")
    assertFalse(
      "闸门 A 拒启路径不得 spawn（否则互锁的成因就变了）",
      gateA.contains("startWithArgs("),
    )
    assertTrue("闸门 A 必须在 return 之前给出结构化原因码", gateA.contains("REFUSAL_LIVE_RUNTIME_INCOMPLETE"))
  }

  /**
   * 拒启分支必须**真的**调恢复，且传的是确诊列表（默认自动路径，`userForced` 缺省 false）。
   *
   * 反证价值：删掉这一句调用、或把它改成不传 `lastStartRefusalConfirmed`，本 issue 即复发。
   */
  @Test
  fun `refusal branch invokes the recovery with the confirmed evidence`() {
    val flow = code("EngineStartFlow.kt")
    val branch = between(flow, "if (!activity.engineManager.startEngine()) {", "activity.runOnUiThread {")
    assertTrue(
      "拒启分支必须调恢复入口",
      branch.contains("maybeRecoverFromIncompleteLiveRuntime("),
    )
    assertTrue(
      "必须传确诊项（否则恢复条件退化成「只要拒启就重抽取」）",
      branch.contains("lastStartRefusalConfirmed"),
    )
    assertFalse("自动路径不得走 userForced 旁路", branch.contains("userForced = true"))
    assertTrue(
      "必须先写 boot-fail 再恢复（取证先于抹现场）",
      branch.indexOf("writeBootFail(") < branch.indexOf("maybeRecoverFromIncompleteLiveRuntime("),
    )
  }

  /** 恢复动作的顺序不可换：标记 -> 删指纹 -> 清账本 -> 取证镜像 -> 落盘文案。 */
  @Test
  fun `recovery order is marker fingerprint ledger evidence then boot fail`() {
    val flow = code("EngineStartFlow.kt")
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    val order = listOf(
      "DAMAGE_MARKER",
      "invalidateSnapshotFreshness()",
      "clearRefreshLedger()",
      "mirrorDiagnosticsToShared(",
      "writeBootFail(",
    )
    var at = -1
    for (token in order) {
      val next = fn.indexOf(token)
      assertTrue("恢复动作缺步骤或顺序错：" + token, next > at)
      at = next
    }
    assertFalse("恢复不得绕过预算判定", fn.contains("runtimeTreeHealedThisRun = true\n\n  try"))
  }

  /** 删除指纹必须经 EngineManager 的具名 API，且**返回值**要影响落盘文案。 */
  @Test
  fun `fingerprint removal is a named API whose failure changes the recorded outcome`() {
    val manager = code("EngineManager.kt")
    assertTrue(
      "必须有具名的指纹失效 API（否则调用方只能就地拼文件路径）",
      manager.contains("fun invalidateSnapshotFreshness(): Boolean"),
    )
    val api = between(manager, "fun invalidateSnapshotFreshness(): Boolean", "var pendingRecoveryFailure")
    assertTrue("必须在删不掉时返回假", api.contains("if (!deleted)") && api.contains("return deleted"))
    val flow = code("EngineStartFlow.kt")
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    assertTrue("恢复侧必须消费返回值", fn.contains("val invalidated ="))
    assertTrue(
      "删不掉指纹时不得写「下次启动将走完整重抽取」（issue #309 第 5 条：文案不得承诺不存在的动作）",
      fn.contains("live-runtime-incomplete-recovery-blocked"),
    )
  }

  /** 错误页的显式出口必须存在，且只在「上一次拒启就是 live 残缺」时触发。 */
  @Test
  fun `error page offers a manual forced recovery only after a live runtime refusal`() {
    val guide = code("GuidePageRenderer.kt")
    val safe = between(guide, "private fun enterSafeMode()", "private companion object {")
    assertTrue(
      "错误页必须调恢复入口（自动路径克制，用户得有显式出口）",
      safe.contains("maybeRecoverFromIncompleteLiveRuntime("),
    )
    assertTrue("必须传 userForced = true", safe.contains("userForced = true"))
    assertTrue(
      "必须先判上一次拒启的原因码，否则会对无关失败白付一次全量重抽取",
      safe.contains("REFUSAL_LIVE_RUNTIME_INCOMPLETE") &&
        safe.indexOf("REFUSAL_LIVE_RUNTIME_INCOMPLETE") < safe.indexOf("maybeRecoverFromIncompleteLiveRuntime("),
    )
  }

  /** 取证必须在**删指纹之前**产生，否则重抽取会抹掉现场（issue #309 建议 3 的取证要求）。 */
  @Test
  fun `evidence is captured before the fingerprint can be deleted`() {
    val manager = code("EngineManager.kt")
    val gateA = between(manager, "if (!liveRuntimeComplete()) {", "lastStartRefusalCode = null")
    val evidenceAt = gateA.indexOf("liveRuntimeEvidence(")
    assertTrue("拒启时必须取证", evidenceAt >= 0)
    assertTrue(
      "取证用的缺失项与决定恢复的缺失项必须来自同一次探测",
      gateA.contains("RuntimeTree.confirmedDamage(missing)"),
    )
    val flow = code("EngineStartFlow.kt")
    val branch = between(flow, "if (!activity.engineManager.startEngine()) {", "activity.runOnUiThread {")
    assertTrue(
      "删指纹在恢复函数里、取证在闸门 A 里 ⇒ 取证天然先于删除",
      branch.indexOf("writeBootFail(") < branch.indexOf("maybeRecoverFromIncompleteLiveRuntime("),
    )
  }

  /** 诊断包必须带上拒启原因/确诊项/现场，否则用户取包时没有可归因的事实。 */
  @Test
  fun `diagnostics package carries the refusal facts`() {
    val manager = code("EngineManager.kt")
    val diag = between(manager, "private fun buildDiagnosticsText(", "EngineProbe.check(")
    for (field in listOf("start_refusal_code", "start_refusal_confirmed", "start_refusal_evidence")) {
      assertTrue("诊断包缺少字段：" + field, diag.contains(field))
    }
  }
}