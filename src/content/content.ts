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
import { heapSnapshotRefFor } from "../shared/types";

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
  if (name) return `${el.tagName.toLowerCase()}[name=${name}]`;
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
export function captureDOMTree(root: Element): { nodes: FlatNodeDescriptor[]; truncated: number[] } {
  const nodes: FlatNodeDescriptor[] = [];
  const truncated: number[] = [];
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

  return { nodes, truncated };
}

export function captureFormInputs(doc: Document): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  const inputs = doc.querySelectorAll("input, textarea, select");
  inputs.forEach((el, index) => {
    const key = getFormKey(el, index);
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT") {
      const input = el as HTMLInputElement;
      const type = (input.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        out[key] = input.checked;
      } else if (type === "password") {
        out[key] = input.value; // preserved losslessly; stored only in local IndexedDB
      } else {
        out[key] = input.value;
      }
    } else if (tag === "TEXTAREA") {
      out[key] = (el as HTMLTextAreaElement).value;
    } else if (tag === "SELECT") {
      const sel = el as HTMLSelectElement;
      if (sel.multiple) {
        const vals: string[] = [];
        for (const opt of Array.from(sel.selectedOptions)) vals.push(opt.value);
        out[key] = vals;
      } else {
        out[key] = sel.value;
      }
    }
  });
  return out;
}

export function captureTabState(tabId: number, doc: Document = document, win: Window = window): CaptureResult {
  const { nodes, truncated } = captureDOMTree(doc.documentElement);
  const state: SerializedTabState = {
    tabId,
    url: doc.URL,
    title: doc.title,
    timestamp: Date.now(),
    scrollPosition: { x: win.scrollX, y: win.scrollY },
    domTree: nodes,
    formInputs: captureFormInputs(doc),
    heapSnapshotRef: heapSnapshotRefFor(tabId),
  };
  return { state, truncatedTextNodes: truncated };
}

// ---------------------------------------------------------------------------
// Content-script message bridge
// ---------------------------------------------------------------------------

export const MSG_CAPTURE_REQUEST = "LTO_CAPTURE_REQUEST";
export const MSG_CAPTURE_RESPONSE = "LTO_CAPTURE_RESPONSE";

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && (msg as { type?: string }).type === MSG_CAPTURE_REQUEST) {
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
