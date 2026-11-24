/**
 * 模拟的 RDMA Queue Pair。
 *
 * refs: mrId -> {
 *   qpId, mrId, lkey, generation, connectionId, attachedAtSeq
 * }
 * 引用快照记录 attach 时刻的 lkey / generation / connectionId，
 * 重连后 connectionId 变化，旧快照即成为“残留引用”，
 * 旧 lkey 不允许进入新连接。
 */
export class QueuePair {
  constructor({ id }) {
    this.id = id;
    this.state = 'created'; // created -> connected -> disconnected
    this.connectionId = null;
    this.refs = new Map();
  }
}
