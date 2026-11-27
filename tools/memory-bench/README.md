# Memory comparison

Memory measurement is now part of the Bun verification harness — **T07**
launches two identical browsing sessions (plain Chrome vs. Chrome with the
unpacked extension), samples the Chrome process tree, and writes
`T07-baseline.json` / `T07-extension.json` into each run directory under
`results/verification/<run-id>/`.

```sh
bun run build
bun run verify -- --tests T07
```

Linux uses PSS from `/proc/<pid>/smaps_rollup`; Windows uses Working Set (RSS)
through PowerShell/CIM because Windows has no PSS equivalent. Every record
states its `memory_metric` — Windows and Linux numbers are not comparable.
The comparison ratio is recorded in `T07.json` and shown in
`results/verification/SUMMARY.md`.

No Python, `smem`, or standalone `zstd` binary is needed. The former Python
`bench.py` tool has been removed; the `urls.txt` and `results/` files here are
kept as historical sample inputs/results.
