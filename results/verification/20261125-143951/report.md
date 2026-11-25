# Thesis verification report

- Run: `20261125-143951`
- Generated: 2026-11-25T06:44:26.742972+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T07 | extension idle memory overhead | **PASS** | ratio 1.0249 | extension/baseline PSS ratio <= 1.1 (extension loaded, no freeze used) |
| T08 | freeze/restore latency and spikes | **PASS** | freeze p95 21.5ms, restore p95 741.2ms | freeze p95 <= 2000.0ms; restore p95 <= 5000.0ms; maxBatchMs <= 50.0ms |
| T09 | determinism of capture+compression | **PASS** | 1 distinct hash(es) | 3 freezes of the same page: identical rawBytes and identical SHA-256 of decompressed state minus runtime-only fields (timestamp, tabId, heapSnapshotRef); no other field may vary |
| T10 | stress: 20 freeze/restore cycles, leak check | **PASS** | slope 0.0139%/cycle | 0 errors, all 20 cycles, slope <= 1.0%/cycle |

Records: 4 file(s), 0 not passing.

- All recorded tests passed their thresholds.

Every test record (including failures) is a `T*.json` file next to this report.
