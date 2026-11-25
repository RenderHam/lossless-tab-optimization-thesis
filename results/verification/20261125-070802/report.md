# Thesis verification report

- Run: `20261125-070802`
- Generated: 2026-11-24T23:12:53.933289+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T01 | freeze success rate | **PASS** | success rate 100.0% | success rate >= 95% of eligible tabs |
| T02 | byte-exact fidelity after freeze/restore | **PASS** | html/forms/scroll equal | html == AND form values == AND scroll ±2px for every tab |
| T03 | restore mode correctness (+ auto-restore) | **PASS** | auto-restore ok | form page => overlay; empty page => full; activation auto-restores typed value |
| T04 | no duplicated UI after restore | **PASS** | max ratio 1.0 | max element-count ratio <= 1.1 |

Records: 4 file(s), 0 not passing.

- All recorded tests passed their thresholds.

Every test record (including failures) is a `T*.json` file next to this report.
