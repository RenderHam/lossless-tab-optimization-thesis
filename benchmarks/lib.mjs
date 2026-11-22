/** Pure, deterministic math shared by the report script and tests. */
export function reductionPercent(before, after) {
  if (before <= 0) return null;
  return Math.max(0, ((before - after) / before) * 100);
}

export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function mib(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}
