package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 应用级 root 授权面（2026-09-30 主人定例：「这个开关应该调用一下 root 弹窗，并且检测 root
 * 是否授权，如果没有，请写好引导去 Root 管理器，授予 root」）。
 *
 * ── 与 [RootGrant] / [ShizukuTransport] 的分工（三层，别混）────────────────────
 *  1. **本对象** = 应用自身有没有 root 的事实面：`su -c id` 取一次真实身份（uid 0 与否）。
 *  2. [RootGrant] = 「AI root 权限」开关位与免责确认（策略门 + 知情同意门）。
 *  3. [ShizukuTransport] = 特权执行通道；其身份（uid 0 / 2000）决定通道是不是 root。
 *
 * ── ★授权框的现实（2026-09-30 主人指正，别再假设统一行为）────────────────────
 * **多数 Root 管理器（KernelSU / SukiSU 等）不再自动弹授权框** —— 除 Magisk 外，用户得
 * 自己打开管理器授予 ✗。所以：
 *  - 不承诺"点一下就会弹窗"（旧注释与旧文案这么写，是把管理器行为当成了统一的 ✗）；
 *  - **不做「打开 Root 管理器」入口**：各家管理器包名/入口不一（还可能根本没管理器 App，
 *    如部分 ROM 内置 su），打开不保证成功；而"能刷 root 的人自己会开管理器"（主人原话口径）⇒
 *    只做**诚实引导**（识别到管理器就报它的名字，识别不到就说"你使用的 Root 管理器"）✓。
 *  - 因此状态读面 `state()` 是**纯读**（读缓存 + su 是否存在），永不触发任何管理器交互；
 *    `requestGrant()` 只在用户显式点按钮时跑一次 `su -c id`（成功即证明已授权 ✓，
 *    失败/超时如实回报，绝不猜）✓。
 *
 * ── su 调用纪律 ──────────────────────────────────────────────────────────────
 *  - 后台线程执行 + 有界超时（[REQUEST_TIMEOUT_MS]，给用户在管理器上操作的时间）；
 *  - 超时即 `destroyForcibly()`，不留挂死进程；
 *  - 判据是输出里的 `uid=0`（`su -c id` 的真实身份），不是退出码（各家 su 退出码语义不一）；
 *  - 任何异常都不抛出，一律落成结构化状态（fail-closed：未知就是未知）。
 */
object RootAccess {

  /** su 候选路径（按常见顺序；不限于 root 管理器自带的那份）。 */
  private val SU_PATHS = listOf(
    "/system/bin/su",
    "/system/xbin/su",
    "/sbin/su",
    "/data/adb/ksu/bin/su",
    "/data/adb/magisk/su",
    "/debug_ramdisk/su",
  )

  /** Root 管理器包名 → 显示名（顺序即识别优先级）。 */
  private val MANAGERS = listOf(
    "me.weishu.kernelsu" to "KernelSU",
    "com.topjohnwu.magisk" to "Magisk",
    "me.bmax.apatch" to "APatch",
  )

  /** 授权请求的总预算：要留出用户在弹窗上点「允许」的时间（KernelSU 默认弹窗本身约 30s）。 */
  private const val REQUEST_TIMEOUT_MS = 25_000L

  private const val PREFS = "dsh_root_access"
  private const val KEY_STATE = "state"
  private const val KEY_UID = "uid"

  private val lock = Any()
  @Volatile private var requesting = false
  /** 内存态；进程重启后由 prefs 回填（见 [cachedState]）。 */
  @Volatile private var memState: String? = null

  /** 状态取值（互斥，全部如实；未知不用默认值冒充）。 */
  const val STATE_UNKNOWN = "unknown"     // 从未请求过（或本机无 su）
  const val STATE_REQUESTING = "requesting" // 弹窗已弹出，等用户在管理器上确认
  const val STATE_GRANTED = "granted"     // 已授权（uid 0）
  const val STATE_DENIED = "denied"       // 用户在弹窗上拒绝 / su 明确失败
  const val STATE_TIMEOUT = "timeout"     // 弹窗无响应（用户没点）
  const val STATE_NO_SU = "no-su"         // 本机没有可执行的 su（未 root 或未装管理器）

