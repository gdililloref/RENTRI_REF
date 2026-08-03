/* app.js — RENTRI Esploratore dati: decodifica, motore di query, stato, UI */

const DATASET_LABELS = { A: "Rifiuti prodotti", B: "Materiali End of Waste", C: "Rifiuti trattati", D: "Operatori e unità locali" };

const DIMS_BY_DATASET = {
  A: [["region", "Regione"], ["prov", "Provincia"], ["anno", "Anno"], ["eerChapter", "Capitolo EER"], ["eerCode", "Codice EER"], ["haz", "Pericolosità"]],
  B: [["region", "Regione"], ["prov", "Provincia"], ["anno", "Anno"], ["mat", "Materiale"]],
  C: [["region", "Regione"], ["prov", "Provincia"], ["anno", "Anno"], ["eerChapter", "Capitolo EER"], ["eerCode", "Codice EER"], ["haz", "Pericolosità"], ["att", "Attività R/D"], ["tipo", "Tipo operazione"]],
  D: [["prov", "Provincia"], ["region", "Regione"]],
};

const D_MEASURE_LABELS = {
  "Numero operatori iscritti": "N. operatori iscritti",
  "Numero unita locali iscritte": "N. unità locali iscritte",
  "di cui Produttore": "di cui Produttore",
  "di cui Trasportatore": "di cui Trasportatore",
  "di cui Intermediario senza detenzione": "di cui Intermediario",
  "di cui Recuperatore": "di cui Recuperatore",
  "di cui Smaltitore": "di cui Smaltitore",
  "di cui Centro di raccolta": "di cui Centro di raccolta",
};

let DATA = null;
let GEO = { regionCentroids: {}, provinceCentroids: {} };
let echartInstance = null;
let lastExportPayload = null;

const state = {
  dataset: "A",
  view: "chart",
  chartType: "map",
  chartCategory: "territorio",
  filters: { anno: null, unit: 0, prov: null, haz: null, eerChapter: null, eerCode: null, mat: null, tipo: null, att: null },
  cfg: { xDim: "region", seriesDim: "", measure: "sum", measureColD: "Numero operatori iscritti", mapLevel: "region", topN: 10, sort: "desc", orientation: "h", showLabels: false },
  crossFilter: true,
};

/* ======================================================================== */
/* 1. Decodifica payload                                                    */
/* ======================================================================== */

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gunzipToUint8Array(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("Il browser non supporta DecompressionStream (serve Chrome/Edge/Firefox recente).");
  }
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

const DTYPE_CTORS = [Uint8Array, Uint16Array, Uint32Array];
const DTYPE_ITEMSIZE = [1, 2, 4];

function parseBinaryPayload(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  off += 4;
  if (magic !== "RNT1") throw new Error("Formato payload non riconosciuto: " + magic);
  const metaLen = dv.getUint32(off, true); off += 4;
  const metaBytes = bytes.subarray(off, off + metaLen); off += metaLen;
  const meta = JSON.parse(new TextDecoder("utf-8").decode(metaBytes));
  const numCols = dv.getUint16(off, true); off += 2;
  const cols = {};
  for (let i = 0; i < numCols; i++) {
    const nameLen = dv.getUint8(off); off += 1;
    const name = new TextDecoder("ascii").decode(bytes.subarray(off, off + nameLen)); off += nameLen;
    const dtypeCode = dv.getUint8(off); off += 1;
    const count = dv.getUint32(off, true); off += 4;
    const byteLen = count * DTYPE_ITEMSIZE[dtypeCode];
    const slice = bytes.slice(off, off + byteLen); // own buffer -> alignment-safe
    cols[name] = new DTYPE_CTORS[dtypeCode](slice.buffer);
    off += byteLen;
  }
  return { meta, cols };
}

function buildDataModel(parsed) {
  const { meta, cols } = parsed;
  const d = {
    meta,
    A: { n: meta.row_counts.A, anno: cols.A_anno, prov: cols.A_prov, eer: cols.A_eer, haz: cols.A_haz, unit: cols.A_unit, qty: cols.A_qty },
    B: { n: meta.row_counts.B, anno: cols.B_anno, prov: cols.B_prov, mat: cols.B_mat, qty: cols.B_qty },
    C: { n: meta.row_counts.C, anno: cols.C_anno, prov: cols.C_prov, eer: cols.C_eer, haz: cols.C_haz, att: cols.C_att, tipo: cols.C_tipo, qty: cols.C_qty },
    D: { n: meta.row_counts.D, prov: cols.D_prov },
    provinces: meta.provinces,
    provRegionIdx: meta.province_region_idx,
    provinceMapSigla: meta.province_map_sigla,
    regions: meta.region_display_names,
    regionIstat: meta.region_istat_codes,
    eerCodes: meta.eer_codes,
    eerDesc: meta.eer_desc,
    eerChapterByIdx: meta.eer_chapter,
    materiali: meta.materiali,
    attivita: meta.attivita,
  };
  for (const c of meta.d_measure_cols) d.D[c] = cols["D_" + c];
  return d;
}

function runBrowserSelfCheck() {
  const expect = DATA.meta.self_check;
  const idx2025 = DATA.meta.anno_labels_ac.indexOf("2025");
  const A = DATA.A, C = DATA.C, D = DATA.D;
  let a56 = 0, a58 = 0, dOp = 0, aLombardia = 0;
  const regLombIdx = DATA.regions.indexOf("Lombardia");
  for (let i = 0; i < A.n; i++) {
    if (A.anno[i] === idx2025 && A.unit[i] === 0) {
      a56 += A.qty[i];
      if (DATA.provRegionIdx[A.prov[i]] === regLombIdx) aLombardia += A.qty[i];
    }
  }
  for (let i = 0; i < C.n; i++) if (C.anno[i] === idx2025) a58 += C.qty[i];
  for (let i = 0; i < D.n; i++) dOp += D["Numero operatori iscritti"][i];

  const results = [
    ["report_56 2025 kg totale", a56, expect["report_56 2025 kg totale"]],
    ["report_58 2025 kg totale", a58, expect["report_58 2025 kg totale"]],
    ["report_59 operatori totale", dOp, expect["report_59 operatori totale"]],
    ["report_56 2025 kg Lombardia", aLombardia, expect["report_56 2025 kg Lombardia"]],
  ];
  let allOk = true;
  for (const [label, actual, exp] of results) {
    const ok = actual === exp;
    if (!ok) allOk = false;
    console.log(`[self-check] ${ok ? "OK" : "FALLITO"} ${label}: atteso=${exp} calcolato=${actual}`);
  }
  if (!allOk) showToast("Attenzione: self-check dati fallito, vedi console.");
}

/* ======================================================================== */
/* 2. Geometria mappe                                                       */
/* ======================================================================== */

async function loadGeo() {
  const regionsRaw = await gunzipToUint8Array(base64ToUint8Array(document.getElementById("rentri-geo-regions").textContent.trim()));
  const provincesRaw = await gunzipToUint8Array(base64ToUint8Array(document.getElementById("rentri-geo-provinces").textContent.trim()));
  const regionsTopo = JSON.parse(new TextDecoder("utf-8").decode(regionsRaw));
  const provincesTopo = JSON.parse(new TextDecoder("utf-8").decode(provincesRaw));

  const regionsGeo = topojson.feature(regionsTopo, regionsTopo.objects.regions);
  const provincesGeo = topojson.feature(provincesTopo, provincesTopo.objects.provinces);

  const istatToName = {};
  DATA.meta.region_istat_codes.forEach((code, idx) => { istatToName[code] = DATA.regions[idx]; });
  for (const f of regionsGeo.features) f.properties.name = istatToName[f.properties.reg_istat_code] || f.properties.reg_name;
  for (const f of provincesGeo.features) f.properties.name = f.properties.prov_acr;

  echarts.registerMap("rentri_regioni", regionsGeo);
  echarts.registerMap("rentri_province", provincesGeo);

  GEO.regionCentroids = computeCentroids(regionsGeo);
  GEO.provinceCentroids = computeCentroids(provincesGeo);
}

function computeCentroids(geojson) {
  const out = {};
  for (const f of geojson.features) {
    const name = f.properties.name;
    const geom = f.geometry;
    if (!geom) continue;
    let coords = [];
    if (geom.type === "Polygon") coords = geom.coordinates[0];
    else if (geom.type === "MultiPolygon") {
      let biggest = geom.coordinates[0][0];
      for (const poly of geom.coordinates) if (poly[0].length > biggest.length) biggest = poly[0];
      coords = biggest;
    }
    if (!coords.length) continue;
    let sx = 0, sy = 0;
    for (const c of coords) { sx += c[0]; sy += c[1]; }
    out[name] = [sx / coords.length, sy / coords.length];
  }
  return out;
}

/* ======================================================================== */
/* 3. Motore di query                                                        */
/* ======================================================================== */

function makeFilterPredicate(ds, filters) {
  const t = DATA[ds];
  const provRegionIdx = DATA.provRegionIdx;
  const eerChapterByIdx = DATA.eerChapterByIdx;
  return function rowOk(i) {
    if (filters.anno && t.anno && !filters.anno.has(t.anno[i])) return false;
    const prov = t.prov[i];
    if (filters.prov && !filters.prov.has(prov)) return false;
    if (t.haz && filters.haz && !filters.haz.has(t.haz[i])) return false;
    if (t.unit && filters.unit !== null && filters.unit !== undefined && t.unit[i] !== filters.unit) return false;
    if (t.eer !== undefined) {
      if (filters.eerChapter && !filters.eerChapter.has(eerChapterByIdx[t.eer[i]])) return false;
      if (filters.eerCode && !filters.eerCode.has(t.eer[i])) return false;
    }
    if (t.mat && filters.mat && !filters.mat.has(t.mat[i])) return false;
    if (t.tipo && filters.tipo && !filters.tipo.has(t.tipo[i])) return false;
    if (t.att && filters.att && !filters.att.has(t.att[i])) return false;
    return true;
  };
}

function getDimValue(t, dim, i) {
  switch (dim) {
    case "anno": return t.anno[i];
    case "prov": return t.prov[i];
    case "region": return DATA.provRegionIdx[t.prov[i]];
    case "eerChapter": return DATA.eerChapterByIdx[t.eer[i]];
    case "eerCode": return t.eer[i];
    case "haz": return t.haz[i];
    case "mat": return t.mat[i];
    case "att": return t.att[i];
    case "tipo": return t.tipo[i];
    default: return 0;
  }
}

