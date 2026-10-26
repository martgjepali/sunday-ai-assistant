import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT, MODEL } from "./config";
import { addMessage, conversationHistory, reflectOnExchange } from "./memory";
import { requestFromClient } from "./bridge";
import { PERSONA, dynamicContext } from "./persona";
import type { ChatSecurity } from "./speaker";
import { runTool, toolHub, toolSchemas } from "./tools";

export type AgentEvent =
  | { type: "meta"; conversationId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; hub: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "activate"; ids: string[] }
  | { type: "request"; id: string; kind: string; payload?: unknown }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

let client: Anthropic | null = null;
const MAX_TURNS = 16;
const MAX_TOOL_RESULT = 30_000;

export async function runAgent(opts: {
  conversationId: string;
  userText: string;
  mode: "voice" | "text";
  security: ChatSecurity;
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
}) {
  const { conversationId, userText, mode, security, signal, emit } = opts;
  client ??= new Anthropic();

  const history = conversationHistory(conversationId);
  addMessage(conversationId, "user", userText);

  const ctx = dynamicContext(userText, mode, security);
  emit({ type: "activate", ids: ["sunday", "hub:memory", ...ctx.activated] });

  const tools = toolSchemas();
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: userText }];
  let spoken = "";
  /** What really ran this turn — stored with the reply so later turns can trust it. */
  const actions: string[] = [];
  let jsonRetries = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let startedTurnText = false;
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 64000,
          system: [
            { type: "text", text: PERSONA, cache_control: { type: "ephemeral" } },
            { type: "text", text: ctx.text },
          ],
          tools,
          messages,
          output_config: { effort: EFFORT },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

      stream.on("text", (delta) => {
        if (!startedTurnText && spoken && !/\s$/.test(spoken)) {
          spoken += " ";
          emit({ type: "text", delta: " " });
        }
        startedTurnText = true;
        spoken += delta;
        emit({ type: "text", delta });
      });
      stream.on("streamEvent", (event) => {
        if (event.type !== "content_block_start") return;
        const block = event.content_block;
        if (block.type === "tool_use") {
          emit({ type: "tool", id: block.id, name: block.name, hub: toolHub(block.name), status: "start" });
        } else if (block.type === "server_tool_use") {
          emit({ type: "tool", id: block.id, name: block.name, hub: "web", status: "start" });
          emit({ type: "activate", ids: ["hub:web", `skill:${block.name}`] });
        }
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API errors and aborts propagate.
        if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
        continue;
      }

      if (message.stop_reason === "refusal") {
        if (!spoken) {
          spoken = "That's one I can't help with, sir.";
          emit({ type: "text", delta: spoken });
        }
        break;
      }
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }

      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0) break;
      // A tool input cut off at max_tokens can still parse; never run it.
      if (message.stop_reason === "max_tokens") throw new Error("Tool input was cut off.");
      if (message.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: message.content });
      for (const b of message.content) {
        if (b.type === "server_tool_use") actions.push(`${b.name} ${clip(JSON.stringify(b.input), 160)}`);
      }

      const results = await Promise.all(
        toolUses.map(async (tu) => {
          const outcome = await runTool(tu.name, tu.input, {
            conversationId,
            requestClient: (kind, payload) => requestFromClient(emit, kind, payload),
            signal,
          });
          actions.push(describeAction(tu.name, tu.input, outcome.ok, outcome.result));
          emit({
            type: "tool",
            id: tu.id,
            name: tu.name,
            hub: toolHub(tu.name),
            status: outcome.ok ? "done" : "error",
            detail: outcome.ok ? undefined : String((outcome.result as { error?: unknown }).error ?? ""),
          });
          if (outcome.activate.length) emit({ type: "activate", ids: outcome.activate });
          let text = JSON.stringify(outcome.result);
          if (text.length > MAX_TOOL_RESULT) text = text.slice(0, MAX_TOOL_RESULT) + "…(truncated)";
          // Tools like look_at_screen hand Claude a real image alongside their text result.
          const content: Anthropic.Beta.BetaToolResultBlockParam["content"] = outcome.image
            ? [
                { type: "image", source: { type: "base64", media_type: outcome.image.mediaType, data: outcome.image.data } },
                { type: "text", text },
              ]
            : text;
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content,
            ...(outcome.ok ? {} : { is_error: true }),
          };
        }),
      );
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    if (signal.aborted) {
      if (spoken.trim()) addMessage(conversationId, "assistant", `${spoken.trim()} … (interrupted by sir)`, actions);
      return;
    }
    throw err;
  }

  const finalText = spoken.trim();
  addMessage(conversationId, "assistant", finalText || "(done)", actions);
  emit({ type: "done", text: finalText });

  reflectOnExchange(conversationId, userText, finalText).catch((err) =>
    console.error("[sunday] memory reflection failed:", err instanceof Error ? err.message : err),
  );
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "My Anthropic API key was rejected, sir. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return "My Anthropic key doesn't have access to that model.";
  if (err instanceof Anthropic.RateLimitError) return "I'm being rate-limited by Anthropic. Give me a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach my brain — the internet connection looks down.";
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function describeAction(name: string, input: unknown, ok: boolean, result: unknown) {
  return `${name} ${clip(JSON.stringify(input), 200)} → ${ok ? "OK" : "FAILED"}: ${clip(JSON.stringify(result), 260)}`;
}
