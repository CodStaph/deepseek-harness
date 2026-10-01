/**
 * 运行时管控层 · 机制 3：按目标的写锁（EffectWriteLock）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.7（第 1927–1955 行）
 * 阶段：S18（批次 3b，M3 智能体运行语义）——并发子代理写冲突控制机制二。
 *
 * 语义要点（方案 §5.7）：
 * - 同一文件路径（写效果目标）的写效果串行化，不同路径并行——防并行子代理写同一
 *   文件时内容交错损坏（验收 R23）。
 * - 锁粒度是**效果目标**（realpath 规范化后的绝对路径），不是插件——两个不同插件
 *   写同一文件同样串行（与 R11 fiber 隔离精神正交，补写冲突维度）。
 * - 适用于 fs.write / fs.trash / fs.delete-permanent / env.set；fs.read 不加锁
 *   （读不互斥）。锁以 target 为键，`withLock` 内部排队。
 * - 并发安全：Map 链式 Promise 实现——新 effect 挂在上一把锁之后，最后清理完成时
 *   若仍是最新锁则删除键，避免 Map 无限增长。
 *
 * SEC 码位结论：纯并发协调载体（不授予能力、不开辟信任通道），零码位新增；
 * SEC-3xxx 段维持留白（§5.11.1 准入）。
 */

/**
 * 按目标的写锁——同一 target 的写效果串行，不同 target 并行（方案 §5.7 原文）。
 * 用法：`await lock.withLock(realpath, () => fsWrite(...))`。
 */
export class EffectWriteLock {
  private locks = new Map<string, Promise<unknown>>()

  /** 以 target 为键串行执行 effect；同一 target 的后续调用排队等待前一完成 */
  async withLock<T>(target: string, effect: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(target) ?? Promise.resolve()
    // 无论前置成功/失败都继续执行当前 effect（失败不阻塞后续）
    const run = previous.then(effect, effect)
    this.locks.set(target, run)
    try {
      return await run
    } finally {
      // 仅当当前锁仍是链尾最新者才删除——避免误删中途插入的后续锁
      if (this.locks.get(target) === run) this.locks.delete(target)
    }
  }

  /** 当前持有的锁目标集合（诊断/测试用） */
  pendingTargets(): string[] {
    return [...this.locks.keys()]
  }
}