function labelForDim(ds, dim, code) {
  switch (dim) {
    case "anno": return (ds === "B" ? DATA.meta.anno_labels_b : DATA.meta.anno_labels_ac)[code];
    case "prov": return DATA.provinces[code];
    case "region": return DATA.regions[code];
    case "eerChapter": {
      const ch = String(code).padStart(2, "0");
      return `${ch} — ${CHAPTER_LABELS[ch] || ""}`;
    }
    case "eerCode": return `${DATA.eerCodes[code]} — ${DATA.eerDesc[code]}`;
    case "haz": return code === 1 ? "Pericoloso" : "Non pericoloso";
    case "mat": return DATA.materiali[code];
    case "att": {
      const raw = DATA.attivita[code];
      return ATTIVITA_LABELS[raw] !== undefined ? ATTIVITA_LABELS[raw] : raw;
    }
    case "tipo": return code === 0 ? "Recupero (R)" : code === 1 ? "Smaltimento (D)" : "N/D";
    default: return String(code);
  }
}

function queryRows(ds, { filters, groupBy }) {
  const t = DATA[ds];
  const n = t.n;
  const rowOk = makeFilterPredicate(ds, filters);
  const results = new Map();
  for (let i = 0; i < n; i++) {
    if (!rowOk(i)) continue;
    const dims = groupBy.map((dim) => getDimValue(t, dim, i));
    const key = dims.join("||");
    let rec = results.get(key);
    if (!rec) { rec = { dims, sum: 0, count: 0 }; results.set(key, rec); }
    rec.sum += t.qty[i];
    rec.count++;
  }
  return [...results.values()];
}

function queryD(xDim, measureCol, filters) {
  const t = DATA.D;
  const results = new Map();
  for (let i = 0; i < t.n; i++) {
    const prov = t.prov[i];
    if (filters.prov && !filters.prov.has(prov)) continue;
    const code = xDim === "region" ? DATA.provRegionIdx[prov] : prov;
    let rec = results.get(code);
    if (!rec) { rec = { code, sum: 0, count: 0 }; results.set(code, rec); }
    rec.sum += t[measureCol][i];
    rec.count++;
  }
  return [...results.values()].map((r) => ({ label: xDim === "region" ? DATA.regions[r.code] : DATA.provinces[r.code], code: r.code, sum: r.sum, count: r.count }));
}

function toPivot(ds, xDim, seriesDim, queryResults) {
  const xMap = new Map();
  const sMap = new Map();
  for (const r of queryResults) {
    const [xc, sc] = r.dims;
    if (!xMap.has(xc)) xMap.set(xc, { label: labelForDim(ds, xDim, xc), total: 0 });
    xMap.get(xc).total += r.sum;
    if (!sMap.has(sc)) sMap.set(sc, labelForDim(ds, seriesDim, sc));
  }
  const xCodes = [...xMap.keys()].sort((a, b) => xMap.get(b).total - xMap.get(a).total);
  const sCodes = [...sMap.keys()].sort((a, b) => a - b);
  const categories = xCodes.map((c) => xMap.get(c).label);
  const cellLookup = new Map(queryResults.map((r) => [r.dims.join("||"), r.sum]));
  const series = sCodes.map((sc) => ({ name: sMap.get(sc), data: xCodes.map((xc) => cellLookup.get(`${xc}||${sc}`) || 0) }));
  return { categories, series, xCodes, sCodes, sLabels: sCodes.map((sc) => sMap.get(sc)) };
}

function applyMeasureToRawRows(raw, measure) {
  if (measure === "count") return raw.map((r) => ({ ...r, sum: r.count }));
  if (measure === "pct") {
    const total = raw.reduce((s, r) => s + r.sum, 0) || 1;
    return raw.map((r) => ({ ...r, sum: r.sum / total }));
  }
  return raw;
}

function applyTopNAndSortToPivot(pivot, topN, sort) {
  let categories = pivot.categories.slice();
  let series = pivot.series.map((se) => ({ name: se.name, data: se.data.slice() }));
  let hasOther = false;
  const n = categories.length;
  if (topN && n > topN) {
    const head = topN;
    const tailIdx = Array.from({ length: n - head }, (_, i) => i + head);
    series = series.map((se) => ({ name: se.name, data: [...se.data.slice(0, head), tailIdx.reduce((s, i) => s + se.data[i], 0)] }));
    categories = [...categories.slice(0, head), "Altro"];
    hasOther = true;
  }
  if (sort === "asc") {
    const fixedCount = hasOther ? categories.length - 1 : categories.length;
    const order = Array.from({ length: fixedCount }, (_, i) => fixedCount - 1 - i);
    if (hasOther) order.push(fixedCount);
    categories = order.map((i) => categories[i]);
    series = series.map((se) => ({ name: se.name, data: order.map((i) => se.data[i]) }));
  }
  return { categories, series, sLabels: pivot.sLabels };
}

function operatorRoleSumFor(ds, dim, code) {
  const t = DATA.D;
  let sum = 0;
  for (let i = 0; i < t.n; i++) {
    const p = t.prov[i];
    const match = dim === "prov" ? p === code : DATA.provRegionIdx[p] === code;
    if (!match) continue;
    sum += ds === "A" ? t["di cui Produttore"][i] : (t["di cui Recuperatore"][i] + t["di cui Smaltitore"][i]);
  }
  return sum;
}

function applyMeasure(rows, filters) {
  const measure = state.cfg.measure;
  if (measure === "count") return rows.map((r) => ({ ...r, sum: r.count, isCount: true }));
  if (measure === "pct") {
    const filtersNoTerritory = { ...filters, prov: null };
    const totalRaw = queryRows(state.dataset, { filters: filtersNoTerritory, groupBy: [] });
    const total = totalRaw.reduce((s, r) => s + r.sum, 0) || 1;
    return rows.map((r) => ({ ...r, sum: r.sum / total, isPercent: true }));
  }
  if (measure === "per_operatore") {
    return rows.map((r) => {
      const opCount = operatorRoleSumFor(state.dataset, state.cfg.xDim, r.code);
      return { ...r, sum: opCount > 0 ? r.sum / opCount : 0, isRatio: true };
    });
  }
  return rows;
}

function measureOptsFlags() {
  const m = state.cfg.measure;
  return { isCount: m === "count", isPercent: m === "pct", isRatio: m === "per_operatore" };
}

/* ======================================================================== */
/* 4. Stato: helper filtri                                                  */
/* ======================================================================== */

function annoIndexFor(ds, label) {
  const arr = ds === "B" ? DATA.meta.anno_labels_b : DATA.meta.anno_labels_ac;
  return arr.indexOf(label);
}

function ensureProvSet() {
  if (state.filters.prov === null) {
    const s = new Set();
    for (let i = 0; i < DATA.provinces.length; i++) s.add(i);
    return s;
  }
  return new Set(state.filters.prov);
}

function provincesInRegion(ri) {
  const out = [];
  for (let pi = 0; pi < DATA.provinces.length; pi++) if (DATA.provRegionIdx[pi] === ri) out.push(pi);
  return out;
}

function toggleProvinceSelection(pi) {
  const s = ensureProvSet();
  if (s.has(pi)) s.delete(pi); else s.add(pi);
  state.filters.prov = s.size === DATA.provinces.length ? null : (s.size === 0 ? s : s);
  onFiltersChanged();
}

function toggleRegionSelection(ri) {
  const s = ensureProvSet();
  const provIdxs = provincesInRegion(ri);
  const allSelected = provIdxs.every((pi) => s.has(pi));
  provIdxs.forEach((pi) => (allSelected ? s.delete(pi) : s.add(pi)));
  state.filters.prov = s.size === DATA.provinces.length ? null : s;
  onFiltersChanged();
}

function toggleMacroSelection(macro) {
  const s = ensureProvSet();
  const provIdxs = [];
  for (let pi = 0; pi < DATA.provinces.length; pi++) {
    const region = DATA.regions[DATA.provRegionIdx[pi]];
    if (MACRO_AREA_BY_REGION[region] === macro) provIdxs.push(pi);
  }
  const allSelected = provIdxs.every((pi) => s.has(pi));
  provIdxs.forEach((pi) => (allSelected ? s.delete(pi) : s.add(pi)));
  state.filters.prov = s.size === DATA.provinces.length ? null : s;
  onFiltersChanged();
}

function buildFilterSets() {
  return { anno: state.filters.anno, unit: state.filters.unit, prov: state.filters.prov, haz: state.filters.haz, eerChapter: state.filters.eerChapter, eerCode: state.filters.eerCode, mat: state.filters.mat, tipo: state.filters.tipo, att: state.filters.att };
}

function unitLabel() {
  // Only dataset A ever has litre rows; B/C/D are always kg regardless of a
  // stale unit selection left over from a previous visit to dataset A.
  return (state.dataset === "A" && state.filters.unit === 1) ? "l" : "kg";
}

function onFiltersChanged() { render(); }

/* ======================================================================== */
/* 5. Rendering: filtri, chip, KPI                                          */
/* ======================================================================== */

function applicableGroups(ds) {
  const eer = ds === "A" || ds === "C";
  return { unit: ds === "A", haz: ds === "A" || ds === "C", eerChapter: eer, eerCode: eer, mat: ds === "B", tipo: ds === "C", att: ds === "C", anno: ds !== "D" };
}

function renderAnnoFilter() {
  const ds = state.dataset;
  const el = document.getElementById("filter-anno");
  const app = applicableGroups(ds);
  document.getElementById("group-anno").classList.toggle("hidden", !app.anno);
  if (!app.anno) return;
  const labels = ds === "B" ? DATA.meta.anno_labels_b : DATA.meta.anno_labels_ac;
  el.innerHTML = "";
  const selected = state.filters.anno;
  labels.forEach((label, idx) => {
    const chip = document.createElement("button");
    const isPartial = label === "2026";
    const isStartup = label === "2024";
    chip.className = "chip" + (isPartial || isStartup ? " partial" : "") + (!selected || selected.has(idx) ? " selected" : "");
    chip.textContent = label;
    chip.title = isPartial ? "Dato parziale: gennaio–luglio 2026" : isStartup ? "Anno di avvio del tracciamento: dati minimi" : "";
    chip.onclick = () => {
      const s = selected ? new Set(selected) : new Set(labels.map((_, i) => i));
      if (s.has(idx)) s.delete(idx); else s.add(idx);
      state.filters.anno = s.size === labels.length ? null : s;
      onFiltersChanged();
    };
    el.appendChild(chip);
  });
  const note = document.getElementById("anno-note");
  note.textContent = labels.includes("2026") && (!selected || selected.has(labels.indexOf("2026")))
    ? "* 2026: dato parziale (gen–lug). 2024: avvio tracciamento." : "";
}

