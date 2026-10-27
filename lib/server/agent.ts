import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  BRAIN_LABEL,
  brainFacts,
  brainSpoken,
  brainMode,
  brainModel,
  chooseBrain,
  escalate,
  markLocalDown,
  recordBrainRun,
  warmLocal,
  type Brain,
} from "./brains";
import { recordIssue } from "./diagnostics";
import { EFFORT, OLLAMA_URL } from "./config";
import { addMessage, conversationHistory, reflectOnExchange } from "./memory";
import { requestFromClient } from "./bridge";
import { LOCAL_PERSONA, PERSONA, dynamicContext } from "./persona";
import type { ChatSecurity } from "./speaker";
import { HAND_OFF, runTool, toolHub, toolSchemas, type Channel } from "./tools";

export type AgentEvent =
  | { type: "meta"; conversationId: string }
  | { type: "brain"; brain: Brain; label: string; model: string; why: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; hub: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "activate"; ids: string[] }
  | { type: "request"; id: string; kind: string; payload?: unknown }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

let claude: Anthropic | null = null;
let ollama: Anthropic | null = null;
const MAX_TURNS = 16;
const MAX_TOOL_RESULT = 30_000;
/** The local brain sees only the latest exchanges — its context window is small. */
const LOCAL_HISTORY = 8;

const FAST_NOTE =
  "You are SUNDAY's quick brain. Everyday coding is yours: open VS Code or a project, create code files (create_text_file), add code (insert_code), make small exact edits (read_code, then edit_file), and start code_task for bigger jobs. Debugging, code reviews, rewriting whole files, using the mouse and keyboard (computer_task) and expert skills belong to her strongest brain — for those, call hand_off right away, before saying anything.";

