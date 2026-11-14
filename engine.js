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
// Cram mode settings before you change anything. Every page uses these, so they all compute the same plan.
const CRAM_DEFAULT = { active: false, exams: [], dailyHours: 6, hwShare: 0.25, effort: 0.8, stretchH: 1.5, hwCapByDay: {}, appliedSig: null };

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

/* Work minutes you can realistically get out of [a, b] around fixed `busy` intervals:
 * 10 min breathing room around each event, gaps too short for a real session don't count,
 * and every hour loses 10 min to a break (the scheduler's 50/10 rhythm). */
function usableMinutes(busy, a, b) {
  if (b <= a) return 0;
  return freeGaps(busy, a, b, SCHED.breather).reduce((s, [x, y]) => {
    const len = y - x;
    return len < SCHED.minChunk + 5 ? s : s + len - Math.floor(len / 60) * SCHED.breakLen;
  }, 0);
}

/* Split each day's study budget across the exams in their study window.
 * opts: { fromAbs, dayStart, windDown, dailyMin (total work minutes per cram day), hwShare 0..1,
 *         busy: [[start, end], ...] fixed events (practices, shifts, exams),
 *         stretchMin: how far over dailyMin a day may go to make up time that fixed events ate }
 * Big fixed blocks shrink that day's budget (homework share shrinks with it). The study time an exam
 * loses is made up on its other study days with room, earliest first, up to stretchMin extra per day.
 * Returns { days: [{ day, budget, hw, alloc, ideal, base, extra, blocked, free }], totals, hwCapByDay,
 *           byExam: { examId: { lost, recovered } }, lost, recovered } */
function cramAllocate(exams, opts) {
  const valid = exams.filter((e) => Number.isFinite(e.at) && e.at > opts.fromAbs);
  const out = { days: [], totals: {}, hwCapByDay: {}, byExam: {}, lost: 0, recovered: 0 };
  valid.forEach((e) => { out.totals[e.id] = 0; out.byExam[e.id] = { lost: 0, recovered: 0 }; });
  if (!valid.length) return out;
  const busy = opts.busy || [];
  const stretch = Math.max(0, Number(opts.stretchMin) || 0);
  const r5 = (m) => Math.max(0, Math.floor(m / 5) * 5);
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
    // Study stops 30 min before the earliest exam that day.
    const studyEnd = Math.min(winEnd, ...active.filter((e) => dayOfAbs(e.at) === d).map((e) => e.at - 30));
    // What the day would give if nothing else were on it...
    const budget = Math.min(opts.dailyMin, usableMinutes([], winStart, winEnd));
    const idealHw = r5(Math.round(budget * opts.hwShare));
    const ideal = shareOut(active, r5(Math.min(budget - idealHw, usableMinutes([], winStart, studyEnd))), d);
    // ...and what it really gives around your fixed events.
    const free = usableMinutes(busy, winStart, winEnd);
    const freeStudy = usableMinutes(busy, winStart, studyEnd);
    const real = Math.min(budget, free);
    const hw = r5(Math.round(real * opts.hwShare));
    const alloc = shareOut(active, r5(Math.min(real - hw, freeStudy)), d);
    out.days.push({ day: d, budget, hw, alloc, ideal, base: Object.assign({}, alloc), extra: {},
      blocked: budget - real, free, freeStudy, active: active.map((e) => e.id) });
  }

  // Make up what fixed events took, on the exam's other study days (soonest exam first).
  const used = (x) => x.hw + Object.values(x.alloc).reduce((a, b) => a + b, 0);
  const room = (x) => Math.min(x.budget + stretch, x.free) - used(x);
  const studyRoom = (x) => x.freeStudy - Object.values(x.alloc).reduce((a, b) => a + b, 0);
  valid.slice().sort((a, b) => a.at - b.at).forEach((e) => {
    const mine = out.days.filter((x) => x.active.includes(e.id));
    let owed = mine.reduce((s, x) => s + Math.max(0, (x.ideal[e.id] || 0) - (x.alloc[e.id] || 0)), 0);
    out.byExam[e.id].lost = owed;
    out.lost += owed;
    while (owed > 0) {
      // A first block on a day has to be a real session; after that, top up 15 min at a time.
      const amount = (x) => ((x.alloc[e.id] || 0) >= STUDY_MIN_BLOCK ? Math.min(15, owed) : Math.min(30, owed));
      const ok = mine.filter((x) => {
        const a = amount(x);
        return (x.alloc[e.id] || 0) + a >= STUDY_MIN_BLOCK && room(x) >= a && studyRoom(x) >= a;
      });
      if (!ok.length) break;
      const pick = ok.reduce((best, x) => (room(x) > room(best) ? x : best)); // most room; ties -> earliest
      const a = amount(pick);
      pick.alloc[e.id] = (pick.alloc[e.id] || 0) + a;
      pick.extra[e.id] = (pick.extra[e.id] || 0) + a;
      owed -= a;
      out.byExam[e.id].recovered += a;
      out.recovered += a;
    }
  });

  out.days.forEach((x) => {
    out.hwCapByDay[x.day] = x.hw;
    Object.entries(x.alloc).forEach(([id, m]) => { out.totals[id] += m; });
  });
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

