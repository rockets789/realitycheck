/* RealityCheck engine: shared by index.html (calendar) and cram.html (Cram mode).
 * Plain JS, no JSX, so it loads with a normal <script src> (works from file://) and can be tested outside a browser.
 *
 *  1. Config + date/time helpers
 *  2. estimate(): the reality check
 *  3. Scheduler: places flexible tasks around fixed events
 *  4. Cram mode: splits study time across exams by how cooked you are
 */

/* ============ 1. Config + date/time helpers ============ */
const DAY_MIN = 1440;
const DAY_START = 9 * 60;    // 9:00 AM, in minutes from midnight
const DAY_END = 23 * 60;     // 11:00 PM
const STORAGE_KEY = "realitycheck.events.v1";
const TASKS_KEY = "realitycheck.tasks.v1";
const SETTINGS_KEY = "realitycheck.settings.v1";
const CRAM_KEY = "realitycheck.cram.v1";

const COLORS = [
  { bg: "#e6eefb", edge: "#4a72c4" }, // blue
  { bg: "#f3e8fb", edge: "#8a5cc4" }, // purple
  { bg: "#fdf0d6", edge: "#c9932b" }, // amber
  { bg: "#e3eee5", edge: "#5d8a6a" }, // sage
  { bg: "#fbe3d9", edge: "#e0603a" }, // coral
];

