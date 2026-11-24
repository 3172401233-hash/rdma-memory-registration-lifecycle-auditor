import { MemoryRegion } from './memory-region.js';
import { QueuePair } from './queue-pair.js';

/**
 * RDMA MR 生命周期审计器（纯软件模拟，不触碰真实 RDMA 设备）。
 *
 * 输入：memory region 定义、lkey/rkey、QP 引用、注册/注销事件、
 *       远程访问权限、IOVA 范围与重连过程（均为事件流）。
 * 输出：{
 *   illegalAccesses,     // 非法访问（陈旧 lkey、权限不匹配、越界 IOVA 等）
 *   residualReferences,  // 残留引用链（注销被阻塞 / 强制注销后的悬空引用）
 *   recoverableQueue,    // 可恢复请求队列（重连后重新 attach 即可重试）
 *   cleanupOrder,        // 推荐的清理顺序
 *   events,              // 带序号的事件日志
 * }
 */
export class RdmaLifecycleAuditor {
  constructor() {
    this.mrs = new Map(); // mrId -> MemoryRegion
    this.qps = new Map(); // qpId -> QueuePair
    this.lkeyToMr = new Map(); // 当前活跃 lkey -> mrId
    this.freeLkeys = []; // 已注销 MR 归还的 lkey，可被新 MR 重用
    this.nextLkey = 0x1000;
    this.nextRkey = 0x2000;
    this.generationCounter = 0;
    this.connectionCounter = 0;
    this.seq = 0;
    this.events = [];
    this.illegalAccesses = [];
    this.recoverableQueue = [];
    this.acceptedRequests = [];
  }