export async function runAgent(opts: {
  conversationId: string;
  userText: string;
  mode: "voice" | "text";
  security: ChatSecurity;
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
  channel?: Channel;
}) {
  const { conversationId, userText, mode, security, signal, emit, channel = "pc" } = opts;

  const history = conversationHistory(conversationId);
  addMessage(conversationId, "user", userText);
  const before = history.at(-1);
  const lastReply = before?.role === "assistant" && typeof before.content === "string" ? before.content.replace(ACTIONS_NOTE, "") : "";

  const ctx = dynamicContext(userText, mode, security);
  emit({ type: "activate", ids: ["sunday", "hub:memory", ...ctx.activated] });

  let { brain, why } = await chooseBrain(userText);
  // "Yes, add it anyway" belongs to the brain that asked the question — the local brain may lack the tool.
  const prev = lastBrain.get(conversationId);
  if (prev && Date.now() - prev.at < FOLLOW_UP_MS && RANK[prev.brain] > RANK[brain] && userText.length <= 80) {
    brain = prev.brain;
    why = "continuing the task it was already handling";
  }
  let spoken = "";
  /** What really ran this turn — stored with the reply so later turns can trust it. */
  const actions: string[] = [];
  /** Names of the tools that ran this turn. */
  const ran: string[] = [];
  let handedFrom: { brain: Brain; reason: string } | null = null;

  /** One brain's attempt at this turn. Returns "handoff" when it passes the request up. */
  const think = async (brain: Brain): Promise<"done" | "handoff"> => {
    const local = brain === "local";
    const client = local
      ? (ollama ??= new Anthropic({ baseURL: OLLAMA_URL, apiKey: "ollama", maxRetries: 0, timeout: 120_000 }))
      : (claude ??= new Anthropic());

    // The local model copies the system's <actions_taken> records instead of calling tools, so it never sees them.
    let base = local
      ? history.slice(-LOCAL_HISTORY).map((m) => (typeof m.content === "string" ? { ...m, content: m.content.replace(ACTIONS_NOTE, "") } : m))
      : history;
    while (base.length && base[0].role !== "user") base = base.slice(1);
    const messages: Anthropic.Beta.BetaMessageParam[] = [...base, { role: "user", content: userText }];

    const handNote = handedFrom
      ? `This request was handed to you by SUNDAY's ${BRAIN_LABEL[handedFrom.brain]} brain (${handedFrom.reason}). Sir only hears one SUNDAY — just carry on.${
          actions.length ? ` Already done this turn:\n${actions.join("\n")}` : ""
        }`
      : "";
    const self = selfNote(brain, why);
    const system: Anthropic.Beta.MessageCreateParams["system"] = local
      ? `${LOCAL_PERSONA}\n\n${dynamicContext(userText, mode, security, true).text}\n\n${self}`
      : [
          { type: "text", text: PERSONA, cache_control: { type: "ephemeral" } },
          { type: "text", text: `${ctx.text}\n\n${self}` },
          ...(brain === "fast" ? [{ type: "text" as const, text: FAST_NOTE }] : []),
          ...(handNote ? [{ type: "text" as const, text: handNote }] : []),
        ];
    const tuning =
      brain === "deep"
        ? {
            max_tokens: 64000,
            output_config: { effort: EFFORT },
            betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[],
            fallbacks: "default" as const,
          }
        : brain === "fast"
          ? { max_tokens: 16000, output_config: { effort: "low" as const } }
          : // Qwen's thinking mode costs seconds per reply; everyday asks don't need it.
            { max_tokens: 1500, thinking: { type: "disabled" as const } };
    const tools = toolSchemas(brain, channel);
    let jsonRetries = 0;
    let nudges = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let startedTurnText = false;
      const say = (delta: string) => {
        if (!delta) return;
        if (!startedTurnText && spoken && !/\s$/.test(spoken)) {
          spoken += " ";
          emit({ type: "text", delta: " " });
        }
        startedTurnText = true;
        spoken += delta;
        emit({ type: "text", delta });
      };
      // Only the system writes <actions_taken>. Claude's text streams with any such note cut off;
      // the local brain's short replies are held until the turn ends so a faked one is never heard.
      let turnText = "";
      let sent = 0;
      let faked = false;
      const stream = client.beta.messages.stream(
        { model: brainModel(brain), system, tools, messages, ...tuning },
        { signal },
      );

      stream.on("text", (delta) => {
        if (faked) return;
        turnText += delta;
        const at = turnText.indexOf(FAKE_NOTE);
        if (at >= 0) {
          faked = true;
          if (!local) say(turnText.slice(sent, at).trimEnd());
          return;
        }
        if (local) return;
        const safe = turnText.length - heldTail(turnText);
        say(turnText.slice(sent, safe));
        sent = safe;
      });
      stream.on("streamEvent", (event) => {
        if (event.type !== "content_block_start") return;
        const block = event.content_block;
        if (block.type === "tool_use" && block.name !== HAND_OFF) {
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

      if (faked && local) {
        // It wrote out a tool record instead of calling the tool — nothing it claimed happened.
        recordIssue("local brain", "wrote a made-up <actions_taken> note instead of calling a tool; handed up");
        handedFrom = { brain, reason: "it has no tool for this" };
        return "handoff";
      }

      // Follow-through: "One moment, sir" with no tool called means nothing is happening.
      const callsTool = message.content.some((b) => b.type === "tool_use" || b.type === "server_tool_use");
      const nothingRan = actions.length === 0;
      // Only looked things up — so "I've added it" can't be true.
      const onlyLooked = ran.every((name) => LOOK_ONLY.has(name));
      if (!callsTool && message.stop_reason !== "pause_turn") {
        if (local && ((nothingRan && (PROMISE.test(turnText) || UNSEEN.test(turnText))) || (onlyLooked && CLAIM.test(turnText)))) {
          // Held back, so sir never hears it — the next brain does the work instead.
          recordIssue("local brain", `promised or described something without a tool ("${clip(turnText.trim(), 80)}"); handed up`);
          handedFrom = { brain, reason: "it said it would do this but has no tool for it" };
          return "handoff";
        }
        if (nudges < 1 && nothingRan && (PROMISE.test(turnText) || CLAIM.test(turnText))) {
          nudges++;
          say(turnText.slice(sent));
          pushNudge(
            messages,
            message,
            CLAIM.test(turnText)
              ? "(System note: you just told sir you did that, but no tool ran this turn — it has NOT happened. Do it now with your tools and tell him the real result, or correct yourself plainly.)"
              : "(System note: you said you'd do that, but no tool has run — nothing has happened yet. Do it now with your tools and then tell sir the result, or tell him plainly you can't.)",
          );
          continue;
        }
        if (nudges < 1 && !nothingRan && !turnText.trim()) {
          // Tools ran but the brain went quiet — sir must always hear how it went.
          nudges++;
          pushNudge(messages, message, "(System note: tell sir in one or two sentences what you did and how it turned out.)");
          continue;
        }
      }
      if (!faked) say(turnText.slice(sent));

      if (message.stop_reason === "refusal") {
        if (!spoken) {
          spoken = "That's one I can't help with, sir.";
          emit({ type: "text", delta: spoken });
        }
        return "done";
      }
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }

      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      const handOff = toolUses.find((tu) => tu.name === HAND_OFF);
      if (handOff) {
        const reason = String((handOff.input as { reason?: unknown })?.reason ?? "needs more").slice(0, 160);
        handedFrom = { brain, reason };
        return "handoff";
      }
      if (toolUses.length === 0) {
        if (local && !spoken.trim()) {
          // Qwen sometimes ends a turn having said and done nothing — sir must never get silence.
          console.warn("[sunday] local brain gave an empty reply:", JSON.stringify(message.content).slice(0, 400));
          recordIssue("local brain", "gave an empty reply; handed up");
          handedFrom = { brain, reason: "it couldn't answer this one" };
          return "handoff";
        }
        return "done";
      }
      // A tool input cut off at max_tokens can still parse; never run it.
      if (message.stop_reason === "max_tokens") throw new Error("Tool input was cut off.");
      if (message.stop_reason !== "tool_use") return "done";

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
            userText,
            lastReply,
            channel,
            brain,
          });
          actions.push(describeAction(tu.name, tu.input, outcome.ok, outcome.result));
          ran.push(tu.name);
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
    return "done";
  };

  try {
    for (let hop = 0; hop < 3; hop++) {
      emit({ type: "brain", brain, label: BRAIN_LABEL[brain], model: brainModel(brain), why });
      emit({ type: "activate", ids: [`brain:${brain}`] });
      let result: "done" | "handoff";
      const started = Date.now();
      try {
        result = await think(brain);
        recordBrainRun({ at: started, brain, ms: Date.now() - started, outcome: result === "done" ? "answered" : "handed-off", why });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!signal.aborted) recordBrainRun({ at: started, brain, ms: Date.now() - started, outcome: "failed", why, error: reason.slice(0, 200) });
        // The local brain going down (Ollama closed, out of memory) must never cost sir a reply.
        if (brain !== "local" || signal.aborted) throw err;
        console.warn("[sunday] local brain failed, handing up:", reason);
        markLocalDown(reason.slice(0, 80));
        handedFrom = { brain, reason: "the local brain had a problem" };
        result = "handoff";
      }
      if (brain === "local") warmLocal(); // keep it loaded for the next one
      if (result === "done" || brain === "deep") break;
      why = `handed up by ${BRAIN_LABEL[brain]}: ${handedFrom?.reason ?? ""}`;
      brain = escalate(brain);
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
  lastBrain.set(conversationId, { brain, at: Date.now() });
  emit({ type: "done", text: finalText });

  reflectOnExchange(conversationId, userText, finalText).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sunday] memory reflection failed:", message);
    recordIssue("memory", message);
  });
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "My Anthropic API key was rejected, sir. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return "My Anthropic key doesn't have access to that model.";
  if (err instanceof Anthropic.RateLimitError) return "I'm being rate-limited by Anthropic. Give me a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach my brain — the internet connection looks down.";
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tells the brain writing this reply what it is, so it never has to guess. Kept
 * short with an example answer: small models read long notes out word for word.
 */