/* The whole Cram plan from saved state. Cram mode previews it; Apply (and the calendar, whenever a fixed event
 * changes while Cram mode is on) writes `nextEvents`, `nextTasks` and `hwCapByDay`/`sig` back.
 *   cram: the Cram settings + exams, events/tasks: calendar data, settings: { windDown, planFrom, lookahead, dailyCapH } */
function cramPlan({ cram, events, tasks, settings, nowAbs }) {
  const fromAbs = absFromLocal(settings.planFrom) ?? Math.ceil(nowAbs / 5) * 5;
  const windDown = Math.min(timeOr(settings.windDown, 21 * 60), DAY_END);
  const dailyCap = Number(settings.dailyCapH) > 0 ? Number(settings.dailyCapH) * 60 : Infinity;
  const lookahead = clamp(Math.round(Number(settings.lookahead) || 7), 1, 60);
  const dailyHours = clamp(Number(cram.dailyHours) || 6, 1, 14);
  const hwShare = clamp(Number(cram.hwShare) || 0, 0, 0.8);
  const effort = clamp(Number(cram.effort) || 1, 0.5, 1);
  const stretchH = clamp(Number(cram.stretchH ?? 1.5) || 0, 0, 4);

  const exams = (cram.exams || []).map((e) => Object.assign({}, e, { at: absFromLocal(e.when), days: e.days == null ? suggestedDays(e.cooked) : e.days }));
  const valid = exams.filter((e) => e.name.trim() && e.at != null && e.at > nowAbs);
  const examEvents = valid.map((e) => {
    const d = dayOfAbs(e.at), start = e.at - d * DAY_MIN;
    return { id: "exam:" + e.id, cramExamId: e.id, title: `${e.name.trim()} exam`, date: keyOf(d), start,
      end: Math.min(start + (Number(e.length) || 90), DAY_MIN), color: e.color };
  });
  const otherEvents = events.filter((e) => !e.cramExamId);
  const fixed = otherEvents.concat(examEvents).map(eventAbs).map((e) => [e.start, e.end]);
  const alloc = cramAllocate(valid, { fromAbs, dayStart: DAY_START, windDown, dailyMin: dailyHours * 60, hwShare,
    busy: fixed, stretchMin: stretchH * 60 });
  const study = cramStudyTasks(valid, alloc);

  const isDone = (t) => t.fits && t.segments.length && t.segments[t.segments.length - 1].end <= nowAbs;
  const hwTasks = tasks.filter((t) => !t.study);
  const todoHw = hwTasks.filter((t) => !isDone(t));
  const doneSegs = hwTasks.filter(isDone).flatMap((t) => t.segments);
  const lastDay = Math.max(dayOfAbs(fromAbs), ...valid.map((e) => dayOfAbs(e.at)));
  const windows = planningWindows(fromAbs, Math.max(lookahead, lastDay - dayOfAbs(fromAbs) + 1), DAY_START, windDown);
  const runPlan = (withCram) => {
    const cramOpt = withCram ? { hwCapByDay: alloc.hwCapByDay, effort } : null;
    const hwCap = withCram ? (d) => (d in alloc.hwCapByDay ? alloc.hwCapByDay[d] : dailyCap) : dailyCap;
    return planAll(withCram ? todoHw.concat(study) : todoHw, fixed.concat(doneSegs.map((s) => [s.start, s.end])), windows,
      { dailyCap, capLeft: capLeftFrom(doneSegs, hwCap), cram: cramOpt });
  };
  const plan = runPlan(true);
  const placedStudy = study.map((t) => Object.assign({}, t, plan[t.id]));
  const withPlan = (p) => (t) => (p[t.id] ? Object.assign({}, t, p[t.id]) : t);

  return {
    fromAbs, windDown, dailyCap, dailyHours, hwShare, effort, stretchH,
    valid, examEvents, otherEvents, fixed, alloc, study, hwTasks, todoHw, plan, placedStudy, runPlan,
    // Fixed events are part of the plan, so a new practice makes an applied plan out of date.
    sig: JSON.stringify({ exams: cram.exams, dailyHours, hwShare, effort, stretchH, fixed }),
    nextEvents: otherEvents.concat(examEvents),
    nextTasks: hwTasks.map(withPlan(plan)).concat(placedStudy),
    offTasks: () => hwTasks.map(withPlan(runPlan(false))),
  };
}