  #log(type, detail) {
    this.seq += 1;
    const entry = { seq: this.seq, type, ...detail };
    this.events.push(entry);
    return entry;
  }

  /** 按事件流驱动审计。支持一次性传入数组。 */
  process(events) {
    for (const event of events) this.processEvent(event);
    return this;
  }

  processEvent(event) {
    switch (event.type) {
      case 'register':
        return this.#register(event);
      case 'deregister':
        return this.#deregister(event);
      case 'createQp':
        return this.#createQp(event);
      case 'connect':
        return this.#connect(event);
      case 'reconnect':
        return this.#reconnect(event);
      case 'disconnect':
        return this.#disconnect(event);
      case 'attach':
        return this.#attach(event);
      case 'detach':
        return this.#detach(event);
      case 'request':
        return this.#request(event);
      default:
        throw new Error(`未知事件类型: ${event.type}`);
    }
  }

  #register({ mrId, iova, length, lkey, rkey, access }) {
    if (this.mrs.has(mrId)) throw new Error(`MR 已存在: ${mrId}`);
    // lkey 复用池：注销归还的 lkey 优先分配给新 MR（模拟硬件 lkey 重用）
    const allocatedLkey =
      lkey ?? (this.freeLkeys.length > 0 ? this.freeLkeys.shift() : this.nextLkey++);
    if (this.lkeyToMr.has(allocatedLkey)) {
      throw new Error(`lkey 仍被活跃 MR 占用，不能注册: ${allocatedLkey}`);
    }
    const mr = new MemoryRegion({
      id: mrId,
      iova,
      length,
      lkey: allocatedLkey,
      rkey: rkey ?? this.nextRkey++,
      access,
      generation: ++this.generationCounter,
    });
    this.mrs.set(mrId, mr);
    this.lkeyToMr.set(allocatedLkey, mrId);
    return this.#log('register', {
      mrId,
      lkey: mr.lkey,
      rkey: mr.rkey,
      generation: mr.generation,
    });
  }

  /**
   * 注销 MR。规则：注销前必须撤销全部 QP 引用。
   * - 存在引用且未强制：部分注销失败 —— 保留 MR 与 lkey，记录残留引用链。
   * - force: 模拟硬件层绕过（如异常路径）完成注销，QP 引用变为悬空。
   */
  #deregister({ mrId, force = false }) {
    const mr = this.mrs.get(mrId);
    if (!mr) throw new Error(`MR 不存在: ${mrId}`);
    if (mr.state === 'deregistered') {
      return this.#log('deregister-redundant', { mrId });
    }
    if (mr.qpRefs.size > 0 && !force) {
      mr.deregAttempted = true;
      return this.#log('deregister-blocked', {
        mrId,
        lkey: mr.lkey,
        holders: [...mr.qpRefs.keys()],
        reason: '存在未撤销的 QP 引用，注销被拒绝，资源保留',
      });
    }
    mr.state = 'deregistered';
    this.lkeyToMr.delete(mr.lkey);
    this.freeLkeys.push(mr.lkey);
    return this.#log('deregister', {
      mrId,
      lkey: mr.lkey,
      forced: force,
      danglingRefs: force ? [...mr.qpRefs.keys()] : [],
    });
  }

  #createQp({ qpId }) {
    if (this.qps.has(qpId)) throw new Error(`QP 已存在: ${qpId}`);
    this.qps.set(qpId, new QueuePair({ id: qpId }));
    return this.#log('createQp', { qpId });
  }

  #connect({ qpId, connectionId }) {
    const qp = this.#mustQp(qpId);
    qp.state = 'connected';
    qp.connectionId = connectionId ?? ++this.connectionCounter;
    return this.#log('connect', { qpId, connectionId: qp.connectionId });
  }

  /**
   * 连接重建：QP 进入新连接，所有既有 MR 引用快照立即过期。
   * 旧 lkey 不得进入新连接 —— 之后携带旧引用的请求会被判为非法，
   * 并进入可恢复队列（重新 attach 后可安全重试）。
   */
  #reconnect({ qpId, connectionId }) {
    const qp = this.#mustQp(qpId);
    qp.state = 'connected';
    qp.connectionId = connectionId ?? ++this.connectionCounter;
    return this.#log('reconnect', {
      qpId,
      connectionId: qp.connectionId,
      staleRefs: [...qp.refs.keys()],
    });
  }

  #disconnect({ qpId }) {
    const qp = this.#mustQp(qpId);
    qp.state = 'disconnected';
    return this.#log('disconnect', { qpId, connectionId: qp.connectionId });
  }

  #attach({ qpId, mrId }) {
    const qp = this.#mustQp(qpId);
    const mr = this.#mustMr(mrId);
    if (mr.state !== 'registered') throw new Error(`MR 已注销，无法 attach: ${mrId}`);
    if (qp.state !== 'connected') throw new Error(`QP 未连接，无法 attach: ${qpId}`);
    const ref = {
      qpId,
      mrId,
      lkey: mr.lkey,
      generation: mr.generation,
      connectionId: qp.connectionId,
      attachedAtSeq: this.seq + 1,
    };
    qp.refs.set(mrId, ref);
    mr.qpRefs.set(qpId, ref);
    return this.#log('attach', { qpId, mrId, lkey: mr.lkey, connectionId: qp.connectionId });
  }

  #detach({ qpId, mrId }) {
    const qp = this.#mustQp(qpId);
    const mr = this.#mustMr(mrId);
    qp.refs.delete(mrId);
    mr.qpRefs.delete(qpId);
    return this.#log('detach', { qpId, mrId });
  }

  /** 校验一个发送请求是否仍可安全使用。 */
  #request({ id, qpId, lkey, iova, length, op }) {
    const requestId = id ?? `req-${this.seq + 1}`;
    const reject = (reason, detail, recoverable = false) => {
      this.#log('request-rejected', { requestId, qpId, lkey, op, reason });
      this.illegalAccesses.push({ requestId, qpId, lkey, op, reason, ...detail });
      if (recoverable) {
        this.recoverableQueue.push({
          requestId,
          qpId,
          lkey,
          op,
          action: '在新连接上重新 attach MR 后重试',
        });
      }
      return false;
    };

    const qp = this.qps.get(qpId);
    if (!qp) return reject('unknown-qp', { detail: 'QP 不存在' });
    if (qp.state !== 'connected') {
      return reject('qp-not-connected', { detail: `QP 状态: ${qp.state}` }, true);
    }

    const ownerMrId = this.lkeyToMr.get(lkey);
    const mr = ownerMrId ? this.mrs.get(ownerMrId) : undefined;
    if (!mr || mr.state !== 'registered') {
      return reject('lkey-not-registered', { detail: 'lkey 不属于任何已注册 MR' });
    }

    const ref = qp.refs.get(mr.id);
    if (!ref) {
      // lkey 重用检测：QP 持有的旧引用记录的 lkey 如今指向另一个 MR，
      // 硬件会读到另一块缓冲区。
      const stale = [...qp.refs.values()].find((r) => r.lkey === lkey);
      if (stale) {
        const oldMr = this.mrs.get(stale.mrId);
        return reject('lkey-reused-stale-reference', {
          detail:
            `lkey ${lkey} 原属 MR ${stale.mrId}` +
            `（IOVA ${oldMr?.iova}，已${oldMr?.state === 'deregistered' ? '注销' : '变更'}），` +
            `现属 MR ${mr.id}（IOVA ${mr.iova}）；QP 引用未更新，可能访问到另一块缓冲区`,
          staleMrId: stale.mrId,
          currentMrId: mr.id,
        });
      }
      return reject('qp-not-referencing-mr', { detail: `QP 未引用 MR ${mr.id}` });
    }

    if (ref.connectionId !== qp.connectionId) {
      return reject(
        'stale-lkey-across-reconnect',
        {
          detail:
            `引用建立于连接 ${ref.connectionId}，当前连接 ${qp.connectionId}；` +
            '旧 lkey 不得进入新连接',
          refConnectionId: ref.connectionId,
          currentConnectionId: qp.connectionId,
        },
        true,
      );
    }
    if (ref.generation !== mr.generation) {
      return reject('stale-lkey-generation', {
        detail: `引用代次 ${ref.generation} 与 MR 当前代次 ${mr.generation} 不一致`,
      });
    }

    // 读 / 写权限分别校验
    if (op === 'read' && !mr.access.remoteRead) {
      return reject('permission-denied-read', {
        detail: `MR ${mr.id} 未授予 remoteRead`,
        required: 'remoteRead',
      });
    }
    if (op === 'write' && !mr.access.remoteWrite) {
      return reject('permission-denied-write', {
        detail: `MR ${mr.id} 未授予 remoteWrite`,
        required: 'remoteWrite',
      });
    }
    if (op !== 'read' && op !== 'write') {
      return reject('unsupported-op', { detail: `不支持的操作: ${op}` });
    }

    if (!mr.contains(iova, length)) {
      return reject('iova-out-of-bounds', {
        detail: `[${iova}, ${iova + length}) 超出 MR 范围 [${mr.iova}, ${mr.iova + mr.length})`,
        mrIova: mr.iova,
        mrLength: mr.length,
      });
    }

    this.#log('request-accepted', { requestId, qpId, mrId: mr.id, lkey, op });
    this.acceptedRequests.push({ requestId, qpId, mrId: mr.id, lkey, op, iova, length });
    return true;
  }

  /** 当前残留的 QP -> MR 引用链（注销被阻塞或强制注销后的悬空引用）。 */
  #residualReferences() {
    const residual = [];
    for (const mr of this.mrs.values()) {
      const dangling = mr.state === 'deregistered';
      if (!dangling && !mr.deregAttempted) continue;
      for (const ref of mr.qpRefs.values()) {
        residual.push({
          mrId: mr.id,
          qpId: ref.qpId,
          lkey: ref.lkey,
          mrState: mr.state,
          kind: dangling ? 'dangling-after-forced-deregister' : 'blocking-deregister',
          chain: [
            `event#${ref.attachedAtSeq} attach qp=${ref.qpId} -> mr=${mr.id} (lkey=${ref.lkey}, gen=${ref.generation})`,
            `connection=${ref.connectionId}`,
            `mr=${mr.id} state=${mr.state}` +
              (mr.deregAttempted ? '（注销曾被拒绝，资源保留）' : ''),
          ],
        });
      }
    }
    return residual;
  }

  /** 推荐清理顺序：先撤销 QP 引用，再断开 QP，最后注销 MR 并回收 lkey。 */
  #cleanupOrder() {
    const steps = [];
    let step = 0;
    for (const mr of this.mrs.values()) {
      for (const qpId of mr.qpRefs.keys()) {
        steps.push({ step: ++step, action: 'detach', qpId, mrId: mr.id });
      }
    }
    for (const qp of this.qps.values()) {
      if (qp.state === 'connected') {
        steps.push({ step: ++step, action: 'disconnect', qpId: qp.id });
      }
    }
    for (const mr of this.mrs.values()) {
      if (mr.state === 'registered') {
        steps.push({
          step: ++step,
          action: 'deregister',
          mrId: mr.id,
          lkey: mr.lkey,
        });
      }
    }
    for (const qp of this.qps.values()) {
      steps.push({ step: ++step, action: 'destroyQp', qpId: qp.id });
    }
    return steps;
  }

  /** 汇总审计报告。 */
  finalize() {
    return {
      illegalAccesses: this.illegalAccesses,
      residualReferences: this.#residualReferences(),
      recoverableQueue: this.recoverableQueue,
      cleanupOrder: this.#cleanupOrder(),
      acceptedRequests: this.acceptedRequests,
      events: this.events,
    };
  }

  #mustQp(qpId) {
    const qp = this.qps.get(qpId);
    if (!qp) throw new Error(`QP 不存在: ${qpId}`);
    return qp;
  }

  #mustMr(mrId) {
    const mr = this.mrs.get(mrId);
    if (!mr) throw new Error(`MR 不存在: ${mrId}`);
    return mr;
  }
}
