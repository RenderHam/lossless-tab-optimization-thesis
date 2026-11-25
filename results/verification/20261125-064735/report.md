# Thesis verification report

- Run: `20261125-064735`
- Generated: 2026-11-24T22:48:46.478746+00:00

| Test | Name | Result | Key metric | Threshold |
|---|---|---|---|---|
| T02 | byte-exact fidelity after freeze/restore | **FAIL** | MISMATCH | html == AND form values == AND scroll ±2px for every tab |

Records: 1 file(s), 1 not passing.

- **T02 fail**: http://x001.lto.test:8123/form.html: forms/scroll mismatch

Every test record (including failures) is a `T*.json` file next to this report.
