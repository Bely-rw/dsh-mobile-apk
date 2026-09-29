package com.dsharnessmobile.shell

import android.content.Context
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.annotation.Keep
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Shell/root-side implementation of the ShizukuUserService AIDL contract.
 *
 * v1 only accepted a native-controller-owned argv vector. v2 (0.14.0 §6) adds the privileged shell
 * execution surface required to replace the retired in-snapshot adb transport: relaxed timeouts,
 * large output spooled to a shell-side file with chunked app-side retrieval, and chunked file write
 * for push semantics. The class still never parses engine text itself; callers hand in argv.
 */
class ShizukuUserServiceBridge() : ShizukuUserService.Stub() {
  companion object {
    private const val TAG = "dsh-shizuku-user"
    private const val OUTPUT_LIMIT = 16 * 1024

    /** v3（2026-09-30）：新增 [configure] / [repairOwnership]——root 通道写盘的属主归一。 */
    private const val PROTOCOL_VERSION = 3
    private const val MAX_TIMEOUT_MS = 600_000
    private const val MIN_TIMEOUT_MS = 250
    private const val CHUNK_LIMIT = 512 * 1024
    private const val MAX_CAPTURE_BYTES = 256L * 1024 * 1024
    private const val SPOOL_DIR = "/data/local/tmp/dsh-shizuku"

    /** 单次修复的遍历上限（默认值；调用方可给更小的值，绝不放宽到无界）。 */
    private const val DEFAULT_REPAIR_ENTRIES = 20_000
    private const val MAX_REPAIR_ENTRIES = 200_000

    private val spoolCounter = AtomicInteger(0)

    private fun spoolFile(): File {
      val dir = File(SPOOL_DIR)
      if (!dir.exists()) dir.mkdirs()
      return File(dir, "exec-" + SystemClock.elapsedRealtime() + "-" + spoolCounter.incrementAndGet() + ".out")
    }
  }

  /**
   * 应用侧回填的身份（[configure]）。root 通道里本进程 uid=0，写出来的文件属主是 root:root；
   * 只有知道「本该属于谁」才能把落进应用数据目录的那些修回去。
   */
  @Volatile private var appUid = -1
  @Volatile private var appDataDir = ""

  init {
    Log.i(TAG, "created uid=${Process.myUid()}")
  }

  /** Shizuku API v13 constructor; keep this reflection target from shrinking. */
  @Keep
  constructor(context: Context) : this() {
    Log.i(TAG, "created with context uid=${Process.myUid()} package=${context.packageName}")
  }

  override fun uid(): Int = Process.myUid()

  override fun protocolVersion(): Int = PROTOCOL_VERSION

  // ── v3：属主归一（root 通道写盘污染的自愈面）────────────────────────────────────

  override fun configure(appUid: Int, appDataDir: String) {
    // 校验（fail-closed，2026-09-30 复核补）：本方法的唯一调用者是本应用的 transport，
    // 但 AIDL 面不因此免除自证——uid 必须是应用区间、目录必须是应用数据目录前缀，
    // 且**一次性生效**（已配置则拒绝改写，杜绝「先配好后被换成任意路径」）。
    if (this.appUid > 0) {
      Log.w(TAG, "configure ignored: already configured (appUid=${this.appUid})")
      return
    }
    if (appUid < 10_000 || appUid > 19_999) {
      Log.w(TAG, "configure rejected: implausible app uid $appUid")
      return
    }
    val canonical = runCatching { File(appDataDir).canonicalPath }.getOrNull()
    if (canonical == null || (!canonical.startsWith("/data/user/") && !canonical.startsWith("/data/data/"))) {
      Log.w(TAG, "configure rejected: data dir outside app data roots ($appDataDir)")
      return
    }
    this.appUid = appUid
    this.appDataDir = canonical.trimEnd('/')
    Log.i(TAG, "configured appUid=$appUid dataDir=$canonical")
  }

  /** 应用数据目录内的路径判据（两侧都走 canonical；`/data/data` 与 `/data/user/0` 是同一棵树）。 */
  private fun isUnderAppData(file: File): Boolean {
    if (appDataDir.isEmpty()) return false
    val target = runCatching { file.canonicalPath }.getOrNull() ?: return false
    return target == appDataDir || target.startsWith(appDataDir + "/")
  }

  /**
   * 把单个条目的属主修回应用 uid（**lchown，绝不跟随符号链接**——否则会把链接目标也改掉）。
   * @return true = 本次确实改动了属主。
   */
  private fun repairOne(file: File): Boolean = try {
    val st = android.system.Os.lstat(file.path)
    if (st.st_uid == appUid) {
      false
    } else {
      android.system.Os.lchown(file.path, appUid, appUid)
      true
    }
  } catch (t: Throwable) {
    // 单个条目失败不中断整批（可能是并发删除/无权限的特殊节点）；失败即不算 fixed。
    Log.w(TAG, "repair failed ${file.name}: ${t.javaClass.simpleName}")
    false
  }

