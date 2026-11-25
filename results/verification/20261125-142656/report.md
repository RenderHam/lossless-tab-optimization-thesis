# Thesis verification report

- Run: `20261125-142656`
- Generated: 2026-11-25T06:38:35.546682+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T01 | freeze success rate | **PASS** | success rate 100.0% | success rate >= 95% of eligible tabs |
| T02 | byte-exact fidelity after freeze/restore | **PASS** | html/forms/scroll equal | html == AND form values == AND scroll ±2px for every tab |
| T03 | restore mode correctness (+ auto-restore) | **PASS** | auto-restore ok | form page => overlay; empty page => full; activation auto-restores typed value |
| T04 | no duplicated UI after restore | **PASS** | max ratio 1.0 | max element-count ratio <= 1.1 |
| T05 | per-tab memory saving | **PASS** | mean 100.0%, p10 100.0%, tree 74.48% | mean >= 70.0% and p10 >= 60.0% (claim: 90%) |
| T06 | aggregate memory saving across 50 tabs | **PASS** | 79.25% of 2751 MiB (transient 76.16%, 45.0 MiB/tab) | aggregate saving >= 50.0% (claim: 80%) |
| T07 | extension idle memory overhead | **PASS** | ratio 0.1395 | extension/baseline PSS ratio <= 1.1 (extension loaded, no freeze used) |
| T08 | freeze/restore latency and spikes | **ERROR** | freeze p95 0.0ms, restore p95 0.0ms |  |
| T09 | determinism of capture+compression | **ERROR** | None distinct hash(es) |  |
| T10 | stress: 20 freeze/restore cycles, leak check | **ERROR** | slope None%/cycle |  |

Records: 10 file(s), 3 not passing.

- **T08 error**: could not open tab: http://x118.lto.test:8123/light.html
- **T09 error**: could not open tab: http://x119.lto.test:8123/medium.html
- **T10 error**: could not open tab: http://x120.lto.test:8123/medium.html

Every test record (including failures) is a `T*.json` file next to this report.