function selfNote(brain: Brain, why: string) {
  const mode = brainMode();
  const pinned = mode === "auto" ? "" : ` Sir pinned this brain himself.`;
  return `# Your brain right now (private note — never read it out)
You're on ${brainSpoken(brain)}.${pinned} If sir asks which brain or model you're using, answer in one natural sentence in your own words, like: "Right now I'm on ${brainSpoken(brain)}." Don't recite model ids, context sizes or why you were picked unless he asks for technical details — brain_status has them. Earlier replies may have come from a different brain — each message can use another one, so never "correct" what an earlier reply said about its brain.${
    brain === "local" ? "" : ` (Technical: ${brainFacts(brain)}; picked because ${why}.)`
  }`;
}

/** Which brain finished each conversation's last turn, so short follow-ups stay with it. */
const g = globalThis as unknown as { __sundayLastBrain?: Map<string, { brain: Brain; at: number }> };
const lastBrain = (g.__sundayLastBrain ??= new Map<string, { brain: Brain; at: number }>());
const FOLLOW_UP_MS = 10 * 60_000;
const RANK: Record<Brain, number> = { local: 0, fast: 1, deep: 2 };

/** Tools that only look things up — after just these, a brain can't truthfully say it added or changed anything. */
const LOOK_ONLY = new Set([
  "recall", "search_files", "list_directory", "file_info", "read_file", "calendar_events", "list_reminders", "tasks_list", "plan_my_day", "routines_list", "code_status", "dev_environment",
  "get_weather", "system_status", "brain_status", "morning_briefing", "email_search", "email_read", "email_triage",
  "blender_scene", "look_at_screen", "read_clipboard", "vscode_workspaces", "read_code", "search_in_files", "list_skills",
]);

