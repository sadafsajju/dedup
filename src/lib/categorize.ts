// AI component categorization (user-supplied Anthropic key). The LLM's job is
// strictly *organization* — naming what each component is (Button, Card,
// Navigation…) so the canvas can group artboards into sections. Duplicate
// detection stays deterministic; the model never decides what's a duplicate.
//
// Privacy: only component names, file paths, and structural outlines
// (tag/class skeletons) are sent — never full source code.

import Anthropic from "@anthropic-ai/sdk";
import type { GalleryEntry } from "./types";

export const CATEGORIES = [
  "Buttons",
  "Cards",
  "Forms & Inputs",
  "Navigation",
  "Overlays & Modals",
  "Lists & Tables",
  "Media",
  "Feedback & Status",
  "Marketing & Hero",
  "Layout",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface CategoryEntry {
  /** djb2 of the skeleton at assignment time — invalidates on change. */
  hash: string;
  category: string;
  /** JSON object literal of realistic mock props for the preview harness. */
  mockProps?: string;
}

export type CategoryCache = Record<string, CategoryEntry>;

// Gallery entries can come from persisted JSON written by older builds, so
// `skeleton` is treated as possibly-missing at runtime despite the type.
export function skeletonHash(skeleton: string | undefined): string {
  const s = skeleton ?? "";
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

export const keyOf = (e: GalleryEntry) => `${e.file}#${e.name}`;

/** Components whose cached category is missing or stale. */
export function needingCategorization(
  gallery: GalleryEntry[],
  cache: CategoryCache,
): GalleryEntry[] {
  return gallery.filter((e) => {
    const cached = cache[keyOf(e)];
    return !cached || cached.hash !== skeletonHash(e.skeleton);
  });
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          name: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          mock_props: {
            type: "string",
            description:
              "A JSON object literal of realistic demo props for rendering this component in a preview (infer plausible values and shapes from the prop names, component name, and structure). Empty string when the component needs no props. JSON-serializable values only — no functions.",
          },
        },
        required: ["file", "name", "category", "mock_props"],
        additionalProperties: false,
      },
    },
  },
  required: ["components"],
  additionalProperties: false,
} as const;

const CHUNK = 50;

const SYSTEM_PROMPT =
  "You categorize React UI components for a design-tool canvas and invent realistic demo props for previewing them. You are given each component's name, file path, prop names, and a structural outline (JSX tags with Tailwind classes). Assign every component exactly one category from the allowed set — judge by what the component IS in a UI (a card, a button, a nav bar), using tags, class names, and the component's own name as evidence; use 'Other' only when nothing fits. For mock_props, produce a compact JSON object with a plausible value for every listed prop: strings that read like real product copy, small numbers, ISO dates, short arrays of 2-3 items, and nested objects with the fields the component likely reads (e.g. an `order` prop on a ReceiptCard likely has orderNumber, items, total). No functions, no nulls where an object is expected.";

function listingFor(chunk: GalleryEntry[]): string {
  return chunk
    .map(
      (e) =>
        `- ${e.name} (${e.file})\n  props: ${(e.props ?? []).join(", ") || "(none)"}\n  uses: ${e.callSites} call sites\n  structure:\n${(e.skeleton ?? "")
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`,
    )
    .join("\n\n");
}

/** Where AI calls go: the user's Claude Code install, or a raw API key. */
export type AiBackend =
  | { kind: "claude-code"; run: (prompt: string) => Promise<string> }
  | { kind: "api"; apiKey: string };

/** Pull the first {...} out of free-form model text (fences, prose, etc.). */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no JSON object in AI response");
  }
  return text.slice(start, end + 1);
}

async function runChunk(backend: AiBackend, listing: string): Promise<string> {
  const userPrompt = `Categorize every component below.\n\n${listing}`;

  if (backend.kind === "claude-code") {
    // Headless CLI has no schema enforcement — ask for bare JSON and be
    // lenient when parsing.
    const prompt = `${SYSTEM_PROMPT}\n\nAllowed categories: ${CATEGORIES.join(", ")}\n\n${userPrompt}\n\nRespond with ONLY a JSON object, no prose and no code fences, of the shape {"components": [{"file": string, "name": string, "category": string, "mock_props": string}]} where mock_props is a JSON object literal encoded as a string ("" when the component takes no props).`;
    return extractJson(await backend.run(prompt));
  }

  // This runs inside the app's own webview with the user's own key — the
  // "browser" here is dedup itself, not a public website.
  const client = new Anthropic({
    apiKey: backend.apiKey,
    dangerouslyAllowBrowser: true,
  });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    output_config: {
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("categorization returned no text content");
  }
  return text.text;
}

/**
 * Categorize `entries` with Claude, returning fresh cache entries keyed by
 * `file#name`. Throws on auth/API errors — the caller surfaces them.
 */
export async function categorizeComponents(
  backend: AiBackend,
  entries: GalleryEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<CategoryCache> {
  const fresh: CategoryCache = {};
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const raw = await runChunk(backend, listingFor(chunk));
    const parsed = JSON.parse(raw) as {
      components: {
        file: string;
        name: string;
        category: string;
        mock_props: string;
      }[];
    };
    for (const c of parsed.components) {
      const entry = chunk.find((e) => e.file === c.file && e.name === c.name);
      if (!entry) continue; // model invented a row — ignore it
      // Keep mock props only when they're actually valid JSON objects.
      let mockProps: string | undefined;
      if (c.mock_props) {
        try {
          const obj = JSON.parse(c.mock_props);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            mockProps = JSON.stringify(obj);
          }
        } catch {
          // Malformed guess — preview falls back to neutral props.
        }
      }
      fresh[keyOf(entry)] = {
        hash: skeletonHash(entry.skeleton),
        category: c.category,
        ...(mockProps ? { mockProps } : {}),
      };
    }
    onProgress?.(Math.min(i + CHUNK, entries.length), entries.length);
  }
  return fresh;
}
