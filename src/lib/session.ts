// Mock-session seed generation (zero-login editing). Given the project's
// auth-related source, ask the AI for the browser-storage writes that make the
// app's own client guard consider itself authenticated — so protected routes
// render on the canvas and their visuals become editable.
//
// What comes back is a *script the user reviews*, not something applied
// silently: it only ever touches localStorage/sessionStorage/cookie (never
// source, never the network), runs only inside dedup's framed canvas, and is
// opt-in. The generation is the convenience; the seed itself is honest.

import Anthropic from "@anthropic-ai/sdk";
import type { AiBackend } from "./categorize";
import type { AuthContext } from "./types";

const SYSTEM_PROMPT = `You are helping a visual code editor ("dedup") reach a React app's protected pages so their layout can be edited. The app guards routes on the client and redirects to a login page when no session is present.

Your job: write the minimal browser-side statements that make the app's OWN client-side auth check pass, using the exact storage keys and shapes the provided source uses.

Hard rules:
- Output ONLY executable JavaScript statements (no function wrapper, no imports, no exports, no markdown prose). The statements run in the page before the app boots.
- Write ONLY to localStorage, sessionStorage, and document.cookie. Never call fetch/XHR, never touch the DOM, never redefine globals.
- Reuse the EXACT keys, token/cookie names, and value shapes you see in the source. If the app stores a JSON user object, write a plausible one with the same fields. If it stores a JWT string, use an obviously-fake but well-formed placeholder token.
- Prefer the smallest set of writes that satisfies the guard. Do not invent keys the source doesn't reference.
- If the source is insufficient to know what to write, output a single line: // INSUFFICIENT: <one short reason>`;

/** Build the generation prompt from the detected SDK and scanned source. */
export function buildSeedPrompt(context: AuthContext): string {
  const files = context.files
    .map((f) => `--- ${f.path} ---\n${f.snippet}`)
    .join("\n\n");
  // Naming the SDK matters more than the file listing: an app using a managed
  // SDK never writes the session itself, so the scan is empty and the model
  // would otherwise conclude "no auth here" from an app that is full of it.
  const provider = context.provider
    ? `This project depends on ${context.provider.name}, which persists the session in ${context.provider.storage}. Write the seed for that SDK's documented storage format.`
    : `No managed auth SDK was found in package.json — this app appears to handle its session itself, so follow the source below exactly.`;
  return [
    provider,
    ``,
    `The app's auth/session-related source follows. Write the storage seed that makes its client guard consider the user signed in.`,
    ``,
    files || "(the app writes no session storage of its own)",
  ].join("\n");
}

/**
 * Pull the runnable script out of a model reply: strip a ```…``` fence if the
 * model added one despite instructions, and surface the INSUFFICIENT marker as
 * an error rather than saving it as a "script".
 */
export function parseSeedReply(reply: string): string {
  let text = reply.trim();
  const fence = text.match(/```(?:js|javascript|ts)?\s*\n([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const insufficient = text.match(/\/\/\s*INSUFFICIENT:\s*(.*)/i);
  if (insufficient) {
    throw new Error(
      `The AI couldn't determine the session shape: ${insufficient[1].trim()}. Write the seed by hand, or open a protected page in browse mode and copy what the app stores.`,
    );
  }
  if (!text) throw new Error("The AI returned an empty seed.");
  return text;
}

/** One generation round-trip through the chosen backend. */
export async function generateSeed(
  backend: AiBackend,
  context: AuthContext,
): Promise<string> {
  const userPrompt = buildSeedPrompt(context);
  if (backend.kind === "claude-code") {
    return parseSeedReply(await backend.run(`${SYSTEM_PROMPT}\n\n${userPrompt}`));
  }
  const client = new Anthropic({
    apiKey: backend.apiKey,
    dangerouslyAllowBrowser: true,
  });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("seed generation returned no text content");
  }
  return parseSeedReply(block.text);
}
