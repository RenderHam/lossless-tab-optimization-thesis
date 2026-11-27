# Verification suite — run index

- Generated: 2026-11-27T22:52:49.037Z
- Chrome: Chrome/160.0.8171.0
- Machine: 8 CPUs, 11729 MiB RAM
- Latest run platform: Linux — memory metric: PSS
- Linux records PSS; Windows records Working Set (RSS). Do not compare numbers across operating systems.
- Suite docs: `tools/thesis-verify/README.md`

## Thesis claims vs evidence

| Claim | Tests | Latest result | Evidence (all passing runs) |
|---|---|---|---|
| 90 % memory reduction per frozen tab — _per-tab renderer PSS (Linux) / Working Set (Windows) reclaimed (tree-level delta recorded as conservative secondary)_ | T05 | T05 PASS (`20261127223949`) | T05: mean 100%, p10 100%, tree 71.24% (`20261125-072140`)<br>mean 100%, p10 100%, tree 69.79% (`20261125-083228`)<br>mean 100%, p10 100%, tree 74.48% (`20261125-142656`)<br>mean 100%, p10 100%, tree 67.77% (`20261127223949`) |
| 80 % total reduction across 50 open tabs — _whole-tree PSS (Linux) / Working Set (Windows) in steady state_ | T06 | T06 PASS (`20261127223949`) | T06: 59.73% of 1320 MiB (transient 48.78%, 18 MiB/tab) (`20261125-074200`)<br>80.49% of 2583 MiB (transient 74.47%, 43.7 MiB/tab) (`20261125-081732`)<br>79.34% of 2721 MiB (transient 76.19%, 44.7 MiB/tab) (`20261125-083228`)<br>79.25% of 2751 MiB (transient 76.16%, 45 MiB/tab) (`20261125-142656`)<br>80.51% of 2877 MiB (transient 78.26%, 47.7 MiB/tab) (`20261127223949`) |
| Lossless restore — _byte-exact DOM/forms/scroll, correct restore mode, no duplicated UI_ | T02, T03, T04 | T02 PASS (`20261127223949`)<br>T03 PASS (`20261127223949`)<br>T04 PASS (`20261127223949`) | T02: html/forms/scroll equal (`20261125-065425, 20261125-070802, 20261125-083228, 20261125-142656, 20261127223949`)<br>T03: auto-restore ok (`20261125-070802, 20261125-083228, 20261125-142656, 20261127223949`)<br>T04: max ratio 1 (`20261125-065545, 20261125-070802, 20261125-083228, 20261125-142656, 20261127223949`) |
| Deterministic pipeline (no ML/AI) — _identical bytes across freezes; no memory slope over cycles_ | T09, T10 | T09 PASS (`20261127223949`)<br>T10 PASS (`20261127223949`) | T09: 1 distinct hash(es) (`20261125-083008, 20261125-083228, 20261125-143951, 20261127223927, 20261127223949`)<br>T10: slope -0.6915%/cycle (`20261125-083017`)<br>slope 0.0104%/cycle (`20261125-083228`)<br>slope 0.0139%/cycle (`20261125-143951`)<br>slope -0.4797%/cycle (`20261127223822`)<br>slope -0.0498%/cycle (`20261127223949`) |
| Usable latency / idle cost — _extension overhead while loaded; freeze/restore p95_ | T07, T08 | T07 PASS (`20261127224909`)<br>T08 PASS (`20261127223949`) | T07: ratio 0.9886 (`20261125-082014`)<br>ratio 1.0144 (`20261125-083228`)<br>ratio 0.1395 (`20261125-142656`)<br>ratio 1.0249 (`20261125-143951`)<br>ratio 1.0147 (`20261127224909`)<br>T08: freeze p95 18.3ms, restore p95 152.3ms (`20261125-082658`)<br>freeze p95 19.8ms, restore p95 150.0ms (`20261125-083228`)<br>freeze p95 21.5ms, restore p95 741.2ms (`20261125-143951`)<br>freeze p95 20.4ms, restore p95 148.9ms (`20261127223949`) |

## All runs

Runs are never deleted — failures are part of the record.