  /** 修复后尽力恢复 SELinux 上下文（chown 与 context 是两件事；restorecon 缺席就跳过）。 */
  private fun restoreconBestEffort(path: String) {
    runCatching {
      ProcessBuilder("/system/bin/restorecon", "-R", path).redirectErrorStream(true).start().waitFor()
    }
  }

  /**
   * v3：把 path 子树里**不属于应用 uid** 的条目修回去（有界遍历、不跟随符号链接）。
   *
   * 只认「已配置的应用 uid」——这不是通用 chown 面（AIDL 不接受任意 uid/gid），
   * 且路径必须在应用数据目录内（越界结构化拒绝）。未 configure 时同样拒绝。
   */
  override fun repairOwnership(path: String, maxEntries: Int): Bundle {
    val out = Bundle()
    val uid = appUid
    if (uid <= 0 || appDataDir.isEmpty()) {
      out.putBoolean("ok", false)
      out.putString("error", "not-configured")
      return out
    }
    if (!isAbsolute(path)) {
      out.putBoolean("ok", false)
      out.putString("error", "requires absolute path")
      return out
    }
    val target = File(path)
    if (!isUnderAppData(target)) {
      out.putBoolean("ok", false)
      out.putString("error", "out-of-app-data")
      return out
    }
    val cap = (if (maxEntries > 0) maxEntries else DEFAULT_REPAIR_ENTRIES).coerceAtMost(MAX_REPAIR_ENTRIES)
    var scanned = 0
    var fixed = 0
    var truncated = false
    val stack = ArrayDeque<File>()
    stack.addLast(target)
    while (stack.isNotEmpty()) {
      if (scanned >= cap) {
        truncated = true
        break
      }
      val file = stack.removeLast()
      scanned++
      if (repairOne(file)) fixed++
      if (file.isDirectory && !SnapshotFs.isSymbolicLink(file)) {
        runCatching { file.listFiles()?.forEach { stack.addLast(it) } }
      }
    }
    if (fixed > 0) restoreconBestEffort(target.path)
    // 截断 = 没修完（未扫到的条目还留着）⇒ **报失败**，不让上层把它计入成功。
    out.putBoolean("ok", !truncated)
    if (truncated) out.putString("error", "repair-truncated: entry cap reached, part of the tree was not scanned")
    out.putInt("scanned", scanned)
    out.putInt("fixed", fixed)
    out.putBoolean("truncated", truncated)
    return out
  }

  /**
   * 写盘后自愈：把刚写的文件与 mkdirs 出来的父目录（一路到应用数据目录为止）修回应用 uid。
   * 只在路径落在应用数据目录内且已 configure 时动作；任何失败都不影响写入结果本身。
   *
   * 守卫（2026-09-30 复核补）：**目标本身不得等于应用数据目录根**——否则一次
   * `writeChunk("/data/user/0/<pkg>", …)` 会把整个数据目录（含系统建的 `databases/`、
   * `shared_prefs/`）一并 chown；范围放大不是越界，但没有任何调用方需要它。
   */
  private fun repairAfterWrite(file: File) {
    if (appUid <= 0 || !isUnderAppData(file)) return
    val canon = runCatching { file.canonicalPath }.getOrNull() ?: return
    if (canon == appDataDir) return
    var fixedAny = repairOne(file)
    var parent = file.parentFile
    while (parent != null && isUnderAppData(parent)) {
      if (parent.path == appDataDir) break
      if (repairOne(parent)) fixedAny = true
      parent = parent.parentFile
    }
    if (fixedAny) restoreconBestEffort(file.path)
  }