/* Study minutes per day from a task list, e.g. to say what a re-plan moved. */
function studyByDay(tasks) {
  const out = {};
  tasks.filter((t) => t.study && t.fits).forEach((t) => t.segments.forEach((s) => {
    if (s.kind === "break") return;
    const d = dayOfAbs(s.start);
    out[d] = (out[d] || 0) + s.end - s.start;
  }));
  return out;
}

/* ============ To-dos ============
 * Quick add understands plain text, no AI needed:
 *   "stats pset fri 5pm 2h"  -> due Friday 5:00 PM, ~2h
 *   "CS 251 lab tmrw 1h30m"  -> due tomorrow (end of day), ~1h 30m, class "CS 251"
 *   "read ch 4 by 11/20 45m" -> due Nov 20, ~45m
 * Returns { title, due (absolute minutes or null), minutes (or null), cls (or "") } */
const TODOS_KEY = "realitycheck.todos.v1";
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseQuickTodo(text, nowAbs) {
  let s = ` ${text} `;
  const today = dayOfAbs(nowAbs);
  let minutes = null, day = null, time = null;
  const cut = (re, fn) => { s = s.replace(re, (...m) => { fn(m); return " "; }); };

  cut(/\s~?(\d+)\s*h(?:rs?|ours?)?\s*(\d+)\s*m(?:ins?|inutes?)?\b/i, (m) => { minutes = Number(m[1]) * 60 + Number(m[2]); });
  if (minutes == null) cut(/\s~?(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b/i, (m) => { minutes = Math.round(parseFloat(m[1]) * 60); });
  if (minutes == null) cut(/\s~?(\d+)\s*(?:m|mins?|minutes?)\b/i, (m) => { minutes = Number(m[1]); });

  cut(/\s(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m) => {
    time = (Number(m[1]) % 12 + (m[3].toLowerCase() === "pm" ? 12 : 0)) * 60 + Number(m[2] || 0);
  });
  cut(/\s(?:at\s+)?(noon|midnight)\b/i, (m) => { time = m[1].toLowerCase() === "noon" ? 12 * 60 : 23 * 60 + 59; });

  cut(/\s(?:due\s+|by\s+|on\s+)?(today|tonight|tomorrow|tmrw|tmr)\b/i, (m) => { day = today + (/^to(day|night)$/i.test(m[1]) ? 0 : 1); });
  if (day == null) cut(/\s(?:due\s+|by\s+|on\s+)?(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i, (m) => {
    const ahead = (WEEKDAY_NAMES.indexOf(m[2].toLowerCase()) - weekday(keyOf(today)) + 7) % 7;
    day = today + (m[1] ? ahead || 7 : ahead);
  });
  if (day == null) cut(/\s(?:due\s+|by\s+|on\s+)?(\d{1,2})\/(\d{1,2})\b/, (m) => {
    const y = Number(keyOf(today).slice(0, 4));
    let d = dayNum(`${y}-${pad2(m[1])}-${pad2(m[2])}`);
    if (d < today) d = dayNum(`${y + 1}-${pad2(m[1])}-${pad2(m[2])}`);
    day = d;
  });

  let due = null;
  if (day != null) due = day * DAY_MIN + (time ?? 23 * 60 + 59);
  else if (time != null) due = (today * DAY_MIN + time > nowAbs ? today : today + 1) * DAY_MIN + time;

  const title = s.replace(/\s(?:due|by|on|at)\s*$/i, " ").replace(/\s+/g, " ").trim();
  const cls = (title.match(/^([A-Za-z]{2,5}\s?\d{3,5})\b/) || [])[1] || "";
  // "chem quiz mon 10am" / "study for the MA 261 midterm" is an exam: Cram mode should plan the studying.
  const examLike = /\b(midterms?|finals?|exams?|quiz(zes)?|tests?)\b/i.test(title) && !/\b(unit|test cases?|tests? (?:for|on) (?:the )?code)\b/i.test(title);
  const examName = title.replace(/^(?:study(?:ing)?|review(?:ing)?|prep(?:are)?|cram(?:ming)?)\s+(?:for\s+)?(?:the\s+|my\s+)?/i, "").trim() || title;
  return { title: title || text.trim(), due, minutes, cls: cls.toUpperCase(), examLike, examName, hasTime: time != null };
}

/* ============ 5. Grades ============
 * A class: { name, target: "B", scale: [["A", 90], ...], categories: [{ name, weight, items: [{ name, score, outOf }] }] }
 * An item with a blank score is still to come. A category with no items counts as entirely still to come (e.g. "Final 30%").
 * Weights don't have to add to 100: they're normalized. */
const GRADES_KEY = "realitycheck.grades.v1";
const DEFAULT_SCALE = [["A", 90], ["B", 80], ["C", 70], ["D", 60]];
const hasScore = (i) => i.score !== "" && i.score != null && Number.isFinite(Number(i.score));

function letterFor(pct, scale) {
  const s = (scale || DEFAULT_SCALE).slice().sort((a, b) => b[1] - a[1]);
  const hit = s.find(([, cut]) => pct >= cut);
  return hit ? hit[0] : "F";
}

/* Returns {
 *   current:  average so far on graded work (0..100, weighted), or null if nothing graded
 *   banked:   points already locked into the final grade (0..100 of the whole class)
 *   pending:  share of the final grade still to come (0..100)
 *   need:     { letter: % average needed on everything left } for each letter in the scale
 *   targetNeed, floor (grade if you get 0 on the rest), ceiling (grade if you get 100), cooked 1..5, verdict
 *   cats:     per category { name, weight (normalized %), avg, done, pending } } */
function gradeSummary(cls) {
  const scale = cls.scale && cls.scale.length ? cls.scale : DEFAULT_SCALE;
  const raw = (cls.categories || []).map((c) => {
    const w = Math.max(0, Number(c.weight) || 0);
    const items = (c.items || []).filter((i) => Number(i.outOf) > 0);
    const graded = items.filter(hasScore);
    const possible = items.reduce((s, i) => s + Number(i.outOf), 0);
    const gp = graded.reduce((s, i) => s + Number(i.outOf), 0);
    const ge = graded.reduce((s, i) => s + Number(i.score), 0);
    const doneFrac = possible ? gp / possible : 0;
    return { id: c.id, name: c.name, w, avg: gp ? (ge / gp) * 100 : null,
      doneW: w * doneFrac, earnedW: possible ? (w * ge) / possible : 0, pendingW: w * (1 - doneFrac) };
  });
  const total = raw.reduce((s, c) => s + c.w, 0);
  if (!total) return null;
  const doneW = raw.reduce((s, c) => s + c.doneW, 0);
  const earnedW = raw.reduce((s, c) => s + c.earnedW, 0);
  const banked = (earnedW / total) * 100;
  const pending = (raw.reduce((s, c) => s + c.pendingW, 0) / total) * 100;
  const current = doneW > 0 ? (earnedW / doneW) * 100 : null;
  const needFor = (cut) => (pending > 0.01 ? ((cut - banked) / pending) * 100 : banked >= cut ? -Infinity : Infinity);
  const need = Object.fromEntries(scale.map(([l, cut]) => [l, needFor(Number(cut))]));
  const targetCut = Number((scale.find(([l]) => l === cls.target) || scale[0])[1]);
  const targetNeed = needFor(targetCut);

  // How cooked are you? Compare what you need with how you've been doing.
  const gap = targetNeed - (current ?? 80);
  let cooked = targetNeed <= 0 ? 1 : gap <= -5 ? 1 : gap <= 3 ? 2 : gap <= 10 ? 3 : 4;
  if (targetNeed > 95) cooked = Math.max(cooked, 4);
  if (targetNeed > 100) cooked = 5;
  const verdict = [
    targetNeed <= 0 ? "It's in the bag. Even a zero on the rest keeps it." : "Comfortable. Keep showing up.",
    "On track. Keep doing exactly what you're doing.",
    "Step it up. You need to beat your average so far.",
    "Lock in. You need your best work from here on.",
    "Not possible anymore. Time to save the next letter down.",
  ][cooked - 1];
  return {
    current, banked, pending, need, targetNeed, targetCut, cooked, verdict, scale,
    floor: banked, ceiling: banked + pending,
    cats: raw.map((c) => ({ id: c.id, name: c.name, weight: (c.w / total) * 100, avg: c.avg,
      done: (c.doneW / total) * 100, pending: (c.pendingW / total) * 100 })),
  };
}

/* The class a Cram exam belongs to: "MA 261 Midterm 2" matches a class named "MA 261" (spaces and case ignored). */
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function classForExam(classes, examName) {
  const e = normName(examName);
  if (!e) return null;
  return (classes || []).filter((c) => normName(c.name) && (e.includes(normName(c.name)) || normName(c.name).includes(e)))
    .sort((a, b) => normName(b.name).length - normName(a.name).length)[0] || null;
}

if (typeof module !== "undefined") module.exports = {
  gradeSummary, letterFor, classForExam,
  DAY_MIN, DAY_START, DAY_END, dayNum, keyOf, dateKey, absFromLocal, localFromAbs, fmtWhen,
  estimate, freeGaps, planningWindows, clipWindows, capLeftFrom, placeTask, planTasks, planAll, trimForCram,
  deadlineStatus, countSessions, cramAllocate, usableMinutes, cramStudyTasks, cookedWeight, suggestedDays, migrateTasks,
};
