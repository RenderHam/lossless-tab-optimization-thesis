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

import type { FlatNodeDescriptor, FormValue, SerializedTabState } from "../shared/types";
import { HYDRATION_BATCH_SIZE } from "../shared/types";

export interface HydrationStats {
  totalNodes: number;
  batches: number;
  elapsedMs: number;
  maxBatchMs: number;
  formApplied: number;
  formMissing: string[];
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
  // Stable identity for form restoration even if index-based keys shift.
  el.setAttribute("data-lto-id", String(desc.id));
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

  // Capture starts at <html>. When hydrating into the live document root,
  // map that root descriptor onto the existing documentElement instead of
  // nesting a second <html> inside it.
  const rootIsHtml = nodes[0]?.tagName === "HTML";
  const mountIntoDocumentRoot = rootIsHtml && host === doc.documentElement;

  // Clear host deterministically.
  while (host.firstChild) host.removeChild(host.firstChild);

  for (let off = 0; off < nodes.length; off += HYDRATION_BATCH_SIZE) {
    const batchStart = performance.now();
    const batch = nodes.slice(off, off + HYDRATION_BATCH_SIZE);
    for (const desc of batch) {
      if (mountIntoDocumentRoot && desc.parentId === -1) {
        built.set(desc.id, host);
        continue;
      }
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

  const form = restoreFormInputs(state, doc);
  // Page scripts can re-initialize fields after hydration; re-apply once more
  // on the next idle frame so the user's typed values survive.
  await nextIdle();
  restoreFormInputs(state, doc);
  return {
    totalNodes: nodes.length,
    batches,
    elapsedMs: performance.now() - t0,
    maxBatchMs,
    formApplied: form.applied,
    formMissing: form.missing,
  };
}

export interface FormRestoreStats {
  applied: number;
  missing: string[];
}

/** Re-apply captured form values, preferring stable BFS node identity. */
export function restoreFormInputs(state: SerializedTabState, doc: Document = document): FormRestoreStats {
  const stats: FormRestoreStats = { applied: 0, missing: [] };
  const handled = new Set<string>();

  // 1. BFS node id is the authoritative match: survives index shifts and
  //    dynamic elements injected by the page after reload.
  if (state.formInputNodeIds) {
    for (const [key, nodeId] of Object.entries(state.formInputNodeIds)) {
      if (!(key in state.formInputs) || nodeId < 0) continue;
      const el = doc.querySelector(`[data-lto-id="${nodeId}"]`);
      if (el && applyFormValue(el, state.formInputs[key])) {
        stats.applied++;
        handled.add(key);
      }
    }
  }

  // 2. Fallback for older snapshots or pages that changed structure.
  const inputs = doc.querySelectorAll("input, textarea, select");
  inputs.forEach((el, index) => {
    const candidates = formKeysFor(el, index);
    const key = candidates.find((k) => !handled.has(k) && k in state.formInputs);
    if (!key) return;
    if (applyFormValue(el, state.formInputs[key])) {
      stats.applied++;
      handled.add(key);
    }
  });

  for (const key of Object.keys(state.formInputs)) {
    if (!handled.has(key)) stats.missing.push(key);
  }

  try {
    window.scrollTo(state.scrollPosition.x, state.scrollPosition.y);
  } catch {
    // non-visual context — ignore
  }
  return stats;
}

function applyFormValue(el: Element, value: FormValue | undefined): boolean {
  if (value === undefined) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    const type = (input.type || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") input.checked = value === true;
    else if (typeof value === "string") {
      input.value = value;
      input.setAttribute("value", value); // some frameworks read the attribute
    } else return false;
  } else if (tag === "TEXTAREA") {
    if (typeof value !== "string") return false;
    const area = el as HTMLTextAreaElement;
    area.value = value;
    area.textContent = value;
  } else if (tag === "SELECT") {
    const sel = el as HTMLSelectElement;
    if (sel.multiple && Array.isArray(value)) {
      for (const opt of Array.from(sel.options)) opt.selected = (value as string[]).includes(opt.value);
    } else if (typeof value === "string") {
      sel.value = value;
    } else return false;
  } else return false;
  return true;
}

function formKeysFor(el: Element, index: number): string[] {
  const tag = el.tagName.toLowerCase();
  const keys: string[] = [];
  const id = el.getAttribute("id");
  const name = el.getAttribute("name");
  if (id) keys.push(`#${id}`);
  if (name) keys.push(`${tag}[name=${name}]`);
  keys.push(`${tag}#${index}`);
  return keys;
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
