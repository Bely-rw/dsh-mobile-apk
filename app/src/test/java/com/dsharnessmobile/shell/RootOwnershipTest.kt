package com.dsharnessmobile.shell

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * root 通道写盘**属主污染**的自愈面回归（2026-09-30 主人定例：「这个 root 适配不是单纯加个门，
 * Root 属主这种 bug 也得找一找修一修」）。
 *
 * 缺陷本体（本次排查结论）：Shizuku 以 root 启动时 UserService 的 uid=0，它写的每个文件属主
 * 都是 root:root；一旦落在应用数据目录（files/...）里，应用（u0_a241）就**读不回来**
 * （0600 root 属主）⇒ watcher / 插件更新 / 引擎读写失败。全仓此前**零 chown 处理**（grep 实证）。
 *
 * 本文件钉的是「修法不得被无声拆掉」——chown 面依赖 Android/root 环境，JVM 侧无法真跑，
 * 与包名/结算契约同款：用源码契约锁住关键接线与拒收分支。
 */
class RootOwnershipTest {

  private fun source(rel: String): String = listOf(
    File("src/main/$rel"),
    File("app/src/main/$rel"),
  ).firstOrNull { it.isFile }?.readText()
    ?: throw AssertionError("找不到 $rel")

  /** AIDL v3 必须声明 configure + repairOwnership（协议面缺失 ⇒ 归一化能力不存在）。 */
  @Test
  fun `aidl declares configure and repairOwnership`() {
    val aidl = source("aidl/com/dsharnessmobile/shell/ShizukuUserService.aidl")
    assertTrue("AIDL 必须声明 configure(appUid, appDataDir)", aidl.contains("void configure(int appUid, String appDataDir)"))
    assertTrue("AIDL 必须声明 repairOwnership(path, maxEntries)", aidl.contains("Bundle repairOwnership(in String path, int maxEntries)"))
    assertTrue("协议版本必须随 v3 面走", source("java/com/dsharnessmobile/shell/ShizukuUserService.kt").contains("PROTOCOL_VERSION = 3"))
  }

  /** writeChunk（root 通道写盘）必须写后自愈属主——这是 shPush 语义落进应用目录的唯一防线。 */
  @Test
  fun `writeChunk repairs ownership after write`() {
    val impl = source("java/com/dsharnessmobile/shell/ShizukuUserService.kt")
    val body = Regex("override fun writeChunk[\\s\\S]*?\\n  \\}").find(impl)?.value
      ?: throw AssertionError("找不到 writeChunk 实现")
    assertTrue("writeChunk 必须调用 repairAfterWrite（写后自愈属主）", body.contains("repairAfterWrite(file)"))
  }

  /**
   * repairOwnership 的两条硬约束：①未 configure（不知道应用 uid）必须拒绝；
   * ②路径必须落在应用数据目录内（越界拒绝）——它不是通用 chown 面。
   */
  @Test
  fun `repairOwnership fails closed without configuration and outside app data`() {
    val impl = source("java/com/dsharnessmobile/shell/ShizukuUserService.kt")
    val body = Regex("override fun repairOwnership[\\s\\S]*?\\n  \\}").find(impl)?.value
      ?: throw AssertionError("找不到 repairOwnership 实现")
    assertTrue("未 configure 必须结构化拒绝（not-configured）", body.contains("not-configured"))
    assertTrue("越界路径必须拒绝（out-of-app-data）", body.contains("out-of-app-data"))
    assertTrue("必须做应用数据目录前缀校验", body.contains("isUnderAppData(target)"))
    assertTrue("遍历必须有界（truncated 如实回报）", body.contains("truncated"))
  }

  /**
   * 属主归一用 **lchown**：绝不跟随符号链接（chown 跟随会改到链接目标——应用目录里
   * 指向 /storage 之类的链接会被误伤）。判据钉在实现里，防「顺手换成 chown」。
   */
  @Test
  fun `repair uses lchown not chown`() {
    val impl = source("java/com/dsharnessmobile/shell/ShizukuUserService.kt")
    assertTrue("必须用 Os.lchown（不跟随符号链接）", impl.contains("Os.lchown"))
    assertTrue("不得使用跟随链接的 Os.chown", !impl.contains("Os.chown("))
  }

