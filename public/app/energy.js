// public/app/energy.js
// 曜石能量与多邻国式连击（Streak）激励系统：纯逻辑与本机存储持久化。
// 零依赖，可单测。

export const ENERGY_KEY = 'sl.energy';

export const REASONS = {
  LAUNCH: 'launch',         // 启动破冰 (+5 曜石)
  DECISION: 'decision',     // 清醒决断 (+10 曜石)
  ON_DECK: 'ondeck',       // 念头入库 (+2 曜石)
  STREAK_BONUS: 'streak',   // 连续连击奖励
  CONSUME: 'consume'        // 能量消耗
};

function todayKey(now = new Date()) {
  return new Date(now).toLocaleDateString('sv-SE');
}

function yesterdayKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE');
}

const DEFAULT_ENERGY = Object.freeze({
  stones: 15, // 初始赠送 15 曜石新手礼包
  streak: 0,
  lastActiveDay: '',
  streakFreezeCount: 1,
  history: []
});

export function getEnergy(storage = globalThis.localStorage) {
  if (!storage) return { ...DEFAULT_ENERGY };
  try {
    const raw = storage.getItem(ENERGY_KEY);
    if (!raw) return { ...DEFAULT_ENERGY };
    const parsed = JSON.parse(raw);
    return {
      stones: Number.isFinite(parsed.stones) ? Math.max(0, parsed.stones) : DEFAULT_ENERGY.stones,
      streak: Number.isFinite(parsed.streak) ? Math.max(0, parsed.streak) : DEFAULT_ENERGY.streak,
      lastActiveDay: typeof parsed.lastActiveDay === 'string' ? parsed.lastActiveDay : '',
      streakFreezeCount: Number.isFinite(parsed.streakFreezeCount) ? parsed.streakFreezeCount : 1,
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 50) : []
    };
  } catch (e) {
    return { ...DEFAULT_ENERGY };
  }
}

export function saveEnergy(data, storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    storage.setItem(ENERGY_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 奖励能量石并维护连击天数。
 * @param {number} amount 曜石数量
 * @param {string} reason 奖励原因
 * @param {string} title 关联事项或动作描述
 * @param {Storage} storage 存储实例
 * @param {Date|number} now 当前时间
 */
export function awardEnergy(amount, reason, title = '', storage = globalThis.localStorage, now = new Date()) {
  const curr = getEnergy(storage);
  const today = todayKey(now);
  const yesterday = yesterdayKey(now);

  let newStreak = curr.streak;
  let freezeUsed = false;

  if (!curr.lastActiveDay || curr.streak === 0) {
    newStreak = 1;
  } else if (curr.lastActiveDay === today) {
    // 今日已活跃，连击保持
  } else if (curr.lastActiveDay === yesterday) {
    // 连续昨天活跃，连击递增
    newStreak = curr.streak + 1;
  } else {
    // 中断了：有冻结卡则保级，否则重置为 1
    if (curr.streakFreezeCount > 0) {
      curr.streakFreezeCount -= 1;
      freezeUsed = true;
      newStreak = curr.streak + 1;
    } else {
      newStreak = 1;
    }
  }

  const stones = curr.stones + Math.max(0, amount);
  const entry = {
    at: Date.now(),
    amount,
    reason,
    title: String(title).slice(0, 100)
  };

  const next = {
    stones,
    streak: newStreak,
    lastActiveDay: today,
    streakFreezeCount: curr.streakFreezeCount,
    history: [entry, ...curr.history].slice(0, 50)
  };

  saveEnergy(next, storage);

  return {
    energy: next,
    added: amount,
    reason,
    freezeUsed
  };
}

/**
 * 消耗能量石（用于兑换连击保护或高定资产）。
 */
export function consumeStones(amount, purpose = '', storage = globalThis.localStorage) {
  const curr = getEnergy(storage);
  if (curr.stones < amount) return { ok: false, error: 'insufficient_stones', energy: curr };

  const next = {
    ...curr,
    stones: curr.stones - amount,
    history: [{ at: Date.now(), amount: -amount, reason: REASONS.CONSUME, title: purpose }, ...curr.history].slice(0, 50)
  };
  saveEnergy(next, storage);
  return { ok: true, energy: next };
}
