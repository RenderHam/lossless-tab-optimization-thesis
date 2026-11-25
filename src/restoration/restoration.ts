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
  /** "full" rebuilt the DOM tree; "overlay" only restored state onto a live page. */
  mode: "full" | "overlay";
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
    mode: "full",
    totalNodes: nodes.length,
    batches,
    elapsedMs: performance.now() - t0,
    maxBatchMs,
    formApplied: form.applied,
    formMissing: form.missing,
  };
}

/**
 * Overlay mode: the page already reloaded from the network, so its own DOM,
 * event listeners, and framework state are intact. Rebuilding the DOM would
 * duplicate UI and break those references. Restore only the captured live
 * state — form values and scroll — onto the existing document.
 */
export async function overlayRestore(state: SerializedTabState, doc: Document = document): Promise<HydrationStats> {
  const t0 = performance.now();
  const form = restoreFormInputs(state, doc);
  await nextIdle();
  restoreFormInputs(state, doc);
  return {
    mode: "overlay",
    totalNodes: 0,
    batches: 0,
    elapsedMs: performance.now() - t0,
    maxBatchMs: 0,
    formApplied: form.applied,
    formMissing: form.missing,
  };
}

export interface FormRestoreStats {
  applied: number;
  missing: string[];
}

/**
 * Recover BFS node ids on the *live* DOM by replaying capture's traversal
 * membership rules (whitespace text and comments dropped, skip-tags and the
 * inline-text fast-path not descended into) and zipping the result against
 * `state.domTree`. Returns id -> element, or null when the reloaded DOM no
 * longer structurally matches the snapshot (dynamic pages) — callers then
 * fall back to id/name/index keys.
 *
 * This is what makes node-id matching work in overlay mode, where no
 * `data-lto-id` attributes exist because the DOM was never rebuilt.
 */
export function buildLiveIdMap(
  state: SerializedTabState,
  doc: Document = document,
): Map<number, Element> | null {
  const root = doc.documentElement;
  if (!root || !state.domTree.length) return null;
  const SKIP = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "CANVAS"]);
  const live: Node[] = [];
  const queue: Node[] = [root];
  while (queue.length > 0) {
    const node = queue.shift() as Node;
    const type = node.nodeType;
    if (type === 8) continue; // comment — dropped at capture
    if (type === 3) {
      // Whitespace-only text is dropped at capture (ids stay dense).
      if ((node.textContent ?? "").trim().length === 0) continue;
      live.push(node);
      continue;
    }
    if (type === 1) {
      const el = node as Element;
      live.push(el);
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag)) continue; // placeholder only — no descent
      // Inline-text fast path: single text child is stored on the element,
      // so the text node itself never enters the captured array.
      if (el.childNodes.length === 1 && el.firstChild?.nodeType === 3) continue;
      for (const child of el.childNodes) queue.push(child);
      continue;
    }
    // Other node types (doctype, PI): dropped at capture.
  }

  const tree = state.domTree;
  if (live.length !== tree.length) return null;
  const idxOf = new Map<Node, number>();
  for (let i = 0; i < live.length; i++) idxOf.set(live[i] as Node, i);

  const out = new Map<number, Element>();
  for (let i = 0; i < tree.length; i++) {
    const desc = tree[i] as FlatNodeDescriptor;
    const node = live[i] as Node;
    const tag = node.nodeType === 1 ? (node as Element).tagName.toUpperCase() : "#text";
    if (desc.tagName !== tag) return null;
    // Parent link check: same parent node at the same array position.
    const parent = node.parentNode;
    const pi = parent && parent !== doc ? idxOf.get(parent) : undefined;
    const expectedParentId = pi === undefined ? -1 : (tree[pi] as FlatNodeDescriptor).parentId;
    if (desc.parentId !== expectedParentId) return null;
    if (node.nodeType === 1) out.set(desc.id, node as Element);
  }
  return out;
}

/** Re-apply captured form values, preferring stable BFS node identity. */
export function restoreFormInputs(state: SerializedTabState, doc: Document = document): FormRestoreStats {
  const stats: FormRestoreStats = { applied: 0, missing: [] };
  const handled = new Set<string>();

  // 1. BFS node id is the authoritative match: survives index shifts and
  //    dynamic elements injected by the page after reload. Full-hydration
  //    DOMs carry `data-lto-id`; overlay DOMs get their ids re-derived from
  //    the captured tree via buildLiveIdMap.
  if (state.formInputNodeIds) {
    const byBfsId = buildLiveIdMap(state, doc);
    for (const [key, nodeId] of Object.entries(state.formInputNodeIds)) {
      if (!(key in state.formInputs) || nodeId < 0) continue;
      let el = doc.querySelector(`[data-lto-id="${nodeId}"]`);
      if (!el && byBfsId) el = byBfsId.get(nodeId) ?? null;
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
  if (name) {
    const base = `${tag}[name=${name}]`;
    keys.push(base);
    // Toggle groups are keyed with their value (see getFormKey in content.ts).
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "radio" || type === "checkbox") {
        const v = el.getAttribute("value");
        keys.push(`${base}|v=${v ?? `#${index}`}`);
      }
    }
  }
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
