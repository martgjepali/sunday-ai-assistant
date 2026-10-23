import "server-only";

/**
 * TypeSafe System One (Jev): fast, typed judgments — probabilities instead of
 * prose. SUNDAY uses it where Claude would be slow or overkill: deciding
 * whether speech is an interruption, and scoring email urgency.
 * Docs: https://docs.typesafe.ai/api/system-one.md
 */

const API = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";

export const typesafeEnabled = () => Boolean(process.env.TYPESAFE_API_KEY);

type Criterion = string | { what: string; examples?: string[] };

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: Criterion[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export class TypeSafeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Ask several independent questions over one shared state in a single request. */
export async function judge<Q extends Record<string, Question>>(
  state: unknown,
  questions: Q,
  { timeoutMs = 8000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ answers: { [K in keyof Q]: Answer }; inputTokens: number }> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new TypeSafeError("TYPESAFE_API_KEY is not set.");

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // Rate-limited or overloaded: brief exponential backoff, as the docs advise.
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new TypeSafeError(`TypeSafe ${res.status}: ${detail}`, res.status);
    }
    const body = (await res.json()) as {
      answers: { [K in keyof Q]: Answer };
      usage?: { input_tokens?: number };
    };
    return { answers: body.answers, inputTokens: body.usage?.input_tokens ?? 0 };
  }
}
