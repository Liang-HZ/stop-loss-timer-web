// 测试用的确定性上下文：时间与 id 全部可控，避免任何随机导致的偶发绿／红。
export function makeCtx(startAt = 1_700_000_000_000) {
  let t = startAt;
  let n = 0;
  return {
    now: () => t,
    idGen: () => `id${++n}`,
    set(ms) { t = ms; return t; },
    advance(ms) { t += ms; return t; },
    get at() { return t; }
  };
}
export const MIN = 60000;
