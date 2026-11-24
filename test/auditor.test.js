import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RdmaLifecycleAuditor } from '../src/index.js';

const RW = { remoteRead: true, remoteWrite: true };

function baseSetup(access = RW) {
  return [
    { type: 'register', mrId: 'mr-1', iova: 0x10000, length: 0x1000, access },
    { type: 'createQp', qpId: 'qp-1' },
    { type: 'connect', qpId: 'qp-1', connectionId: 1 },
    { type: 'attach', qpId: 'qp-1', mrId: 'mr-1' },
  ];
}

test('正常路径：已连接 QP + 有效 lkey + 权限与 IOVA 匹配，请求被接受', () => {
  const auditor = new RdmaLifecycleAuditor();
  const mr = auditor.processEvent(baseSetup()[0]);
  auditor.process(baseSetup().slice(1));
  auditor.process([
    { type: 'request', id: 'r1', qpId: 'qp-1', lkey: mr.lkey, iova: 0x10000, length: 0x100, op: 'read' },
    { type: 'request', id: 'r2', qpId: 'qp-1', lkey: mr.lkey, iova: 0x10800, length: 0x800, op: 'write' },
  ]);
  const report = auditor.finalize();
  assert.equal(report.illegalAccesses.length, 0);
  assert.deepEqual(
    report.acceptedRequests.map((r) => r.requestId),
    ['r1', 'r2'],
  );
});

test('QP 重连：旧 lkey 不得进入新连接，请求判非法并进入可恢复队列，重新 attach 后可重试', () => {
  const auditor = new RdmaLifecycleAuditor();
  auditor.process(baseSetup());
  const lkey = auditor.mrs.get('mr-1').lkey;

  auditor.process([
    { type: 'disconnect', qpId: 'qp-1' },
    { type: 'reconnect', qpId: 'qp-1', connectionId: 2 },
    { type: 'request', id: 'r-stale', qpId: 'qp-1', lkey, iova: 0x10000, length: 0x100, op: 'read' },
  ]);

  let report = auditor.finalize();
  assert.equal(report.illegalAccesses.length, 1);
  assert.equal(report.illegalAccesses[0].reason, 'stale-lkey-across-reconnect');
  assert.equal(report.illegalAccesses[0].refConnectionId, 1);
  assert.equal(report.illegalAccesses[0].currentConnectionId, 2);
  assert.deepEqual(
    report.recoverableQueue.map((r) => r.requestId),
    ['r-stale'],
  );

  // 在新连接上重新 attach 后，相同请求恢复安全
  auditor.process([
    { type: 'attach', qpId: 'qp-1', mrId: 'mr-1' },
    { type: 'request', id: 'r-retry', qpId: 'qp-1', lkey, iova: 0x10000, length: 0x100, op: 'read' },
  ]);
  report = auditor.finalize();
  assert.equal(report.illegalAccesses.length, 1);
  assert.deepEqual(
    report.acceptedRequests.map((r) => r.requestId),
    ['r-retry'],
  );
});

test('提前注销：存在 QP 引用时注销被阻塞，资源保留并报告引用链，清理顺序先 detach 再 deregister', () => {
  const auditor = new RdmaLifecycleAuditor();
  auditor.process(baseSetup());
  auditor.process([{ type: 'deregister', mrId: 'mr-1' }]);

  const report = auditor.finalize();
  const mr = auditor.mrs.get('mr-1');
  assert.equal(mr.state, 'registered', '部分注销失败时必须保留资源');
  assert.ok(auditor.lkeyToMr.has(mr.lkey), 'lkey 不得被回收');

  assert.equal(report.residualReferences.length, 1);
  const residual = report.residualReferences[0];
  assert.equal(residual.kind, 'blocking-deregister');
  assert.equal(residual.qpId, 'qp-1');
  assert.equal(residual.mrId, 'mr-1');
  assert.ok(residual.chain.some((link) => link.includes('attach qp=qp-1 -> mr=mr-1')));

  const actions = report.cleanupOrder.map((s) => s.action);
  assert.ok(actions.indexOf('detach') < actions.indexOf('deregister'));
  assert.ok(actions.indexOf('disconnect') < actions.indexOf('deregister'));

  // 撤销引用后注销即可成功
  auditor.process([
    { type: 'detach', qpId: 'qp-1', mrId: 'mr-1' },
    { type: 'deregister', mrId: 'mr-1' },
  ]);
  assert.equal(auditor.mrs.get('mr-1').state, 'deregistered');
});

