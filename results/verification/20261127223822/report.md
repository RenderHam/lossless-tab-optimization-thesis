# Thesis verification report

- Run: `20261127223822`
- Generated: 2026-11-27T22:39:10.844Z

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T09 | determinism of capture+compression | **ERROR** | undefined distinct hash(es) |  |
| T10 | stress: 20 freeze/restore cycles, leak check | **PASS** | slope -0.4797%/cycle | 0 errors, all 20 cycles, slope <= 1%/cycle |

Records: 2 file(s), 1 not passing.

- **T09 error**: Error: page eval failed: SyntaxError: missing ) after argument list

Every test record (including failures) is a `T*.json` file next to this report.
