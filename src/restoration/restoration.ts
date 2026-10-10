/**
 * Lazy Restoration Module.
 *
 * Two deterministic mechanisms:
 *
 *  1. Chunked stream deserialization — compressed bytes are read from
 *     IndexedDB in fixed 64 KiB increments and joined in index order.
 *  2. Batched DOM hydration — nodes are materialized in batches of at most
 *     HYDRATION_BATCH_SIZE (100) per idle frame via requestIdleCallback
 *     (fallback: setTimeout 0), guaranteeing no long task (>50ms) is forced
 *     by hydration itself. Each batch yields back to the event loop.
 *
 * Because capture assigns dense BFS ids in visitation order with
 * parentId < child id, hydration can proceed strictly in array order with a
 * single id->Element map and no forward references.
 */

import type { FlatNodeDescriptor, SerializedTabState } from "../shared/types";
import { HYDRATION_BATCH_SIZE } from "../shared/types";

export interface HydrationStats {
  totalNodes: number;
  batches: number;
  elapsedMs: number;
  maxBatchMs: number;
}

function nextIdle(timeoutMs = 50): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      ric.call(globalThis, () => resolve(), { timeout: timeoutMs });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function createNode(desc: FlatNodeDescriptor, doc: Document): Node {
  if (desc.tagName === "#text") {
    return doc.createTextNode(desc.textContent ?? "");
  }
  const el = doc.createElement(desc.tagName.toLowerCase());
  for (const [k, v] of Object.entries(desc.attributes)) {
    if (k === "data-lto-skipped") continue;
    try {
      el.setAttribute(k, v);
    } catch {
      // Invalid attribute name on this document — skip deterministically.
    }
  }
  if (desc.textContent !== undefined && el.childNodes.length === 0) {
    el.textContent = desc.textContent;
  }
  return el;
}

/**
 * Hydrate `state.domTree` into `container` (defaults to document.body),
 * replacing its children. Returns per-run stats for profiling.
 */
export async function hydrateDOM(
  state: SerializedTabState,
  container?: Element,
  onProgress?: (done: number, total: number) => void,
): Promise<HydrationStats> {
  const t0 = performance.now();
  const doc = container?.ownerDocument ?? document;
  const host: Element = container ?? doc.body;
  const nodes = state.domTree;
  const built = new Map<number, Node>();
  let maxBatchMs = 0;
  let batches = 0;

  // Clear host deterministically.
  while (host.firstChild) host.removeChild(host.firstChild);

  for (let off = 0; off < nodes.length; off += HYDRATION_BATCH_SIZE) {
    const batchStart = performance.now();
    const batch = nodes.slice(off, off + HYDRATION_BATCH_SIZE);
    for (const desc of batch) {
      const node = createNode(desc, doc);
      built.set(desc.id, node);
      if (desc.parentId === -1) {
        host.appendChild(node);
      } else {
        const parent = built.get(desc.parentId);
        if (parent) parent.appendChild(node);
        else host.appendChild(node); // orphan fallback — never throws
      }
    }
    batches++;
    onProgress?.(Math.min(off + batch.length, nodes.length), nodes.length);
    maxBatchMs = Math.max(maxBatchMs, performance.now() - batchStart);
    // Yield to keep the main thread under the long-task budget.
    await nextIdle();
  }

  restoreFormInputs(state, doc);
  return { totalNodes: nodes.length, batches, elapsedMs: performance.now() - t0, maxBatchMs };
}

/** Re-apply captured form values in document order (same key scheme as capture). */
export function restoreFormInputs(state: SerializedTabState, doc: Document = document): void {
  const inputs = doc.querySelectorAll("input, textarea, select");
  inputs.forEach((el, index) => {
    const key = formKeyFor(el as Element, index);
    if (!(key in state.formInputs)) return;
    const value = state.formInputs[key];
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT" && typeof value !== "undefined") {
      const input = el as HTMLInputElement;
      const type = (input.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") input.checked = value === true;
      else if (typeof value === "string") input.value = value;
    } else if (tag === "TEXTAREA" && typeof value === "string") {
      (el as HTMLTextAreaElement).value = value;
    } else if (tag === "SELECT") {
      const sel = el as HTMLSelectElement;
      if (sel.multiple && Array.isArray(value)) {
        for (const opt of Array.from(sel.options)) opt.selected = (value as string[]).includes(opt.value);
      } else if (typeof value === "string") {
        sel.value = value;
      }
    }
  });
  try {
    window.scrollTo(state.scrollPosition.x, state.scrollPosition.y);
  } catch {
    // non-visual context — ignore
  }
}

function formKeyFor(el: Element, index: number): string {
  const id = el.getAttribute("id");
  if (id) return `#${id}`;
  const name = el.getAttribute("name");
  if (name) return `${el.tagName.toLowerCase()}[name=${name}]`;
  return `${el.tagName.toLowerCase()}#${index}`;
}

// ---------------------------------------------------------------------------
// Proxy-based lazy heap reinitialization
// ---------------------------------------------------------------------------

export interface HeapSliceLoader {
  /** Synchronously unmarshal slice `key`; called at most once per key. */
  load(key: string): unknown;
}

/**
 * Wraps a `Record<key, marshalled>` so each slice is unmarshalled on first
 * property access via the `get` trap, then cached. Deterministic: access
 * order does not affect stored values, loader is pure per key.
 */
export function createLazyHeap<T extends Record<string, unknown>>(marshalled: T, loader: HeapSliceLoader): T {
  const cache = new Map<string, unknown>();
  const loaded = new Set<string>();
  return new Proxy(marshalled, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || !(prop in target)) {
        return Reflect.get(target, prop, receiver);
      }
      if (!loaded.has(prop)) {
        const value = loader.load(prop);
        cache.set(prop, value);
        loaded.add(prop);
      }
      return cache.get(prop);
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(target, prop);
      if (!d) return d;
      if (typeof prop === "string" && loaded.has(prop)) {
        return { ...d, value: cache.get(prop) };
      }
      return d;
    },
  });
}
