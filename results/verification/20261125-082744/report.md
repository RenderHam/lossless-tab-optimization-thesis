# Thesis verification report

- Run: `20261125-082744`
- Generated: 2026-11-25T00:27:48.586237+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T09 | determinism of capture+compression | **FAIL** | 3 distinct hash(es) | 3 freezes of the same page: identical rawBytes and identical SHA-256 of decompressed state minus timestamp |

Records: 1 file(s), 1 not passing.

- **T09 fail**: determinism violated — inspect runs

Every test record (including failures) is a `T*.json` file next to this report.
