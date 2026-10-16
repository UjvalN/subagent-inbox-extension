(() => {
  // Firefox exposes `browser`; Chrome only `chrome` (callback-style), so wrap it.
  const browser = globalThis.browser || (() => {
    const c = globalThis.chrome, wrap = (fn, ctx) => (...a) => new Promise(res => fn.call(ctx, ...a, res));
    return { storage: { local: { get: wrap(c.storage.local.get, c.storage.local), set: wrap(c.storage.local.set, c.storage.local) } },
             runtime: { onMessage: c.runtime.onMessage } };
  })();
  console.log("[Subagent Inbox] loaded");

  // Heuristics for finding subagent / tool output blocks on claude.ai.
  // claude.ai's markup changes often; tweak these if nothing gets captured.
  const BASE_SELECTORS = [
    '[data-testid*="tool" i]',
    '[data-testid*="agent" i]',
    '[class*="tool-use" i]',
    '[class*="toolUse" i]',
    '[class*="subagent" i]',
    'details'
  ];
  const BUSY_SEL = '[aria-busy="true"], [class*="spin" i], [class*="loading" i], [class*="pulse" i], [class*="shimmer" i]';
  const KEYWORDS = /(subagent|sub-agent|task|agent|tool result|research|analysis)/i;
  const ERR = /\b(error|failed|failure|exception|traceback)\b/i;
  const STORE_KEY = "subagentInbox", DISMISS_KEY = "subagentDismissed", CUSTOM_KEY = "subagentSelectors";
  let custom = [];             // selectors learned via the Pick tool
  const allSelectors = () => [...BASE_SELECTORS, ...custom];
  const countSel = sel => { try { return [...document.querySelectorAll(sel)].filter(e => !root.contains(e)).length; } catch { return -1; } };
  const QUIET_MS = 3000;       // no output change for this long => finished
  const HISTORY_MS = 4000;     // blocks first seen this soon after load are history, not live
  const loadedAt = Date.now();

  let items = [];
  const dismissed = new Set();
  const live = new Map();      // id -> { el, text, lastChange }
  let selectedId = null, filter = "all", query = "", follow = true, dup = 0, fullOpen = false, builtId = null;

  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const byId = id => items.find(i => i.id === id);

  function summarize(text) {
    const clean = text.replace(/\s+\n/g, "\n").trim();
    const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
    const title = (lines.find(l => l.length > 2) || "Subagent output").slice(0, 90);
    const sentences = clean.replace(/\n+/g, " ").match(/[^.!?]+[.!?]+/g) || [clean];
    const keyLines = lines.filter(l => /^([-*•]|\d+[.)])\s/.test(l) || /(result|found|error|done|completed|summary|conclusion|fail)/i.test(l));
    return {
      title,
      summary: sentences.slice(0, 2).join(" ").slice(0, 280),
      bullets: keyLines.slice(0, 6),
      tail: lines.slice(-8).join("\n")
    };
  }

  // ---------- capture ----------
  const isBusy = el => el.getAttribute("aria-busy") === "true" || !!el.querySelector(BUSY_SEL);

  function candidates() {
    const set = new Set();
    allSelectors().forEach(sel => { try { document.querySelectorAll(sel).forEach(el => { if (!root.contains(el)) set.add(el); }); } catch {} });
    const arr = [...set];
    return arr.filter(el => !arr.some(o => o !== el && el.contains(o))); // innermost block only
  }

  function setStatus(item, running, silent) {
    const next = running ? "running" : ERR.test(item.full.slice(-400)) ? "error" : "done";
    if (item.status === next) return false;
    const was = item.status;
    item.status = next;
    if (next === "running") { item.ended = null; if (!silent) toast("▶", "Subagent started", item); }
    else { item.ended = Date.now(); if (was === "running" && !silent) toast(next === "error" ? "⚠" : "✓", "Subagent finished", item); }
    return true;
  }

  function upsert(el) {
    const text = (el.innerText || "").trim();
    if (text.length < 40) return;
    if (el.tagName === "DETAILS" && !KEYWORDS.test(text.slice(0, 200))) return;
    let id = el.dataset.saiId;
    if (!id) {
      id = hash(text.replace(/\s+/g, " ").slice(0, 40));
      const o = live.get(id);
      if (o && o.el !== el && o.el.isConnected) id += "-" + (++dup);
      el.dataset.saiId = id;
    }
    if (dismissed.has(id)) return;

    const now = Date.now(), busy = isBusy(el);
    let item = byId(id), rec = live.get(id);
    const historical = !busy && now - loadedAt < HISTORY_MS;
    if (!rec) live.set(id, rec = { el, text, lastChange: historical || (item && item.full === text) ? 0 : now });
    else { rec.el = el; if (rec.text !== text) { rec.text = text; rec.lastChange = now; } }

    const isNew = !item;
    if (isNew) { item = { id, time: now, updated: now, read: false, pinned: false, url: location.href, status: "done", full: "" }; items.unshift(item); }
    let changed = isNew;
    if (item.full !== text) { Object.assign(item, summarize(text), { full: text.slice(0, 20000), updated: now }); changed = true; }
    const running = busy || now - rec.lastChange < QUIET_MS;
    if (setStatus(item, running, isNew && !running)) changed = true;
    if (isNew && follow && running) selectedId = id;
    if (changed) { items = items.slice(0, 300); save(); render(); }
  }

  const scan = () => candidates().forEach(upsert);

  setInterval(() => {                       // flips running -> done once output goes quiet
    const now = Date.now(); let any = false;
    for (const item of items) {
      if (item.status !== "running") continue;
      any = true;
      const rec = live.get(item.id);
      const running = rec && rec.el.isConnected && (isBusy(rec.el) || now - rec.lastChange < QUIET_MS);
      if (setStatus(item, !!running)) { save(); any = true; }
    }
    if (any) render();
  }, 1000);

  let scanTimer;
  new MutationObserver(muts => {
    if (muts.every(m => root.contains(m.target))) return;
    clearTimeout(scanTimer); scanTimer = setTimeout(scan, 300);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => browser.storage.local.set({ [STORE_KEY]: items, [DISMISS_KEY]: [...dismissed].slice(-1000) }), 800);
  }

  // ---------- UI ----------
  const root = document.createElement("div");
  root.id = "sai-root";
  root.innerHTML = `
    <div id="sai-panel">
      <div id="sai-header"><b>Subagent Inbox</b> <span id="sai-count"></span>
        <label class="sai-follow" title="Auto-select newly started subagents"><input type="checkbox" id="sai-follow" checked> Follow live</label>
        <span class="sai-actions"><button id="sai-pick" title="Click a subagent block on the page to track it">Pick</button><button id="sai-debug">Debug</button><button id="sai-clear">Clear</button><button id="sai-close">×</button></span></div>
      <div id="sai-toolbar"><div id="sai-tabs"></div><input id="sai-search" type="search" placeholder="Search…  ( / )"></div>
      <div id="sai-body"><ul id="sai-list"></ul><div id="sai-detail"><p class="sai-empty">Select a message</p></div></div>
      <div id="sai-foot">j/k navigate · p pin · u unread · x dismiss · esc close</div>
    </div>
    <div id="sai-toasts"></div>
    <button id="sai-fab">📥</button>`;
  document.body.append(root);

  const panel = root.querySelector("#sai-panel"), fab = root.querySelector("#sai-fab");
  const $ = s => panel.querySelector(s);
  const toggle = () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) { root.querySelector("#sai-toasts").innerHTML = ""; render(); }
  };
  fab.onclick = toggle;
  $("#sai-close").onclick = toggle;
  $("#sai-follow").onchange = e => { follow = e.target.checked; };
  $("#sai-search").oninput = e => { query = e.target.value.toLowerCase(); render(); };
  $("#sai-clear").onclick = () => {
    items.forEach(i => dismissed.add(i.id)); items = []; selectedId = null;
    save(); render(); $("#sai-detail").innerHTML = '<p class="sai-empty">Inbox cleared</p>';
  };
  browser.runtime.onMessage.addListener(m => { if (m.type === "toggle") toggle(); });

  const TABS = [["all", "All"], ["running", "Running"], ["done", "Done"], ["unread", "Unread"], ["pinned", "Pinned"]];
  const matches = {
    all: () => true, running: i => i.status === "running", done: i => i.status !== "running",
    unread: i => !i.read, pinned: i => i.pinned
  };
  const visible = () => items
    .filter(i => matches[filter](i) && (!query || (i.title + i.full).toLowerCase().includes(query)))
    .sort((a, b) => (b.pinned - a.pinned) || (b.time - a.time));

  const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; };
  const dur = i => fmtDur((i.status === "running" ? Date.now() : (i.ended || i.updated)) - i.time);
  const ICON = { running: "●", done: "✓", error: "⚠" };

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; draw(); });
  }

  function draw() {
    const running = items.filter(i => i.status === "running").length, unread = items.filter(i => !i.read).length;
    $("#sai-count").textContent = `${items.length} · ${running} running · ${unread} new`;
    fab.dataset.badge = unread || "";
    fab.classList.toggle("busy", running > 0);
    $("#sai-tabs").innerHTML = TABS.map(([k, label]) =>
      `<button data-tab="${k}" class="${k === filter ? "on" : ""}">${label} <small>${items.filter(matches[k]).length}</small></button>`).join("");

    const list = $("#sai-list"), st = list.scrollTop, vis = visible();
    list.innerHTML = vis.map(i => `
      <li data-id="${i.id}" class="${i.read ? "" : "unread"} ${i.status} ${i.id === selectedId ? "sel" : ""}">
        <div class="sai-title"><span class="sai-dot ${i.status}">${ICON[i.status]}</span>${i.pinned ? "📌 " : ""}${esc(i.title)}</div>
        <div class="sai-snip">${esc((i.status === "running" ? i.tail.split("\n").pop() : i.summary).slice(0, 110))}</div>
        <div class="sai-time">${new Date(i.time).toLocaleTimeString()} · ${dur(i)}${i.status === "running" ? " · " + i.full.length + " chars" : ""}</div>
      </li>`).join("") || '<li class="sai-empty">Nothing here</li>';
    list.scrollTop = st;
    updateDetail();
  }

  // selection uses mousedown so a re-render between mousedown/mouseup can't swallow the click
  $("#sai-list").addEventListener("mousedown", e => { const li = e.target.closest("li[data-id]"); if (li) select(li.dataset.id); });
  $("#sai-tabs").addEventListener("mousedown", e => { const b = e.target.closest("button[data-tab]"); if (b) { filter = b.dataset.tab; render(); } });

  function select(id) {
    const i = byId(id); if (!i) return;
    selectedId = id; i.read = true; save();
    render();
  }

  // Detail pane: static header/actions built once per selection, live region patched in place.
  function buildDetail(i) {
    $("#sai-detail").innerHTML = `
      <h3 id="sai-d-title"></h3>
      <div class="sai-time" id="sai-d-meta"></div>
      <div class="sai-btns">
        <button data-act="jump">Jump to it in chat</button>
        <button data-act="quote">Quote in reply</button>
        <button data-act="copy">Copy</button>
        <button data-act="pin"></button>
        <button data-act="unread">Mark unread</button>
        <button data-act="dismiss" class="danger">Dismiss</button>
      </div>
      <div id="sai-live"></div>
      <details id="sai-fulld"${fullOpen ? " open" : ""}><summary>Full output</summary><pre id="sai-full"></pre></details>`;
    $("#sai-fulld").ontoggle = e => { fullOpen = e.target.open; };
    builtId = i.id;
    patchDetail(i);
  }

  function updateDetail() {
    const i = byId(selectedId);
    if (!i) return;
    if (builtId !== i.id) buildDetail(i); else patchDetail(i);
  }

  function patchDetail(i) {
    $("#sai-d-title").textContent = i.title;
    $("#sai-d-meta").innerHTML = `<span class="sai-dot ${i.status}">${ICON[i.status]}</span> ${i.status} · ${dur(i)} · started ${new Date(i.time).toLocaleString()}`;
    $('[data-act="pin"]').textContent = i.pinned ? "Unpin" : "Pin";
    $("#sai-live").innerHTML = i.status === "running"
      ? `<h4>Live output</h4><pre class="sai-tail">${esc(i.tail)}</pre>`
      : `<h4>Summary</h4><p>${esc(i.summary)}</p>${i.bullets.length ? `<h4>Key points</h4><ul>${i.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}`;
    const pre = $("#sai-full"), atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    if (pre.textContent !== i.full) { pre.textContent = i.full; if (i.status === "running" && atEnd) pre.scrollTop = pre.scrollHeight; }
  }

  $("#sai-detail").addEventListener("click", e => {
    const b = e.target.closest("[data-act]"), i = byId(selectedId); if (!b || !i) return;
    ({ jump: () => jump(i), quote: () => quote(i), copy: () => copy(i.full, b),
       pin: () => { i.pinned = !i.pinned; save(); render(); },
       unread: () => { i.read = false; save(); render(); },
       dismiss: () => dismiss(i) })[b.dataset.act]();
  });

  function jump(i) {
    const rec = live.get(i.id);
    const el = rec && rec.el.isConnected ? rec.el : document.querySelector(`[data-sai-id="${i.id}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("sai-flash"); setTimeout(() => el.classList.remove("sai-flash"), 2000); }
    else if (i.url !== location.href) location.href = i.url;
  }

  function copy(text, btn) {
    const done = () => { if (btn) { const t = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => btn.textContent = t, 1200); } };
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done, () => {
      const ta = document.createElement("textarea"); ta.value = text; document.body.append(ta); ta.select();
      document.execCommand("copy"); ta.remove(); done();
    });
  }

  function quote(i) {
    const box = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => !root.contains(e)).pop();
    const text = `Re subagent "${i.title}":\n> ${(i.summary || i.title).replace(/\n/g, "\n> ")}\n\n`;
    if (!box) return copy(text);
    box.focus();
    document.execCommand("insertText", false, text);
  }

  function dismiss(i) {
    const vis = visible(), idx = vis.findIndex(x => x.id === i.id);
    dismissed.add(i.id); items = items.filter(x => x !== i);
    const next = vis[idx + 1] || vis[idx - 1];
    selectedId = null; save();
    if (next && next !== i) select(next.id);
    else { $("#sai-detail").innerHTML = '<p class="sai-empty">Select a message</p>'; render(); }
  }


  // ---------- Pick tool & debug ----------
  let picking = false, hover = null;
  const selFor = el => {
    const tid = el.getAttribute("data-testid");
    if (tid) return `[data-testid="${CSS.escape(tid)}"]`;
    const cls = [...el.classList].filter(c => !/\d{3,}/.test(c) && !c.startsWith("sai-")).slice(0, 5).map(c => "." + CSS.escape(c)).join("");
    return el.tagName.toLowerCase() + cls;
  };
  const mark = el => { hover && hover.classList.remove("sai-pick"); hover = el; el && el.classList.add("sai-pick"); };
  function stopPick() { picking = false; mark(null); root.querySelector("#sai-toasts").innerHTML = ""; document.body.classList.remove("sai-picking"); }
  $("#sai-pick").onclick = () => {
    picking = true; panel.classList.remove("open"); document.body.classList.add("sai-picking");
    toast("🎯", "Pick mode", { title: "Hover a subagent block, ↑ = parent, click to track, Esc cancels" }, true);
  };
  document.addEventListener("mouseover", e => { if (picking && !root.contains(e.target)) mark(e.target); }, true);
  document.addEventListener("click", e => {
    if (!picking || root.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const el = hover || e.target;
    stopPick();
    const sel = selFor(el), n = countSel(sel);
    if (!custom.includes(sel)) custom.push(sel);
    browser.storage.local.set({ [CUSTOM_KEY]: custom });
    scan(); panel.classList.add("open"); render();
    showMsg(`Tracking <code>${esc(sel)}</code> — matches ${n} element(s) on this page.${n > 30 ? " That is very generic; press ↑ while picking to choose a tighter element." : ""}`);
  }, true);
  document.addEventListener("keydown", e => {
    if (!picking) return;
    if (e.key === "Escape") { stopPick(); e.stopPropagation(); }
    if (e.key === "ArrowUp" && hover && hover.parentElement) { mark(hover.parentElement); e.preventDefault(); }
  }, true);

  function showMsg(html) { $("#sai-detail").innerHTML = `<div class="sai-msg">${html}</div>`; builtId = null; }
  $("#sai-debug").onclick = () => {
    const rows = allSelectors().map(sel => `<tr><td><code>${esc(sel)}</code></td><td>${countSel(sel)}</td></tr>`).join("");
    showMsg(`<h4>Debug</h4>
      <p>Content script is running. Candidate blocks now: <b>${candidates().length}</b> · tracked items: <b>${items.length}</b> · learned selectors: <b>${custom.length}</b></p>
      <table class="sai-dbg"><tr><th>Selector</th><th>Matches</th></tr>${rows}</table>
      <p>If everything is 0, use <b>Pick</b> and click a subagent block on the page.</p>
      <button id="sai-resetsel">Forget learned selectors</button>`);
    $("#sai-resetsel").onclick = () => { custom = []; browser.storage.local.set({ [CUSTOM_KEY]: [] }); $("#sai-debug").click(); };
  };

  // toasts: shown only while the panel is closed
  function toast(icon, label, item, force) {
    if (panel.classList.contains("open") && !force) return;
    const t = document.createElement("div");
    t.className = "sai-toast";
    t.innerHTML = `<b>${icon} ${label}</b><span>${esc(item.title)}</span>`;
    t.onclick = () => { t.remove(); panel.classList.add("open"); select(item.id); };
    root.querySelector("#sai-toasts").append(t);
    setTimeout(() => t.remove(), force ? 6000 : 5000);
  }

  document.addEventListener("keydown", e => {
    if (e.altKey && e.shiftKey && e.code === "KeyI") { toggle(); e.preventDefault(); return; }
    if (picking || !panel.classList.contains("open")) return;
    if (e.key === "Escape") { toggle(); return; }
    if (e.target.closest("input, textarea, [contenteditable]")) { if (e.key === "Escape") e.target.blur(); return; }
    const vis = visible(), idx = vis.findIndex(x => x.id === selectedId), cur = byId(selectedId);
    const act = {
      j: () => vis[idx + 1] && select(vis[idx + 1].id),
      k: () => vis[idx - 1] && select(vis[idx - 1].id),
      p: () => cur && (cur.pinned = !cur.pinned, save(), render()),
      u: () => cur && (cur.read = false, save(), render()),
      x: () => cur && dismiss(cur),
      "/": () => $("#sai-search").focus()
    }[e.key];
    if (act) { act(); e.preventDefault(); }
  }, true);

  browser.storage.local.get([STORE_KEY, DISMISS_KEY, CUSTOM_KEY]).then(r => {
    custom = r[CUSTOM_KEY] || [];
    (r[DISMISS_KEY] || []).forEach(id => dismissed.add(id));
    items = (r[STORE_KEY] || []).map(i => ({ ...i, status: i.status === "running" ? "done" : i.status })); // stale from last page
    render(); scan();
  });
})();