// Dates are "YYYY-MM-DD" keys; dayNum = days since 1970-01-01 (DST-proof).
// Scheduler times are ABSOLUTE minutes: dayNum * 1440 + minute-of-day.
const pad2 = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayNum = (k) => { const [y, m, d] = k.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const keyOf = (n) => { const d = new Date(n * 86400000); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const addDays = (k, n) => keyOf(dayNum(k) + n);
const weekday = (k) => (((dayNum(k) + 4) % 7) + 7) % 7;      // 0 = Sunday
const weekStart = (k) => addDays(k, -weekday(k));
const monthStart = (k) => k.slice(0, 8) + "01";
const addMonths = (k, n) => { const [y, m] = k.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}-01`; };
const fmtDate = (k, opts) => new Date(dayNum(k) * 86400000).toLocaleDateString(undefined, Object.assign({ timeZone: "UTC" }, opts));
const isDateKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const toHHMM = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
function fmt(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${((h + 11) % 12) + 1}:${pad2(m)} ${h >= 12 ? "PM" : "AM"}`;
}
const fmtDur = (min) => {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};
const timeOr = (hhmm, fallback) => (/^\d{2}:\d{2}$/.test(hhmm || "") ? toMin(hhmm) : fallback);
// "YYYY-MM-DDTHH:MM" (datetime-local) <-> absolute minutes
const absFromLocal = (s) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s || "") ? dayNum(s.slice(0, 10)) * DAY_MIN + toMin(s.slice(11, 16)) : null);
const localFromAbs = (abs) => { const d = Math.floor(abs / DAY_MIN); return `${keyOf(d)}T${toHHMM(abs - d * DAY_MIN)}`; };
const dayOfAbs = (abs) => Math.floor(abs / DAY_MIN);
function fmtWhen(abs, todayN) {
  const d = dayOfAbs(abs), t = fmt(abs - d * DAY_MIN);
  if (d === todayN) return t;
  if (d === todayN + 1) return `tomorrow ${t}`;
  return `${fmtDate(keyOf(d), { weekday: "short", month: "short", day: "numeric" })}, ${t}`;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const eventAbs = (e) => { const base = dayNum(e.date) * DAY_MIN; return { title: e.title, start: base + e.start, end: base + e.end }; };

// Older saves (one-day version) had no dates: treat them as today.
const LEGACY = 100000; // any real absolute minute is far above this
const migrateEvents = (list) => list.map((e) => (isDateKey(e.date) ? e : Object.assign({}, e, { date: dateKey(new Date()) })));
const migrateTasks = (list) => {
  const base = dayNum(dateKey(new Date())) * DAY_MIN;
  return list.map((t) => Object.assign({}, t, {
    deadline: t.deadline != null && t.deadline < LEGACY ? base + t.deadline : (t.deadline == null ? null : t.deadline),
    segments: (t.segments || []).map((s) => (s.start < LEGACY ? Object.assign({}, s, { start: s.start + base, end: s.end + base }) : s)),
  }));
};

/* ============ 2. The reality check ============
 * estimate({ guess, energy, distraction, dread }) -> { total, phases }
 *   guess:       optimistic estimate in minutes (> 0)
 *   energy:      1 (running on fumes) .. 5 (fully charged)
 *   distraction: 1 (phone in another room) .. 5 (group chat is popping)
 *   dread:       1 (kind of fun) .. 5 (I'd rather do laundry)
 * Phases are rounded to whole minutes; total is the sum of the rounded phases,
 * so the bars always add up to the headline number. */
function estimate({ guess, energy, distraction, dread }) {
  const g = Number(guess);
  if (!Number.isFinite(g) || g <= 0) throw new Error("guess must be a positive number of minutes");
  const e = clamp(Number(energy), 1, 5), d = clamp(Number(distraction), 1, 5), r = clamp(Number(dread), 1, 5);

  const setup = 5 + r * 3;                        // setup friction
  const fatigue = 1 + (5 - e) * 0.10;             // fatigue multiplier
  const deep = g * fatigue;                       // deep work
  const distractionTax = deep * (d - 1) * 0.08;   // distraction tax
  const buffer = Math.max(5, 0.10 * (setup + deep + distractionTax));

  const phases = [
    { key: "setup", label: "Setup", minutes: Math.round(setup),
      why: `5m to get going + ${r * 3}m of stalling because dread is ${r}/5.` },
    { key: "deep", label: "Deep Work", minutes: Math.round(deep + distractionTax),
      why: `Your ${g}m × ${fatigue.toFixed(1)} for energy ${e}/5 = ${Math.round(deep)}m, plus ${Math.round(distractionTax)}m lost to distraction (${d}/5).`,
      parts: { guess: g, fatigue: Math.round(deep) - g, distraction: Math.round(deep + distractionTax) - Math.round(deep) } },
    { key: "buffer", label: "Buffer", minutes: Math.round(buffer),
      why: "10% slack for wrap-up and surprises (never less than 5m)." },
  ];
  const total = phases.reduce((s, p) => s + p.minutes, 0);
  return { total, phases };
}

/* ============ 3. Scheduler ============
 * A task is { setup, deep, buffer } minutes (from estimate()). Rules that keep a schedule reasonable:
 *  - 10 min of breathing room around every fixed event and every placed task
 *  - deep work runs in sessions of at most 50 min, with a 10 min break between sessions
 *  - tasks only go inside planning windows (each day: day start -> wind-down, nothing in the past)
 *  - at most `dailyCap` minutes of task work per day (a number, or a function of the day)
 *  - optional per-task limits: t.earliest / t.latest (absolute minutes)
 *  - prefer one contiguous block; if none fits, split across gaps (no deep piece under 25 min) */
const SCHED = { breather: 10, maxChunk: 50, breakLen: 10, minChunk: 25, dailyCap: Infinity };

function mergeIntervals(list) {
  const sorted = list.filter(([a, b]) => b > a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/* Free [start, end] gaps inside [from, to], treating each busy interval as padded by `pad` minutes */
function freeGaps(busy, from, to, pad) {
  const merged = mergeIntervals(busy.map(([a, b]) => [a - (pad || 0), b + (pad || 0)]));
  const gaps = [];
  let c = from;
  for (const [a, b] of merged) {
    if (b <= c) continue;
    if (a >= to) break;
    if (a > c) gaps.push([c, Math.min(a, to)]);
    c = Math.max(c, b);
  }
  if (c < to) gaps.push([c, to]);
  return gaps;
}

/* One window per day for `days` days starting at fromAbs: [max(dayStart, from), windDown] */
function planningWindows(fromAbs, days, dayStart, windDown) {
  const first = Math.floor(fromAbs / DAY_MIN), out = [];
  for (let d = first; d < first + days; d++) {
    const a = Math.max(d * DAY_MIN + dayStart, fromAbs), b = d * DAY_MIN + windDown;
    if (b > a) out.push([a, b]);
  }
  return out;
}

const clipWindows = (windows, earliest, latest) => windows
  .map(([a, b]) => [Math.max(a, earliest == null ? -Infinity : earliest), Math.min(b, latest == null ? Infinity : latest)])
  .filter(([a, b]) => b > a);

const capValue = (cap, d) => (typeof cap === "function" ? cap(d) : cap);

/* Remaining task-work minutes per day after the given segments are counted (breaks are free time) */
function capLeftFrom(segments, dailyCap, start) {
  const left = Object.assign({}, start);
  segments.forEach((s) => {
    if (s.kind === "break") return;
    const d = Math.floor(s.start / DAY_MIN);
    left[d] = (d in left ? left[d] : capValue(dailyCap, d)) - (s.end - s.start);
  });
  return left;
}

const splitEven = (total, n) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));

/* Place one task into the free time left by `busy` ([[start, end], ...]) within `windows`.
 * Returns { fits, split, segments: [{ kind, start, end }] }. */
function placeTask(t, busy, windows, opt) {
  opt = Object.assign({}, SCHED, opt);
  const capLeft = Object.assign({}, opt.capLeft);
  const capOf = (m) => { const d = Math.floor(m / DAY_MIN); return d in capLeft ? capLeft[d] : capValue(opt.dailyCap, d); };
  const use = (m, len) => { capLeft[Math.floor(m / DAY_MIN)] = capOf(m) - len; };
  const gaps = clipWindows(windows, t.earliest, t.latest).flatMap(([a, b]) => freeGaps(busy, a, b, opt.breather));
  const n = Math.max(1, Math.ceil(t.deep / opt.maxChunk));
  const work = t.setup + t.deep + t.buffer;
  const runLen = work + (n - 1) * opt.breakLen;

  // 1) First gap that holds the whole padded task in one go (and the day has room under the cap).
  const whole = gaps.find(([s, e]) => e - s >= runLen && capOf(s) >= work);
  const wholeRes = whole && (() => {
    const segments = []; let c = whole[0];
    const push = (kind, len) => { if (len > 0) segments.push({ kind, start: c, end: c + len }); c += len; };
    push("setup", t.setup);
    splitEven(t.deep, n).forEach((len, i) => { if (i) push("break", opt.breakLen); push("deep", len); });
    push("buffer", t.buffer);
    return { fits: true, split: false, segments };
  })();
  // One block is nicer, but not if it means missing the deadline when a split would make it.
  const onTime = (r) => t.deadline == null || r.segments[r.segments.length - 1].end <= t.deadline;
  if (wholeRes && onTime(wholeRes)) return wholeRes;

  // 2) Otherwise split deep work across gaps (and days), earliest first.
  const splitRes = (() => {
    const segments = [];
    let setupDone = false, deepLeft = t.deep;
    for (const [gs, ge] of gaps) {
      let c = gs, lastWasDeep = false;
      const push = (kind, len) => { if (len > 0) segments.push({ kind, start: c, end: c + len }); c += len; };
      if (!setupDone) {
        const need = t.setup + Math.min(opt.minChunk, deepLeft);
        if (ge - c < need || capOf(c) < need) continue; // setup only makes sense right before work
        push("setup", t.setup); use(gs, t.setup); setupDone = true;
      }
      while (deepLeft > 0) {
        const brk = lastWasDeep ? opt.breakLen : 0;
        const chunk = Math.min(opt.maxChunk, deepLeft, ge - c - brk, capOf(gs));
        if (chunk < Math.min(opt.minChunk, deepLeft)) break;
        if (brk) push("break", brk);
        push("deep", chunk); use(gs, chunk); deepLeft -= chunk; lastWasDeep = true;
      }
      if (deepLeft === 0 && ge - c >= t.buffer && capOf(gs) >= t.buffer) {
        push("buffer", t.buffer);
        return { fits: true, split: true, segments };
      }
    }
    return null;
  })();
  if (splitRes && (onTime(splitRes) || !wholeRes)) return splitRes;
  return wholeRes || { fits: false, split: false, segments: [] };
}

const byPriority = (a, b) =>
  (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || b.dread - a.dread || b.total - a.total;
const finishesLate = (p, deadline) => !p.fits || (deadline != null && p.segments[p.segments.length - 1].end > deadline);

/* Re-plan flexible tasks around `busy`: earliest deadline first, then highest dread
 * (do the thing you're avoiding while you still have energy), then longest. */
function planTasks(tasks, busy, windows, opt) {
  opt = Object.assign({}, SCHED, opt);
  const order = [...tasks].sort(byPriority);
  busy = busy.slice();
  let capLeft = Object.assign({}, opt.capLeft);
  const plan = {};
  for (const t of order) {
    const p = placeTask(t, busy, windows, Object.assign({}, opt, { capLeft }));
    plan[t.id] = p;
    p.segments.forEach((s) => busy.push([s.start, s.end]));
    capLeft = capLeftFrom(p.segments, opt.dailyCap, capLeft);
  }
  return plan;
}

/* Plan everything, Cram-mode aware.
 *  opt.dailyCap: normal max task minutes per day
 *  opt.capLeft:  per-day minutes already used up (e.g. by finished tasks)
 *  opt.cram:     { hwCapByDay: { day: minutes }, effort: 0.5..1 } or null
 * Study sessions (t.study) go first, pinned to their day; then homework/other tasks fill what's left,
 * capped at the Cram homework budget on cram days and trimmed to `effort`.
 * Deadlines still win: if the cram cap would make a homework late, that one task may use the normal daily cap
 * (marked overCramCap) when that gets it in on time. */
function planAll(tasks, busy, windows, opt) {
  opt = Object.assign({}, SCHED, opt);
  const cram = opt.cram;
  const hwCap = cram && cram.hwCapByDay
    ? (d) => (d in cram.hwCapByDay ? cram.hwCapByDay[d] : capValue(opt.dailyCap, d))
    : opt.dailyCap;
  busy = busy.slice();
  const plan = {};
  tasks.filter((t) => t.study).sort((a, b) => a.earliest - b.earliest || b.total - a.total).forEach((t) => {
    const p = placeTask(t, busy, windows, Object.assign({}, opt, { dailyCap: Infinity, capLeft: {} }));
    plan[t.id] = p;
    p.segments.forEach((s) => busy.push([s.start, s.end]));
  });
  let capLeft = Object.assign({}, opt.capLeft);
  const placedHw = [];
  tasks.filter((t) => !t.study).map((t) => trimForCram(t, cram)).sort(byPriority).forEach((t) => {
    let p = placeTask(t, busy, windows, Object.assign({}, opt, { dailyCap: hwCap, capLeft }));
    if (cram && t.deadline != null && finishesLate(p, t.deadline)) {
      const relaxed = placeTask(t, busy, windows, Object.assign({}, opt, { capLeft: capLeftFrom(placedHw, opt.dailyCap) }));
      if (!finishesLate(relaxed, t.deadline)) p = Object.assign(relaxed, { overCramCap: true });
    }
    plan[t.id] = p;
    p.segments.forEach((s) => busy.push([s.start, s.end]));
    placedHw.push(...p.segments);
    capLeft = capLeftFrom(p.segments, hwCap, capLeft);
  });
  return plan;
}

/* In Cram mode homework gets "minimum viable" effort: deep work scaled down, setup/buffer kept. */
function trimForCram(t, cram) {
  if (!cram || !(cram.effort < 1) || t.study) return t;
  return Object.assign({}, t, { deep: Math.max(5, Math.round(t.deep * cram.effort)) });
}

/* Drop-dead start = deadline - total. `late` = minutes the planned finish runs past the deadline. */
function deadlineStatus(t, nowAbs) {
  if (t.deadline == null) return null;
  const dropDead = t.deadline - t.total;
  const last = t.fits && t.segments.length ? t.segments[t.segments.length - 1].end : null;
  return { dropDead, passed: nowAbs > dropDead, late: last != null && last > t.deadline ? last - t.deadline : 0 };
}

const countSessions = (segs) => segs.reduce((n, s, i) => n + (i === 0 || segs[i - 1].end !== s.start ? 1 : 0), 0);

/* ============ 4. Cram mode ============
 * Each exam: { id, name, at (absolute minutes), cooked 1..5, days (study days before, incl. exam day), color }
 * "How cooked" drives both how much of each day's study time an exam gets and the default number of days.
 * The day before (and the morning of) an exam it gets an urgency boost, so the next exam up gets focus. */
const COOKED_LABELS = ["I'll be fine", "a little rusty", "kinda cooked", "very cooked", "fully cooked"];
const COOKED_WEIGHT = [1, 2, 3.5, 5.5, 8];
const COOKED_DAYS = [2, 3, 4, 6, 8];
const cookedWeight = (c) => COOKED_WEIGHT[clamp(Math.round(c), 1, 5) - 1];
const suggestedDays = (c) => COOKED_DAYS[clamp(Math.round(c), 1, 5) - 1];
const urgency = (daysLeft) => 1 + 1.5 / (daysLeft + 1);
const STUDY_MIN_BLOCK = 20; // shares smaller than this get folded into the other exams that day

/* Split each day's study budget across the exams in their study window.
 * opts: { fromAbs, dayStart, windDown, dailyMin (total work minutes per cram day), hwShare 0..1 }
 * Returns { days: [{ day, budget, hw, alloc: { examId: minutes } }], totals: { examId: minutes }, hwCapByDay } */
function cramAllocate(exams, opts) {
  const valid = exams.filter((e) => Number.isFinite(e.at) && e.at > opts.fromAbs);
  const out = { days: [], totals: {}, hwCapByDay: {} };
  valid.forEach((e) => { out.totals[e.id] = 0; });
  if (!valid.length) return out;
  const first = dayOfAbs(opts.fromAbs);
  const last = Math.max(...valid.map((e) => dayOfAbs(e.at)));
  for (let d = first; d <= last; d++) {
    const winStart = Math.max(d * DAY_MIN + opts.dayStart, opts.fromAbs);
    const winEnd = d * DAY_MIN + opts.windDown;
    if (winEnd - winStart <= 0) continue;
    const active = valid.filter((e) => {
      const ed = dayOfAbs(e.at), days = Math.max(1, Math.round(e.days || suggestedDays(e.cooked)));
      if (d < ed - (days - 1) || d > ed) return false;
      return d < ed || e.at - 30 - winStart >= 60; // exam day only counts if there's an hour before it
    });
    if (!active.length) continue;
    // Time actually usable for study that day: the window, cut off before the earliest exam that day.
    const examToday = active.filter((e) => dayOfAbs(e.at) === d).map((e) => e.at - 30);
    const usable = Math.max(0, Math.min(winEnd, ...examToday) - winStart);
    const budget = Math.min(opts.dailyMin, winEnd - winStart);
    const hw = Math.round((budget * opts.hwShare) / 5) * 5;
    let pool = Math.min(budget - hw, usable);
    let alloc = shareOut(active, pool, d);
    out.days.push({ day: d, budget, hw, alloc });
    out.hwCapByDay[d] = hw;
    Object.entries(alloc).forEach(([id, m]) => { out.totals[id] += m; });
  }
  return out;
}

function shareOut(active, pool, d) {
  let list = active.slice();
  for (;;) {
    const w = list.map((e) => cookedWeight(e.cooked) * urgency(dayOfAbs(e.at) - d));
    const sum = w.reduce((a, b) => a + b, 0);
    const alloc = {};
    list.forEach((e, i) => { alloc[e.id] = Math.floor((pool * w[i]) / sum / 5) * 5; });
    const tooSmall = list.filter((e) => alloc[e.id] < STUDY_MIN_BLOCK);
    if (!tooSmall.length || tooSmall.length === list.length) {
      if (tooSmall.length === list.length) { // pool too small for everyone: give it all to the top exam
        let top = 0;
        w.forEach((x, i) => { if (x > w[top]) top = i; });
        Object.keys(alloc).forEach((k) => { alloc[k] = 0; });
        alloc[list[top].id] = pool >= STUDY_MIN_BLOCK ? Math.floor(pool / 5) * 5 : 0;
      }
      active.forEach((e) => { if (!(e.id in alloc)) alloc[e.id] = 0; });
      return alloc;
    }
    list = list.filter((e) => !tooSmall.includes(e));
  }
}

/* Turn an allocation into study tasks the scheduler can place (one per exam per day). */
function cramStudyTasks(exams, allocation) {
  const byId = Object.fromEntries(exams.map((e) => [e.id, e]));
  const tasks = [];
  allocation.days.forEach(({ day, alloc }) => {
    Object.entries(alloc).forEach(([id, min]) => {
      const e = byId[id];
      if (!e || min < STUDY_MIN_BLOCK) return;
      const examDay = dayOfAbs(e.at) === day;
      tasks.push({
        id: `cram:${id}:${day}`, study: true, examId: id, color: e.color,
        title: `Study · ${e.name}`, guess: min, total: min, setup: 5, deep: min - 5, buffer: 0,
        dread: e.cooked, deadline: null,
        earliest: day * DAY_MIN, latest: examDay ? e.at - 30 : (day + 1) * DAY_MIN,
      });
    });
  });
  return tasks;
}

if (typeof module !== "undefined") module.exports = {
  DAY_MIN, DAY_START, DAY_END, dayNum, keyOf, dateKey, absFromLocal, localFromAbs, fmtWhen,
  estimate, freeGaps, planningWindows, clipWindows, capLeftFrom, placeTask, planTasks, planAll, trimForCram,
  deadlineStatus, countSessions, cramAllocate, cramStudyTasks, cookedWeight, suggestedDays, migrateTasks,
};
