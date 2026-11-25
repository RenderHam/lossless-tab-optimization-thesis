# Thesis verification report

- Run: `20261125-065545`
- Generated: 2026-11-24T22:57:53.925645+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T03 | restore mode correctness (+ auto-restore) | **FAIL** | auto-restore FAILED | form page => overlay; empty page => full; activation auto-restores typed value |
| T04 | no duplicated UI after restore | **PASS** | max ratio 1.0 | max element-count ratio <= 1.1 |

Records: 2 file(s), 1 not passing.

- **T03 fail**: auto-restore on activation failed: tab live but values not restored: 'server-name'

Every test record (including failures) is a `T*.json` file next to this report.