function renderUnitFilter() {
  const ds = state.dataset;
  const app = applicableGroups(ds);
  document.getElementById("group-unit").classList.toggle("hidden", !app.unit);
  if (!app.unit) return;
  const el = document.getElementById("filter-unit");
  el.innerHTML = "";
  ["kg", "l"].forEach((u, idx) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.filters.unit === idx ? " selected" : "");
    chip.textContent = u;
    chip.onclick = () => { state.filters.unit = idx; onFiltersChanged(); };
    el.appendChild(chip);
  });
  const note = document.getElementById("unit-note");
  note.textContent = state.filters.unit === 0 ? "Le righe in litri sono escluse dal totale (non sommabili con i kg)." : "Solo le righe in litri: totale minoritario rispetto ai kg.";
}

function renderTerritoryFilter() {
  const searchEl = document.getElementById("filter-region-search");
  const search = searchEl.value.trim().toLowerCase();
  const listEl = document.getElementById("filter-region-list");
  listEl.innerHTML = "";
  for (let ri = 0; ri < DATA.regions.length; ri++) {
    const regionName = DATA.regions[ri];
    const provIdxs = provincesInRegion(ri);
    const regionMatches = regionName.toLowerCase().includes(search);
    const matchingProv = provIdxs.filter((pi) => !search || regionMatches || DATA.provinces[pi].toLowerCase().includes(search));
    if (search && !regionMatches && matchingProv.length === 0) continue;
    const allSelected = !state.filters.prov || provIdxs.every((pi) => state.filters.prov.has(pi));
    const rDiv = document.createElement("div");
    rDiv.className = "list-item";
    rDiv.style.fontWeight = "700";
    const rCb = document.createElement("input"); rCb.type = "checkbox"; rCb.checked = allSelected;
    rCb.onchange = () => toggleRegionSelection(ri);
    rDiv.appendChild(rCb);
    const rSpan = document.createElement("span"); rSpan.textContent = regionName; rDiv.appendChild(rSpan);
    listEl.appendChild(rDiv);
    const provsToShow = search && !regionMatches ? matchingProv : provIdxs;
    for (const pi of provsToShow) {
      const pDiv = document.createElement("div");
      pDiv.className = "list-item"; pDiv.style.paddingLeft = "20px";
      const pCb = document.createElement("input"); pCb.type = "checkbox";
      pCb.checked = !state.filters.prov || state.filters.prov.has(pi);
      pCb.onchange = () => toggleProvinceSelection(pi);
      pDiv.appendChild(pCb);
      const pSpan = document.createElement("span"); pSpan.textContent = DATA.provinces[pi]; pDiv.appendChild(pSpan);
      listEl.appendChild(pDiv);
    }
  }
}

function renderMacroButtons() {
  const el = document.getElementById("filter-macro");
  el.innerHTML = "";
  ["Nord", "Centro", "Sud", "Isole"].forEach((macro) => {
    const btn = document.createElement("button");
    btn.className = "macro-btn"; btn.textContent = macro;
    btn.onclick = () => toggleMacroSelection(macro);
    el.appendChild(btn);
  });
}

function renderHazFilter() {
  const ds = state.dataset;
  const app = applicableGroups(ds);
  document.getElementById("group-haz").classList.toggle("hidden", !app.haz);
  if (!app.haz) return;
  const el = document.getElementById("filter-haz");
  el.innerHTML = "";
  const options = [["Tutti", null], ["Pericolosi (P)", new Set([1])], ["Non pericolosi (NP)", new Set([0])]];
  options.forEach(([label, val]) => {
    const chip = document.createElement("button");
    const active = val === null ? state.filters.haz === null : (state.filters.haz && [...state.filters.haz].join() === [...val].join());
    chip.className = "chip" + (active ? " selected" : "");
    chip.textContent = label;
    chip.onclick = () => { state.filters.haz = val; onFiltersChanged(); };
    el.appendChild(chip);
  });
}

function renderEerChapterFilter() {
  const ds = state.dataset;
  const app = applicableGroups(ds);
  document.getElementById("group-eer-chapter").classList.toggle("hidden", !app.eerChapter);
  if (!app.eerChapter) return;
  const el = document.getElementById("filter-eer-chapter");
  el.innerHTML = "";
  for (let ch = 1; ch <= 20; ch++) {
    const label = `${String(ch).padStart(2, "0")} — ${CHAPTER_LABELS[String(ch).padStart(2, "0")]}`;
    const div = document.createElement("div");
    div.className = "list-item";
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !state.filters.eerChapter || state.filters.eerChapter.has(ch);
    cb.onchange = () => {
      const s = state.filters.eerChapter ? new Set(state.filters.eerChapter) : new Set(Array.from({ length: 20 }, (_, i) => i + 1));
      if (s.has(ch)) s.delete(ch); else s.add(ch);
      state.filters.eerChapter = s.size === 20 ? null : s;
      onFiltersChanged();
    };
    div.appendChild(cb);
    const span = document.createElement("span"); span.textContent = label; span.title = label; div.appendChild(span);
    el.appendChild(div);
  }
}

function renderEerCodeFilter() {
  const ds = state.dataset;
  const app = applicableGroups(ds);
  document.getElementById("group-eer-code").classList.toggle("hidden", !app.eerCode);
  if (!app.eerCode) return;
  const searchEl = document.getElementById("filter-eercode-search");
  const search = searchEl.value.trim().toLowerCase();
  const el = document.getElementById("filter-eercode-list");
  el.innerHTML = "";
  const selectedCount = state.filters.eerCode ? state.filters.eerCode.size : DATA.eerCodes.length;
  if (search.length < 2) {
    const note = document.createElement("div");
    note.className = "filter-note";
    note.textContent = state.filters.eerCode
      ? `${selectedCount} codici selezionati. Digita almeno 2 caratteri per cercarne altri (codice o descrizione).`
      : "Digita almeno 2 caratteri per cercare (es. 170504 o cemento).";
    el.appendChild(note);
    return;
  }
  let shown = 0;
  for (let idx = 0; idx < DATA.eerCodes.length && shown < 150; idx++) {
    const code = DATA.eerCodes[idx];
    const desc = DATA.eerDesc[idx];
    if (!code.toLowerCase().includes(search) && !desc.toLowerCase().includes(search)) continue;
    shown++;
    const div = document.createElement("div");
    div.className = "list-item";
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !state.filters.eerCode || state.filters.eerCode.has(idx);
    cb.onchange = () => {
      const s = state.filters.eerCode ? new Set(state.filters.eerCode) : new Set(DATA.eerCodes.map((_, i) => i));
      if (s.has(idx)) s.delete(idx); else s.add(idx);
      state.filters.eerCode = s.size === DATA.eerCodes.length ? null : s;
      onFiltersChanged();
    };
    div.appendChild(cb);
    const span = document.createElement("span"); span.textContent = `${code} — ${desc}`; span.title = desc;
    div.appendChild(span);
    el.appendChild(div);
  }
  if (shown === 0) {
    const note = document.createElement("div"); note.className = "filter-note"; note.textContent = "Nessun codice EER corrisponde alla ricerca.";
    el.appendChild(note);
  }
}

function renderMaterialeFilter() {
  const ds = state.dataset;
  const app = applicableGroups(ds);
  document.getElementById("group-materiale").classList.toggle("hidden", !app.mat);
  if (!app.mat) return;
  const el = document.getElementById("filter-materiale");
  el.innerHTML = "";
  DATA.materiali.forEach((m, idx) => {
    const div = document.createElement("div");
    div.className = "list-item";
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !state.filters.mat || state.filters.mat.has(idx);
    cb.onchange = () => {
      const s = state.filters.mat ? new Set(state.filters.mat) : new Set(DATA.materiali.map((_, i) => i));
      if (s.has(idx)) s.delete(idx); else s.add(idx);
      state.filters.mat = s.size === DATA.materiali.length ? null : s;
      onFiltersChanged();
    };
    div.appendChild(cb);
    const span = document.createElement("span"); span.textContent = m; div.appendChild(span);
    el.appendChild(div);
  });
}

function renderTipoFilter() {
  const ds = state.dataset;
  const app = applicableGroups(ds);
  document.getElementById("group-attivita").classList.toggle("hidden", !app.tipo);
  if (!app.tipo) return;
  const el = document.getElementById("filter-tipo");
  el.innerHTML = "";
  const options = [["Tutti", null], ["Recupero (R)", new Set([0])], ["Smaltimento (D)", new Set([1])], ["Non specificato", new Set([2])]];
  options.forEach(([label, val]) => {
    const chip = document.createElement("button");
    const active = val === null ? state.filters.tipo === null : (state.filters.tipo && [...state.filters.tipo].join() === [...val].join());
    chip.className = "chip" + (active ? " selected" : "");
    chip.textContent = label;
    chip.onclick = () => { state.filters.tipo = val; onFiltersChanged(); };
    el.appendChild(chip);
  });
}

function renderAttivitaDetailFilter() {
  const ds = state.dataset;
  const app = applicableGroups(ds);
  document.getElementById("group-attivita-detail").classList.toggle("hidden", !app.att);
  if (!app.att) return;
  const el = document.getElementById("filter-attivita-detail");
  el.innerHTML = "";
  DATA.attivita.forEach((code, idx) => {
    const label = ATTIVITA_LABELS[code] !== undefined ? ATTIVITA_LABELS[code] : code;
    const div = document.createElement("div");
    div.className = "list-item";
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !state.filters.att || state.filters.att.has(idx);
    cb.onchange = () => {
      const s = state.filters.att ? new Set(state.filters.att) : new Set(DATA.attivita.map((_, i) => i));
      if (s.has(idx)) s.delete(idx); else s.add(idx);
      state.filters.att = s.size === DATA.attivita.length ? null : s;
      onFiltersChanged();
    };
    div.appendChild(cb);
    const span = document.createElement("span"); span.textContent = label; span.title = label;
    div.appendChild(span);
    el.appendChild(div);
  });
}

function updateFilterRailUI() {
  renderAnnoFilter();
  renderUnitFilter();
  renderMacroButtons();
  renderTerritoryFilter();
  renderHazFilter();
  renderEerChapterFilter();
  renderEerCodeFilter();
  renderMaterialeFilter();
  renderTipoFilter();
  renderAttivitaDetailFilter();
}

function countSelectedProv() { return state.filters.prov ? state.filters.prov.size : DATA.provinces.length; }

