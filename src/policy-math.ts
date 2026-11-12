/**
 * Integer spread math shared with contracts/sluice-gate.
 * roundDivJs matches JavaScript Math.round for an integer numerator and a
 * positive integer denominator: halves go toward +infinity.
 */

export function roundDivJs(numer: number, denom: number): number {
  if (!Number.isInteger(numer) || !Number.isInteger(denom) || denom <= 0) {
    throw new Error("roundDivJs expects an integer numerator and a positive integer denominator");
  }
  if (numer >= 0) return Math.floor((numer + Math.floor(denom / 2)) / denom);
  const q = Math.floor(numer / denom);
  const r = numer - q * denom;
  if (r * 2 >= denom) return q + 1;
  return q;
}

/** DefiLlama APY percent, scaled by 1e6. 5.23% -> 5_230_000. */
export function apyToPpm(apyPercent: number): number {
  if (!Number.isFinite(apyPercent)) throw new Error("apy is not finite");
  return Math.round(apyPercent * 1_000_000);
}

export function grossSpreadBps(destApyPercent: number, sourceApyPercent: number): number {
  return roundDivJs(apyToPpm(destApyPercent) - apyToPpm(sourceApyPercent), 10_000);
}

export function grossSpreadBpsFromPpm(destPpm: number, sourcePpm: number): number {
  return roundDivJs(destPpm - sourcePpm, 10_000);
}

export function annualizedCostBps(oneTimeCostBps: number, assumedHoldDays: number): number {
  return roundDivJs(oneTimeCostBps * 365, assumedHoldDays);
}

/** True when the one-time cost is not earned back inside maxPaybackDays. */
export function paybackExceeds(oneTimeCostBps: number, grossBps: number, maxPaybackDays: number): boolean {
  if (grossBps <= 0) return true;
  return oneTimeCostBps * 365 > maxPaybackDays * grossBps;
}

export function paybackDays(oneTimeCostBps: number, grossBps: number): number {
  if (grossBps <= 0) return Number.POSITIVE_INFINITY;
  return (oneTimeCostBps * 365) / grossBps;
}