| Run | Platform | Metric | Tests recorded | Outcomes | Report |
|---|---|---|---|---|---|
| `20261125-064735` | — | — | T02 | T02 FAIL | [report.md](20261125-064735/report.md) |
| `20261125-065425` | — | — | T02 | T02 PASS | [report.md](20261125-065425/report.md) |
| `20261125-065545` | — | — | T03, T04 | T03 FAIL, T04 PASS | [report.md](20261125-065545/report.md) |
| `20261125-070155` | — | — | T03 | T03 FAIL | [report.md](20261125-070155/report.md) |
| `20261125-070802` | — | — | T01, T02, T03, T04 | T01 PASS, T02 PASS, T03 PASS, T04 PASS | [report.md](20261125-070802/report.md) |
| `20261125-071302` | — | — | T05 | T05 FAIL | [report.md](20261125-071302/report.md) |
| `20261125-071633` | — | — | T05 | T05 FAIL | [report.md](20261125-071633/report.md) |
| `20261125-072140` | — | — | T05 | T05 PASS | [report.md](20261125-072140/report.md) |
| `20261125-072419` | — | — | T06 | T06 FAIL | [report.md](20261125-072419/report.md) |
| `20261125-074200` | — | — | T06 | T06 PASS | [report.md](20261125-074200/report.md) |
| `20261125-081732` | — | — | T06 | T06 PASS | [report.md](20261125-081732/report.md) |
| `20261125-082014` | — | — | T07 | T07 PASS | [report.md](20261125-082014/report.md) |
| `20261125-082658` | — | — | T08 | T08 PASS | [report.md](20261125-082658/report.md) |
| `20261125-082744` | — | — | T09 | T09 FAIL | [report.md](20261125-082744/report.md) |
| `20261125-083008` | — | — | T09 | T09 PASS | [report.md](20261125-083008/report.md) |
| `20261125-083017` | — | — | T10 | T10 PASS | [report.md](20261125-083017/report.md) |
| `20261125-083228` | — | — | T01, T02, T03, T04, T05, T06, T07, T08, T09, T10 | T01 PASS, T02 PASS, T03 PASS, T04 PASS, T05 PASS, T06 PASS, T07 PASS, T08 PASS, T09 PASS, T10 PASS | [report.md](20261125-083228/report.md) |
| `20261125-142323` | Linux | PSS | T01 | T01 ERROR | [report.md](20261125-142323/report.md) |
| `20261125-142656` | Linux | PSS | T01, T02, T03, T04, T05, T06, T07, T08, T09, T10 | T01 PASS, T02 PASS, T03 PASS, T04 PASS, T05 PASS, T06 PASS, T07 PASS, T08 ERROR, T09 ERROR, T10 ERROR | [report.md](20261125-142656/report.md) |
| `20261125-143951` | Linux | PSS | T07, T08, T09, T10 | T07 PASS, T08 PASS, T09 PASS, T10 PASS | [report.md](20261125-143951/report.md) |
| `20261127223822` | Linux | PSS | T09, T10 | T09 ERROR, T10 PASS | [report.md](20261127223822/report.md) |
| `20261127223927` | Linux | PSS | T09 | T09 PASS | [report.md](20261127223927/report.md) |
| `20261127223949` | Linux | PSS | T01, T02, T03, T04, T05, T06, T07, T08, T09, T10 | T01 PASS, T02 PASS, T03 PASS, T04 PASS, T05 PASS, T06 PASS, T07 ERROR, T08 PASS, T09 PASS, T10 PASS | [report.md](20261127223949/report.md) |
| `20261127224909` | Linux | PSS | T07 | T07 PASS | [report.md](20261127224909/report.md) |

## Latest status per test

| Test | Name | Latest run | Result | Key metric | Passing evidence |
|---|---|---|---|---|---|
| T01 | freeze success rate | `20261127223949` | **PASS** | success rate 100.0% | success rate 100.0% |
| T02 | byte-exact fidelity after freeze/restore | `20261127223949` | **PASS** | html/forms/scroll equal | html/forms/scroll equal |
| T03 | restore mode correctness (+ auto-restore) | `20261127223949` | **PASS** | auto-restore ok | auto-restore ok |
| T04 | no duplicated UI after restore | `20261127223949` | **PASS** | max ratio 1 | max ratio 1 |
| T05 | per-tab memory saving | `20261127223949` | **PASS** | mean 100%, p10 100%, tree 67.77% | mean 100%, p10 100%, tree 67.77% |
| T06 | aggregate memory saving across 50 tabs | `20261127223949` | **PASS** | 80.51% of 2877 MiB (transient 78.26%, 47.7 MiB/tab) | 80.51% of 2877 MiB (transient 78.26%, 47.7 MiB/tab) |
| T07 | extension idle memory overhead | `20261127224909` | **PASS** | ratio 1.0147 | ratio 1.0147 |
| T08 | freeze/restore latency and spikes | `20261127223949` | **PASS** | freeze p95 20.4ms, restore p95 148.9ms | freeze p95 20.4ms, restore p95 148.9ms |
| T09 | determinism of capture+compression | `20261127223949` | **PASS** | 1 distinct hash(es) | 1 distinct hash(es) |
| T10 | stress: 20 freeze/restore cycles, leak check | `20261127223949` | **PASS** | slope -0.0498%/cycle | slope -0.0498%/cycle |