function updateActiveChips() {
  const el = document.getElementById("active-chips");
  el.innerHTML = "";
  const ds = state.dataset;
  const app = applicableGroups(ds);
  const chips = [];
  if (app.anno && state.filters.anno) {
    const labels = ds === "B" ? DATA.meta.anno_labels_b : DATA.meta.anno_labels_ac;
    chips.push({ text: "Anno: " + [...state.filters.anno].map((i) => labels[i]).join(", "), dormant: false, clear: () => { state.filters.anno = null; render(); } });
  }
  if (app.unit) chips.push({ text: "Unità: " + unitLabel(), dormant: false });
  if (countSelectedProv() < DATA.provinces.length) {
    chips.push({ text: `Territorio: ${countSelectedProv()} province`, dormant: false, clear: () => { state.filters.prov = null; render(); } });
  }
  if (app.haz && state.filters.haz) chips.push({ text: "Pericolosità: " + (state.filters.haz.has(1) ? "P" : "NP"), dormant: false, clear: () => { state.filters.haz = null; render(); } });
  if (!app.haz && state.filters.haz) chips.push({ text: "Pericolosità (non applicabile)", dormant: true });
  if (app.eerChapter && state.filters.eerChapter) chips.push({ text: `Capitolo EER: ${state.filters.eerChapter.size} selezionati`, dormant: false, clear: () => { state.filters.eerChapter = null; render(); } });
  if (!app.eerChapter && state.filters.eerChapter) chips.push({ text: "Capitolo EER (non applicabile)", dormant: true });
  if (app.eerCode && state.filters.eerCode) chips.push({ text: `Codice EER: ${state.filters.eerCode.size} selezionati`, dormant: false, clear: () => { state.filters.eerCode = null; render(); } });
  if (!app.eerCode && state.filters.eerCode) chips.push({ text: "Codice EER (non applicabile)", dormant: true });
  if (app.mat && state.filters.mat) chips.push({ text: `Materiale: ${state.filters.mat.size} selezionati`, dormant: false, clear: () => { state.filters.mat = null; render(); } });
  if (app.tipo && state.filters.tipo) chips.push({ text: "Tipo op.: " + [...state.filters.tipo].map((c) => (c === 0 ? "R" : c === 1 ? "D" : "N/D")).join(","), dormant: false, clear: () => { state.filters.tipo = null; render(); } });
  if (app.att && state.filters.att) chips.push({ text: `Attività: ${state.filters.att.size} selezionate`, dormant: false, clear: () => { state.filters.att = null; render(); } });
  if (!app.att && state.filters.att) chips.push({ text: "Attività (non applicabile)", dormant: true });

  chips.forEach((c) => {
    const span = document.createElement("span");
    span.className = "active-chip" + (c.dormant ? " dormant-chip" : "");
    span.innerHTML = `<span>${c.text}</span>` + (c.clear ? ' <span class="x">×</span>' : "");
    if (c.clear) span.querySelector(".x").onclick = c.clear;
    el.appendChild(span);
  });
  if (!chips.length) { const span = document.createElement("span"); span.className = "filter-note"; span.textContent = "Nessun filtro attivo oltre l'anno/unità di default."; el.appendChild(span); }
}

function resetAllFilters() {
  state.filters = { anno: new Set([annoIndexFor(state.dataset, "2025")]), unit: 0, prov: null, haz: null, eerChapter: null, eerCode: null, mat: null, tipo: null, att: null };
  render();
}

/* ======================================================================== */
/* 6. KPI                                                                    */
/* ======================================================================== */

function kpiTile(value, unitTxt, label) {
  return `<div class="kpi-tile"><div class="kpi-value">${value}<span class="kpi-unit">${unitTxt || ""}</span></div><div class="kpi-label">${label}</div></div>`;
}

function renderKPIs() {
  const el = document.getElementById("kpi-strip");
  const filters = buildFilterSets();
  const ds = state.dataset;
  if (ds === "D") {
    const rowsOp = queryD("prov", "Numero operatori iscritti", filters);
    const rowsUl = queryD("prov", "Numero unita locali iscritte", filters);
    const totOp = rowsOp.reduce((s, r) => s + r.sum, 0);
    const totUl = rowsUl.reduce((s, r) => s + r.sum, 0);
    el.innerHTML = kpiTile(formatInt(totOp), "", "Operatori iscritti")
      + kpiTile(formatInt(totUl), "", "Unità locali iscritte")
      + kpiTile(formatInt(rowsOp.length), "", "Province con dati")
      + kpiTile("Istantanea", "", "24/07/2026 (nessuna serie storica)");
    return;
  }
  const raw = queryRows(ds, { filters, groupBy: [] });
  const total = raw.reduce((s, r) => s + r.sum, 0);
  const count = raw.reduce((s, r) => s + r.count, 0);
  if (ds === "A") {
    const eerRaw = queryRows(ds, { filters, groupBy: ["eerCode"] });
    const hazRaw = queryRows(ds, { filters: { ...filters, haz: null }, groupBy: ["haz"] });
    const hazP = hazRaw.find((r) => r.dims[0] === 1);
    const pShare = hazP ? hazP.sum / (hazRaw.reduce((s, r) => s + r.sum, 0) || 1) : 0;
    const provRaw = queryRows(ds, { filters, groupBy: ["prov"] });
    el.innerHTML = kpiTile(formatQty(total, unitLabel()).split(" ")[0], formatQty(total, unitLabel()).split(" ")[1], "Totale prodotto")
      + kpiTile(formatInt(eerRaw.length), "", "Codici EER distinti")
      + kpiTile(formatPct(pShare), "", "Quota pericolosi")
      + kpiTile(formatInt(provRaw.length), "", "Province con dati");
  } else if (ds === "C") {
    const tipoRaw = queryRows(ds, { filters: { ...filters, tipo: null }, groupBy: ["tipo"] });
    const rSum = tipoRaw.filter((r) => r.dims[0] === 0).reduce((s, r) => s + r.sum, 0);
    const dSum = tipoRaw.filter((r) => r.dims[0] === 1).reduce((s, r) => s + r.sum, 0);
    const rShare = (rSum + dSum) > 0 ? rSum / (rSum + dSum) : 0;
    const attRaw = queryRows(ds, { filters, groupBy: ["att"] });
    const provRaw = queryRows(ds, { filters, groupBy: ["prov"] });
    el.innerHTML = kpiTile(formatQty(total, "kg").split(" ")[0], formatQty(total, "kg").split(" ")[1], "Totale trattato")
      + kpiTile(formatPct(rShare), "", "Quota operazioni R (su R+D)")
      + kpiTile(formatInt(attRaw.length), "", "Operazioni distinte")
      + kpiTile(formatInt(provRaw.length), "", "Province impianto con dati");
  } else { // B
    const matRaw = queryRows(ds, { filters, groupBy: ["mat"] });
    const provRaw = queryRows(ds, { filters, groupBy: ["prov"] });
    const top = matRaw.slice().sort((a, b) => b.sum - a.sum)[0];
    el.innerHTML = kpiTile(formatQty(total, "kg").split(" ")[0], formatQty(total, "kg").split(" ")[1], "Totale EoW")
      + kpiTile(formatInt(matRaw.length), "", "Materiali distinti")
      + kpiTile(top ? labelForDim(ds, "mat", top.dims[0]) : "—", "", "Materiale principale")
      + kpiTile(formatInt(provRaw.length), "", "Province con dati");
  }
}

/* ======================================================================== */
/* 7. Pannello configurazione grafico                                       */
/* ======================================================================== */

function fillSelect(el, options, selected) {
  el.innerHTML = "";
  options.forEach(([val, label]) => {
    const opt = document.createElement("option"); opt.value = val; opt.textContent = label;
    if (val === selected) opt.selected = true;
    el.appendChild(opt);
  });
}

function currentDims() { return DIMS_BY_DATASET[state.dataset]; }

// Regioni (20) e province (111) sono insiemi chiusi e nominabili: nasconderne
// alcune dentro un generico "Altro" per via del Top-N le renderebbe "non
// correttamente visualizzate" — vanno sempre mostrate per intero.
function isTerritorialDim(dim) { return dim === "region" || dim === "prov"; }

function toggleHidden(id, hide) { document.getElementById(id).classList.toggle("hidden", hide); }

function updateConfigPanelUI() {
  const ds = state.dataset;
  const dims = currentDims();
  const cap = CHART_CAPABILITIES[state.chartType] || {};

  renderChartCategoryTabs();
  renderChartTypeGrid();
  document.getElementById("chart-type-note").textContent = cap.note || "";

  // Never let a stale measure choice (e.g. "% del totale" picked on a previous
  // chart type) silently leak into a chart/table that ignores it.
  if (!cap.usesMeasure) state.cfg.measure = "sum";

  const isMap = state.chartType === "map";
  toggleHidden("field-maplevel", !isMap);
  if (isMap) renderMapLevelToggle();

  const usesXDim = cap.usesXDim === true || cap.usesXDim === "limited";
  toggleHidden("field-xdim", !usesXDim);
  toggleHidden("field-seriesdim", !cap.usesSeries);
  toggleHidden("field-measure", !cap.usesMeasure);
  toggleHidden("section-title-dati", !usesXDim && !cap.usesSeries && !cap.usesMeasure);

  const xSel = document.getElementById("config-xdim");
  const sSel = document.getElementById("config-seriesdim");
  const mSel = document.getElementById("config-measure");

  if (usesXDim) {
    const xOptions = cap.usesXDim === "limited" ? [["prov", "Provincia"], ["region", "Regione"]] : dims;
    if (!xOptions.some(([id]) => id === state.cfg.xDim)) state.cfg.xDim = xOptions[0][0];
    fillSelect(xSel, xOptions, state.cfg.xDim);
    xSel.onchange = () => { state.cfg.xDim = xSel.value; render(); };
  }
  if (cap.usesSeries) {
    const seriesOptions = dims.filter(([id]) => id !== state.cfg.xDim);
    const optionsWithNone = cap.seriesRequired ? seriesOptions : [["", "Nessuna"], ...seriesOptions];
    if (!optionsWithNone.some(([id]) => id === state.cfg.seriesDim)) {
      state.cfg.seriesDim = cap.seriesRequired ? (seriesOptions[0] ? seriesOptions[0][0] : "") : "";
    }
    fillSelect(sSel, optionsWithNone, state.cfg.seriesDim);
    sSel.onchange = () => { state.cfg.seriesDim = sSel.value; render(); };
  }
  if (cap.usesMeasure) {
    if (ds === "D") {
      fillSelect(mSel, Object.entries(D_MEASURE_LABELS), state.cfg.measureColD);
      mSel.onchange = () => { state.cfg.measureColD = mSel.value; render(); };
    } else {
      const measureOpts = [["sum", "Somma quantità"], ["count", "Numero di righe"], ["pct", "% del totale nazionale"]];
      if (!cap.usesSeries && (ds === "A" || ds === "C") && (state.cfg.xDim === "prov" || state.cfg.xDim === "region")) measureOpts.push(["per_operatore", "kg per operatore iscritto"]);
      if (!measureOpts.some(([id]) => id === state.cfg.measure)) state.cfg.measure = "sum";
      fillSelect(mSel, measureOpts, state.cfg.measure);
      mSel.onchange = () => { state.cfg.measure = mSel.value; render(); };
    }
  }

  const territorial = usesXDim && isTerritorialDim(state.cfg.xDim);
  toggleHidden("field-topn", !cap.usesTopN || territorial);
  toggleHidden("field-sort", !cap.usesSort);
  toggleHidden("field-orientation", !cap.usesOrientation);
  toggleHidden("field-labels", !cap.usesLabels);
  toggleHidden("section-title-aspetto", (!cap.usesTopN || territorial) && !cap.usesSort && !cap.usesOrientation && !cap.usesLabels);
  document.getElementById("config-hint").textContent = (cap.usesTopN && territorial)
    ? "Regioni e province sono sempre mostrate per intero: non vengono mai raggruppate in \"Altro\"."
    : "";

  document.getElementById("config-topn").value = String(state.cfg.topN);
  document.getElementById("config-topn").onchange = (e) => { state.cfg.topN = parseInt(e.target.value, 10); render(); };
  document.getElementById("config-sort").value = state.cfg.sort;
  document.getElementById("config-sort").onchange = (e) => { state.cfg.sort = e.target.value; render(); };
  document.getElementById("config-orientation").value = state.cfg.orientation;
  document.getElementById("config-orientation").onchange = (e) => { state.cfg.orientation = e.target.value; render(); };
  document.getElementById("config-labels").checked = state.cfg.showLabels;
  document.getElementById("config-labels").onchange = (e) => { state.cfg.showLabels = e.target.checked; render(); };
}