  /** Transport 侧：绑定后必须回填身份；自愈只在**两条 root 路径任一可用**时动作。 */
  @Test
  fun `transport configures after bind and heals with a root path`() {
    val t = source("java/com/dsharnessmobile/shell/ShizukuTransport.kt")
    assertTrue("readyService 必须回填身份（configureIfNeeded）", t.contains("configureIfNeeded(context)"))
    val heal = Regex("fun autoHealOwnership[\\s\\S]*?\\n  \\}").find(t)?.value
      ?: throw AssertionError("找不到 autoHealOwnership")
    assertTrue("两条 root 路径都不可用才跳过（no-root-path）", heal.contains("no-root-path"))
    assertTrue("必须只修 root 属主的条目", heal.contains("owner == 0"))
    assertTrue("su 直连优先（不依赖 Shizuku 授权/运行状态）", heal.contains("RootAccess.repairOwnership"))
    assertTrue("逐项失败必须计数并如实暴露（failures）", heal.contains("failures"))
  }

  /** 应用启动必须有自愈入口（延后执行、不阻塞启动路径）。 */
  @Test
  fun `main activity schedules a bounded startup heal`() {
    val m = source("java/com/dsharnessmobile/shell/MainActivity.kt")
    assertTrue("MainActivity 必须排一次启动自愈", m.contains("autoHealOwnership"))
    assertTrue("自愈必须在后台线程（不阻塞启动）", m.contains("dsh-root-owner-heal"))
  }

  /**
   * 2026-09-30 主人一问（「root 属主会导致无法启动，你在设置里弄真有用吗」）换来的两条判据：
   * ①**启动前置自愈**必须在快照判定/引擎启动之前跑（污染在咬人前被清掉）；
   * ②**失败相位自动自愈**——启动挂了的用户停在引导页，修复不能依赖他找到设置页按钮。
   */
  @Test
  fun `heal runs before the boot decision and on the failure phase`() {
    val flow = source("java/com/dsharnessmobile/shell/EngineStartFlow.kt")
    val healAt = flow.indexOf("autoHealOwnership")
    val freshAt = flow.indexOf("snapshotFresh()")
    assertTrue("启动流必须有前置自愈", healAt >= 0)
    assertTrue("前置自愈必须在快照判定之前（否则启动已挂）", freshAt > 0 && healAt < freshAt)
    val guide = source("java/com/dsharnessmobile/shell/GuidePageRenderer.kt")
    assertTrue("失败相位必须自动自愈", guide.contains("autoRepairOwnershipOnFailure()"))
    assertTrue("失败相位自愈必须防重入", guide.contains("ownershipRepairRunning"))
    assertTrue("失败相位自愈的结果必须如实写进提示（修好才说话）", guide.contains("已自动修复"))
  }

  /**
   * 子进程输出**必须有界读取**（门禁 `check-bounded-io.mjs` 强制）：读到 EOF 才返回的裸读法
   * ⇒ 超时参数形同虚设（用户在弹窗上不点时永久阻塞）。本仓为此有过全局锁死的实锤。
   */
  @Test
  fun `root access reads subprocess output through ProcIo`() {
    val impl = source("java/com/dsharnessmobile/shell/RootAccess.kt")
    assertTrue("su 调用必须走 ProcIo.readBounded（有界 + 三态）", impl.contains("ProcIo.readBounded"))
    // 判据看**代码**不看注释：按行剔除注释行后再断言（注释里提到该 API 名属正常说明）。
    val codeOnly = impl.lines().filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }.joinToString("\n")
    assertTrue("代码里不得出现裸 readText()（无界，超时失效）", !codeOnly.contains("readText()"))
  }

  /**
   * 属主修复的成功判据必须是**残余为 0**，不是「命令退出码 0」：
   * 脚本以 echo 结尾时退出码恒 0 ⇒ chown 全失败也会报 ok（静默失败）。
   */
  @Test
  fun `repair success requires zero remaining entries`() {
    val impl = source("java/com/dsharnessmobile/shell/RootAccess.kt")
    assertTrue("脚本必须回报 REMAIN（残余条目数）", impl.contains("REMAIN="))
    assertTrue("ok 判据必须含 remain == 0", impl.contains("remain == 0"))
  }
}
