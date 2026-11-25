# Thesis verification report

- Run: `20261125-082658`
- Generated: 2026-11-25T00:38:00.576041+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T08 | freeze/restore latency and spikes | **PASS** | freeze p95 18.3ms, restore p95 152.3ms | freeze p95 <= 2000.0ms; restore p95 <= 5000.0ms; maxBatchMs <= 50.0ms |

Records: 1 file(s), 0 not passing.

- All recorded tests passed their thresholds.

Every test record (including failures) is a `T*.json` file next to this report.