  /** 找到可执行的 su 路径；没有则 null（纯读，不触发任何弹窗）。 */
  fun suPath(): String? = SU_PATHS.firstOrNull { runCatching { File(it).canExecute() }.getOrDefault(false) }

  /** 本机是否装了已知的 Root 管理器（纯读）。 */
  fun manager(context: Context): Pair<String, String>? {
    val pm = context.packageManager
    return MANAGERS.firstOrNull { (pkg, _) ->
      runCatching { pm.getPackageInfo(pkg, 0); true }.getOrDefault(false)
    }
  }

  /** 缓存的授权状态（内存优先；无则读 prefs；都没有 = 未检测）。 */
  private fun cachedState(context: Context): Pair<String, Int> {
    memState?.let { return it to uidValue(context) }
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val s = prefs.getString(KEY_STATE, STATE_UNKNOWN) ?: STATE_UNKNOWN
    memState = s
    return s to prefs.getInt(KEY_UID, -1)
  }

  private fun uidValue(context: Context): Int =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_UID, -1)

  /** 当前是否已授权（供 [RootGrant] 的策略门消费；只认缓存，不触发弹窗）。 */
  fun isGranted(context: Context): Boolean {
    if (suPath() == null) return false
    return cachedState(context).first == STATE_GRANTED
  }

  private fun writeState(context: Context, state: String, uid: Int) {
    memState = state
    runCatching {
      context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString(KEY_STATE, state).putInt(KEY_UID, uid).apply()
    }
  }

  /**
   * 状态读面（**永不触发弹窗**）。字段：
   * `suExists` / `state` / `uid` / `granted` / `requesting` / `manager{package,label,installed}` / `guidance`。
   */
  fun state(context: Context): JSONObject {
    val su = suPath()
    val (state, uid) = cachedState(context)
    val effective = if (su == null && state != STATE_REQUESTING) STATE_NO_SU else state
    val mgr = manager(context)
    val out = JSONObject()
      .put("suExists", su != null)
      .put("suPath", su ?: "")
      .put("state", effective)
      .put("uid", if (effective == STATE_GRANTED) uid else -1)
      .put("granted", effective == STATE_GRANTED)
      .put("requesting", requesting)
    out.put(
      "manager",
      JSONObject()
        .put("package", mgr?.first ?: "")
        .put("label", mgr?.second ?: "")
        .put("installed", mgr != null),
    )
    out.put("guidance", guidance(effective, mgr?.second))
    return out
  }

  /**
   * 每态都能说清「下一步做什么」（页面直接展示，不静默）。
   *
   * 口径（2026-09-30 主人指正）：**多数 Root 管理器（KernelSU / SukiSU 等）不再自动弹授权框**
   * ——除 Magisk 外，用户得自己打开管理器授予 ✗ ⇒ 引导语一律说「在你使用的 Root 管理器里允许本应用」，
   * **不承诺"点一下就会弹窗"** ✗（旧文案这么写，是把管理器行为当成了统一的 ✗）。
   * 管理器名只在**识别到时**作为提示带上（识别不到就说"你使用的 Root 管理器"，不猜 ✗）。
   */
  private fun guidance(state: String, managerLabel: String?): String = when (state) {
    STATE_GRANTED -> "已获得 root 授权（uid 0）。"
    STATE_REQUESTING -> "正在等待 root 授权结果——若管理器没有弹出授权框，请自己打开" +
      (managerLabel ?: "你使用的 Root 管理器") + "允许本应用。"
    STATE_DENIED -> "root 授权被拒绝——请在" + (managerLabel ?: "你使用的 Root 管理器") +
      "里允许本应用使用 root，然后回到本页重新检测。"
    STATE_TIMEOUT -> "root 授权没有结果——请在" + (managerLabel ?: "你使用的 Root 管理器") +
      "里允许本应用后重试。"
    STATE_NO_SU -> "本机没有可用的 su（未 root 或未安装 Root 管理器）——请先在" +
      (managerLabel ?: "你使用的 Root 管理器") + "中完成 root，再回到本页。"
    else -> "尚未检测——点「检测 root 授权」会尝试取一次 root 身份（多数管理器不会自动弹授权框，需你在管理器里允许）。"
  }

  /**
   * 显式请求 root 授权：后台跑 `su -c id`（**这一步会触发管理器的授权弹窗**），立即返回。
   *
   * 幂等：已有请求在飞时不重复起（否则用户会看到一堆弹窗）。
   * 结果（granted / denied / timeout）写回缓存，页面靠既有 2s 轮询看到。
   */
  fun requestGrant(context: Context): JSONObject {
    val app = context.applicationContext
    val su = suPath() ?: run {
      writeState(app, STATE_NO_SU, -1)
      return state(app).put("ok", false).put("code", "no-su")
    }
    synchronized(lock) {
      if (requesting) return state(app).put("ok", true).put("code", "already-requesting")
      requesting = true
    }
    writeState(app, STATE_REQUESTING, -1)
    Thread({
      var state = STATE_DENIED
      var uid = -1
      try {
        val process = ProcessBuilder(su, "-c", "id").redirectErrorStream(true).start()
        // **有界读取**（门禁 `check-bounded-io.mjs` 强制）：裸 `inputStream.readText()` 会读到 EOF
        // 才返回 ⇒ 超时形同虚设（用户在弹窗上不点、进程不退出时永久阻塞）；且「先 waitFor 再读」
        // 还会被子进程写满管道缓冲（~64KB）反卡。`ProcIo.readBounded` 同时给出三态
        // （exitTimedOut / drainTimedOut / truncated），「弹窗没响应」与「拒绝」得以分开。
        val result = ProcIo.readBounded(process, REQUEST_TIMEOUT_MS / 1000, 64 * 1024)
        state = when {
          result.exitTimedOut -> STATE_TIMEOUT
          result.text.contains("uid=0") -> {
            uid = 0
            STATE_GRANTED
          }
          else -> STATE_DENIED
        }
      } catch (t: Throwable) {
        state = STATE_DENIED
      } finally {
        writeState(app, state, uid)
        synchronized(lock) { requesting = false }
      }
    }, "dsh-root-request").start()
    return state(app).put("ok", true).put("code", "request-started")
  }

  // ── su 直连执行面（2026-09-30 主人定例：「我们不是做 root 适配吗」）──────────────────
  //
  // 为什么要有它：issue #262 的通道设计建立在 Shizuku 上（写 issue 的测试机 su 不可达），
  // 但**本机 su 是好的**（KernelSU）。让 root 能力只依赖 Shizuku，等于把「能不能用 root」
  // 押在另一个应用的授权与运行状态上——Shizuku 一旦未授权/未以 root 启动，整条链就死。
  // 这里给出直连 su 的执行与自愈面：应用自身获 Root 管理器授权即可用，不经过 Shizuku。

  /**
   * 以 root 执行一条命令（`su -c <command>`），捕获 stdout/stderr/退出码。
   *
   * 纪律：①要求**已授权**（未授权时 su 会弹窗——模型驱动的批量操作绝不能靠弹窗推进，
   * 如实回 `root-not-granted` 让页面引导用户去授权）；②有界超时；③超时即 `destroyForcibly`。
   *
   * 每个失败分支都带 `reason`（= code）：页面对 `ok:false` 只读 `reason` 翻人话
   * （`user-copy.ts` 的 CALL_REASON 唯一真源），只带 code 会落「未在本版登记」兜底。
   */
  fun execRoot(context: Context, command: String, timeoutMs: Int = 20_000): JSONObject {
    if (command.isBlank()) return fail("empty-command", "命令为空。")
    val su = suPath() ?: return fail("no-su", "本机没有可用的 su。")
    if (!isGranted(context)) {
      // 授权请求在飞时如实说「等待中」，不要报成「未授权」——那会让用户在弹窗还开着时看到莫名错误。
      return if (requesting) {
        fail("requesting", "root 授权框已弹出，请在手机上点「允许」后重试。")
      } else {
        fail("root-not-granted", "应用尚未获得 root 授权——请到设置页「手机控制」点「请求 root 授权」并在弹窗上允许。")
      }
    }
    val timeout = timeoutMs.coerceIn(500, 600_000)
    return try {
      val process = ProcessBuilder(su, "-c", command).redirectErrorStream(false).start()
      // 双流各自在 **daemon** 读线程里收集；缓冲区在 join 之后才读，避免跨线程可见性问题。
      val outRef = java.util.concurrent.atomic.AtomicReference("")
      val errRef = java.util.concurrent.atomic.AtomicReference("")
      val outThread = Thread { streamReaderBody(process.inputStream, outRef) }
      outThread.isDaemon = true
      outThread.start()
      val errThread = Thread { streamReaderBody(process.errorStream, errRef) }
      errThread.isDaemon = true
      errThread.start()
      val finished = process.waitFor(timeout.toLong(), TimeUnit.MILLISECONDS)
      if (!finished) {
        // destroy() 不保证杀掉 su 起的孙进程（shell 里带后台任务时管道仍被持住）⇒ 强杀 + 短等。
        runCatching { process.destroyForcibly() }
        runCatching { process.waitFor(1, TimeUnit.SECONDS) }
        outThread.join(500)
        errThread.join(500)
        return JSONObject().put("ok", false).put("code", "su-timeout").put("reason", "su-timeout")
          .put("transport", "su").put("stdout", outRef.get()).put("stderr", errRef.get())
          .put("guidance", "root 命令超时（${timeout}ms）后被终止。")
      }
      outThread.join(1_000)
      errThread.join(1_000)
      val exit = process.exitValue()
      JSONObject()
        .put("ok", exit == 0)
        .put("transport", "su")
        .put("exitCode", exit)
        .put("stdout", outRef.get())
        .put("stderr", errRef.get())
        .put("error", if (exit == 0) "" else "exit=$exit")
    } catch (t: Throwable) {
      // 异常只进日志，不上屏（页面文案一律来自 CALL_REASON 真源）。
      android.util.Log.w("dsh-root", "execRoot failed: " + t.javaClass.simpleName + ": " + (t.message ?: ""))
      fail("su-exec-failed", "root 命令执行失败——请稍后重试；多次失败可复制日志反馈。")
    }
  }

  /**
   * 读一条子进程流到 [sink]（daemon 线程体）。**收集完才 set**：缓冲区不跨线程共享，
   * 避免 StringBuilder 并发写（旧实现两线程共写一个非线程安全缓冲，超时后仍在写）。
   */
  private fun streamReaderBody(stream: java.io.InputStream, sink: java.util.concurrent.atomic.AtomicReference<String>) {
    val buf = StringBuilder()
    runCatching { stream.bufferedReader().forEachLine { buf.append(it).append('\n') } }
    sink.set(buf.toString())
  }

  /** 结构化失败（`ok:false` + `code` + `reason` 同码 + 人话 guidance）。 */
  private fun fail(code: String, guidance: String): JSONObject = JSONObject()
    .put("ok", false).put("code", code).put("reason", code).put("guidance", guidance)

  /** shell 单引号安全包裹（路径可能含空格/引号；命令由本文件拼，不接受调用方原始拼接）。 */
  private fun shq(raw: String): String = "'" + raw.replace("'", "'\\''") + "'"

  /**
   * su 版属主修复（不依赖 Shizuku 通道）：把 [path] 子树里不属于本应用 uid 的条目 chown 回来，
   * 再尽力 restorecon。路径必须在应用数据目录内（canonical 前缀，fail-closed）。
   *
   * @return `{ok, scanned, fixed, truncated, error?}`（与 Shizuku 版同构，调用方无感切换）
   */
  fun repairOwnership(context: Context, path: String, maxEntries: Int = 20_000): JSONObject {
    if (!isGranted(context)) {
      return JSONObject().put("ok", false).put("code", "root-not-granted")
        .put("guidance", "应用尚未获得 root 授权——无法修复属主。")
    }
    val app = context.applicationContext
    val dataDir = runCatching { app.filesDir.parentFile?.canonicalPath }.getOrNull()
      ?: return fail("no-data-dir", "读不到应用数据目录。")
    val target = runCatching { java.io.File(path).canonicalPath }.getOrNull()
      ?: return fail("bad-path", "路径无法解析。")
    if (target != dataDir && !target.startsWith(dataDir + "/")) {
      return fail("out-of-app-data", "只修应用数据目录内的文件。")
    }
    val uid = android.os.Process.myUid()
    val cap = maxEntries.coerceIn(1, 200_000)
    // 一趟脚本：先数、再改、再复查**残余**（REMAIN 才是「真修好了吗」的判据）。
    // 退出码必须反映 chown 结果——以 `echo` 结尾会让退出码恒 0 ⇒ chown 全失败也报 ok（静默失败）。
    // ⚠️ **不加 `-P`**：Android 的 toybox find 只认 `[-HL]`，`-P` 会被判 `bad arg`（2026-09-30 真机
    // 实测：加了它整条修复脚本失败、属主一条没修）；而 find 的**默认行为本就不跟随符号链接**
    // （等价于 GNU 的 -P）⇒ 不加参数即是想要的安全语义。`-xdev` 不跨文件系统。
    // 注意 Kotlin 字符串里的 `\$` 是**转义**（`$P` 会被当成本文件的变量插值，编译期 Unresolved reference）。
    val script = "P=" + shq(target) + "; " +
      "N=\$(find \"\$P\" -xdev -not -user " + uid + " 2>/dev/null | wc -l); " +
      "find \"\$P\" -xdev -not -user " + uid +
      " -exec chown " + uid + ":" + uid + " {} + 2>/dev/null; C=\$?; " +
      "restorecon -R \"\$P\" 2>/dev/null; " +
      "R=\$(find \"\$P\" -xdev -not -user " + uid + " 2>/dev/null | wc -l); " +
      "S=\$(find \"\$P\" -xdev 2>/dev/null | wc -l); " +
      "echo \"SCANNED=\$S FIXED=\$N REMAIN=\$R CHOWN_RC=\$C\"; exit \$C"
    val result = execRoot(app, script, 120_000)
    val stdout = result.optString("stdout")
    val scanned = Regex("SCANNED=(\\d+)").find(stdout)?.groupValues?.get(1)?.toIntOrNull() ?: 0
    val fixed = Regex("FIXED=(\\d+)").find(stdout)?.groupValues?.get(1)?.toIntOrNull() ?: 0
    val remain = Regex("REMAIN=(\\d+)").find(stdout)?.groupValues?.get(1)?.toIntOrNull() ?: -1
    val truncated = scanned > cap
    // 成功判据 = 命令成功 **且** 残余为 0 **且** 未截断（拿不到 REMAIN 时按未证实处理，fail-closed）。
    // 截断时必须报失败：未扫到的条目还留着，报 ok 就是「修了一半当修好了」（静默失败形态）。
    val ok = result.optBoolean("ok") && remain == 0 && !truncated
    return JSONObject()
      .put("ok", ok)
      .put("transport", "su")
      .put("scanned", scanned)
      .put("fixed", fixed)
      .put("remaining", remain)
      .put("truncated", truncated)
      .put("error", result.optString("error"))
      .put("reason", if (ok) "" else result.optString("reason").ifBlank { if (truncated) "repair-truncated" else "repair-incomplete" })
      .put("code", if (ok) "" else result.optString("code").ifBlank { if (truncated) "repair-truncated" else "repair-incomplete" })
      .put("guidance", if (ok) "" else result.optString("guidance").ifBlank { "属主修复未完成（残余 $remain 项）" })
  }
}