  override fun exec(argv: Array<String>, timeoutMs: Int): Bundle {
    val out = Bundle()
    if (argv.isEmpty() || argv.any { it.isEmpty() }) {
      out.putBoolean("ok", false)
      out.putString("error", "empty argv")
      return out
    }
    return try {
      val process = ProcessBuilder(argv.toList()).redirectErrorStream(true).start()
      val text = StringBuilder()
      BufferedReader(InputStreamReader(process.inputStream, Charsets.UTF_8)).useLines { lines ->
        for (line in lines) {
          if (text.length >= OUTPUT_LIMIT) break
          text.append(line).append('\n')
        }
      }
      val completed = process.waitFor(timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).toLong(), TimeUnit.MILLISECONDS)
      if (!completed) process.destroyForcibly()
      out.putBoolean("ok", completed && process.exitValue() == 0)
      out.putInt("exitCode", if (completed) process.exitValue() else -1)
      out.putString("stdout", text.toString().take(OUTPUT_LIMIT))
      if (!completed) out.putString("error", "controller command timed out")
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  /**
   * v2 large-output execution: stdout/stderr stream to a shell-side spool file while the first
   * `inlineBytes` stay inline for small-output callers. The timeout is enforced on a reader thread
   * so a silent hang is still reclaimed, and the spool file is capped to protect shell storage.
   */
  override fun execCapture(argv: Array<String>, timeoutMs: Int, inlineBytes: Int): Bundle {
    val out = Bundle()
    if (argv.isEmpty() || argv.any { it.isEmpty() }) {
      out.putBoolean("ok", false)
      out.putString("error", "empty argv")
      return out
    }
    val inlineLimit = inlineBytes.coerceIn(0, OUTPUT_LIMIT)
    val file = spoolFile()
    var total = 0L
    var truncated = false
    return try {
      val process = ProcessBuilder(argv.toList()).redirectErrorStream(true).start()
      val reader = Thread {
        try {
          FileOutputStream(file).use { sink ->
            val inline = ByteArrayOutputStream()
            process.inputStream.use { input ->
              val buf = ByteArray(64 * 1024)
              while (true) {
                val n = input.read(buf)
                if (n < 0) break
                if (total < MAX_CAPTURE_BYTES) {
                  val room = (MAX_CAPTURE_BYTES - total).coerceAtMost(n.toLong()).toInt()
                  sink.write(buf, 0, room)
                  total += room
                  if (room < n) truncated = true
                } else {
                  truncated = true
                }
                if (inline.size() < inlineLimit) {
                  inline.write(buf, 0, minOf(n, inlineLimit - inline.size()))
                }
              }
            }
            sink.flush()
            out.putByteArray("inline", inline.toByteArray())
          }
        } catch (t: Throwable) {
          out.putString("readError", t.javaClass.simpleName + ": " + (t.message ?: ""))
        }
      }
      reader.isDaemon = true
      reader.start()
      val completed = process.waitFor(
        timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).toLong(),
        TimeUnit.MILLISECONDS,
      )
      if (!completed) process.destroyForcibly()
      reader.join(2_000)
      out.putBoolean("ok", completed && process.exitValue() == 0)
      out.putInt("exitCode", if (completed) process.exitValue() else -1)
      out.putString("path", file.absolutePath)
      out.putLong("size", total)
      out.putBoolean("truncated", truncated)
      if (!out.containsKey("inline")) out.putByteArray("inline", ByteArray(0))
      if (!completed) out.putString("error", "command timed out after ${timeoutMs}ms")
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  /** @return null = 远端不可读（缺失 / 权限）；空数组 = 已到 EOF；其余为该段字节。 */
  override fun readChunk(path: String, offset: Long, length: Int): ByteArray? {
    if (!isAbsolute(path)) return null
    val file = File(path)
    if (!file.isFile) return null
    if (offset >= file.length()) return ByteArray(0)
    val size = length.takeIf { it > 0 }?.coerceAtMost(CHUNK_LIMIT) ?: CHUNK_LIMIT
    return try {
      RandomAccessFile(file, "r").use { raf ->
        if (offset > 0) raf.seek(offset)
        val buf = ByteArray(size)
        var read = 0
        while (read < size) {
          val n = raf.read(buf, read, size - read)
          if (n < 0) break
          read += n
        }
        if (read == size) buf else buf.copyOf(read)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "readChunk failed ${file.name}: ${t.javaClass.simpleName}")
      null
    }
  }

  override fun writeChunk(path: String, data: ByteArray, append: Boolean): Bundle {
    val out = Bundle()
    if (!isAbsolute(path)) {
      out.putBoolean("ok", false)
      out.putString("error", "requires absolute path")
      return out
    }
    return try {
      val file = File(path)
      file.parentFile?.let { if (!it.exists()) it.mkdirs() }
      FileOutputStream(file, append).use { sink -> sink.write(data) }
      // v3（2026-09-30）：root 通道（本进程 uid=0）写进应用数据目录的文件，属主会变成 root:root
      // ⇒ 应用侧 0600 读不回来（watcher/插件/引擎读写全崩）。写后立即自愈成应用 uid。
      repairAfterWrite(file)
      // **回读验证**（2026-09-30 复核补）：不回读就是「报成功、但应用仍读不回来」的静默失败——
      // 只在路径确实落在应用数据目录内、且已 configure 时才要求属主已归位。
      val ownerOk = appUid <= 0 || !isUnderAppData(file) ||
        runCatching { android.system.Os.lstat(file.path).st_uid == appUid }.getOrDefault(false)
      out.putBoolean("ok", ownerOk)
      if (!ownerOk) out.putString("error", "ownership not repaired: file is still not owned by the app uid")
      out.putString("path", file.absolutePath)
      out.putLong("size", file.length())
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  override fun removePath(path: String): Bundle {
    val out = Bundle()
    if (!isAbsolute(path)) {
      out.putBoolean("ok", false)
      out.putString("error", "requires absolute path")
      return out
    }
    return try {
      val file = File(path)
      val removed = when {
        // 审查 I-9：远端删除同样不得跟随符号链接（删链接本身而不是它的目标）——
        // NOFOLLOW 原语删完再复查存在性，removed 语义与旧实现一致（删不净即失败）。
        file.isDirectory && !SnapshotFs.isSymbolicLink(file) -> {
          SnapshotFs.deletePath(file)
          !SnapshotFs.exists(file)
        }
        else -> !SnapshotFs.exists(file) || file.delete()
      }
      out.putBoolean("ok", removed)
      if (!removed) out.putString("error", "delete failed")
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  /** Reserved Shizuku transaction: remove the remote user-service process cleanly. */
  override fun destroy() {
    Log.i(TAG, "destroy")
    System.exit(0)
  }

  private fun isAbsolute(path: String): Boolean = path.startsWith("/") && path.length > 1
}