test('lkey 重用：旧 QP 引用已注销 MR，新 MR 复用同一 lkey，请求判非法并指明缓冲区混淆', () => {
  const auditor = new RdmaLifecycleAuditor();
  auditor.process([
    { type: 'register', mrId: 'mr-old', iova: 0x10000, length: 0x1000, access: RW },
    { type: 'createQp', qpId: 'qp-1' },
    { type: 'connect', qpId: 'qp-1', connectionId: 1 },
    { type: 'attach', qpId: 'qp-1', mrId: 'mr-old' },
  ]);
  const reusedLkey = auditor.mrs.get('mr-old').lkey;

  // 异常路径：硬件层强制完成注销，QP 引用悬空，lkey 回到池中
  auditor.process([
    { type: 'deregister', mrId: 'mr-old', force: true },
    { type: 'register', mrId: 'mr-new', iova: 0x90000, length: 0x1000, access: RW },
  ]);
  assert.equal(auditor.mrs.get('mr-new').lkey, reusedLkey, '新 MR 应复用回收的 lkey');

  auditor.process([
    { type: 'request', id: 'r-confused', qpId: 'qp-1', lkey: reusedLkey, iova: 0x90000, length: 0x100, op: 'read' },
  ]);

  const report = auditor.finalize();
  assert.equal(report.illegalAccesses.length, 1);
  const illegal = report.illegalAccesses[0];
  assert.equal(illegal.reason, 'lkey-reused-stale-reference');
  assert.equal(illegal.staleMrId, 'mr-old');
  assert.equal(illegal.currentMrId, 'mr-new');
  assert.match(illegal.detail, /另一块缓冲区/);

  const dangling = report.residualReferences.find((r) => r.mrId === 'mr-old');
  assert.equal(dangling.kind, 'dangling-after-forced-deregister');
});

test('权限不匹配：读 / 写权限分别校验', () => {
  const auditor = new RdmaLifecycleAuditor();
  auditor.process([
    { type: 'register', mrId: 'mr-ro', iova: 0x10000, length: 0x1000, access: { remoteRead: true, remoteWrite: false } },
    { type: 'register', mrId: 'mr-wo', iova: 0x20000, length: 0x1000, access: { remoteRead: false, remoteWrite: true } },
    { type: 'createQp', qpId: 'qp-1' },
    { type: 'connect', qpId: 'qp-1', connectionId: 1 },
    { type: 'attach', qpId: 'qp-1', mrId: 'mr-ro' },
    { type: 'attach', qpId: 'qp-1', mrId: 'mr-wo' },
  ]);
  const roLkey = auditor.mrs.get('mr-ro').lkey;
  const woLkey = auditor.mrs.get('mr-wo').lkey;

  auditor.process([
    { type: 'request', id: 'w-on-ro', qpId: 'qp-1', lkey: roLkey, iova: 0x10000, length: 0x10, op: 'write' },
    { type: 'request', id: 'r-on-ro', qpId: 'qp-1', lkey: roLkey, iova: 0x10000, length: 0x10, op: 'read' },
    { type: 'request', id: 'r-on-wo', qpId: 'qp-1', lkey: woLkey, iova: 0x20000, length: 0x10, op: 'read' },
    { type: 'request', id: 'w-on-wo', qpId: 'qp-1', lkey: woLkey, iova: 0x20000, length: 0x10, op: 'write' },
  ]);

  const report = auditor.finalize();
  const reasons = Object.fromEntries(report.illegalAccesses.map((a) => [a.requestId, a.reason]));
  assert.equal(reasons['w-on-ro'], 'permission-denied-write');
  assert.equal(reasons['r-on-wo'], 'permission-denied-read');
  assert.deepEqual(
    report.acceptedRequests.map((r) => r.requestId).sort(),
    ['r-on-ro', 'w-on-wo'],
  );
});

test('IOVA 越界：请求范围超出 MR 边界判非法', () => {
  const auditor = new RdmaLifecycleAuditor();
  auditor.process(baseSetup());
  const lkey = auditor.mrs.get('mr-1').lkey;
  auditor.process([
    { type: 'request', id: 'oob', qpId: 'qp-1', lkey, iova: 0x10f00, length: 0x200, op: 'read' },
  ]);
  const report = auditor.finalize();
  assert.equal(report.illegalAccesses.length, 1);
  assert.equal(report.illegalAccesses[0].reason, 'iova-out-of-bounds');
});
