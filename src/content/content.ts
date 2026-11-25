/**
 * State Capture Module — content script side.
 *
 * Runs in the page's isolated world. Performs a Breadth-First Search (BFS)
 * traversal of the DOM into a flat `FlatNodeDescriptor[]`, extracts live
 * form control values, and records scroll offsets.
 *
 * Deterministic rules:
 *  - BFS queue order = document order (children pushed left-to-right).
 *  - Attribute order normalized by sorting keys on read (not stored sorted,
 *    but serialization via stableStringify guarantees byte determinism).
 *  - Live resources (sockets, intervals, media playback) are intentionally
 *    NOT captured — documented edge-case boundary.
 */

import type { FlatNodeDescriptor, FormValue, SerializedTabState } from "../shared/types";
import {
  heapSnapshotRefFor,
  MSG_CAPTURE_REQUEST,
  MSG_CAPTURE_RESPONSE,
  MSG_PING,
  MSG_RESTORE_PUSH,
} from "../shared/types";
import { hydrateDOM, overlayRestore } from "../restoration/restoration";

const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

/** Tags whose live state must never be serialized verbatim. */
const SKIP_TAGS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "CANVAS"]);

/** Cap text payload per node to bound message size; restoration is still lossless
 *  below the cap, truncation flag is explicit above it. */
export const MAX_TEXT_PER_NODE = 65536;

export interface CaptureResult {
  state: SerializedTabState;
  truncatedTextNodes: number[];
}

function getFormKey(el: Element, index: number): string {
  const id = el.getAttribute("id");
  if (id) return `#${id}`;
  const name = el.getAttribute("name");
  if (name) {
    const base = `${el.tagName.toLowerCase()}[name=${name}]`;
    // Same-name toggles (radio groups, checkbox lists) would collide on the
    // name alone and lose one control's value — distinguish by value attr.
    if (el.tagName.toUpperCase() === "INPUT") {
      const type = (el as HTMLInputElement).type;
      if (type === "radio" || type === "checkbox") {
        const v = el.getAttribute("value");
        return `${base}|v=${v ?? `#${index}`}`;
      }
    }
    return base;
  }
  return `${el.tagName.toLowerCase()}#${index}`;
}

function readAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a) out[a.name] = a.value;
  }
  return out;
}

/**
 * BFS traversal. Root = document.documentElement.
 * Assigns dense ids in visitation order so parentId < child id always holds,
 * which lets restoration hydrate strictly in array order without lookahead.
 */
export function captureDOMTree(root: Element): {
  nodes: FlatNodeDescriptor[];
  truncated: number[];
  ids: Map<Element, number>;
} {
  const nodes: FlatNodeDescriptor[] = [];
  const truncated: number[] = [];
  const ids = new Map<Element, number>();
  const queue: Array<{ node: Node; parentId: number }> = [{ node: root, parentId: -1 }];
  let nextId = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { node, parentId } = item;
    const id = nextId++;

    if (node.nodeType === TEXT_NODE) {
      let text = node.textContent ?? "";
      if (text.length > MAX_TEXT_PER_NODE) {
        truncated.push(id);
        text = text.slice(0, MAX_TEXT_PER_NODE);
      }
      // Skip whitespace-only text nodes to shrink payload deterministically.
      if (text.trim().length === 0) {
        nextId--; // reclaim id so ids stay dense
        continue;
      }
      nodes.push({ id, parentId, tagName: "#text", attributes: {}, textContent: text });
      continue;
    }

    if (node.nodeType === COMMENT_NODE) {
      continue; // comments carry no render state; drop deterministically
    }

    if (node.nodeType === ELEMENT_NODE) {
      const el = node as Element;
      ids.set(el, id);
      const tagName = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tagName)) {
        // Record a placeholder so child indexing stays consistent but
        // no live/unsafe content is serialized.
        nodes.push({ id, parentId, tagName, attributes: { "data-lto-skipped": "1" } });
        continue;
      }
      const attributes = readAttributes(el);
      const desc: FlatNodeDescriptor = { id, parentId, tagName, attributes };
      // Leaf text fast-path: single text-node child stored inline.
      if (el.childNodes.length === 1 && el.firstChild?.nodeType === TEXT_NODE) {
        let t = el.firstChild.textContent ?? "";
        if (t.length > MAX_TEXT_PER_NODE) {
          truncated.push(id);
          t = t.slice(0, MAX_TEXT_PER_NODE);
        }
        if (t.length > 0) desc.textContent = t;
      } else {
        const children = el.childNodes;
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child) queue.push({ node: child, parentId: id });
        }
      }
      nodes.push(desc);
      continue;
    }

    if (node.nodeType === DOCUMENT_NODE) {
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child) queue.push({ node: child, parentId });
      }
      nextId--; // document itself gets no descriptor
      continue;
    }
    // Other node types (doctype, PI): skip.
    nextId--;
  }

  return { nodes, truncated, ids };
}

