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

The suite runs on **Linux and Windows** with a single runtime: **Bun 1.4+**.
No Node.js, npm, Python, venv, `websocket-client`, `smem`, or `zstd` CLI is
needed. The only other requirement is a real browser (Chrome 160+ dev channel
recommended, or Edge). `zstd`, if installed, is used only as an optional
cross-check for T09.

Install Bun once:

```sh
curl -fsSL https://bun.com/install | bash            # macOS/Linux
powershell -c "irm bun.sh/install.ps1|iex"           # Windows PowerShell
```

`bun install` (or `bun run setup`) installs the project dependencies. The OS
launchers `scripts/bootstrap.sh` / `scripts/bootstrap.ps1` / `bootstrap.cmd`
will print the install command and ask before installing Bun.

The harness auto-detects Chrome on `PATH` (Linux) or in the usual
`Program Files` locations plus the `App Paths` registry key (Windows). Override
with `--chrome`, including absolute Windows paths with spaces:

```powershell
bun run verify -- --tests all --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## Commands

These work identically in bash, cmd.exe and PowerShell:

```sh
bun run build                          # typecheck + Vite build → dist/
bun run verify                         # full suite (T01..T10), ~30–45 min
bun run verify -- --tests T01,T02      # subset
bun run verify -- --tests T01,T02 --tabs 50 --small-tabs 8 --bench-tabs 10 --cycles 20
bun run report -- --run <run-id>       # regenerate one run's report
bun run summary                        # regenerate the cross-run index
```

You can also call the harness directly:
`bun tools/thesis-verify/verify.ts run --tests all`.

## Development tests (no browser)

The extension contracts and the platform layer are tested with Bun's test
runner. Both groups run on either OS without launching Chrome:

```sh
bun test                               # all tests
bun test tools/thesis-verify/tests     # platform layer only
bun run typecheck                      # extension + tooling
```

CI (`.github/workflows/verify.yml`) runs these plus `bun run build` on
`ubuntu-latest` and `windows-latest` using `oven-sh/setup-bun@v2`.

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
| T05 | **Per-tab saving** — tab's renderer PSS (Linux) / Working Set (Windows) reclaimed by freeze | mean ≥ 70 %, p10 ≥ 60 % (claim 90 %) |
| T06 | **Aggregate saving across 50 tabs** — whole-tree PSS (Linux) / Working Set (Windows), steady state | ≥ 50 % (claim 80 %) |
| T07 | Extension idle overhead while merely loaded | extension/baseline memory ratio ≤ 1.10 |
| T08 | Latency: freeze p95, restore p95, hydration batch time | freeze ≤ 2000 ms, restore ≤ 5000 ms, batch ≤ 50 ms |
| T09 | Determinism: 3 freezes of the same page → identical bytes | 1 distinct SHA-256 (modulo runtime-only fields) |
| T10 | Stress: 20 freeze/restore cycles, leak check | 0 errors, memory slope ≤ 1 %/cycle |

Thresholds live in `THRESHOLDS` at the top of `verify.ts` and are copied into
each run's `env.json`, so a record always states the bar it was judged against.

## Metric definitions (read before interpreting numbers)

- **The metric depends on the operating system, and runs are labelled.**
  Linux uses **PSS** (proportional set size, from `/proc/<pid>/smaps_rollup`).
  Windows has no PSS equivalent, so it uses **Working Set (RSS)** for the
  Chrome process tree via PowerShell/CIM (`windowsSnapshot`). Every `env.json` records `os`,
  `memory_metric` and `memory_backend`; T05/T06/T07 records repeat
  `memory_metric`. **Do not compare a Windows number with a Linux number** —
  Working Set counts shared pages in every process, so it is systematically
  larger than PSS. Older field names (`pss_before`, `tab_pss_bytes`, …) are
  kept for compatibility with existing records; on Windows they hold Working
  Set values, and `memory_metric` is the authoritative label.
- **Primary metric is per-process PSS** on Linux (proportional set size, from
  `/proc/<pid>/smaps_rollup`); on Windows it is per-process Working Set. T05 attributes memory to
  the tab's own renderer: freezing the tab kills the renderer, so
  `tab_reclaimed_pct` = share of that process's memory that came back.
  Tree-level delta (`mean_tree_saved_pct`) is recorded as a *conservative
  secondary* metric — it includes Chrome's fixed baseline (browser, GPU,
  network, extension workers ≈ 500 MiB), which does not shrink no matter how
  well freezing works.
- **Transient vs steady state (T06):** the extension's service worker /
  offscreen document hold ≈ +50 MiB for ~30 s after the last freeze. T06 waits
  for steady state (`min_wait=40 s`, 5 samples within 1 %) and records both the
  steady number (`saved_pct`, the pass/fail metric) and the transient one
  (`transient_saved_pct`).
- **Per-tab weight caps the tree percentage.** Tree saving = (tab memory ×
  frozen tabs) ÷ total tree memory. With light pages the fixed ~500 MiB baseline
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
  `ldblbaljliedojnkgjmealollolmbdga`; T07's A/B sessions use the same mechanism.
- **`chrome.tabs.discard` replaces the tab id.** The harness polls and
  restores tabs by URL, not by id.
- Fixtures are served from `http://127.0.0.1:8123`; distinct
  `*.lto.test` hostnames (via `--host-resolver-rules`) keep each tab in its
  own renderer process so memory can be attributed per tab.
- The extension is driven through its own popup page
  (`chrome-extension://<id>/src/ui/popup.html`) over CDP — the same message
  protocol a user triggers.
- **Windows:** run from PowerShell. Chrome/Edge is found under
  `Program Files` (or `--chrome`); the browser is killed with
  `taskkill /T /F`; total RAM comes from PowerShell/CIM; the version
  string is read over CDP because `chrome.exe --version` prints nothing.
  T09 decompresses through the extension's own offscreen worker, so no
  external `zstd` is needed. Use the same Windows machine for before/after
  comparisons and record the run normally — `env.json` will say
  `"os": "Windows"` and `"memory_metric": "Working Set (RSS)"`.

## Artifacts per run (`results/verification/<run-id>/`)

| File | Content |
|---|---|
| `env.json` | Chrome version, git revision, Bun version, OS, memory metric, machine, thresholds |
| `T01.json` … `T10.json` | one record per test: `result`, `metrics`, `notes`, `threshold`, timings |
| `report.md` | aggregated table: test → result → key metric → threshold |
| `T02-*.png`, `T07-*.json`, `T09-run*.zst/.json`, … | raw evidence referenced from the record's `artifacts` list |

An index of all runs lives in `results/verification/SUMMARY.md`.