function chartTypesForDataset(ds) {
  if (ds === "D") return ["map", "bar", "ranking", "pie", "radar"];
  const base = ["map", "bar", "bar_grouped", "bar_stacked", "bar_stacked_pct", "pie", "treemap", "heatmap", "boxplot", "ranking"];
  if (ds === "A" || ds === "C") base.push("scatter", "sunburst");
  if (ds === "C") base.push("sankey");
  return base;
}

function renderChartCategoryTabs() {
  const el = document.getElementById("chart-category-tabs");
  const ds = state.dataset;
  const allowedIds = chartTypesForDataset(ds);
  const availableCategories = CHART_CATEGORIES.filter((c) => CHART_TYPES.some((t) => t.group === c.id && allowedIds.includes(t.id)));
  const currentType = CHART_TYPES.find((t) => t.id === state.chartType);
  if (!availableCategories.some((c) => c.id === state.chartCategory)) {
    state.chartCategory = (currentType && availableCategories.some((c) => c.id === currentType.group)) ? currentType.group : availableCategories[0].id;
  }
  el.innerHTML = "";
  availableCategories.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "category-pill" + (state.chartCategory === c.id ? " selected" : "");
    btn.textContent = c.label;
    btn.onclick = () => {
      state.chartCategory = c.id;
      const typesInCat = CHART_TYPES.filter((t) => t.group === c.id && allowedIds.includes(t.id));
      if (!typesInCat.some((t) => t.id === state.chartType)) state.chartType = typesInCat[0].id;
      render();
    };
    el.appendChild(btn);
  });
}

function renderChartTypeGrid() {
  const el = document.getElementById("chart-type-grid");
  el.innerHTML = "";
  const ds = state.dataset;
  const allowed = chartTypesForDataset(ds);
  const typesInCategory = CHART_TYPES.filter((t) => allowed.includes(t.id) && t.group === state.chartCategory);
  typesInCategory.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "type-btn" + (state.chartType === t.id ? " selected" : "");
    btn.textContent = t.label;
    btn.onclick = () => { state.chartType = t.id; render(); };
    el.appendChild(btn);
  });
}

function renderMapLevelToggle() {
  const el = document.getElementById("config-maplevel");
  el.innerHTML = "";
  [["region", "Regione"], ["prov", "Provincia"]].forEach(([val, label]) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.cfg.mapLevel === val ? " selected" : "");
    chip.textContent = label;
    chip.onclick = () => { state.cfg.mapLevel = val; render(); };
    el.appendChild(chip);
  });
}

/* ======================================================================== */
/* 8. Rendering grafico                                                     */
/* ======================================================================== */

function ensureEchartsInstance() {
  if (!echartInstance) {
    echartInstance = echarts.init(document.getElementById("chart-canvas"));
    window.addEventListener("resize", () => echartInstance.resize());
  }
  return echartInstance;
}

function showView(view) {
  document.getElementById("chart-panel").classList.toggle("hidden", view !== "chart");
  document.getElementById("table-panel").classList.toggle("hidden", view !== "table");
  document.querySelectorAll(".view-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "chart" && echartInstance) setTimeout(() => echartInstance.resize(), 30);
}

function computeChartTitle() {
  const ds = DATASET_LABELS[state.dataset];
  const dimLabel = (currentDims().find(([id]) => id === state.cfg.xDim) || [null, state.cfg.xDim])[1];
  return `${ds} — per ${dimLabel}`;
}

function renderChartBadges() {
  const el = document.getElementById("chart-badges");
  el.innerHTML = "";
  const badges = [];
  const app = applicableGroups(state.dataset);
  if (app.anno) {
    const labels = state.dataset === "B" ? DATA.meta.anno_labels_b : DATA.meta.anno_labels_ac;
    const sel = state.filters.anno ? [...state.filters.anno].map((i) => labels[i]) : labels;
    if (sel.includes("2026")) badges.push(["warn", "2026: dato parziale (gen–lug)"]);
    if (sel.includes("2024")) badges.push(["warn", "2024: avvio tracciamento"]);
  }
  if (state.dataset === "A") badges.push(["", `Provincia = del produttore · unità ${unitLabel()}`]);
  if (state.dataset === "C") badges.push(["", "Provincia = dell'impianto di trattamento"]);
  if (state.dataset === "D") badges.push(["", "Istantanea al 24/07/2026 — nessuna dimensione anno"]);
  badges.forEach(([kind, text]) => {
    const span = document.createElement("span"); span.className = "badge" + (kind === "warn" ? " badge-warn" : ""); span.textContent = text; el.appendChild(span);
  });
}

function renderMap() {
  const filters = buildFilterSets();
  const dim = state.cfg.mapLevel === "prov" ? "prov" : "region";
  let rows;
  if (state.dataset === "D") {
    rows = queryD(dim, state.cfg.measureColD, filters);
  } else {
    const raw = queryRows(state.dataset, { filters, groupBy: [dim] });
    rows = raw.map((r) => ({ label: labelForDim(state.dataset, dim, r.dims[0]), code: r.dims[0], sum: r.sum, count: r.count }));
    rows = applyMeasure(rows, filters);
  }
  let finalRows = rows;
  let mapName = "rentri_regioni";
  if (dim === "prov") {
    mapName = "rentri_province";
    const merged = new Map();
    for (const r of rows) {
      const sigla = DATA.provinceMapSigla[r.code];
      if (!merged.has(sigla)) merged.set(sigla, { label: sigla, sum: 0, count: 0 });
      merged.get(sigla).sum += r.sum; merged.get(sigla).count += r.count;
    }
    finalRows = [...merged.values()];
  }
  const opts = { unit: unitLabel(), ...measureOptsFlags() };
  const option = buildMapOption(mapName, finalRows, opts);
  echartInstance.setOption(option, true);
  lastExportPayload = { mode: "single", rows: finalRows.map((r) => ({ label: r.label, sum: r.sum, count: r.count })) };
  wireMapClick(dim);
  document.getElementById("chart-footnote").textContent = dim === "prov" ? "Le 4 province soppresse nel 2016 (CI, VS, OG, OT) sono aggregate sui confini attuali (SU/NU/SS) solo su questa mappa." : "";
}

function wireMapClick(dim) {
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType !== "series") return;
    if (dim === "region") {
      const ri = DATA.regions.indexOf(params.name);
      if (ri < 0) return;
      const wasIncluded = !state.filters.prov || provincesInRegion(ri).every((pi) => state.filters.prov.has(pi));
      toggleRegionSelection(ri);
      showToast(`${params.name}: ${wasIncluded ? "escluso dal" : "incluso nel"} filtro Territorio`);
    } else {
      const matches = [];
      DATA.provinces.forEach((p, pi) => { if (DATA.provinceMapSigla[pi] === params.name) matches.push(pi); });
      if (!matches.length) return;
      const wasIncluded = !state.filters.prov || matches.every((pi) => state.filters.prov.has(pi));
      matches.forEach((pi) => toggleProvinceSelection(pi));
      showToast(`${params.name}: ${wasIncluded ? "escluso dal" : "incluso nel"} filtro Territorio`);
    }
  });
}

function toggleMultiFilter(filterKey, code, totalCount) {
  const s = state.filters[filterKey] ? new Set(state.filters[filterKey]) : new Set(Array.from({ length: totalCount }, (_, i) => filterKey === "eerChapter" ? i + 1 : i));
  if (s.has(code)) s.delete(code); else s.add(code);
  state.filters[filterKey] = s.size === totalCount ? null : s;
  render();
}

const FILTERABLE_CLICK_DIMS = ["prov", "region", "haz", "eerChapter", "eerCode", "mat", "att"];

function wireGenericClick(dim) {
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType !== "series") return;
    const label = (currentDims().find(([id]) => id === dim) || [null, dim])[1];
    if (params.data && params.data.code === "__other__") {
      showToast(`"Altro" raggruppa più valori: usa i filtri a sinistra per selezionarne uno specifico.`);
      return;
    }
    if (!FILTERABLE_CLICK_DIMS.includes(dim)) {
      showToast(`Il click non filtra per "${label}" — usa i filtri nel pannello a sinistra.`);
      return;
    }
    const code = params.data && params.data.code !== undefined ? params.data.code : null;
    if (code === null) return;
    if (dim === "prov") { toggleProvinceSelection(code); showToast(`${DATA.provinces[code]}: filtro Territorio aggiornato`); }
    else if (dim === "region") { toggleRegionSelection(code); showToast(`${DATA.regions[code]}: filtro Territorio aggiornato`); }
    else if (dim === "haz") { state.filters.haz = new Set([code]); render(); showToast(`Filtro Pericolosità impostato su "${labelForDim(state.dataset, "haz", code)}"`); }
    else if (dim === "eerChapter") { state.filters.eerChapter = new Set([code]); render(); showToast(`Filtro Capitolo EER impostato`); }
    else if (dim === "eerCode") { toggleMultiFilter("eerCode", code, DATA.eerCodes.length); showToast(`Filtro Codice EER aggiornato`); }
    else if (dim === "mat") { toggleMultiFilter("mat", code, DATA.materiali.length); showToast(`Filtro Materiale aggiornato`); }
    else if (dim === "att") { toggleMultiFilter("att", code, DATA.attivita.length); showToast(`Filtro Attività aggiornato`); }
  });
}

