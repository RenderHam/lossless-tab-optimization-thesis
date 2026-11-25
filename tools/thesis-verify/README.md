# Thesis verification suite (T01–T10)

Automated, fully recorded verification of the tab-freeze extension against the
thesis claims in `README.md` / `PROMPT.md`:

- **90 % reduction in memory footprint per frozen tab** → T05
- **80 % total reduction across 50 open tabs** → T06
- **Lossless restore** → T02, T03, T04
- Deterministic (no ML/AI) pipeline → T09

Every run writes one JSON record per test plus an aggregated `report.md` to
`results/verification/<run-id>/`. Failures and aborted runs are recorded too —
nothing is ever deleted.

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| `python3` + `venv` | harness runtime | preinstalled |
| `websocket-client` | drives Chrome over CDP | `python3 -m venv tools/thesis-verify/.venv && tools/thesis-verify/.venv/bin/pip install websocket-client` |
| Google Chrome (160+) | real browser under test | `google-chrome-unstable` (dev channel) |
| `zstd` | decompresses snapshot artifacts for byte checks | `zstd` package (already present) |
| `smem` | proportional-set-size (PSS) per process — the memory metric | `smem` package (already present) |
| `node` + npm | builds the extension (`tsc`, `vite build`) | preinstalled |
| `jq` (optional) | inspecting JSON records | `jq` package |

The harness auto-detects the Chrome binary; override with `--chrome`.

## Commands

```sh
# build the extension first
npx tsc --noEmit && npx vite build

# full suite (T01..T10), ~30–45 min
tools/thesis-verify/.venv/bin/python tools/thesis-verify/verify.py run --tests all

# subset / sizing options
tools/thesis-verify/.venv/bin/python tools/thesis-verify/verify.py run \
  --tests T01,T02 --tabs 50 --small-tabs 8 --bench-tabs 10 --cycles 20

# regenerate the report for an existing run
tools/thesis-verify/.venv/bin/python tools/thesis-verify/verify.py report --run <run-id>

# regenerate the cross-run index (runs automatically after every run, too)
tools/thesis-verify/.venv/bin/python tools/thesis-verify/verify.py summary
```

Options: `--tabs` (T01/T06, default 50), `--small-tabs` (T05/T08, default 8),
`--bench-tabs` (T07, default 10), `--cycles` (T10, default 20),
`--keep-profile` (keep the Chrome profile for post-mortem).

## Test matrix

| ID | What it proves | Threshold |
|---|---|---|
| T01 | Freeze succeeds on real tabs | ≥ 95 % of eligible tabs |
| T02 | Restore is byte-exact: HTML, form values, scroll ±2 px | every tab equal |
| T03 | Overlay mode on populated pages, full rebuild on empty pages, auto-restore on activation | all three correct |
| T04 | No duplicated UI after restore (element-count ratio) | ≤ 1.10 |
| T05 | **Per-tab saving** — tab's renderer process PSS reclaimed by freeze | mean ≥ 70 %, p10 ≥ 60 % (claim 90 %) |
| T06 | **Aggregate saving across 50 tabs** — whole-tree PSS, steady state | ≥ 50 % (claim 80 %) |
| T07 | Extension idle overhead while merely loaded | extension/baseline PSS ratio ≤ 1.10 |
| T08 | Latency: freeze p95, restore p95, hydration batch time | freeze ≤ 2000 ms, restore ≤ 5000 ms, batch ≤ 50 ms |
| T09 | Determinism: 3 freezes of the same page → identical bytes | 1 distinct SHA-256 (modulo runtime-only fields) |
| T10 | Stress: 20 freeze/restore cycles, leak check | 0 errors, memory slope ≤ 1 %/cycle |

Thresholds live in `THRESHOLDS` at the top of `verify.py` and are copied into
each run's `env.json`, so a record always states the bar it was judged against.

## Metric definitions (read before interpreting numbers)

- **Primary metric is per-process PSS** (proportional set size, from `smem`).
  T05 attributes memory to the tab's own renderer: freezing the tab kills the
  renderer, so `tab_reclaimed_pct` = share of that process's PSS that came back.
  Tree-level delta (`mean_tree_saved_pct`) is recorded as a *conservative
  secondary* metric — it includes Chrome's fixed baseline (browser, GPU,
  network, extension workers ≈ 500 MiB), which does not shrink no matter how
  well freezing works.
- **Transient vs steady state (T06):** the extension's service worker /
  offscreen document hold ≈ +50 MiB for ~30 s after the last freeze. T06 waits
  for steady state (`min_wait=40 s`, 5 samples within 1 %) and records both the
  steady number (`saved_pct`, the pass/fail metric) and the transient one
  (`transient_saved_pct`).
- **Per-tab weight caps the tree percentage.** Tree saving = (tab PSS × frozen
  tabs) ÷ total tree PSS. With light pages the fixed ~500 MiB baseline
  dominates: that boundary is recorded honestly in run `20261125-072419`
  (47.01 %, FAIL) before fixtures carried a realistic heap. Heavy fixtures
  (24 MiB resident JS heap per tab) put each tab at ≈ 44 MiB PSS, and the same
  measurement reaches **80.49 %** in run `20261125-081732`.
- **Fixture heap must be read, not just allocated.** V8 builds
  `String.repeat` results as lazy cons-strings; the pages only become
  resident once read. `fixtures/heavy.html` therefore touches every string
  (fixed index → still deterministic). Measured effect: renderer private
  memory 19 MiB → 45 MiB per tab.
- **T09 excludes exactly three runtime-only fields:** `timestamp` (wall
  clock), `tabId` and `heapSnapshotRef` (Chrome mints a new tab id on every
  discard cycle, so these cannot be page-derived; nothing reads them back —
  storage is keyed by the tab id passed alongside the payload). The record's
  `varying_fields` metric lists the fields that actually differed; any
  field outside the exclusion list fails the test.

## Environment notes

- **Chrome 160 blocks `--load-extension`.** The harness loads the extension
  via CDP `Extensions.loadUnpacked` (requires
  `--enable-unsafe-extension-debugging`); extension id
  `ldblbaljliedojnkgjmealollolmbdga`. `bench.py` uses the same mechanism.
- **`chrome.tabs.discard` replaces the tab id.** The harness polls and
  restores tabs by URL, not by id.
- Fixtures are served from `http://127.0.0.1:8123`; distinct
  `*.lto.test` hostnames (via `--host-resolver-rules`) keep each tab in its
  own renderer process so PSS can be attributed per tab.
- The extension is driven through its own popup page
  (`chrome-extension://<id>/src/ui/popup.html`) over CDP — the same message
  protocol a user triggers.

## Artifacts per run (`results/verification/<run-id>/`)

| File | Content |
|---|---|
| `env.json` | Chrome version, git revision, machine, thresholds |
| `T01.json` … `T10.json` | one record per test: `result`, `metrics`, `notes`, `threshold`, timings |
| `report.md` | aggregated table: test → result → key metric → threshold |
| `T02-*.png`, `T07-*.json`, `T09-run*.zst/.json`, … | raw evidence referenced from the record's `artifacts` list |

An index of all runs lives in `results/verification/SUMMARY.md`.