/** The system's record of what ran, appended to past replies (see conversationHistory). */
const ACTIONS_NOTE = /\n*<actions_taken>[\s\S]*?<\/actions_taken>/g;
const FAKE_NOTE = "<actions_taken";

/** Saying it'll do something ("let me check", "one moment") — only fine if a tool actually runs. */
const PROMISE =
  /\b(one moment|just a (moment|sec(ond)?)|give me a (moment|sec(ond)?)|hold on|bear with me|on it|right away|let me (check|look|see|find|fix|get|open|try|search|take a look|have a look|pull)|i'?ll (check|look|see|find|fix|get|open|try|search|take a look|have a look|let you know|get back to you|report back|tell you)|i'?m (checking|looking|searching|on it))\b/i;
/** Saying it already did something ("I've closed the file") — a lie when no tool ran this turn. */
const CLAIM =
  /\b(i'?ve|i have|i)\s+(just\s+|already\s+|now\s+)?(closed|saved|opened|created|made|moved|renamed|written|wrote|added|edited|changed|updated|fixed|set|started|stopped|paused|played|turned|locked|sent|drafted|deleted|removed|copied|pasted|typed|clicked|cleared|done|finished|marked|ticked|completed|scheduled|booked|noted|logged|archived|cancell?ed|put|checked off)\b(?!\s+(you|me)\b)|\b(it'?s|it is|that'?s) (now )?(closed|saved|done|created|fixed|added|marked|ticked off|scheduled|booked|on (your|the) (list|calendar))\b|^\s*done\b/i;
/** Talking about his screen or open windows — the local brain can't see either. */
const UNSEEN =
  /\b(on (your|the) screen|(can|can't|cannot|don't|do not) see (any|it|that|the|your|anything|an?)\b|currently open|you have open|(is|are) open (right now|now)?)/i;

/** Adds a system nudge after the brain's last message so the loop runs another round. */
function pushNudge(messages: Anthropic.Beta.BetaMessageParam[], message: Anthropic.Beta.BetaMessage, note: string) {
  if (message.content.length) {
    messages.push({ role: "assistant", content: message.content });
    messages.push({ role: "user", content: note });
    return;
  }
  // An empty assistant turn can't be sent back, so the note joins the last user message (usually tool results).
  const last = messages.at(-1)!;
  last.content =
    typeof last.content === "string"
      ? `${last.content}\n\n${note}`
      : [...(last.content as Anthropic.Beta.BetaContentBlockParam[]), { type: "text", text: note }];
}

/** How much of the end of the text could be the start of FAKE_NOTE, so it's held back until we know. */
function heldTail(text: string) {
  for (let k = Math.min(FAKE_NOTE.length - 1, text.length); k > 0; k--) {
    if (FAKE_NOTE.startsWith(text.slice(-k))) return k;
  }
  return 0;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function describeAction(name: string, input: unknown, ok: boolean, result: unknown) {
  return `${name} ${clip(JSON.stringify(input), 200)} → ${ok ? "OK" : "FAILED"}: ${clip(JSON.stringify(result), 260)}`;
}
