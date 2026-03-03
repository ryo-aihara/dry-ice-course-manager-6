/* =========================================================
   dry-ice-course-manager vNEXT (相棒保存版)
   app.js  (1/3)
   ---------------------------------------------------------
   SPEC CORE:
   - CSV正式形式: shime_size,25|30 + course,bin,shime,cut
   - bin(1/2)完全分離（混在防止）
   - 切り上げ禁止（floorのみ）
   - 端数はケース+バラ表示
   - 削除は論理削除＆復活可
   - 直近1週のみ保持（週ID=月曜基準、週跨ぎ全削除）
   - 表示モード: card / paper / data
   - グループ: unassigned / A / B / C / D / E / deleted
   - 501-510:60, 601-619:50, 621-648:40 (course×bin)
   - キャリア: 20枚=1ケース floorのみ
   - CSV検証レポート + 重複(course×bin)合算
   ========================================================= */

(() => {
  "use strict";

  /* ---------------------------
     DOM helpers
  ---------------------------- */
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  const dom = {
    pillShime: $("#pillShime"),
    pillBin: $("#pillBin"),
    weekId: $("#weekId"),
    btnResetWeek: $("#btnResetWeek"),
    btnSave: $("#btnSave"),

    dayTabs: $$(".daytab"),
    csvInput: $("#csvInput"),
    btnLoadCsv: $("#btnLoadCsv"),
    btnClearCsv: $("#btnClearCsv"),
    btnCopyResult: $("#btnCopyResult"),
    validationBox: $("#validationBox"),

    segView: $$(".seg__btn[data-view]"),
    segBin: $$(".seg__btn[data-bin]"),
    btnShowDeleted: $("#btnShowDeleted"),

    selCount: $("#selCount"),
    btnSelectAll: $("#btnSelectAll"),
    btnClearSel: $("#btnClearSel"),
    btnAnchor: $("#btnAnchor"),
    btnRange: $("#btnRange"),

    moveBtns: $$('[data-move]'),
    btnDelete: $("#btnDelete"),
    btnRestore: $("#btnRestore"),

    board: $("#board"),
    colDeleted: $("#col_deleted"),
    list: {
      unassigned: $("#list_unassigned"),
      A: $("#list_A"),
      B: $("#list_B"),
      C: $("#list_C"),
      D: $("#list_D"),
      E: $("#list_E"),
      deleted: $("#list_deleted"),
    },
    meta: {
      unassigned: $("#meta_unassigned"),
      A: $("#meta_A"),
      B: $("#meta_B"),
      C: $("#meta_C"),
      D: $("#meta_D"),
      E: $("#meta_E"),
      deleted: $("#meta_deleted"),
    },

    t_case: $("#t_case"),
    t_bara: $("#t_bara"),
    t_ice: $("#t_ice"),
    t_car: $("#t_car"),
    safetyMsg: $("#safetyMsg"),

    toast: $("#toast"),

    dataModal: $("#dataModal"),
    dataText: $("#dataText"),
  };

  /* ---------------------------
     Constants
  ---------------------------- */
  const GROUPS = ["unassigned", "A", "B", "C", "D", "E", "deleted"];
  const DAYS = ["mon","tue","wed","thu","fri"];
  const VIEW = { CARD:"card", PAPER:"paper", DATA:"data" };
  const BIN_FILTER = { ALL:"all", ONE:"1", TWO:"2" };

  const LS_KEY = "dicm_vnext_state";

  /* ---------------------------
     State (single source of truth)
  ---------------------------- */
  const state = {
    weekId: "",                 // monday YYYY-MM-DD
    activeDay: "mon",           // mon..fri
    view: VIEW.CARD,            // card|paper|data
    showDeleted: false,

    // bin filter for DISPLAY. (Operations are guarded to prevent mixing.)
    binFilter: BIN_FILTER.ALL,  // all|1|2

    // shime size: CSV1行目最優先
    shimeFromCsv: null,         // 25|30|null
    shimeSize: null,            // effective base (same as shimeFromCsv)
    lastValidation: { level:"", lines:[] },

    // records: {id, course, bin, shime, cut, group, deleted, createdAt}
    records: [],

    // selection
    selectedIds: new Set(),
    rangeAnchorId: null,
    rangeMode: false,

    // per-day saved snapshots (within same week only)
    savedByDay: {
      mon:null, tue:null, wed:null, thu:null, fri:null
    }
  };

  /* ---------------------------
     Date / Week helpers
  ---------------------------- */
  const pad2 = (n) => String(n).padStart(2, "0");

  function toYMD(d){
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }

  function mondayOf(date){
    const d = new Date(date);
    d.setHours(0,0,0,0);
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = (day === 0) ? -6 : (1 - day);
    d.setDate(d.getDate() + diff);
    return d;
  }

  function calcWeekId(now=new Date()){
    return toYMD(mondayOf(now));
  }

  /* ---------------------------
     Toast
  ---------------------------- */
  let toastTimer = null;
  function toast(msg, ms=1500){
    if(!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove("show"), ms);
  }

  /* ---------------------------
     Safe parsing
  ---------------------------- */
  function asInt(v, fallback=0){
    const n = Number.parseInt(String(v ?? "").trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function isCourseValid(courseStr){
    return /^\d+$/.test(String(courseStr ?? "").trim());
  }

  function makeId(){
    return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  }

  /* ---------------------------
     Cooling fixed logic
  ---------------------------- */
  function coolingSheets(course){
    const c = Number(course);
    if (c >= 501 && c <= 510) return 60;
    if (c >= 601 && c <= 619) return 50;
    if (c >= 621 && c <= 648) return 40;
    return 0;
  }

  function coolingCarrierCasesFromSheets(sheets){
    // 20枚=1ケース、floorのみ（切り上げ禁止）
    return Math.floor((sheets || 0) / 20);
  }

  /* ---------------------------
     Dry-ice calc (NO CEIL)
  ---------------------------- */
  function calcDryIce(shime, cut, base){
    const total = (shime * base) + cut;
    const cases = Math.floor(total / base);
    const bara = total % base;
    return { total, cases, bara };
  }

  /* ---------------------------
     Storage (week-only)
  ---------------------------- */
  function loadFromStorage(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if(!raw) return null;
      return JSON.parse(raw);
    }catch{
      return null;
    }
  }

  function saveToStorage(){
    const payload = {
      weekId: state.weekId,
      activeDay: state.activeDay,
      view: state.view,
      showDeleted: state.showDeleted,
      binFilter: state.binFilter,
      shimeFromCsv: state.shimeFromCsv,
      shimeSize: state.shimeSize,
      records: state.records,
      savedByDay: state.savedByDay
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  }

  function resetStorageAll(){
    localStorage.removeItem(LS_KEY);
  }

  function enforceWeekGuard(){
    const nowWeek = calcWeekId(new Date());
    const stored = loadFromStorage();
    if(!stored){
      state.weekId = nowWeek;
      return;
    }
    if(stored.weekId !== nowWeek){
      // week crossed -> delete everything
      resetStorageAll();
      state.weekId = nowWeek;
      state.records = [];
      state.selectedIds.clear();
      state.rangeAnchorId = null;
      state.rangeMode = false;
      state.savedByDay = { mon:null, tue:null, wed:null, thu:null, fri:null };
      state.shimeFromCsv = null;
      state.shimeSize = null;
      state.lastValidation = { level:"warn", lines:[`週が変わったので全削除しました（${stored.weekId} → ${nowWeek}）`] };
      toast("週が変わったためデータを全削除しました", 2200);
      return;
    }

    // hydrate
    state.weekId = stored.weekId || nowWeek;
    state.activeDay = stored.activeDay || "mon";
    state.view = stored.view || VIEW.CARD;
    state.showDeleted = !!stored.showDeleted;
    state.binFilter = stored.binFilter || BIN_FILTER.ALL;
    state.shimeFromCsv = stored.shimeFromCsv ?? null;
    state.shimeSize = stored.shimeSize ?? stored.shimeFromCsv ?? null;
    state.records = Array.isArray(stored.records) ? stored.records : [];
    state.savedByDay = stored.savedByDay || { mon:null, tue:null, wed:null, thu:null, fri:null };

    // never persist selection
    state.selectedIds = new Set();
    state.rangeAnchorId = null;
    state.rangeMode = false;
  }

  /* ---------------------------
     CSV parse + validate + merge duplicates
     - control format (no quoted commas)
  ---------------------------- */
  function splitCsvLine(line){
    return String(line ?? "").split(",").map(s => s.trim());
  }

  function parseCsv(text){
    const linesRaw = String(text ?? "")
      .replace(/\r\n/g,"\n").replace(/\r/g,"\n")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const report = [];
    const errs = [];
    const warns = [];
    let shimeFrom = null;

    if(linesRaw.length === 0){
      return { ok:false, shimeFrom:null, records:[], reportLines:["CSVが空です"], level:"err" };
    }

    // find shime_size line (prefer line1, but accept within first 3)
    for(let i=0;i<Math.min(3, linesRaw.length);i++){
      const cols = splitCsvLine(linesRaw[i]);
      if((cols[0] || "").toLowerCase() === "shime_size"){
        const v = asInt(cols[1], 0);
        if(v === 25 || v === 30){
          shimeFrom = v;
          report.push(`OK: shime_size=${v}`);
        }else{
          errs.push(`NG: shime_size は 25 or 30（値=${cols[1] ?? ""}）`);
        }
      }
    }

    // find header line
    let headerIdx = -1;
    for(let i=0;i<linesRaw.length;i++){
      const cols = splitCsvLine(linesRaw[i]).map(c => c.toLowerCase());
      if(cols.includes("course") && cols.includes("bin") && cols.includes("shime") && cols.includes("cut")){
        headerIdx = i;
        break;
      }
    }
    if(headerIdx < 0){
      errs.push("NG: ヘッダー course,bin,shime,cut が見つかりません");
      return { ok:false, shimeFrom, records:[], reportLines:[...report, ...errs], level:"err" };
    }

    const header = splitCsvLine(linesRaw[headerIdx]).map(s => s.toLowerCase());
    const iCourse = header.indexOf("course");
    const iBin = header.indexOf("bin");
    const iShime = header.indexOf("shime");
    const iCut = header.indexOf("cut");

    const temp = [];
    let read = 0;

    for(let i=headerIdx+1;i<linesRaw.length;i++){
      const row = linesRaw[i];
      if(row.startsWith("#")) continue;

      const cols = splitCsvLine(row);
      read++;

      const course = (cols[iCourse] ?? "").trim();
      const bin = asInt(cols[iBin], NaN);
      const shime = asInt(cols[iShime], 0);
      const cut = asInt(cols[iCut], 0);

      const tag = `L${i+1}`;

      if(!course || !isCourseValid(course)){
        errs.push(`NG ${tag}: course が不正（${course || "空"}）`);
        continue;
      }
      if(!(bin === 1 || bin === 2)){
        errs.push(`NG ${tag}: bin は 1 or 2（${cols[iBin] ?? ""}）`);
        continue;
      }
      if(shime < 0 || cut < 0){
        errs.push(`NG ${tag}: shime/cut マイナス禁止（shime=${shime}, cut=${cut}）`);
        continue;
      }

      // warn heuristics (safe)
      if(shime >= 5) warns.push(`WARN ${tag}: shime が大きい（${shime}）`);

      temp.push({
        id: makeId(),
        course,
        bin,
        shime,
        cut,
        group: "unassigned",
        deleted: false,
        createdAt: Date.now()
      });
    }

    report.push(`読み取り: ${read} 行`);
    report.push(`採用: ${temp.length} 行 / NG: ${errs.length} 行`);

    // merge duplicates course×bin
    const mergedInfo = [];
    const merged = mergeDuplicates(temp, mergedInfo);
    if(mergedInfo.length){
      mergedInfo.forEach(m => warns.push(`MERGE: ${m}`));
      report.push(`重複合算: ${mergedInfo.length} 件（course×bin）`);
    }

    // cut limit warning if base known
    if(shimeFrom === 25 || shimeFrom === 30){
      merged.forEach(r => {
        if(r.cut >= shimeFrom) warns.push(`WARN: course ${r.course} bin${r.bin} cut=${r.cut} が基準(${shimeFrom})以上`);
      });
    }else{
      warns.push("WARN: shime_size 未確定のため cut上限チェック未実施");
    }

    if(merged.length === 0) errs.push("NG: 有効なデータ行がありません");

    const ok = errs.length === 0 && merged.length > 0;

    const out = [];
    out.push("==== CSV検証レポート ====");
    out.push(...report);
    out.push(`基準（CSV）: ${shimeFrom === 25 || shimeFrom === 30 ? shimeFrom : "未確定"}`);
    if(errs.length){
      out.push("");
      out.push("---- エラー ----");
      out.push(...errs);
    }
    if(warns.length){
      out.push("");
      out.push("---- 警告 ----");
      out.push(...warns);
    }
    out.push("");
    out.push(`OK判定: ${ok ? "OK" : "NG"}`);

    const level = errs.length ? "err" : (warns.length ? "warn" : "ok");
    return { ok, shimeFrom, records: merged, reportLines: out, level };
  }

  function mergeDuplicates(rows, mergedInfoOut){
    const map = new Map(); // key -> record
    const count = new Map();

    for(const r of rows){
      const key = `${r.course}__${r.bin}`;
      if(!map.has(key)){
        map.set(key, { ...r });
        count.set(key, 1);
      }else{
        const base = map.get(key);
        base.shime += r.shime;
        base.cut += r.cut;
        map.set(key, base);
        count.set(key, (count.get(key) || 1) + 1);
      }
    }

    for(const [key, n] of count.entries()){
      if(n > 1){
        const [course, bin] = key.split("__");
        mergedInfoOut.push(`${course} bin${bin}（${n}行）を合算`);
      }
    }

    return Array.from(map.values()).sort((a,b) => Number(a.course) - Number(b.course) || a.bin - b.bin);
  }

  /* ---------------------------
     Validation UI helper
  ---------------------------- */
  function setValidation(level, lines){
    state.lastValidation = { level, lines };
    const box = dom.validationBox;
    if(!box) return;

    box.classList.remove("is-ok","is-warn","is-err");
    if(level === "ok") box.classList.add("is-ok");
    if(level === "warn") box.classList.add("is-warn");
    if(level === "err") box.classList.add("is-err");

    box.innerHTML = "";
    const ul = document.createElement("ul");
    ul.style.margin = "0";
    ul.style.paddingLeft = "18px";
    ul.style.lineHeight = "1.35";
    ul.style.color = "inherit";
    (lines || []).slice(0, 200).forEach(line => {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  /* ---------------------------
     Rendering (header/footer basics)
     (lists + interactions are in 2/3)
  ---------------------------- */
  function setBodyMode(){
    document.body.classList.remove("paper","data");
    if(state.view === VIEW.PAPER) document.body.classList.add("paper");
    if(state.view === VIEW.DATA) document.body.classList.add("data");
  }

  function updatePills(){
    // shime
    const base = state.shimeFromCsv;
    dom.pillShime.classList.remove("pill--25","pill--30");
    if(base === 25){
      dom.pillShime.textContent = "shime_size: 25";
      dom.pillShime.classList.add("pill--25");
    }else if(base === 30){
      dom.pillShime.textContent = "shime_size: 30";
      dom.pillShime.classList.add("pill--30");
    }else{
      dom.pillShime.textContent = "shime_size: ?";
    }

    // bin filter pill
    const bf = state.binFilter;
    dom.pillBin.textContent = (bf === "1") ? "bin: 1便" : (bf === "2") ? "bin: 2便" : "bin: ALL";
  }

  function updateWeek(){
    dom.weekId.textContent = state.weekId || "----";
  }

  function markActiveDay(){
    dom.dayTabs.forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.day === state.activeDay);
    });
  }

  function markSegButtons(){
    dom.segView.forEach(btn => btn.classList.toggle("is-active", btn.dataset.view === state.view));
    dom.segBin.forEach(btn => btn.classList.toggle("is-active", btn.dataset.bin === state.binFilter));
  }

  /* ---------------------------
     Public render entry
  ---------------------------- */
  function render(){
    setBodyMode();
    updateWeek();
    markActiveDay();
    markSegButtons();
    updatePills();

    // deleted column toggle
    if(dom.colDeleted){
      dom.colDeleted.style.display = state.showDeleted ? "flex" : "none";
    }

    // selection count
    dom.selCount.textContent = String(state.selectedIds.size);

    // validation box restore
    setValidation(state.lastValidation.level || "", state.lastValidation.lines || []);

    // totals + board lists will be in 2/3
  }

  /* ---------------------------
     Data export (DATA modal uses in 2/3)
     - build results text used by コピー
  ---------------------------- */
  function buildResultsText(){
    const base = state.shimeFromCsv;
    if(!(base === 25 || base === 30)){
      return "基準(shime_size)が未確定です。\nCSV 1行目 shime_size,25/30 を確認してください。";
    }

    const now = new Date();
    const lines = [];
    lines.push(`# dry-ice-course-manager vNEXT`);
    lines.push(`weekId(monday)=${state.weekId}`);
    lines.push(`day=${state.activeDay}`);
    lines.push(`shime_size=${base}`);
    lines.push(`binFilter=${state.binFilter}`);
    lines.push("");
    lines.push("course,bin,shime,cut,totalPieces,cases,bara,coolSheets,coolCarrierCases,group,deleted");

    const recs = getVisibleRecords({ includeDeleted:true, ignoreGroup:false })
      .sort((a,b)=> Number(a.course)-Number(b.course) || a.bin-b.bin);

    recs.forEach(r => {
      const dry = calcDryIce(r.shime, r.cut, base);
      const cool = coolingSheets(r.course);
      const car = coolingCarrierCasesFromSheets(cool);
      lines.push([
        r.course, r.bin, r.shime, r.cut,
        dry.total, dry.cases, dry.bara,
        cool, car,
        r.deleted ? "deleted" : r.group,
        r.deleted ? 1 : 0
      ].join(","));
    });

    // totals (visible only, non-deleted)
    const totals = calcTotalsVisible();
    lines.push("");
    lines.push(`TOTAL_CASES=${totals.case}`);
    lines.push(`TOTAL_BARA=${totals.bara}`);
    lines.push(`TOTAL_COOL_SHEETS=${totals.coolSheets}`);
    lines.push(`TOTAL_COOL_CARRIER_CASES=${totals.coolCarrier}`);

    return lines.join("\n");
  }

  /* ---------------------------
     Visible record selector
     - respects binFilter + showDeleted (for board)
  ---------------------------- */
  function getVisibleRecords({ includeDeleted=false } = {}){
    const bf = state.binFilter;
    return state.records.filter(r => {
      if(!includeDeleted && r.deleted) return false;
      if(bf === "1" && r.bin !== 1) return false;
      if(bf === "2" && r.bin !== 2) return false;
      return true;
    });
  }

  function calcTotalsVisible(){
    const base = state.shimeFromCsv;
    const res = { case:0, bara:0, coolSheets:0, coolCarrier:0, totalPieces:0 };
    if(!(base === 25 || base === 30)) return res;

    let totalPieces = 0;
    let coolSheets = 0;

    getVisibleRecords({ includeDeleted:false }).forEach(r => {
      const dry = calcDryIce(r.shime, r.cut, base);
      totalPieces += dry.total;
      coolSheets += coolingSheets(r.course);
    });

    res.totalPieces = totalPieces;
    res.case = Math.floor(totalPieces / base);
    res.bara = totalPieces % base;
    res.coolSheets = coolSheets;
    res.coolCarrier = coolingCarrierCasesFromSheets(coolSheets);
    return res;
  }

  /* =========================================================
     END of app.js (1/3)
     Next: app.js (2/3) -> rendering lists + selection/move/delete + events
     ========================================================= */
 /* =========================================================
   app.js (2/3)
   - Board rendering (items)
   - Selection / range select
   - Group move / delete / restore
   - Bin mix-guard for operations
   - View switch + DATA modal open/close
   ========================================================= */

/* ---------------------------
   Item render (card/paper)
---------------------------- */
function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

function itemTagBin(bin){
  return bin === 1 ? "tag tag--bin1" : "tag tag--bin2";
}

function renderBoard(){
  // clear all lists
  GROUPS.forEach(g => {
    const el = dom.list[g];
    if(el) el.innerHTML = "";
    if(dom.meta[g]) dom.meta[g].textContent = "0";
  });

  // if base unknown, still show items (but calc shows "?")
  const base = state.shimeFromCsv;

  // group visible records (board respects showDeleted toggle)
  const includeDeletedInBoard = state.showDeleted; // only then render deleted column contents
  const visible = state.records.filter(r => {
    // bin filter
    if(state.binFilter === "1" && r.bin !== 1) return false;
    if(state.binFilter === "2" && r.bin !== 2) return false;
    // deleted
    if(r.deleted && !includeDeletedInBoard) return false;
    return true;
  });

  const buckets = new Map(GROUPS.map(g => [g, []]));
  visible.forEach(r => {
    const g = r.deleted ? "deleted" : (GROUPS.includes(r.group) ? r.group : "unassigned");
    buckets.get(g).push(r);
  });

  // sort each group by course
  for(const g of GROUPS){
    const arr = buckets.get(g);
    arr.sort((a,b)=> Number(a.course)-Number(b.course) || a.bin-b.bin);
    const listEl = dom.list[g];
    if(!listEl) continue;

    // meta count
    if(dom.meta[g]) dom.meta[g].textContent = String(arr.length);

    arr.forEach(r => {
      const node = renderItem(r, base);
      listEl.appendChild(node);
    });
  }

  // totals footer
  const t = calcTotalsVisible();
  dom.t_case.textContent = String(t.case);
  dom.t_bara.textContent = String(t.bara);
  dom.t_ice.textContent = String(t.coolSheets);
  dom.t_car.textContent = String(t.coolCarrier);

  // safety message
  dom.safetyMsg.textContent =
    (state.binFilter === "all")
      ? "切り上げ禁止 / 便分離（ALL表示は注意）"
      : `切り上げ禁止 / ${state.binFilter}便フィルタ中（混在防止）`;
}

function renderItem(r, base){
  const div = document.createElement("div");
  div.className = "item";
  div.dataset.id = r.id;

  if(state.selectedIds.has(r.id)) div.classList.add("is-selected");
  if(r.deleted) div.classList.add("is-deleted");

  const dry = (base === 25 || base === 30) ? calcDryIce(r.shime, r.cut, base) : null;
  const coolSheets = coolingSheets(r.course);
  const coolCarrier = coolingCarrierCasesFromSheets(coolSheets);

  const top = document.createElement("div");
  top.className = "item__top";
  top.innerHTML = `
    <div class="item__title">${esc(r.course)}</div>
    <div class="item__meta">
      <span class="${itemTagBin(r.bin)}">bin${r.bin}</span>
      <span class="tag">〆:${esc(r.shime)}</span>
      <span class="tag">cut:${esc(r.cut)}</span>
      ${r.deleted ? `<span class="tag tag--del">DELETED</span>` : ``}
    </div>
  `;

  const grid = document.createElement("div");
  grid.className = "item__grid";

  // Dry-ice display: cases + bara
  const dryText = dry ? `${dry.cases} ケース + ${dry.bara} バラ` : `基準?`;
  const piecesText = dry ? `${dry.total}` : `?`;

  grid.innerHTML = `
    <div class="kv">
      <div class="kv__k">総個数</div>
      <div class="kv__v">${esc(piecesText)} <small>(基準: ${esc(base ?? "?")})</small></div>
    </div>
    <div class="kv">
      <div class="kv__k">ケース + バラ</div>
      <div class="kv__v">${esc(dryText)}</div>
    </div>
    <div class="kv">
      <div class="kv__k">蓄冷材</div>
      <div class="kv__v">${esc(coolSheets)} 枚</div>
    </div>
    <div class="kv">
      <div class="kv__k">キャリア（floor）</div>
      <div class="kv__v">${esc(coolCarrier)} ケース</div>
    </div>
  `;

  // small buttons (tap-friendly)
  const footer = document.createElement("div");
  footer.className = "item__footer";
  footer.innerHTML = `
    <button class="mini mini--select" type="button" data-act="toggleSel">選択</button>
    ${r.deleted
      ? `<button class="mini" type="button" data-act="restoreOne">復活</button>`
      : `<button class="mini mini--del" type="button" data-act="deleteOne">削除</button>`
    }
  `;

  div.appendChild(top);
  div.appendChild(grid);
  div.appendChild(footer);

  // warnings inside item (no ceil / cut warning)
  if((base === 25 || base === 30) && r.cut >= base){
    const w = document.createElement("div");
    w.style.marginTop = "8px";
    w.style.fontSize = "12px";
    w.style.fontWeight = "900";
    w.style.color = "rgba(120,53,15,0.95)";
    w.textContent = `⚠ cut=${r.cut} が基準(${base})以上（要確認）`;
    div.appendChild(w);
  }

  return div;
}

/* ---------------------------
   Selection / Range selection
---------------------------- */
function clearSelection(){
  state.selectedIds.clear();
  state.rangeAnchorId = null;
  render();
  renderBoard();
  saveToStorage();
}

function selectAllVisible(){
  const visibleIds = getVisibleRecords({ includeDeleted: state.showDeleted }).map(r => r.id);
  visibleIds.forEach(id => state.selectedIds.add(id));
  render();
  renderBoard();
  saveToStorage();
}

function toggleSelection(id){
  if(state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
}

function setRangeAnchor(){
  if(state.selectedIds.size === 0){
    toast("起点にするため、まず1件選択して");
    return;
  }
  // pick last selected as anchor (deterministic by iteration)
  const last = Array.from(state.selectedIds).slice(-1)[0];
  state.rangeAnchorId = last;
  toast("範囲起点をセット");
  render();
  renderBoard();
  saveToStorage();
}

function applyRangeSelect(toId){
  const anchorId = state.rangeAnchorId;
  if(!anchorId){
    toast("範囲起点が未設定");
    return;
  }
  const anchor = state.records.find(r => r.id === anchorId);
  const target = state.records.find(r => r.id === toId);
  if(!anchor || !target){
    toast("範囲選択に失敗");
    return;
  }

  // must be in same bucket (same group/deleted) and visible under binFilter
  const aGroup = anchor.deleted ? "deleted" : anchor.group;
  const tGroup = target.deleted ? "deleted" : target.group;
  if(aGroup !== tGroup){
    toast("範囲選択は同じ棚内のみ");
    return;
  }
  if(state.binFilter === "1" && (anchor.bin !== 1 || target.bin !== 1)){
    toast("範囲選択は 1便フィルタ中のみ有効");
    return;
  }
  if(state.binFilter === "2" && (anchor.bin !== 2 || target.bin !== 2)){
    toast("範囲選択は 2便フィルタ中のみ有効");
    return;
  }

  // build ordered list of the bucket in current filter
  const list = state.records
    .filter(r => {
      if(state.binFilter === "1" && r.bin !== 1) return false;
      if(state.binFilter === "2" && r.bin !== 2) return false;
      const g = r.deleted ? "deleted" : r.group;
      return g === aGroup;
    })
    .sort((x,y)=> Number(x.course)-Number(y.course) || x.bin-y.bin);

  const i1 = list.findIndex(r => r.id === anchorId);
  const i2 = list.findIndex(r => r.id === toId);
  if(i1 < 0 || i2 < 0){
    toast("範囲選択に失敗（index）");
    return;
  }
  const s = Math.min(i1,i2);
  const e = Math.max(i1,i2);
  for(let i=s;i<=e;i++){
    state.selectedIds.add(list[i].id);
  }
  toast(`範囲選択：${e-s+1}件`);
  render();
  renderBoard();
  saveToStorage();
}

/* ---------------------------
   Bin mix guard for operations
   - if binFilter is ALL, forbid move/delete/restore (accident prevention)
---------------------------- */
function requireSingleBinForOps(){
  if(state.binFilter === BIN_FILTER.ALL){
    toast("事故防止：操作は 1便/2便 フィルタ中のみ可能");
    return false;
  }
  return true;
}

function filteredBinNumber(){
  return state.binFilter === "1" ? 1 : (state.binFilter === "2" ? 2 : null);
}

/* ---------------------------
   Move / Delete / Restore (batch)
---------------------------- */
function moveSelectedTo(group){
  if(!requireSingleBinForOps()) return;
  const bin = filteredBinNumber();
  if(!bin) return;

  const ids = Array.from(state.selectedIds);
  if(ids.length === 0){
    toast("選択がない");
    return;
  }
  let moved = 0;
  ids.forEach(id => {
    const r = state.records.find(x => x.id === id);
    if(!r) return;
    if(r.bin !== bin) return;         // strong guard
    if(r.deleted) return;             // deleted can't move unless restored
    if(group === "deleted") return;
    r.group = group;
    moved++;
  });
  toast(`${moved}件 移動`);
  renderBoard();
  saveToStorage();
}

function deleteSelected(){
  if(!requireSingleBinForOps()) return;
  const bin = filteredBinNumber();
  const ids = Array.from(state.selectedIds);
  if(ids.length === 0){
    toast("選択がない");
    return;
  }
  let n = 0;
  ids.forEach(id => {
    const r = state.records.find(x => x.id === id);
    if(!r) return;
    if(r.bin !== bin) return;
    if(r.deleted) return;
    r.deleted = true;
    r.group = "deleted";
    n++;
  });
  toast(`削除（復活可）: ${n}件`);
  renderBoard();
  saveToStorage();
}

function restoreSelected(){
  if(!requireSingleBinForOps()) return;
  const bin = filteredBinNumber();
  const ids = Array.from(state.selectedIds);
  if(ids.length === 0){
    toast("選択がない");
    return;
  }
  let n = 0;
  ids.forEach(id => {
    const r = state.records.find(x => x.id === id);
    if(!r) return;
    if(r.bin !== bin) return;
    if(!r.deleted) return;
    r.deleted = false;
    r.group = "unassigned"; // safe default
    n++;
  });
  toast(`復活: ${n}件（未振分へ）`);
  renderBoard();
  saveToStorage();
}

/* ---------------------------
   Single-item actions
---------------------------- */
function deleteOne(id){
  if(!requireSingleBinForOps()) return;
  const bin = filteredBinNumber();
  const r = state.records.find(x => x.id === id);
  if(!r || r.bin !== bin) return;
  if(r.deleted) return;
  r.deleted = true;
  r.group = "deleted";
  toast(`削除: ${r.course} bin${r.bin}`);
  renderBoard();
  saveToStorage();
}

function restoreOne(id){
  if(!requireSingleBinForOps()) return;
  const bin = filteredBinNumber();
  const r = state.records.find(x => x.id === id);
  if(!r || r.bin !== bin) return;
  if(!r.deleted) return;
  r.deleted = false;
  r.group = "unassigned";
  toast(`復活: ${r.course} bin${r.bin}`);
  renderBoard();
  saveToStorage();
}

/* ---------------------------
   DATA modal
---------------------------- */
function openDataModal(){
  dom.dataText.textContent = buildResultsText();
  dom.dataModal.setAttribute("aria-hidden","false");
}
function closeDataModal(){
  dom.dataModal.setAttribute("aria-hidden","true");
}

/* ---------------------------
   View & filters
---------------------------- */
function setView(v){
  state.view = v;
  if(v === VIEW.DATA){
    openDataModal();
  }else{
    closeDataModal();
  }
  render();
  renderBoard();
  saveToStorage();
}

function setBinFilter(b){
  state.binFilter = b;
  // leaving ALL should clear selection to reduce confusion
  if(b === BIN_FILTER.ALL){
    state.selectedIds.clear();
    state.rangeAnchorId = null;
  }else{
    // also clear selection to avoid cross-bin leftovers
    state.selectedIds.clear();
    state.rangeAnchorId = null;
  }
  render();
  renderBoard();
  saveToStorage();
}

/* =========================================================
   END of app.js (2/3)
   Next: app.js (3/3) -> events, save/load day, CSV import, init
   ========================================================= */
 /* =========================================================
   app.js (3/3)
   - Day save/load (mon-fri)
   - CSV import (replace data)
   - Event bindings (NO bind漏れ)
   - Init
   ========================================================= */

/* ---------------------------
   Day save/load (mon-fri)
---------------------------- */
function snapshot(){
  return {
    ts: Date.now(),
    shimeFromCsv: state.shimeFromCsv,
    shimeSize: state.shimeSize,
    records: state.records
  };
}

function restoreSnapshot(snap){
  if(!snap) return false;
  state.shimeFromCsv = snap.shimeFromCsv ?? null;
  state.shimeSize = snap.shimeSize ?? snap.shimeFromCsv ?? null;
  state.records = Array.isArray(snap.records) ? snap.records : [];
  state.selectedIds.clear();
  state.rangeAnchorId = null;
  state.rangeMode = false;
  return true;
}

function saveDay(){
  if(!DAYS.includes(state.activeDay)){
    toast("保存は月〜金のみ（仕様）");
    return;
  }
  state.savedByDay[state.activeDay] = snapshot();
  toast(`${state.activeDay.toUpperCase()} 保存`);
  saveToStorage();
  render();
  renderBoard();
}

function loadDay(day){
  if(!DAYS.includes(day)) return;
  state.activeDay = day;

  const snap = state.savedByDay[day];
  if(snap){
    restoreSnapshot(snap);
    toast(`${day.toUpperCase()} を復元`);
    // NOTE: binFilter/view/showDeleted keep as current
  }else{
    // empty day means keep current data? safer: clear for that day
    state.records = [];
    state.selectedIds.clear();
    state.rangeAnchorId = null;
    toast(`${day.toUpperCase()} は未保存（空）`);
  }

  saveToStorage();
  render();
  renderBoard();
}

/* ---------------------------
   Week reset (manual)
---------------------------- */
function resetWeek(){
  const ok = confirm("週リセットします。\nこの端末内の今週データは全削除されます。\nよろしいですか？");
  if(!ok) return;

  resetStorageAll();

  state.weekId = calcWeekId(new Date());
  state.records = [];
  state.selectedIds.clear();
  state.rangeAnchorId = null;
  state.rangeMode = false;
  state.savedByDay = { mon:null, tue:null, wed:null, thu:null, fri:null };
  state.shimeFromCsv = null;
  state.shimeSize = null;
  state.binFilter = BIN_FILTER.ALL;
  state.showDeleted = false;

  setValidation("warn", ["週リセットしました。CSVを読み込んでください。"]);
  toast("週リセット完了", 1800);
  saveToStorage();
  render();
  renderBoard();
}

/* ---------------------------
   CSV Import
   - SAFETY: import replaces ALL records (both bins)
   - avoids stale mix.
---------------------------- */
function importCsv(){
  const text = dom.csvInput.value || "";
  const res = parseCsv(text);

  setValidation(res.level, res.reportLines);

  if(!res.ok){
    toast("CSV NG：レポート確認", 2000);
    saveToStorage();
    return;
  }

  // CSV1行目が最優先（仕様）
  state.shimeFromCsv = res.shimeFrom;
  state.shimeSize = res.shimeFrom;

  // Replace all records to prevent stale mix (safe)
  state.records = res.records;

  // reset selection
  state.selectedIds.clear();
  state.rangeAnchorId = null;
  state.rangeMode = false;

  toast("CSV 読込OK（重複は合算済み）", 2000);
  saveToStorage();
  render();
  renderBoard();
}

/* ---------------------------
   Copy result
---------------------------- */
async function copyResult(){
  try{
    const txt = buildResultsText();
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(txt);
    }else{
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    toast("結果コピーOK");
  }catch{
    toast("コピー失敗");
  }
}

/* ---------------------------
   Clear CSV textarea
---------------------------- */
function clearCsvBox(){
  dom.csvInput.value = "";
  toast("クリア");
}

/* ---------------------------
   Deleted column toggle
---------------------------- */
function toggleDeleted(){
  state.showDeleted = !state.showDeleted;
  toast(state.showDeleted ? "削除棚 表示" : "削除棚 非表示");
  saveToStorage();
  render();
  renderBoard();
}

/* ---------------------------
   Click delegation for item actions
---------------------------- */
function handleBoardClick(e){
  const item = e.target.closest(".item");
  if(!item) return;
  const id = item.dataset.id;
  if(!id) return;

  const act = e.target?.dataset?.act;
  if(act === "toggleSel"){
    // select toggle always allowed (even ALL filter)
    toggleSelection(id);
    dom.selCount.textContent = String(state.selectedIds.size);
    // just rerender the item highlight by full redraw (safe)
    renderBoard();
    saveToStorage();
    return;
  }
  if(act === "deleteOne"){
    deleteOne(id);
    return;
  }
  if(act === "restoreOne"){
    restoreOne(id);
    return;
  }

  // tap on card itself toggles selection (one-tap)
  toggleSelection(id);
  dom.selCount.textContent = String(state.selectedIds.size);
  renderBoard();
  saveToStorage();
}

/* ---------------------------
   Range select behavior
---------------------------- */
function toggleRangeMode(){
  state.rangeMode = !state.rangeMode;
  toast(state.rangeMode ? "範囲選択 ON（起点→終点）" : "範囲選択 OFF");
  saveToStorage();
}

function handleBoardTapForRange(e){
  if(!state.rangeMode) return false;

  const item = e.target.closest(".item");
  if(!item) return false;
  const id = item.dataset.id;
  if(!id) return false;

  // range mode requires single-bin filter for safety (to avoid accidental spanning)
  if(!requireSingleBinForOps()) return true;

  // If no anchor, use current tap as anchor and select it
  if(!state.rangeAnchorId){
    state.rangeAnchorId = id;
    state.selectedIds.add(id);
    toast("範囲起点セット");
    render();
    renderBoard();
    saveToStorage();
    return true;
  }

  // apply range and keep rangeMode on
  applyRangeSelect(id);
  return true;
}

/* ---------------------------
   Modal close (DATA view)
---------------------------- */
function bindModalClose(){
  dom.dataModal.addEventListener("click", (e) => {
    if(e.target?.dataset?.close){
      closeDataModal();
      // return to card view when closing modal (safe default)
      state.view = VIEW.CARD;
      render();
      renderBoard();
      saveToStorage();
    }
  });
}

/* ---------------------------
   Event bindings (慎重・漏れなし)
---------------------------- */
function bindEvents(){
  // week reset
  dom.btnResetWeek.addEventListener("click", resetWeek);

  // day tabs
  dom.dayTabs.forEach(btn => {
    btn.addEventListener("click", () => {
      loadDay(btn.dataset.day);
    });
  });

  // save
  dom.btnSave.addEventListener("click", saveDay);

  // CSV load/clear/copy
  dom.btnLoadCsv.addEventListener("click", importCsv);
  dom.btnClearCsv.addEventListener("click", clearCsvBox);
  dom.btnCopyResult.addEventListener("click", copyResult);

  // view seg
  dom.segView.forEach(btn => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  // bin filter seg
  dom.segBin.forEach(btn => {
    btn.addEventListener("click", () => setBinFilter(btn.dataset.bin));
  });

  // deleted toggle
  dom.btnShowDeleted.addEventListener("click", toggleDeleted);

  // selection buttons
  dom.btnSelectAll.addEventListener("click", selectAllVisible);
  dom.btnClearSel.addEventListener("click", clearSelection);

  // range controls
  dom.btnAnchor.addEventListener("click", setRangeAnchor);
  dom.btnRange.addEventListener("click", toggleRangeMode);

  // move buttons (batch)
  dom.moveBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const g = btn.dataset.move;
      if(!g) return;
      moveSelectedTo(g);
    });
  });

  // delete/restore batch
  dom.btnDelete.addEventListener("click", deleteSelected);
  dom.btnRestore.addEventListener("click", restoreSelected);

  // board delegation
  dom.board.addEventListener("click", (e) => {
    // range mode takes priority
    if(handleBoardTapForRange(e)) return;
    handleBoardClick(e);
  });

  // modal close
  bindModalClose();
}

/* ---------------------------
   Init
---------------------------- */
function init(){
  // week guard
  enforceWeekGuard();
  if(!state.weekId) state.weekId = calcWeekId(new Date());

  // default active day: if today is mon-fri use it, else keep stored or mon
  const dow = new Date().getDay(); // 0 Sun..6 Sat
  const map = { 1:"mon", 2:"tue", 3:"wed", 4:"thu", 5:"fri" };
  const todayKey = map[dow];
  if(todayKey && !state.savedByDay[state.activeDay]){
    // keep stored activeDay if already set; else set to today
    state.activeDay = state.activeDay || todayKey;
  }

  // restore validation message
  if(!state.lastValidation?.lines?.length){
    setValidation("warn", ["CSVを貼り付けて「CSV読込」を押してください。"]);
  }else{
    setValidation(state.lastValidation.level, state.lastValidation.lines);
  }

  // bind then first render
  bindEvents();
  render();
  renderBoard();
  saveToStorage();
}

init();

/* =========================================================
   END of app.js (3/3)  完成
   ========================================================= */
})();
