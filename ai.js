/* RealityCheck AI: optional Claude features for the to-do list.
 * Runs in the browser with the user's own Anthropic API key (kept in this browser's localStorage and sent only to
 * the Anthropic API). Nothing is sent until the user presses an AI button.
 *
 *   aiBrainDump(apiKey, text, nowAbs, known) -> { items: [...], message }   messy text -> to-dos / study / exams / events
 *   aiSuggest(apiKey, context)         -> { summary, suggestions: [...] } what to do next, from the student's data
 */
const AI_STORE_KEY = "realitycheck.ai.v1";
const AI_MODEL = "claude-opus-5-5";
// Pinned SDK build (ESM from jsDelivr), loaded only the first time an AI feature is used.
const AI_SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.2.0/+esm";

let aiSdk = null;
const loadSdk = () => (aiSdk = aiSdk || import(AI_SDK_URL).catch((e) => { aiSdk = null; throw e; }));

/* One structured-output request. Returns the parsed JSON object. */
async function aiCall({ apiKey, system, user, schema, effort }) {
  let mod;
  try { mod = await loadSdk(); } catch (e) { throw new Error("Couldn't load the Claude SDK. Check your internet connection."); }
  const Anthropic = mod.default;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true }); // the key is the user's own, in their own browser
  let res;
  try {
    res = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      // If a safety classifier declines, the API re-runs the request on a fallback model it picks.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("That API key didn't work. Check it in AI settings.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error("That API key isn't allowed to use this model.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Rate limited (or out of credits). Try again in a minute.");
    if (err instanceof Anthropic.BadRequestError) throw new Error(`Claude rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Claude. Check your connection.");
    if (err instanceof Anthropic.APIError) throw new Error(`Claude had a problem (${err.status || "error"}). Try again.`);
    throw err;
  }
  if (res.stop_reason === "refusal") throw new Error("Claude declined to answer that one.");
  if (res.stop_reason === "max_tokens") throw new Error("The answer got cut off. Try a shorter brain dump.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch (e) { throw new Error("Claude's answer couldn't be read. Try again."); }
}

const nowLine = (nowAbs) => {
  const d = dayOfAbs(nowAbs);
  return `Right now it is ${fmtDate(keyOf(d), { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ` +
    `${fmt(nowAbs - d * DAY_MIN)} (local time, ${localFromAbs(nowAbs)}).`;
};

/* ---------- Brain dump: messy text -> structured items ---------- */
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["todo", "study", "exam", "event"] },
    title: { type: "string" },
    class_name: { type: "string" },
    when: { type: "string" },
    end_time: { type: "string" },
    minutes: { type: "integer" },
    dread: { type: "integer", enum: [1, 2, 3, 4, 5] },
    cooked: { type: "integer", enum: [1, 2, 3, 4, 5] },
    exam_title: { type: "string" },
    repeat: { type: "string", enum: ["none", "daily", "weekdays"] },
    repeat_until: { type: "string" },
    note: { type: "string" },
  },
  required: ["kind", "title", "class_name", "when", "end_time", "minutes", "dread", "cooked", "exam_title", "repeat", "repeat_until", "note"],
  additionalProperties: false,
};

const BRAIN_DUMP_SYSTEM = `You turn a college student's messy notes (texts to themselves, syllabus snippets, a rant about their week) into a clean list for their planner app.

Each item is one of:
- "todo": work they have to do (homework, readings, projects, errands). "when" is the deadline, "minutes" is your honest estimate of focused work time (students underestimate, so be realistic: a problem set is often 2-4 hours, a short reading 30-60 minutes, an essay several hours; split giant work like "write 10 page paper" into 2-4 todos with staggered deadlines before the real one).
- "exam": a test or quiz they'll sit. "when" is when it starts (if they gave a day but no time, use 10:00 and say "time is a guess" in note), "minutes" is its length (default 90 for a midterm/final, 30 for a quiz). The app's Cram mode plans their study time for exams automatically, so exams matter most.
- "study": studying or reviewing for a specific exam ("study for chem quiz", "review ch 1-5 for the midterm"). Cram mode schedules study time for exams, so don't make these todos. Set "exam_title" to the exam it's for: one of the exams in this brain dump (copy its title exactly) or one of the exams they already have (listed below, copy the name exactly). If the exam itself is mentioned with a date but isn't in either list, also output it as an "exam" item.
- "event": something at a fixed time they have to attend (practice, a shift, a game, a meeting, office hours). "when" is the start, "end_time" is "HH:MM" (24h). If it repeats ("practice every day 4-6", "shifts mon-fri"), give the first occurrence, set "repeat" to "daily" or "weekdays", and "repeat_until" to "YYYY-MM-DD" if they said when it ends, else "". Big repeating blocks matter: Cram mode shrinks study time on those days.

Rules:
- Dates/times are local, formatted exactly "YYYY-MM-DDTHH:MM" (24h). Resolve words like "friday", "next week", "tmrw" against the current date given. A deadline with a day but no time is 23:59. If there's truly no date, use "".
- "end_time" is "" unless kind is "event".
- "class_name" is the course code or name if one is mentioned or obvious (like "MA 261" or "Chem"), otherwise "".
- "dread" (1-5) guesses how much they'll avoid it: 1 = kind of fun, 5 = would rather do laundry. Use their wording ("ugh", "hate") as a signal; default 3.
- "cooked" (1-5, exams and study only, otherwise 3) is how unprepared they are for that exam: 1 = "I'll be fine", 3 = "kinda cooked", 5 = "fully cooked / haven't started / failing". Read it from their wording; default 3.
- "repeat" is "none" and "repeat_until" is "" unless kind is "event".
- "exam_title" is "" unless kind is "study".
- "note" is a few words only if something matters (e.g. "worth 20% of grade", "estimate is a guess"), else "".
- Keep titles short and specific, like the student would write them. Don't invent work they didn't mention.
- "message" is one short sentence back to the student: a quick read on their week, honest but not preachy. If the text has nothing plannable, say so.`;

async function aiBrainDump(apiKey, text, nowAbs, known) {
  const exams = (known && known.exams) || [];
  const examLine = exams.length
    ? `Exams I already have in Cram mode: ${exams.map((e) => `"${e.name}" (${e.when || "no date"})`).join(", ")}.`
    : "I don't have any exams in Cram mode yet.";
  return aiCall({
    apiKey,
    effort: "low",
    system: BRAIN_DUMP_SYSTEM,
    user: `${nowLine(nowAbs)}\n${examLine}\n\nHere's my brain dump:\n\n${text}`,
    schema: {
      type: "object",
      properties: { items: { type: "array", items: ITEM_SCHEMA }, message: { type: "string" } },
      required: ["items", "message"],
      additionalProperties: false,
    },
  });
}

/* ---------- Suggestions from the student's whole situation ---------- */
const SUGGEST_SYSTEM = `You are the coach inside a student planner app called RealityCheck. Its whole point: help students stop overthinking and lock in.
You get a snapshot of their to-do list, calendar (fixed events and planned work blocks) and free time, exams in Cram mode, and grades.

Give at most 5 suggestions, most important first. Each one must be specific to their data (name the task, day, class, numbers) and doable now. Good suggestions look like:
- the thing to start right now and why (a deadline is close, it's what they're dreading most, they have a free block today)
- a to-do that's too big or vague to start: split it into concrete steps (action "split_todo", with the target id and the steps as todos, each with its own estimate and staggered deadlines before the original)
- missing to-dos that clearly follow from their data (e.g. an exam in 4 days with no study to-dos; a grade that needs 88% on what's left) (action "add_todos")
- unplanned to-dos that should go on the calendar (action "schedule_all")
- exams: the app's Cram mode turns exams into planned study time (more for exams they're more "cooked" for, less on days with big fixed blocks). Use it:
  - an exam or quiz that shows up in their to-dos, calendar or grades but isn't in Cram mode yet: add it (action "add_exams", with the exam in "exams"; "when" is when it starts, "minutes" its length, "cooked" 1-5 from their grades and data). A to-do like "study for chem quiz" usually means this. If it replaces a to-do, put that to-do's id in target_todo_id so it's removed.
  - an exam whose "cooked" level doesn't match reality (their grade says they need 90%+ on the rest, but it's set to 2/5): action "set_cooked" with exam_id copied exactly and the new "cooked".
  - Cram mode is off with exams coming, or its plan is out of date (cram_mode.plan_status): action "apply_cram" turns it on / updates it.
- a class that's in trouble with no exam to plan for: point them to Grade check ("open_grades"); "open_cram" just opens Cram mode
- a reality check if the plan doesn't fit their free time: what to cut or move

Tone: like a sharp friend who's good at school. Short, direct, warm, no lectures, no emojis, no "Great job!". "headline" is under 10 words; "detail" is 1-2 sentences.
Only use target_todo_id for split_todo or add_exams (copy the id exactly), otherwise "". "todos" is [] unless the action is add_todos or split_todo. "exams" is [] unless the action is add_exams. "exam_id" is "" and "cooked" is 3 unless the action is set_cooked.
Dates are local "YYYY-MM-DDTHH:MM" (24h); a day without a time is 23:59; "" if none.
"summary" is one sentence on how their week looks.`;

const SUGGEST_TODO_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    class_name: { type: "string" },
    when: { type: "string" },
    minutes: { type: "integer" },
    dread: { type: "integer", enum: [1, 2, 3, 4, 5] },
  },
  required: ["title", "class_name", "when", "minutes", "dread"],
  additionalProperties: false,
};

