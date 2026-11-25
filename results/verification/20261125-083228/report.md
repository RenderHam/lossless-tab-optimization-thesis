# Thesis verification report

- Run: `20261125-083228`
- Generated: 2026-11-25T00:46:51.806804+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T01 | freeze success rate | **PASS** | success rate 100.0% | success rate >= 95% of eligible tabs |
| T02 | byte-exact fidelity after freeze/restore | **PASS** | html/forms/scroll equal | html == AND form values == AND scroll ±2px for every tab |
| T03 | restore mode correctness (+ auto-restore) | **PASS** | auto-restore ok | form page => overlay; empty page => full; activation auto-restores typed value |
| T04 | no duplicated UI after restore | **PASS** | max ratio 1.0 | max element-count ratio <= 1.1 |
| T05 | per-tab memory saving | **PASS** | mean 100.0%, p10 100.0%, tree 69.79% | mean >= 70.0% and p10 >= 60.0% (claim: 90%) |
| T06 | aggregate memory saving across 50 tabs | **PASS** | 79.34% of 2721 MiB (transient 76.19%, 44.7 MiB/tab) | aggregate saving >= 50.0% (claim: 80%) |
| T07 | extension idle memory overhead | **PASS** | ratio 1.0144 | extension/baseline PSS ratio <= 1.1 (extension loaded, no freeze used) |
| T08 | freeze/restore latency and spikes | **PASS** | freeze p95 19.8ms, restore p95 150.0ms | freeze p95 <= 2000.0ms; restore p95 <= 5000.0ms; maxBatchMs <= 50.0ms |
| T09 | determinism of capture+compression | **PASS** | 1 distinct hash(es) | 3 freezes of the same page: identical rawBytes and identical SHA-256 of decompressed state minus runtime-only fields (timestamp, tabId, heapSnapshotRef); no other field may vary |
| T10 | stress: 20 freeze/restore cycles, leak check | **PASS** | slope 0.0104%/cycle | 0 errors, all 20 cycles, slope <= 1.0%/cycle |

Records: 10 file(s), 0 not passing.

- All recorded tests passed their thresholds.

Every test record (including failures) is a `T*.json` file next to this report.