function renderSimpleChart(ct, rows) {
  const territorial = isTerritorialDim(state.cfg.xDim);
  const effectiveTopN = territorial ? rows.length : state.cfg.topN;
  const opts = { unit: unitLabel(), horizontal: state.cfg.orientation === "h", showLabels: state.cfg.showLabels, topN: effectiveTopN, asc: state.cfg.sort === "asc", donut: true, ...measureOptsFlags() };
  let option;
  switch (ct) {
    case "ranking": option = buildRankingOption(rows, opts); break;
    case "pie": option = buildPieOption(rows, opts); break;
    case "treemap": option = buildTreemapOption(rows, opts); break;
    default: option = buildBarOption(rows.slice(0, effectiveTopN), opts);
  }
  echartInstance.setOption(option, true);
  lastExportPayload = { mode: "single", rows: rows.map((r) => ({ label: r.label, sum: r.sum, count: r.count })) };
  wireGenericClick(state.cfg.xDim);
  document.getElementById("chart-footnote").textContent = "";
}

function renderPivotChart(ct) {
  const filters = buildFilterSets();
  const cap = CHART_CAPABILITIES[ct] || {};
  let raw = queryRows(state.dataset, { filters, groupBy: [state.cfg.xDim, state.cfg.seriesDim] });
  const effectiveMeasure = cap.usesMeasure ? state.cfg.measure : "sum";
  if (effectiveMeasure !== "sum") raw = applyMeasureToRawRows(raw, effectiveMeasure);
  let pivot = toPivot(state.dataset, state.cfg.xDim, state.cfg.seriesDim, raw);
  const territorial = isTerritorialDim(state.cfg.xDim);
  if (cap.usesTopN) pivot = applyTopNAndSortToPivot(pivot, territorial ? null : state.cfg.topN, cap.usesSort ? state.cfg.sort : "desc");
  const opts = { unit: unitLabel(), isCount: effectiveMeasure === "count", isPercent: effectiveMeasure === "pct" };
  if (ct === "heatmap") {
    const cells = [];
    pivot.categories.forEach((_, xi) => pivot.sLabels.forEach((__, si) => {
      cells.push([xi, si, pivot.series[si].data[xi]]);
    }));
    const option = buildHeatmapOption({ xCats: pivot.categories, yCats: pivot.sLabels, cells }, opts);
    echartInstance.setOption(option, true);
  } else {
    const mode = ct === "bar_grouped" ? "group" : ct === "bar_stacked" ? "stack" : "stack_pct";
    const option = buildGroupedStackedOption(pivot, { mode, unit: unitLabel() });
    echartInstance.setOption(option, true);
  }
  lastExportPayload = { mode: "pivot", pivot };
  document.getElementById("chart-footnote").textContent = effectiveMeasure === "pct" ? "Percentuale calcolata sul totale del grafico corrente (non sul totale nazionale non filtrato)." : "";
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType !== "series") return;
    showToast("Il click non filtra su questo grafico — usa i filtri nel pannello a sinistra.");
  });
}

function renderSunburstEer() {
  const filters = buildFilterSets();
  const raw = queryRows(state.dataset, { filters, groupBy: ["eerChapter", "eerCode"] });
  const byChapter = new Map();
  for (const r of raw) {
    const [ch, code] = r.dims;
    if (!byChapter.has(ch)) byChapter.set(ch, []);
    byChapter.get(ch).push({ label: labelForDim(state.dataset, "eerCode", code).split(" — ")[0], code, sum: r.sum, count: r.count });
  }
  const chapters = [...byChapter.keys()];
  const hierarchy = chapters.map((ch) => {
    const children = topNBucket(byChapter.get(ch), 8);
    const total = children.reduce((s, c) => s + c.sum, 0);
    return { name: `${String(ch).padStart(2, "0")}`, value: total, code: ch, children: children.map((c) => ({ name: c.label, value: c.sum })) };
  }).sort((a, b) => b.value - a.value);
  const option = buildSunburstOption(hierarchy, { unit: unitLabel() });
  echartInstance.setOption(option, true);
  lastExportPayload = { mode: "single", rows: hierarchy.map((h) => ({ label: h.name, sum: h.value, count: 0 })) };
  document.getElementById("chart-footnote").textContent = "Capitolo EER → codice EER (max 8 codici per capitolo, resto in \"Altro\").";
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.data && params.data.code !== undefined) {
      toggleMultiFilter("eerChapter", params.data.code, 20);
      showToast(`Filtro Capitolo EER aggiornato (${params.data.name})`);
    } else if (params.componentType === "series") {
      showToast('Clicca un capitolo (anello esterno) per filtrare — i singoli codici EER non sono filtrabili da qui.');
    }
  });
}

function renderSankeyRD() {
  const filters = buildFilterSets();
  const raw = queryRows("C", { filters, groupBy: ["tipo", "att"] });
  const nodesSet = new Map();
  const links = [];
  for (const r of raw) {
    const [tipo, att] = r.dims;
    const attCode = DATA.attivita[att];
    if (tipo === 2 || attCode === "" || attCode === "CR") continue;
    const src = tipo === 0 ? "Recupero (R)" : "Smaltimento (D)";
    const tgt = attCode;
    nodesSet.set(src, true); nodesSet.set(tgt, true);
    links.push({ source: src, target: tgt, value: r.sum });
  }
  const nodes = [...nodesSet.keys()].map((name) => ({ name }));
  const option = buildSankeyOption(nodes, links, { unit: "kg" });
  echartInstance.setOption(option, true);
  lastExportPayload = { mode: "single", rows: links.map((l) => ({ label: `${l.source} → ${l.target}`, sum: l.value, count: 0 })) };
  document.getElementById("chart-footnote").textContent = "Escluse le righe con attività non specificata o Centro di Raccolta (CR).";
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.dataType !== "node") { showToast("Clicca un nodo (Recupero/Smaltimento o un codice operazione) per filtrare."); return; }
    const name = params.name;
    if (name === "Recupero (R)" || name === "Smaltimento (D)") {
      state.filters.tipo = new Set([name === "Recupero (R)" ? 0 : 1]);
      render();
      showToast(`Filtro Tipo operazione impostato su ${name}`);
    } else {
      const attIdx = DATA.attivita.indexOf(name);
      if (attIdx >= 0) { toggleMultiFilter("att", attIdx, DATA.attivita.length); showToast(`Filtro Attività aggiornato (${name})`); }
    }
  });
}

function quartiles(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => { const idx = (s.length - 1) * p; const lo = Math.floor(idx), hi = Math.ceil(idx); return s[lo] + (s[hi] - s[lo]) * (idx - lo); };
  return [s[0], q(0.25), q(0.5), q(0.75), s[s.length - 1]];
}

function renderBoxplotMacro() {
  const filters = buildFilterSets();
  const raw = queryRows(state.dataset, { filters, groupBy: ["prov"] });
  const macroGroups = { Nord: [], Centro: [], Sud: [], Isole: [] };
  for (const r of raw) {
    const region = DATA.regions[DATA.provRegionIdx[r.dims[0]]];
    const macro = MACRO_AREA_BY_REGION[region] || "Nord";
    macroGroups[macro].push(r.sum);
  }
  const groups = Object.entries(macroGroups).filter(([, v]) => v.length >= 3).map(([label, v]) => ({ label: `${label} (n=${v.length})`, macro: label, stats: quartiles(v) }));
  const option = buildBoxplotOption(groups, { unit: unitLabel() });
  echartInstance.setOption(option, true);
  lastExportPayload = { mode: "single", rows: groups.map((g) => ({ label: g.label, sum: g.stats[2], count: 0 })) };
  document.getElementById("chart-footnote").textContent = "Distribuzione dei totali provinciali per macro-area (quartili). Macro-aree con meno di 3 province non mostrate.";
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType !== "series" || !groups[params.dataIndex]) return;
    const macro = groups[params.dataIndex].macro;
    toggleMacroSelection(macro);
    showToast(`Territorio: macro-area ${macro} aggiornata nel filtro`);
  });
}

function renderRadarRoles() {
  const roleCols = ["di cui Produttore", "di cui Trasportatore", "di cui Intermediario senza detenzione", "di cui Recuperatore", "di cui Smaltitore", "di cui Centro di raccolta"];
  const roleLabels = ["Produttore", "Trasportatore", "Intermediario", "Recuperatore", "Smaltitore", "Centro racc."];
  const filters = buildFilterSets();
  const dim = state.cfg.xDim === "prov" ? "prov" : "region";
  const rows = queryD(dim, "Numero unita locali iscritte", filters);
  const top = rows.slice().sort((a, b) => b.sum - a.sum).slice(0, 3);
  const t = DATA.D;
  const series = top.map((terr) => {
    let ulTotal = 0; const roleSums = roleCols.map(() => 0);
    for (let i = 0; i < t.n; i++) {
      const p = t.prov[i];
      const match = dim === "prov" ? p === terr.code : DATA.provRegionIdx[p] === terr.code;
      if (!match) continue;
      ulTotal += t["Numero unita locali iscritte"][i];
      roleCols.forEach((c, ci) => { roleSums[ci] += t[c][i]; });
    }
    return { name: terr.label, values: roleSums.map((v) => (ulTotal > 0 ? Math.round((v / ulTotal) * 1000) / 10 : 0)) };
  });
  const indicators = roleLabels.map((name) => ({ name, max: 100 }));
  const option = buildRadarOption(series, indicators, {});
  echartInstance.setOption(option, true);
  lastExportPayload = { mode: "single", rows: series.flatMap((s) => roleLabels.map((rl, i) => ({ label: `${s.name} · ${rl}`, sum: s.values[i], count: 0 }))) };
  document.getElementById("chart-footnote").textContent = "Ruoli come % delle unità locali iscritte del territorio (non esclusivi: la somma dei ruoli supera il 100%). Confronto limitato ai 3 territori con più unità locali tra quelli selezionati.";
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType !== "series" || !params.name) return;
    if (dim === "prov") {
      const pi = DATA.provinces.indexOf(params.name);
      if (pi >= 0) { toggleProvinceSelection(pi); showToast(`${params.name}: filtro Territorio aggiornato`); }
    } else {
      const ri = DATA.regions.indexOf(params.name);
      if (ri >= 0) { toggleRegionSelection(ri); showToast(`${params.name}: filtro Territorio aggiornato`); }
    }
  });
}

