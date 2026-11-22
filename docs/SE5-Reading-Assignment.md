# SE5 Reading Assignment: Impacts of Coding Practices on Readability

**Course:** Software Engineering 5 (SE5) — Reading Assignment
**Paper reviewed:** Santos, R. M. dos, & Gerosa, M. A. (2018).
**Thesis project:** Lossless State Compression and Lazy Restoration for Browser
Tab Memory Optimization — a deterministic Manifest V3 Web Extension written in
TypeScript (Vite + CRXJS, zstd-wasm compression worker, IndexedDB chunk store).

---

## 1. Key Findings

Santos and Gerosa [1] ran a controlled experiment in which professional
developers compared pairs of Java snippets that differed in exactly one coding
practice, then rated which version was more readable. Four of their results are
directly relevant to our thesis codebase:

- **P.1 — Blank line after opening/closing braces.** Inserting a blank line
  after a block boundary acts as a visual paragraph break. The adhering version
  was preferred by **86.54%** of raters, a highly significant effect
  (**p < 0.0001**).
- **P.4 — 80-character line length limit.** Lines kept under 80 characters were
  preferred by **74.58%** of raters (**p = 0.0003**), because short lines reduce
  horizontal scanning and fit side-by-side diffs and narrow editor panes.
- **P.8 — Avoid fully-qualified names.** Replacing long fully-qualified names
  with short names plus `import` statements was preferred by **89.66%** of
  raters (**p < 0.0001**) — the strongest preference in the study.
- **P.2 — Brace placement (surprising result).** Contrary to the common
  JavaScript/TypeScript convention, placing the opening brace on its *own line*
  (C# style) was judged more readable by **69.81%** of raters (**p = 0.0060**),
  apparently because vertically aligned braces make block boundaries easier to
  scan. We note this finding but do not adopt it (see Section 4).

## 2. Thesis Application

Below, each practice is shown as a **Before** (violating) and **After**
(adhering) snippet drawn from our actual modules (`indexeddb.ts`,
`background.ts`, `restoration.ts`).

### P.1 — Blank lines after braces (`src/background/background.ts`)

```typescript
// BEFORE (violating): blocks run together; freeze stages blur into one wall.
export async function freezeTab(tabId: number) {
  await ensureBridge();
  const state = await captureTab(tabId);
  const compressed = await bridge.compress(encodeUtf8(stableStringify(state)));
  await writeCompressedChunks(tabId, compressed, toMeta(state));
  await chrome.tabs.discard(tabId);
  return { rawBytes: 1, compressedBytes: 2 };
}
```

```typescript
// AFTER (adhering): blank lines separate the pipeline stages.

export async function freezeTab(tabId: number) {

  await ensureBridge();
  const state = await captureTab(tabId);

  const compressed = await bridge.compress(encodeUtf8(stableStringify(state)));
  await writeCompressedChunks(tabId, compressed, toMeta(state));

  await chrome.tabs.discard(tabId);
  return { rawBytes: 1, compressedBytes: 2 };

}
```

### P.4 — 80-character lines (`src/storage/indexeddb.ts`)

```typescript
// BEFORE (violating, 96 chars): forces horizontal scrolling to see the store arg.
import { createStore, get, set, del, keys } from "idb-keyval"; const s = createStore("lto-db", "x");
```

```typescript
// AFTER (adhering): each line fits in 80 columns and in a split-screen diff.
import { createStore, get, set, del, keys } from "idb-keyval";

const s = createStore("lto-db", "x");
```

### P.8 — Short names with imports (`tsconfig.json` path alias `@shared/*`)

```typescript
// BEFORE (violating): deep relative paths repeated in every module.
import { CHUNK_SIZE_BYTES } from "../../../shared/types";
import { stableStringify } from "../../../shared/codec";
```

```typescript
// AFTER (adhering): one alias import per module, configured in tsconfig.json.
import { CHUNK_SIZE_BYTES } from "@shared/types";
import { stableStringify } from "@shared/codec";
```

## 3. Justification

Our choices follow the study's statistics directly. P.8 showed the largest
preference (**89.66%, p < 0.0001**) [1], so normalizing every cross-module
import to the `@shared/*` alias is our highest-priority cleanup: it shortens
the most frequently re-read lines in the codebase. P.1 (**86.54%, p < 0.0001**)
justifies blank lines around each pipeline stage in `background.ts`, since a
reviewer checking our freeze path must distinguish capture, compression, and
teardown at a glance. P.4 (**74.58%, p = 0.0003**) justifies wrapping the long
`writeCompressedChunks` signatures and chunk-key expressions in `indexeddb.ts`,
which are otherwise unreadable in side-by-side pull-request diffs. All three
effects are statistically significant (p < 0.01), so adopting them is
evidence-based rather than a matter of taste [1].

## 4. Reflection

Adopting P.1, P.4, and P.8 will improve our thesis system in three concrete
ways. First, **readability**: blank-line-separated stages and short lines let a
panelist or new maintainer trace the capture → compress → discard → restore
flow without horizontal scrolling or block-boundary hunting. Second,
**maintainability**: alias imports (`@shared/*`) mean moving a module never
requires rewriting brittle `../../../` chains, which directly lowers the cost
of the Weeks 11–14 refactoring and benchmarking work. Third, **code quality**:
an 80-column limit keeps every file diff-friendly, so fidelity bugs (e.g., a
dropped form field during hydration) are easier to spot in review. We
deliberately do **not** adopt P.2's own-line braces: although preferred by
69.81% of the study's Java raters, it contradicts the TypeScript/Prettier
ecosystem default, and consistency with our toolchain matters more for a
TypeScript thesis artifact. Overall, these three low-cost practices make our
deterministic pipeline easier to read, review, and defend.

---

## References

[1] R. M. dos Santos and M. A. Gerosa, "Impacts of coding practices on
readability," in *Proc. 26th IEEE/ACM Int. Conf. Program Comprehension
(ICPC '18)*, Gothenburg, Sweden, 2018, pp. 277–285.
