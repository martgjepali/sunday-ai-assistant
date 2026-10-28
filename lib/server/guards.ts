/**
 * The checks SUNDAY runs on a brain's reply before sir hears it: false "I've done it" claims, empty
 * promises, stalling questions, talk about a screen the local brain can't see, and word-for-word repeats.
 * Kept apart from the agent so they can be tested on their own (tests/unit.test.mts).
 */

/** Saying it'll do something ("let me check", "one moment") — only fine if a tool actually runs. */
export const PROMISE =
  /\b(one moment|just a (moment|sec(ond)?)|give me a (moment|sec(ond)?)|hold on|bear with me|on it|right away|let me (check|look|see|find|fix|get|open|try|search|take a look|have a look|pull)|i'?ll (check|look|see|find|fix|get|open|try|search|take a look|have a look|let you know|get back to you|report back|tell you)|i'?m (checking|looking|searching|on it))\b/i;
/** Saying it already did something ("I've closed the file") — a lie when no tool ran this turn. */
export const CLAIM =
  /\b(i'?ve|i have|i)\s+(just\s+|already\s+|now\s+|gone ahead and\s+|went ahead and\s+)?(closed|saved|opened|created|made|moved|renamed|written|wrote|rewritten|rewrote|added|edited|changed|updated|modified|replaced|swapped|switched|converted|turned|inserted|implemented|refactored|corrected|adjusted|reverted|restored|applied|fixed|set|started|stopped|paused|played|locked|sent|drafted|deleted|removed|copied|pasted|typed|clicked|cleared|done|finished|marked|ticked|completed|scheduled|booked|noted|logged|archived|cancell?ed|put|checked off|approved|confirmed|allowed|installed|ran|built|launched|downloaded|uploaded)\b(?!\s+(you|me)\b)|\b(it'?s|it is|that'?s) (now )?(closed|saved|done|created|fixed|added|replaced|marked|ticked off|scheduled|booked|on (your|the) (list|calendar))\b|\b((has|have) been|was|were|got) (created|updated|edited|changed|saved|added|modified|replaced|swapped|switched|converted|rewritten|inserted|fixed|renamed|moved|written|deleted|removed|opened|closed)\b|\bis now (updated|saved|fixed|changed|replaced|printing|set|using)\b|^\s*done\b/i;
/** Talking about his screen or open windows — the local brain can't see either. */
export const UNSEEN =
  /\b(on (your|the) screen|(can|can't|cannot|don't|do not) see (any|it|that|the|your|anything|an?)\b|currently open|you have open|(is|are) open (right now|now)?)/i;

/** Asking sir for details ("could you describe the error?", "what would you like me to do?"). */
export const CLARIFY =
  /\b(could|can|would) you (please )?(provide|describe|confirm|clarify|tell me|check|specify|give|share|explain|paste)\b|\bwhat (errors?|issue|exactly|would you like|do you mean|are you referring)\b[^.?!]*\?/i;
/** Sir asking about what's on his screen. */
export const SCREEN = /\b(see|look at|check|read|what'?s on|what is on) (my|the) (screen|monitor|display)\b|\bon (my|the) screen\b/i;
/** Sir asking to hear it again — the only time the same reply twice is right. */
export const ASK_AGAIN = /\b(repeat|again|say that|what did you (just )?say|pardon|come again)\b/i;
/** The same reply, ignoring case and punctuation. */
export const sameWords = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) !== "" && norm(a) === norm(b);
};
