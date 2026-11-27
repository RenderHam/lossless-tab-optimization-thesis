# Thesis verification report

- Run: `20261127223949`
- Generated: 2026-11-27T22:48:49.320Z

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T01 | freeze success rate | **PASS** | success rate 100.0% | success rate >= 95% of eligible tabs |
| T02 | byte-exact fidelity after freeze/restore | **PASS** | html/forms/scroll equal | html == AND form values == AND scroll ±2px for every tab |
| T03 | restore mode correctness (+ auto-restore) | **PASS** | auto-restore ok | form page => overlay; empty page => full; activation auto-restores typed value |
| T04 | no duplicated UI after restore | **PASS** | max ratio 1 | max element-count ratio <= 1.1 |
| T05 | per-tab memory saving | **PASS** | mean 100%, p10 100%, tree 67.77% | mean >= 70% and p10 >= 60% (claim: 90%) |
| T06 | aggregate memory saving across 50 tabs | **PASS** | 80.51% of 2877 MiB (transient 78.26%, 47.7 MiB/tab) | aggregate saving >= 50% (claim: 80%) |
| T07 | extension idle memory overhead | **ERROR** | ratio undefined |  |
| T08 | freeze/restore latency and spikes | **PASS** | freeze p95 20.4ms, restore p95 148.9ms | freeze p95 <= 2000ms; restore p95 <= 5000ms; maxBatchMs <= 50ms |
| T09 | determinism of capture+compression | **PASS** | 1 distinct hash(es) | 3 freezes of the same page: identical rawBytes and identical SHA-256 of decompressed state minus runtime-only fields (timestamp, tabId, heapSnapshotRef); no other field may vary |
| T10 | stress: 20 freeze/restore cycles, leak check | **PASS** | slope -0.0498%/cycle | 0 errors, all 20 cycles, slope <= 1%/cycle |

Records: 10 file(s), 1 not passing.

- **T07 error**: TypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function

Every test record (including failures) is a `T*.json` file next to this report.