export function captureFormInputs(doc: Document, ids: Map<Element, number>): {
  values: Record<string, FormValue>;
  nodeIds: Record<string, number>;
} {
  const values: Record<string, FormValue> = {};
  const nodeIds: Record<string, number> = {};
  const inputs = doc.querySelectorAll("input, textarea, select");
  inputs.forEach((el, index) => {
    const key = getFormKey(el, index);
    nodeIds[key] = ids.get(el) ?? -1;
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT") {
      const input = el as HTMLInputElement;
      const type = (input.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        values[key] = input.checked;
      } else if (type === "password") {
        values[key] = input.value; // preserved losslessly; stored only in local IndexedDB
      } else {
        values[key] = input.value;
      }
    } else if (tag === "TEXTAREA") {
      values[key] = (el as HTMLTextAreaElement).value;
    } else if (tag === "SELECT") {
      const sel = el as HTMLSelectElement;
      if (sel.multiple) {
        const vals: string[] = [];
        for (const opt of Array.from(sel.selectedOptions)) vals.push(opt.value);
        values[key] = vals;
      } else {
        values[key] = sel.value;
      }
    }
  });
  return { values, nodeIds };
}

export function captureTabState(tabId: number, doc: Document = document, win: Window = window): CaptureResult {
  const { nodes, truncated, ids } = captureDOMTree(doc.documentElement);
  const form = captureFormInputs(doc, ids);
  const state: SerializedTabState = {
    tabId,
    url: doc.URL,
    title: doc.title,
    timestamp: Date.now(),
    scrollPosition: { x: win.scrollX, y: win.scrollY },
    domTree: nodes,
    formInputs: form.values,
    formInputNodeIds: form.nodeIds,
    heapSnapshotRef: heapSnapshotRefFor(tabId),
  };
  return { state, truncatedTextNodes: truncated };
}

// ---------------------------------------------------------------------------
// Content-script message bridge
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = msg && (msg as { type?: string }).type;

    // Readiness probe used by the background worker before capture/restore.
    if (type === MSG_PING) {
      sendResponse({ ok: true });
      return false;
    }

    // Restore: background has already decompressed the snapshot; hydrate it
    // into the live document in 100-node idle batches.
    if (type === MSG_RESTORE_PUSH) {
      const state = (msg as { state?: SerializedTabState }).state;
      if (!state) {
        sendResponse({ ok: false, error: "RESTORE_PUSH without state" });
        return true;
      }
      // A discarded tab reloads with a complete DOM. Rebuilding it here caused
      // duplicated UI on framework-heavy sites (e.g. YouTube), so only overlay
      // the saved state unless the page is actually empty.
      const hasLiveDom = document.readyState !== "loading" && (document.body?.children.length ?? 0) > 0;
      const restoreTask = hasLiveDom
        ? overlayRestore(state)
        : hydrateDOM(state, document.documentElement);
      restoreTask
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (type === MSG_CAPTURE_REQUEST) {
      const tabId = (msg as { tabId?: number }).tabId ?? -1;
      try {
        const result = captureTabState(tabId);
        sendResponse({ type: MSG_CAPTURE_RESPONSE, ok: true, state: result.state });
      } catch (err) {
        sendResponse({ type: MSG_CAPTURE_RESPONSE, ok: false, error: String(err) });
      }
      return true;
    }
    return false;
  });
}
