# Resource comparison tool

`bench.py` launches two independent Chrome sessions and measures the whole
browser process tree (renderers, GPU process, extension service worker,
offscreen host) while the same set of tabs is open:

- **memory** — RSS and PSS from `/proc/<pid>/smaps_rollup` (PSS is the fair
  metric for multi-process browsers)
- **CPU** — `utime + stime` deltas from `/proc/<pid>/stat`
- **GPU** — NVIDIA `nvidia-smi` utilization and memory, when available

Python 3.10+ standard library only; no pip packages.

## 1. Build the extension first

```sh
npm run build     # produces dist/
```

## 2. Run the baseline (plain Chrome)

```sh
python3 tools/memory-bench/bench.py run \
  --name baseline \
  --fresh \
  --url-file tools/memory-bench/urls.txt \
  --out tools/memory-bench/results/baseline.json
```

## 3. Run with the extension

```sh
python3 tools/memory-bench/bench.py run \
  --name extension \
  --extension dist \
  --fresh \
  --url-file tools/memory-bench/urls.txt \
  --out tools/memory-bench/results/extension.json
```

`--extension dist` adds `--load-extension=<dist>` and
`--disable-extensions-except=<dist>` to the Chrome command line. Recent
Chrome versions may ignore `--load-extension`; if so, install the unpacked
extension manually in the profile at `--profile-dir` (default
`tools/memory-bench/profiles/run` — use a **different** profile dir for each
run, or keep `--fresh` and preinstall into both profiles before measuring).

## 4. Compare

```sh
python3 tools/memory-bench/bench.py compare \
  tools/memory-bench/results/baseline.json \
  tools/memory-bench/results/extension.json \
  --out tools/memory-bench/results/comparison.md
```

The report shows mean/peak memory, CPU, and GPU for both runs with deltas.
Negative memory deltas mean the extension saved memory; positive CPU/GPU
deltas mean it cost extra work.

## Options worth tuning

| Flag | Default | Meaning |
|---|---|---|
| `--warmup` | 10 s | wait for pages to settle before sampling |
| `--interval` | 1 s | seconds between samples |
| `--samples` | 60 | number of samples (60 s at default interval) |
| `--chrome` | auto | path to browser binary (auto-detects `google-chrome`, `google-chrome-stable`, `google-chrome-unstable`, `chromium`, `chromium-browser`, `microsoft-edge`) |
| `--profile-dir` | `tools/memory-bench/profiles/run` | Chrome `--user-data-dir` |
| `--fresh` | off | delete the profile before launch |

## Fair-test checklist

- Use the **same URL file**, tab count, window size, and machine state.
- Use a **fresh profile** per run, or the same profile prepared identically.
- Disable Chrome Memory Saver in both runs.
- Let pages settle (`--warmup`) before sampling.
- Repeat 3–5 times and report means; single runs are noisy.
- Freeze inactive tabs in the extension run before or during sampling — the
  tool deliberately does not click the popup for you.
