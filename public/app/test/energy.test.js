import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnergy, saveEnergy, awardEnergy, consumeStones, REASONS, ENERGY_KEY } from '../energy.js';

function makeMemStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: k => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

test('getEnergy 初始默认值赋予新手礼包', () => {
  const storage = makeMemStorage();
  const e = getEnergy(storage);
  assert.equal(e.stones, 15);
  assert.equal(e.streak, 0);
  assert.equal(e.streakFreezeCount, 1);
});

test('awardEnergy 累加曜石并记录历史', () => {
  const storage = makeMemStorage();
  const r = awardEnergy(5, REASONS.LAUNCH, '写方案', storage);
  assert.equal(r.added, 5);
  assert.equal(r.energy.stones, 20);
  assert.equal(r.energy.history.length, 1);
  assert.equal(r.energy.history[0].reason, 'launch');
  assert.equal(r.energy.history[0].title, '写方案');

  const r2 = awardEnergy(10, REASONS.DECISION, '就此收场', storage);
  assert.equal(r2.energy.stones, 30);
  assert.equal(r2.energy.history.length, 2);
});

test('连击维护：同天不重加，隔天递增，断连优先用保护卡', () => {
  const storage = makeMemStorage();
  const day1 = new Date('2026-10-01T10:00:00Z');
  const day2 = new Date('2026-10-02T10:00:00Z');
  const day4 = new Date('2026-10-04T10:00:00Z'); // 断了一天

  // 第 1 天
  awardEnergy(5, REASONS.LAUNCH, 'task1', storage, day1);
  let e = getEnergy(storage);
  assert.equal(e.streak, 1);

  // 第 1 天再启动，连击不重复加
  awardEnergy(5, REASONS.LAUNCH, 'task1-more', storage, day1);
  e = getEnergy(storage);
  assert.equal(e.streak, 1);

  // 第 2 天启动，连击 + 1 = 2
  awardEnergy(5, REASONS.LAUNCH, 'task2', storage, day2);
  e = getEnergy(storage);
  assert.equal(e.streak, 2);

  // 第 4 天启动（漏了第 3 天）：消耗 1 张保护卡保住连击
  const r4 = awardEnergy(5, REASONS.LAUNCH, 'task4', storage, day4);
  assert.equal(r4.freezeUsed, true);
  assert.equal(r4.energy.streak, 3);
  assert.equal(r4.energy.streakFreezeCount, 0);

  // 再漏一天（第 6 天）：无保护卡，重置为 1
  const day6 = new Date('2026-10-06T10:00:00Z');
  const r6 = awardEnergy(5, REASONS.LAUNCH, 'task6', storage, day6);
  assert.equal(r6.freezeUsed, false);
  assert.equal(r6.energy.streak, 1);
});

test('consumeStones 能量消耗与余额检查', () => {
  const storage = makeMemStorage({ [ENERGY_KEY]: JSON.stringify({ stones: 20, streak: 1, history: [] }) });
  const fail = consumeStones(50, '买皮肤', storage);
  assert.equal(fail.ok, false);
  assert.equal(fail.energy.stones, 20);

  const succ = consumeStones(15, '冻结卡', storage);
  assert.equal(succ.ok, true);
  assert.equal(succ.energy.stones, 5);
});
