# rdma-memory-registration-lifecycle-auditor

审计 RDMA Memory Region（MR）、lkey/rkey 与 Queue Pair（QP）的生命周期，
判断连接重建后发送请求是否仍可安全使用。

## 重要说明：不访问真实 RDMA 设备

本项目是**纯内存软件模拟**：所有 MR、QP、lkey/rkey、IOVA、注册/注销事件
均为普通 JavaScript 对象。代码**不加载 rdma-core / libibverbs，不打开
`/dev/infiniband*`，不执行任何 verbs 调用，也不触碰真实网卡或内核
RDMA 子系统**。审计逻辑完全在用户态对事件流进行推演，可在任何安装了
Node.js ≥ 24.16.0 的机器上离线运行。

## 审计的故障场景

RDMA 连接重建后，旧 QP 仍引用已注销的 MR；新 MR 注册时硬件复用了相同的
lkey，旧请求若被放行，硬件会读到另一块缓冲区。审计器针对此类问题校验：

- **注销前必须撤销全部 QP 引用**：存在引用时注销被阻塞（部分注销失败），
  MR 与 lkey 保留，并报告完整引用链（attach 事件序号、连接号、MR 状态）。
- **旧 lkey 不得进入新连接**：QP 重连后，既有引用快照立即过期；携带旧
  引用的请求判为非法，进入可恢复队列，重新 attach 后可安全重试。
- **lkey 重用检测**：注销归还的 lkey 会被新 MR 复用；QP 持有的旧引用若
  命中复用的 lkey，判为 `lkey-reused-stale-reference` 并指明新旧 MR 的
  IOVA 差异（缓冲区混淆风险）。
- **读 / 写权限分别校验**：`remoteRead` 与 `remoteWrite` 独立判定，
  分别输出 `permission-denied-read` / `permission-denied-write`。
- **IOVA 边界校验**：请求区间必须落在 MR 的 `[iova, iova + length)` 内。

## 输入与输出

输入为事件流（`register` / `deregister` / `createQp` / `connect` /
`reconnect` / `disconnect` / `attach` / `detach` / `request`），携带
MR 定义、lkey/rkey、远程访问权限、IOVA 范围与重连过程。

`finalize()` 输出审计报告：

- `illegalAccesses`：非法访问（陈旧 lkey、权限不匹配、IOVA 越界等）
- `residualReferences`：残留引用链（阻塞注销 / 强制注销后的悬空引用）
- `recoverableQueue`：可恢复请求队列（重新 attach 后可重试）
- `cleanupOrder`：推荐清理顺序（detach → disconnect → deregister → destroyQp）

## 使用

```js
import { RdmaLifecycleAuditor } from './src/index.js';

const auditor = new RdmaLifecycleAuditor();
auditor.process([
  { type: 'register', mrId: 'mr-1', iova: 0x10000, length: 0x1000,
    access: { remoteRead: true, remoteWrite: true } },
  { type: 'createQp', qpId: 'qp-1' },
  { type: 'connect', qpId: 'qp-1', connectionId: 1 },
  { type: 'attach', qpId: 'qp-1', mrId: 'mr-1' },
  { type: 'reconnect', qpId: 'qp-1', connectionId: 2 },
  { type: 'request', id: 'r1', qpId: 'qp-1', lkey: 0x1000,
    iova: 0x10000, length: 0x100, op: 'read' },
]);
console.log(auditor.finalize().illegalAccesses);
```

## 测试

```sh
node --test
```

测试覆盖：QP 重连后旧 lkey 拒绝与恢复、提前注销（部分注销失败保留资源
并报告引用链）、lkey 重用导致的缓冲区混淆、读/写权限分别校验、IOVA 越界。
