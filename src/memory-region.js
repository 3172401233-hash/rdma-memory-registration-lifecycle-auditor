/**
 * 模拟的 RDMA Memory Region（纯内存数据结构，不涉及任何真实 verbs/硬件）。
 *
 * access 权限按读 / 写分别记录，审计时分别校验：
 * - remoteRead:  允许远程节点读取本区域
 * - remoteWrite: 允许远程节点写入本区域
 */
export class MemoryRegion {
  constructor({ id, iova, length, lkey, rkey, access = {}, generation }) {
    this.id = id;
    this.iova = iova;
    this.length = length;
    this.lkey = lkey;
    this.rkey = rkey;
    this.access = {
      remoteRead: Boolean(access.remoteRead),
      remoteWrite: Boolean(access.remoteWrite),
    };
    // 每次注册递增，用于区分同一 lkey 的不同代 MR（lkey 重用检测）
    this.generation = generation;
    // registered -> deregistered；注销被 QP 引用阻塞时保持 registered
    this.state = 'registered';
    // 是否发生过被阻塞的注销尝试（部分注销失败）
    this.deregAttempted = false;
    // qpId -> 引用快照（与 QP 侧共享同一对象）
    this.qpRefs = new Map();
  }

  contains(iova, length) {
    return (
      Number.isInteger(iova) &&
      Number.isInteger(length) &&
      length > 0 &&
      iova >= this.iova &&
      iova + length <= this.iova + this.length
    );
  }
}
