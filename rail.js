/* RealityCheck feature rail: a bar on the side listing every feature.
 * Click one and it scrolls there if it's off-screen, then the border lights up (and the cursor lands in the right box).
 * Features on another page open that page with #feature, which this script picks up on load.
 * Plain JS (no React), shared by index.html, cram.html and grades.html. Elements are found by id at click time. */
(function () {
  const S = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    today: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    timer: S('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>'),
    event: S('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M12 12v6M9 15h6"/>'),
    estimate: S('<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>'),
    tasks: S('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
    calendar: S('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01"/>'),
    todo: S('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>'),
    dump: S('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
    ask: S('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M12 8.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>'),
    cram: S('<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-9-1 2-2 3-4 3 0-2-1-4-2-5-1 4-4 6-4 11 0 4 3 7 7 7z"/>'),
    grades: S('<path d="M22 9L12 4 2 9l10 5 10-5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>'),
  };
  const CAL = "index.html";
  // target: element id to light up; focus: what gets the cursor; open: asks the page to open a panel first
  const ITEMS = [
    { key: "today", label: "Today", page: CAL, target: "f-today" },
    { key: "timer", label: "Timer", page: CAL, target: "f-pomo" },
    { key: "event", label: "Add event", page: CAL, target: "f-event", focus: "#ev-title" },
    { key: "estimate", label: "Estimate", page: CAL, target: "f-check", focus: "#f-check input[type=text]" },
    { key: "tasks", label: "Tasks", page: CAL, target: "f-tasks" },
    { key: "calendar", label: "Calendar", page: CAL, target: "f-calendar" },
    { key: "todo", label: "To-do", page: CAL, target: "f-todo", focus: "#f-todo .quick input" },
    "sep",
    { key: "dump", label: "Brain dump", page: CAL, target: "f-dump", open: "dump", focus: "#f-dump textarea", ai: true },
    { key: "ask", label: "Ask AI", page: CAL, target: "f-ask", ai: true },
    "sep",
    { key: "cram", label: "Cram", page: "cram.html", target: "f-cram" },
    { key: "grades", label: "Grades", page: "grades.html", target: "f-grades" },
  ];
  const items = ITEMS.filter((x) => x !== "sep");
  const file = (location.pathname.split("/").pop() || CAL).toLowerCase();
  const here = file.endsWith(".html") ? file : CAL;
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const css = `
  .rail { position: fixed; left: 12px; top: 50%; transform: translateY(-50%); z-index: 40; display: flex; flex-direction: column; gap: 2px;
    background: var(--card, #fff); border: 1px solid var(--line, #ddd); border-radius: 16px; padding: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.06);
    max-height: calc(100vh - 24px); overflow-y: auto; scrollbar-width: none; }
  .rail::-webkit-scrollbar { display: none; }
  .rail button { all: unset; box-sizing: border-box; width: 64px; padding: 6px 2px 5px; border-radius: 10px; cursor: pointer; display: flex; flex-direction: column;
    align-items: center; gap: 2px; color: var(--muted, #666); font: 500 10.5px/1.15 "DM Sans", system-ui, sans-serif; text-align: center; }
  .rail button:hover { background: var(--paper, #f4f4f4); color: var(--ink, #111); }
  .rail button:focus-visible { outline: 2px solid var(--ink, #111); outline-offset: 1px; }
  .rail button[aria-current="true"] { background: var(--ink, #111); color: #fff; }
  .rail button.ai { color: #4b3fa8; }
  .rail button.ai[aria-current="true"] { background: #4b3fa8; color: #fff; }
  .rail svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .rail hr { border: none; border-top: 1px solid var(--line, #ddd); margin: 3px 8px; }
  @media (min-width: 801px) and (max-width: 1460px) { body.has-rail .app { padding-left: 100px; } }
  @media (max-width: 800px) {
    .rail { left: 8px; right: 8px; top: auto; bottom: 8px; transform: none; flex-direction: row; overflow-x: auto; overflow-y: hidden; max-height: none; }
    .rail button { width: 60px; flex: none; }
    .rail hr { border-top: none; border-left: 1px solid var(--line, #ddd); margin: 8px 2px; }
    body.has-rail .app { padding-bottom: 96px; }
  }
  .spotlight { animation: rc-spot 2.4s ease-out; position: relative; z-index: 1; }
  @keyframes rc-spot {
    0%, 35% { box-shadow: 0 0 0 3px var(--accent, #e0603a), 0 0 0 9px rgba(224, 96, 58, .22); }
    100% { box-shadow: 0 0 0 3px rgba(224, 96, 58, 0), 0 0 0 9px rgba(224, 96, 58, 0); }
  }
  .spotlight.ai-spot { animation-name: rc-spot-ai; }
  @keyframes rc-spot-ai {
    0%, 35% { box-shadow: 0 0 0 3px #4b3fa8, 0 0 0 9px rgba(75, 63, 168, .22); }
    100% { box-shadow: 0 0 0 3px rgba(75, 63, 168, 0), 0 0 0 9px rgba(75, 63, 168, 0); }
  }
  @media (prefers-reduced-motion: reduce) { .spotlight { animation-duration: 3s; animation-timing-function: steps(1, end); } }`;

  // Elements can appear a moment later (React render, a panel that just opened): wait up to 3s.
  function waitFor(id) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      (function tick() {
        const el = document.getElementById(id);
        if (el) return resolve(el);
        if (performance.now() - t0 > 3000) return resolve(null);
        setTimeout(tick, 30); // not requestAnimationFrame: that pauses in background tabs
      })();
    });
  }

  function spotlight(el, item) {
    const r = el.getBoundingClientRect(), vh = window.innerHeight;
    const inView = r.height > vh * 0.9 ? r.top >= -4 && r.top < vh * 0.35 : r.top >= 8 && r.bottom <= vh - 8;
    if (!inView) el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: r.height > vh * 0.9 ? "start" : "center" });
    el.classList.remove("spotlight", "ai-spot");
    void el.offsetWidth; // restart the animation if it's clicked again
    el.classList.add("spotlight");
    if (item.ai) el.classList.add("ai-spot");
    clearTimeout(el._rcSpot);
    el._rcSpot = setTimeout(() => el.classList.remove("spotlight", "ai-spot"), 2500);
    const f = item.focus && document.querySelector(item.focus);
    if (f) f.focus({ preventScroll: true });
  }

  async function go(item) {
    if (item.page !== here) { location.href = `${item.page}#${item.key}`; return; }
    if (item.open) window.dispatchEvent(new CustomEvent("rc:open", { detail: item.open }));
    const el = await waitFor(item.target);
    if (el) spotlight(el, item);
    setCurrent(item.key);
  }

  let buttons = {};
  function setCurrent(key) {
    Object.entries(buttons).forEach(([k, b]) => b.setAttribute("aria-current", String(k === key)));
  }

  function build() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const nav = document.createElement("nav");
    nav.className = "rail";
    nav.setAttribute("aria-label", "Features");
    ITEMS.forEach((it) => {
      if (it === "sep") { nav.appendChild(document.createElement("hr")); return; }
      const b = document.createElement("button");
      b.type = "button";
      b.className = it.ai ? "ai" : "";
      b.title = it.page === here ? `Show ${it.label}` : `Open ${it.label}`;
      b.innerHTML = `${ICON[it.key]}<span>${it.label}</span>`;
      b.addEventListener("click", () => go(it));
      buttons[it.key] = b;
      nav.appendChild(b);
    });
    document.body.appendChild(nav);
    document.body.classList.add("has-rail");

    // Mark the page you're on (Cram / Grades), or the feature you were sent to.
    const fromHash = items.find((it) => it.key === location.hash.slice(1) && it.page === here);
    if (fromHash) setTimeout(() => go(fromHash), 300);
    else if (here !== CAL) setCurrent(items.find((it) => it.page === here)?.key);

    // While scrolling the calendar page, highlight whichever feature is near the top of the screen.
    if (here === CAL) {
      let raf = 0;
      window.addEventListener("scroll", () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          let best = null, bestD = Infinity;
          items.filter((it) => it.page === CAL && !it.ai).forEach((it) => {
            const el = document.getElementById(it.target);
            if (!el) return;
            const r = el.getBoundingClientRect();
            if (r.bottom < 60 || r.top > window.innerHeight * 0.5) return;
            const d = Math.abs(r.top - 80);
            if (d < bestD) { bestD = d; best = it.key; }
          });
          if (best && window.scrollY > 40) setCurrent(best); else if (window.scrollY <= 40) setCurrent(null);
        });
      }, { passive: true });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