const SUGGEST_EXAM_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    class_name: { type: "string" },
    when: { type: "string" },
    minutes: { type: "integer" },
    cooked: { type: "integer", enum: [1, 2, 3, 4, 5] },
  },
  required: ["title", "class_name", "when", "minutes", "cooked"],
  additionalProperties: false,
};

async function aiSuggest(apiKey, context) {
  return aiCall({
    apiKey,
    effort: "medium",
    system: SUGGEST_SYSTEM,
    user: `${nowLine(context.nowAbs)}\n\nMy planner right now (JSON):\n${JSON.stringify(context.snapshot, null, 1)}`,
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              headline: { type: "string" },
              detail: { type: "string" },
              action: { type: "string", enum: ["none", "add_todos", "split_todo", "schedule_all", "add_exams", "set_cooked", "apply_cram", "open_cram", "open_grades"] },
              target_todo_id: { type: "string" },
              todos: { type: "array", items: SUGGEST_TODO_SCHEMA },
              exams: { type: "array", items: SUGGEST_EXAM_SCHEMA },
              exam_id: { type: "string" },
              cooked: { type: "integer", enum: [1, 2, 3, 4, 5] },
            },
            required: ["headline", "detail", "action", "target_todo_id", "todos", "exams", "exam_id", "cooked"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "suggestions"],
      additionalProperties: false,
    },
  });
}