function renderScatterProdTreat() {
  const fA = { ...buildFilterSets(), unit: 0 };
  const fC = buildFilterSets();
  const a = queryRows("A", { filters: fA, groupBy: ["region"] });
  const c = queryRows("C", { filters: fC, groupBy: ["region"] });
  const aMap = new Map(a.map((r) => [r.dims[0], r.sum]));
  const cMap = new Map(c.map((r) => [r.dims[0], r.sum]));
  const regionIdxs = new Set([...aMap.keys(), ...cMap.keys()]);
  const points = [...regionIdxs].map((ri) => ({ name: DATA.regions[ri], x: aMap.get(ri) || 0, y: cMap.get(ri) || 0, size: (aMap.get(ri) || 0) + (cMap.get(ri) || 0) }));
  const option = buildScatterOption(points, { unit: "kg", xLabel: "Prodotto (kg)", yLabel: "Trattato (kg)", logX: true, logY: true });
  echartInstance.setOption(option, true);
  lastExportPayload = { mode: "single", rows: points.map((p) => ({ label: p.name, sum: p.x, count: p.y })) };
  document.getElementById("chart-footnote").textContent = "Confronto interpretativo: la provincia in \"prodotti\" è quella del produttore, in \"trattati\" quella dell'impianto — non è una tracciatura del flusso di materia.";
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType !== "series" || !params.data || !params.data.name) return;
    const ri = DATA.regions.indexOf(params.data.name);
    if (ri >= 0) { toggleRegionSelection(ri); showToast(`${params.data.name}: filtro Territorio aggiornato`); }
  });
}

function renderChartView() {
  ensureEchartsInstance();
  document.getElementById("chart-title").textContent = computeChartTitle();
  renderChartBadges();

  const ct = state.chartType;
  if (ct === "map") return renderMap();
  if (ct === "sankey") return renderSankeyRD();
  if (ct === "radar") return renderRadarRoles();
  if (ct === "boxplot") return renderBoxplotMacro();
  if (ct === "sunburst") return renderSunburstEer();
  if (ct === "scatter") return renderScatterProdTreat();

  if (state.dataset === "D") {
    const filters = buildFilterSets();
    const rows = queryD(state.cfg.xDim, state.cfg.measureColD, filters).sort((a, b) => b.sum - a.sum);
    return renderSimpleChart(ct, rows);
  }

  if (["bar_grouped", "bar_stacked", "bar_stacked_pct", "heatmap"].includes(ct)) return renderPivotChart(ct);

  const filters = buildFilterSets();
  const raw = queryRows(state.dataset, { filters, groupBy: [state.cfg.xDim] });
  let rows = raw.map((r) => ({ label: labelForDim(state.dataset, state.cfg.xDim, r.dims[0]), code: r.dims[0], sum: r.sum, count: r.count }));
  rows = applyMeasure(rows, filters);
  rows.sort((a, b) => (state.cfg.sort === "asc" ? a.sum - b.sum : b.sum - a.sum));
  renderSimpleChart(ct, rows);
}

/* ======================================================================== */
/* 9. Tabella dati                                                          */
/* ======================================================================== */

let tableSort = { key: "sum", dir: "desc" };

function renderTableView() {
  let rows = [];
  const p = lastExportPayload;
  if (p && p.mode === "single") rows = p.rows;
  else if (p && p.mode === "pivot") {
    rows = [];
    p.pivot.categories.forEach((cat, xi) => {
      p.pivot.series.forEach((se) => rows.push({ label: `${cat} · ${se.name}`, sum: se.data[xi], count: 0 }));
    });
  }
  rows = rows.slice().sort((a, b) => (tableSort.dir === "asc" ? a.sum - b.sum : b.sum - a.sum));
  const total = rows.reduce((s, r) => s + r.sum, 0) || 1;
  const opts = { unit: unitLabel(), ...measureOptsFlags() };
  const thead = document.querySelector("#data-table thead");
  const tbody = document.querySelector("#data-table tbody");
  thead.innerHTML = `<tr><th>Etichetta</th><th class="num">Valore</th><th class="num">% del totale</th><th class="num">Righe</th></tr>`;
  tbody.innerHTML = rows.map((r) => `<tr><td>${r.label}</td><td class="num">${fmtExact(r.sum, opts)}</td><td class="num">${formatPct(r.sum / total)}</td><td class="num">${formatInt(r.count || 0)}</td></tr>`).join("");
}

/* ======================================================================== */
/* 10. Dataset / view switching                                             */
/* ======================================================================== */

function setDataset(ds) {
  state.dataset = ds;
  if (!state.filters.anno && applicableGroups(ds).anno) {
    const labels = ds === "B" ? DATA.meta.anno_labels_b : DATA.meta.anno_labels_ac;
    state.filters.anno = new Set([labels.indexOf("2025") >= 0 ? labels.indexOf("2025") : 0]);
  }
  const dims = DIMS_BY_DATASET[ds];
  if (!dims.some(([id]) => id === state.cfg.xDim)) state.cfg.xDim = dims[0][0];
  if (state.cfg.seriesDim && !dims.some(([id]) => id === state.cfg.seriesDim)) state.cfg.seriesDim = "";
  if (!chartTypesForDataset(ds).includes(state.chartType)) state.chartType = "map";
  state.cfg.measure = "sum";
  if (!applicableGroups(ds).unit) state.filters.unit = 0;
  document.querySelectorAll(".dataset-tab").forEach((b) => b.classList.toggle("active", b.dataset.dataset === ds));
  render();
}

function setChartType(ct) { state.chartType = ct; }

function render() {
  updateFilterRailUI();
  updateActiveChips();
  updateConfigPanelUI();
  renderKPIs();
  if (state.view === "table") { renderTableView(); showView("table"); }
  else { renderChartView(); showView("chart"); }
}

/* ======================================================================== */
/* 11. Viste rapide                                                         */
/* ======================================================================== */

const QUICK_VIEWS = [
  { title: "Mappa produzione per regione", sub: "Rifiuti prodotti · 2025 · kg", apply: () => { setDataset("A"); state.filters.anno = new Set([annoIndexFor("A", "2025")]); state.filters.unit = 0; state.cfg.mapLevel = "region"; setChartType("map"); } },
  { title: "Mappa produzione per provincia", sub: "Rifiuti prodotti · 2025 · kg", apply: () => { setDataset("A"); state.cfg.mapLevel = "prov"; setChartType("map"); } },
  { title: "Classifica province — pericolosi", sub: "Rifiuti prodotti · solo P", apply: () => { setDataset("A"); state.filters.haz = new Set([1]); state.cfg.xDim = "prov"; setChartType("ranking"); } },
  { title: "Treemap capitoli EER", sub: "Rifiuti prodotti", apply: () => { setDataset("A"); state.cfg.xDim = "eerChapter"; setChartType("treemap"); } },
  { title: "Sunburst capitolo → codice EER", sub: "Rifiuti prodotti", apply: () => { setDataset("A"); setChartType("sunburst"); } },
  { title: "Pericolosi vs non pericolosi", sub: "Rifiuti prodotti", apply: () => { setDataset("A"); state.cfg.xDim = "haz"; setChartType("pie"); } },
  { title: "Materiali End of Waste", sub: "Per categoria di materiale", apply: () => { setDataset("B"); state.cfg.xDim = "mat"; setChartType("ranking"); } },
  { title: "Ripartizione operazioni R/D", sub: "Rifiuti trattati · Sankey", apply: () => { setDataset("C"); setChartType("sankey"); } },
  { title: "Heatmap regione × capitolo EER", sub: "Rifiuti trattati", apply: () => { setDataset("C"); state.cfg.xDim = "region"; state.cfg.seriesDim = "eerChapter"; setChartType("heatmap"); } },
  { title: "Confronto 2025 vs 2026", sub: "Rifiuti prodotti · per regione", apply: () => { setDataset("A"); state.filters.anno = null; state.cfg.xDim = "region"; state.cfg.seriesDim = "anno"; setChartType("bar_grouped"); } },
  { title: "Operatori iscritti per provincia", sub: "Snapshot 24/07/2026", apply: () => { setDataset("D"); state.cfg.xDim = "prov"; state.cfg.measureColD = "Numero operatori iscritti"; setChartType("ranking"); } },
  { title: "Profilo ruoli (radar)", sub: "Top 3 territori per unità locali", apply: () => { setDataset("D"); setChartType("radar"); } },
  { title: "Prodotti vs trattati per regione", sub: "Confronto interpretativo", apply: () => { setDataset("A"); setChartType("scatter"); } },
  { title: "kg prodotti per operatore", sub: "Per provincia", apply: () => { setDataset("A"); state.cfg.xDim = "prov"; state.cfg.measure = "per_operatore"; setChartType("ranking"); } },
];

function renderQuickViews() {
  const el = document.getElementById("quick-views-grid");
  el.innerHTML = "";
  QUICK_VIEWS.forEach((qv) => {
    const btn = document.createElement("button");
    btn.className = "quick-view-btn";
    btn.innerHTML = `<span class="qv-title">${qv.title}</span><span class="qv-sub">${qv.sub}</span>`;
    btn.onclick = () => { qv.apply(); render(); closeOverlay("quick-views-overlay"); };
    el.appendChild(btn);
  });
}

/* ======================================================================== */
/* 12. Export Excel                                                         */
/* ======================================================================== */

function detailRowObject(ds, t, i) {
  if (ds === "A") return { Anno: DATA.meta.anno_labels_ac[t.anno[i]], "Provincia produttore": DATA.provinces[t.prov[i]], Regione: DATA.regions[DATA.provRegionIdx[t.prov[i]]], "Codice EER": DATA.eerCodes[t.eer[i]], Pericoloso: t.haz[i] ? "P" : "NP", "Descrizione EER": DATA.eerDesc[t.eer[i]], Quantita: t.qty[i], "Unita di misura": t.unit[i] ? "l" : "kg" };
  if (ds === "B") return { Anno: DATA.meta.anno_labels_b[t.anno[i]], "Provincia produttore": DATA.provinces[t.prov[i]], Regione: DATA.regions[DATA.provRegionIdx[t.prov[i]]], Materiale: DATA.materiali[t.mat[i]], Quantita: t.qty[i], "Unita di misura": "kg" };
  if (ds === "C") return { Anno: DATA.meta.anno_labels_ac[t.anno[i]], "Provincia impianto": DATA.provinces[t.prov[i]], Regione: DATA.regions[DATA.provRegionIdx[t.prov[i]]], "Codice EER": DATA.eerCodes[t.eer[i]], Pericoloso: t.haz[i] ? "P" : "NP", "Attivita a destinazione": DATA.attivita[t.att[i]], "Tipo operazione": t.tipo[i] === 0 ? "R" : t.tipo[i] === 1 ? "D" : "", Quantita: t.qty[i], "Unita di misura": "kg" };
  return null;
}

