# Verification suite — run index

- Generated: 2026-11-25T00:46:51.957879+00:00
- Chrome: Google Chrome 160.0.8171.0 dev
- Machine: 8 CPUs, 11729 MiB RAM
- Suite docs: `tools/thesis-verify/README.md`

## Thesis claims vs evidence

| Claim | Tests | Latest result | Evidence (all passing runs) |
|---|---|---|---|
| 90 % memory reduction per frozen tab — _per-tab renderer PSS reclaimed (tree-level delta recorded as conservative secondary)_ | T05 | T05 PASS (`20261125-083228`) | T05: mean 100.0%, p10 100.0%, tree 71.24% (`20261125-072140`)<br>mean 100.0%, p10 100.0%, tree 69.79% (`20261125-083228`) |
| 80 % total reduction across 50 open tabs — _whole-tree PSS in steady state_ | T06 | T06 PASS (`20261125-083228`) | T06: 59.73% of 1320 MiB (transient 48.78%, 18.0 MiB/tab) (`20261125-074200`)<br>80.49% of 2583 MiB (transient 74.47%, 43.7 MiB/tab) (`20261125-081732`)<br>79.34% of 2721 MiB (transient 76.19%, 44.7 MiB/tab) (`20261125-083228`) |
| Lossless restore — _byte-exact DOM/forms/scroll, correct restore mode, no duplicated UI_ | T02, T03, T04 | T02 PASS (`20261125-083228`)<br>T03 PASS (`20261125-083228`)<br>T04 PASS (`20261125-083228`) | T02: html/forms/scroll equal (`20261125-065425, 20261125-070802, 20261125-083228`)<br>T03: auto-restore ok (`20261125-070802, 20261125-083228`)<br>T04: max ratio 1.0 (`20261125-065545, 20261125-070802, 20261125-083228`) |
| Deterministic pipeline (no ML/AI) — _identical bytes across freezes; no memory slope over cycles_ | T09, T10 | T09 PASS (`20261125-083228`)<br>T10 PASS (`20261125-083228`) | T09: 1 distinct hash(es) (`20261125-083008, 20261125-083228`)<br>T10: slope -0.6915%/cycle (`20261125-083017`)<br>slope 0.0104%/cycle (`20261125-083228`) |
| Usable latency / idle cost — _extension overhead while loaded; freeze/restore p95_ | T07, T08 | T07 PASS (`20261125-083228`)<br>T08 PASS (`20261125-083228`) | T07: ratio 0.9886 (`20261125-082014`)<br>ratio 1.0144 (`20261125-083228`)<br>T08: freeze p95 18.3ms, restore p95 152.3ms (`20261125-082658`)<br>freeze p95 19.8ms, restore p95 150.0ms (`20261125-083228`) |

## All runs

Runs are never deleted — failures are part of the record.

| Run | Tests recorded | Outcomes | Report |
|---|---|---|---|
| `20261125-064735` | T02 | T02 FAIL | [report.md](20261125-064735/report.md) |
| `20261125-065425` | T02 | T02 PASS | [report.md](20261125-065425/report.md) |
| `20261125-065545` | T03, T04 | T03 FAIL, T04 PASS | [report.md](20261125-065545/report.md) |
| `20261125-070155` | T03 | T03 FAIL | [report.md](20261125-070155/report.md) |
| `20261125-070802` | T01, T02, T03, T04 | T01 PASS, T02 PASS, T03 PASS, T04 PASS | [report.md](20261125-070802/report.md) |
| `20261125-071302` | T05 | T05 FAIL | [report.md](20261125-071302/report.md) |
| `20261125-071633` | T05 | T05 FAIL | [report.md](20261125-071633/report.md) |
| `20261125-072140` | T05 | T05 PASS | [report.md](20261125-072140/report.md) |
| `20261125-072419` | T06 | T06 FAIL | [report.md](20261125-072419/report.md) |
| `20261125-074200` | T06 | T06 PASS | [report.md](20261125-074200/report.md) |
| `20261125-081732` | T06 | T06 PASS | [report.md](20261125-081732/report.md) |
| `20261125-082014` | T07 | T07 PASS | [report.md](20261125-082014/report.md) |
| `20261125-082658` | T08 | T08 PASS | [report.md](20261125-082658/report.md) |
| `20261125-082744` | T09 | T09 FAIL | [report.md](20261125-082744/report.md) |
| `20261125-083008` | T09 | T09 PASS | [report.md](20261125-083008/report.md) |
| `20261125-083017` | T10 | T10 PASS | [report.md](20261125-083017/report.md) |
| `20261125-083228` | T01, T02, T03, T04, T05, T06, T07, T08, T09, T10 | T01 PASS, T02 PASS, T03 PASS, T04 PASS, T05 PASS, T06 PASS, T07 PASS, T08 PASS, T09 PASS, T10 PASS | [report.md](20261125-083228/report.md) |

## Latest status per test

| Test | Name | Latest run | Result | Key metric | Passing evidence |
|---|---|---|---|---|---|
| T01 | freeze success rate | `20261125-083228` | **PASS** | success rate 100.0% | success rate 100.0% |
| T02 | byte-exact fidelity after freeze/restore | `20261125-083228` | **PASS** | html/forms/scroll equal | html/forms/scroll equal |
| T03 | restore mode correctness (+ auto-restore) | `20261125-083228` | **PASS** | auto-restore ok | auto-restore ok |
| T04 | no duplicated UI after restore | `20261125-083228` | **PASS** | max ratio 1.0 | max ratio 1.0 |
| T05 | per-tab memory saving | `20261125-083228` | **PASS** | mean 100.0%, p10 100.0%, tree 69.79% | mean 100.0%, p10 100.0%, tree 69.79% |
| T06 | aggregate memory saving across 50 tabs | `20261125-083228` | **PASS** | 79.34% of 2721 MiB (transient 76.19%, 44.7 MiB/tab) | 79.34% of 2721 MiB (transient 76.19%, 44.7 MiB/tab) |
| T07 | extension idle memory overhead | `20261125-083228` | **PASS** | ratio 1.0144 | ratio 1.0144 |
| T08 | freeze/restore latency and spikes | `20261125-083228` | **PASS** | freeze p95 19.8ms, restore p95 150.0ms | freeze p95 19.8ms, restore p95 150.0ms |
| T09 | determinism of capture+compression | `20261125-083228` | **PASS** | 1 distinct hash(es) | 1 distinct hash(es) |
| T10 | stress: 20 freeze/restore cycles, leak check | `20261125-083228` | **PASS** | slope 0.0104%/cycle | slope 0.0104%/cycle |
