import { z } from "zod";
import { describeError, runAgent, type AgentEvent } from "@/lib/server/agent";
import { ensureConversation } from "@/lib/server/memory";
import { allowChat } from "@/lib/server/speaker";

const Body = z.object({
  conversationId: z.string().nullish(),
  text: z.string().trim().min(1).max(20_000),
  mode: z.enum(["voice", "text"]).default("text"),
  voiceToken: z.string().max(64).nullish(),
});

/** Streams SUNDAY's reply as newline-delimited JSON events. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  const { text, mode } = parsed.data;
  // Voice ID: only sir gets through, whatever the UI does.
  const security = allowChat(mode, parsed.data.voiceToken);
  if (!security.ok) {
    return Response.json({ error: "not-owner" }, { status: 403 });
  }
  const conversationId = ensureConversation(parsed.data.conversationId);

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: AgentEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false;
        }
      };
      emit({ type: "meta", conversationId });
      try {
        await runAgent({ conversationId, userText: text, mode, security, signal: req.signal, emit });
      } catch (err) {
        console.error("[sunday] chat failed:", err);
        emit({ type: "error", message: describeError(err) });
      }
      if (open) controller.close();
      open = false;
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