function collectDetailRows(cap) {
  const ds = state.dataset;
  if (ds === "D") {
    const t = DATA.D; const out = [];
    for (let i = 0; i < t.n; i++) {
      if (state.filters.prov && !state.filters.prov.has(t.prov[i])) continue;
      const row = { Provincia: DATA.provinces[t.prov[i]], Regione: DATA.regions[DATA.provRegionIdx[t.prov[i]]] };
      DATA.meta.d_measure_cols.forEach((c) => { row[c] = t[c][i]; });
      out.push(row);
    }
    return out;
  }
  const t = DATA[ds];
  const rowOk = makeFilterPredicate(ds, buildFilterSets());
  const out = [];
  for (let i = 0; i < t.n && out.length < cap; i++) {
    if (!rowOk(i)) continue;
    out.push(detailRowObject(ds, t, i));
  }
  return out;
}

function countFilteredRows() {
  const ds = state.dataset;
  if (ds === "D") { let c = 0; const t = DATA.D; for (let i = 0; i < t.n; i++) if (!state.filters.prov || state.filters.prov.has(t.prov[i])) c++; return c; }
  const t = DATA[ds];
  const rowOk = makeFilterPredicate(ds, buildFilterSets());
  let c = 0;
  for (let i = 0; i < t.n; i++) if (rowOk(i)) c++;
  return c;
}

function filterSummaryText() {
  const parts = [];
  const app = applicableGroups(state.dataset);
  if (app.anno) { const labels = state.dataset === "B" ? DATA.meta.anno_labels_b : DATA.meta.anno_labels_ac; parts.push(["Anno", state.filters.anno ? [...state.filters.anno].map((i) => labels[i]).join(", ") : "Tutti"]); }
  if (app.unit) parts.push(["Unità di misura", unitLabel()]);
  parts.push(["Territorio", countSelectedProv() < DATA.provinces.length ? `${countSelectedProv()} province selezionate` : "Tutte le province"]);
  if (app.haz) parts.push(["Pericolosità", state.filters.haz ? (state.filters.haz.has(1) ? "Solo P" : "Solo NP") : "Tutti"]);
  if (app.eerChapter) parts.push(["Capitolo EER", state.filters.eerChapter ? `${state.filters.eerChapter.size} selezionati` : "Tutti"]);
  if (app.eerCode) parts.push(["Codice EER (dettaglio)", state.filters.eerCode ? `${state.filters.eerCode.size} selezionati` : "Tutti"]);
  if (app.mat) parts.push(["Materiale", state.filters.mat ? `${state.filters.mat.size} selezionati` : "Tutti"]);
  if (app.tipo) parts.push(["Tipo operazione", state.filters.tipo ? [...state.filters.tipo].join(",") : "Tutti"]);
  if (app.att) parts.push(["Attività R/D (dettaglio)", state.filters.att ? `${state.filters.att.size} selezionate` : "Tutte"]);
  return parts;
}

function buildChartSheetAoa() {
  const p = lastExportPayload;
  const rows = [["Etichetta", "Valore", "Numero di righe"]];
  if (!p) return rows;
  if (p.mode === "single") p.rows.forEach((r) => rows.push([r.label, r.sum, r.count || 0]));
  else if (p.mode === "pivot") {
    rows[0] = ["Categoria", ...p.pivot.sLabels];
    p.pivot.categories.forEach((cat, xi) => rows.push([cat, ...p.pivot.series.map((se) => se.data[xi])]));
  }
  return rows;
}

function buildProvenanceAoa() {
  const rows = [];
  rows.push(["Esportato il", new Date().toLocaleString("it-IT")]);
  rows.push(["Strumento", "RENTRI Esploratore dati"]);
  rows.push(["Dataset", DATASET_LABELS[state.dataset]]);
  rows.push(["Tipo di grafico", (CHART_TYPES.find((t) => t.id === state.chartType) || { label: state.chartType }).label]);
  rows.push(["Fonte", DATA.meta.build_source]);
  rows.push(["Data di estrazione dei dati", DATA.meta.extraction_date]);
  rows.push([]);
  rows.push(["Filtri attivi", ""]);
  filterSummaryText().forEach(([k, v]) => rows.push([k, v]));
  rows.push([]);
  rows.push(["Righe totali nel dataset", DATA[state.dataset].n]);
  rows.push(["Righe dopo i filtri", countFilteredRows()]);
  rows.push([]);
  rows.push(["Riutilizzo", "Libero citando la fonte"]);
  return rows;
}

function buildNotesAoa() {
  return [
    ["Note metodologiche"],
    ["2026 è un anno parziale (dati al 24/07/2026, ~7 mesi): confronti diretti con il 2025 vanno letti con cautela."],
    ["2024 è l'anno di avvio del tracciamento: dati minimi, non rappresentativi di un anno pieno."],
    ["I quantitativi in kg e in litri non sono sommabili tra loro (report Rifiuti prodotti)."],
    ["Nel report Operatori/UL i sei ruoli non sono esclusivi: la somma dei ruoli supera il totale delle unità locali."],
    ["Il report Operatori/UL è un'istantanea al 24/07/2026, senza dimensione anno."],
    ["Nel report Rifiuti prodotti la provincia è quella del produttore; nel report Rifiuti trattati è quella dell'impianto: un confronto tra i due dataset è interpretativo, non una tracciatura del flusso di materia."],
    ["4 province soppresse nel 2016 (CI, VS, OG, OT) sono presenti nei dati storici; sulla mappa sono aggregate ai confini attuali (SU/NU/SS)."],
    ["Fonte: " + DATA.meta.build_source],
  ].map((r) => [r[0]]);
}

function openExportModal() {
  document.getElementById("export-detail-count").textContent = `(${formatInt(countFilteredRows())} righe)`;
  const warnEl = document.getElementById("export-warning");
  const n = countFilteredRows();
  if (n > 50000) { warnEl.classList.remove("hidden"); warnEl.textContent = n > 200000 ? `Attenzione: ${formatInt(n)} righe, verranno esportate solo le prime 200.000.` : `Attenzione: file pesante (${formatInt(n)} righe).`; }
  else warnEl.classList.add("hidden");
  showOverlay("export-modal");
}

function doExport() {
  const includeChart = document.getElementById("export-chart").checked;
  const includeDetail = document.getElementById("export-detail").checked;
  const wb = XLSX.utils.book_new();
  if (includeChart) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildChartSheetAoa()), "Grafico");
  if (includeDetail) {
    const detail = collectDetailRows(200000);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "Dati_dettaglio");
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildProvenanceAoa()), "Filtri_e_fonte");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildNotesAoa()), "Note_metodologiche");
  const filename = `RENTRI_${state.dataset}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
  closeOverlay("export-modal");
  showToast("File Excel generato: " + filename);
}

/* ======================================================================== */
/* 13. Overlay / toast / tema                                               */
/* ======================================================================== */

function showOverlay(id) { document.getElementById(id).classList.remove("hidden"); }
function closeOverlay(id) { document.getElementById(id).classList.add("hidden"); }

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function initTheme() {
  const saved = localStorage.getItem("rentri-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("btn-theme").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("rentri-theme", next);
    if (echartInstance) render();
  };
}

const NOTES_HTML = `
<h4>Copertura temporale</h4><p>2024 è l'anno di avvio del tracciamento (dati minimi). 2026 è un anno parziale, dati al 24/07/2026 (~7 mesi): non confrontabile ad armi pari con un 2025 completo.</p>
<h4>Unità di misura</h4><p>Nel report "Rifiuti prodotti" convivono kg e litri: non sono mai sommati tra loro. Il filtro Unità è obbligatorio.</p>
<h4>Province produttore vs impianto</h4><p>Nel report "Rifiuti prodotti" la provincia è quella del produttore; nel report "Rifiuti trattati" è quella dell'impianto di destinazione. Un confronto tra i due dataset è interpretativo, non traccia un flusso di materia reale.</p>
<h4>Operatori e unità locali</h4><p>Il report è un'istantanea al 24/07/2026, senza dimensione anno. I sei ruoli (Produttore, Trasportatore, ecc.) non sono esclusivi: un'unità locale può avere più ruoli, quindi la somma dei ruoli supera il totale delle unità locali.</p>
<h4>Province soppresse</h4><p>4 province sarde soppresse nel 2016 (CI, VS, OG, OT) sono presenti nei dati storici RENTRI. Sulle mappe sono aggregate ai confini attuali (rispettivamente SU, SU, NU, SS); nella tabella dati e nell'export restano con la sigla originale.</p>
<h4>Fonte e riutilizzo</h4><p>MASE – RENTRI, cruscotto pubblico area-consultazione (www.rentri.gov.it/area-consultazione). Dati estratti il 24/07/2026. Riutilizzo libero citando la fonte.</p>
`;

/* ======================================================================== */
/* 14. Bootstrap                                                            */
/* ======================================================================== */

function wireStaticUI() {
  document.querySelectorAll(".dataset-tab").forEach((btn) => { btn.onclick = () => setDataset(btn.dataset.dataset); });
  document.querySelectorAll(".view-tab").forEach((btn) => { btn.onclick = () => { state.view = btn.dataset.view; render(); }; });
  document.getElementById("btn-reset-filters").onclick = resetAllFilters;
  document.getElementById("filter-region-search").oninput = renderTerritoryFilter;
  document.getElementById("filter-eercode-search").oninput = renderEerCodeFilter;

  document.getElementById("btn-quick-views").onclick = () => { renderQuickViews(); showOverlay("quick-views-overlay"); };
  document.getElementById("btn-close-quick-views").onclick = () => closeOverlay("quick-views-overlay");
  document.getElementById("btn-notes").onclick = () => { document.getElementById("notes-content").innerHTML = NOTES_HTML; showOverlay("notes-drawer"); };
  document.getElementById("btn-close-notes").onclick = () => closeOverlay("notes-drawer");
  document.getElementById("btn-export").onclick = openExportModal;
  document.getElementById("btn-close-export").onclick = () => closeOverlay("export-modal");
  document.getElementById("btn-do-export").onclick = doExport;
  document.getElementById("btn-collapse-config").onclick = () => document.getElementById("config-panel").classList.toggle("hidden");

  document.querySelectorAll(".overlay").forEach((ov) => { ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); }); });
  initTheme();
}

async function boot() {
  try {
    const raw = base64ToUint8Array(document.getElementById("rentri-data").textContent.trim());
    const gunz = await gunzipToUint8Array(raw);
    const parsed = parseBinaryPayload(gunz);
    DATA = buildDataModel(parsed);
    runBrowserSelfCheck();
    await loadGeo();
    resetAllFilters();
    wireStaticUI();
    render();
  } catch (err) {
    console.error(err);
    document.getElementById("chart-canvas").innerHTML = `<div style="padding:40px;color:#B0413E;">Errore di avvio: ${err.message}</div>`;
  }
}

boot();
