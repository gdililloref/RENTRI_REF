/* monthly.js — sezione "Monitor mensile": variazioni tra scarichi successivi (Scarichi/rentri_mensile)
 *
 * Caricato PRIMA di app.js e composto solo da costanti e funzioni: viene chiamato a runtime da
 * app.js (render, setDataset, export, self-check), quando DATA e state esistono gia'.
 *
 * Modello dati: DATA.MA..MD hanno le stesse dimensioni delle tabelle annuali (stessi dizionari:
 * prov, eer, mat, att, ...) + un totale cumulato per scarico, t.tot[k] (k = indice in DATA.M.dates).
 * La variazione dell'intervallo p (da dates[p] a dates[p+1]) e' tot[p+1] - tot[p], calcolata SOLO
 * sulle righe il cui anno e' coperto da entrambi gli scarichi (DATA.M.comparable): un anno non
 * coperto da uno dei due non ha variazione, non ha variazione zero. Il build verifica che questo
 * calcolo coincida riga per riga con dettaglio_r*_variazione.csv del monitor.
 */

const M_DIMS_BY_DATASET = {
  A: [["region", "Regione"], ["prov", "Provincia"], ["eerChapter", "Capitolo EER"], ["eerCode", "Codice EER"], ["haz", "Pericolosità"]],
  B: [["region", "Regione"], ["prov", "Provincia"], ["mat", "Materiale"]],
  C: [["region", "Regione"], ["prov", "Provincia"], ["eerChapter", "Capitolo EER"], ["eerCode", "Codice EER"], ["haz", "Pericolosità"], ["att", "Attività R/D"], ["tipo", "Tipo operazione"]],
  D: [["region", "Regione"], ["prov", "Provincia"]],
};

const M_CHART_TYPES = [
  { id: "trend", label: "Andamento tra scarichi" },
  { id: "map", label: "Mappa" },
  { id: "ranking", label: "Classifica" },
  { id: "heatmap", label: "Heatmap intervalli" },
];

/* Come CHART_CAPABILITIES: quali controlli hanno un effetto reale su ogni vista. Il pannello
 * nasconde (spiegando perche') tutto il resto: mai un controllo visibile ma inerte. */
const M_CHART_CAPS = {
  trend: { usesPeriod: false, usesXDim: false, usesSeries: true, usesTopN: "series", usesSort: false, note: "Una barra per intervallo tra scarichi. Senza serie, la linea è il totale cumulato a fine intervallo. Clic su una barra = seleziona quell'intervallo." },
  map: { usesPeriod: true, usesXDim: false, usesSeries: false, usesTopN: false, usesSort: false, note: "Variazione nell'intervallo scelto a sinistra. Il livello geografico si sceglie qui sopra." },
  ranking: { usesPeriod: true, usesXDim: true, usesSeries: false, usesTopN: true, usesSort: true, note: "Variazione nell'intervallo scelto a sinistra. «Crescente» mostra prima le variazioni negative (correzioni/annullamenti)." },
  heatmap: { usesPeriod: false, usesXDim: true, usesSeries: false, usesTopN: true, usesSort: false, note: "Righe = gruppi più movimentati, colonne = intervalli. Clic su una cella = seleziona quell'intervallo." },
};

function mMeasureOptions() {
  const abs = state.dataset === "D" ? "Variazione (numero)" : "Variazione (quantità registrata)";
  return [["abs", abs], ["perday", "Media giornaliera"], ["pct", "Variazione % sul totale iniziale"]];
}
function mMeasureLabel() { return (mMeasureOptions().find(([id]) => id === state.m.measure) || [null, ""])[1]; }

/* ------------------------------------------------------------------------ */
/* Helper                                                                   */
/* ------------------------------------------------------------------------ */

function hasMonthly() { return !!(DATA && DATA.M); }
function mTable(ds) { return DATA["M" + (ds || state.dataset)]; }

function mDims() {
  const dims = M_DIMS_BY_DATASET[state.dataset].slice();
  // a gennaio il monitor puo' coprire anche l'anno appena chiuso: solo allora "Anno" e' una dimensione
  if (state.dataset !== "D" && DATA.M.annoLabels.length > 1) dims.push(["anno", "Anno"]);
  return dims;
}
function mDimLabel(dim) { return (mDims().find(([id]) => id === dim) || [null, dim])[1]; }
function mLabelForDim(dim, code) { return dim === "anno" ? DATA.M.annoLabels[code] : labelForDim(state.dataset, dim, code); }

function shortDate(iso) { const [, m, d] = iso.split("-"); return `${d}/${m}`; }
function mPeriodLabel(p) { const x = DATA.M.periods[p]; return `${shortDate(x.from)}→${shortDate(x.to)}`; }

/* intervallo selezionato: range di indici di intervallo (inclusi) */
function mPeriodRange() {
  const P = DATA.M.periods.length;
  return state.m.period === "all" ? { from: 0, to: P - 1 } : { from: state.m.period, to: state.m.period };
}
function mRangeDays(r) { let d = 0; for (let p = r.from; p <= r.to; p++) d += DATA.M.periods[p].days; return d; }
function mRangeLabel(r) {
  const P = DATA.M.periods;
  return `${shortDate(P[r.from].from)} → ${fmtDateIt(P[r.to].to)} (${mRangeDays(r)} gg)`;
}

function mInitState() {
  state.m.period = DATA.M.periods.length - 1;  // di default l'ultimo intervallo
}

function mSanitizeState() {
  const ids = mDims().map(([id]) => id);
  if (!ids.includes(state.m.xDim)) state.m.xDim = ids[0];
  if (state.m.seriesDim && !ids.includes(state.m.seriesDim)) state.m.seriesDim = "";
  if (!DATA.M.campi.includes(state.m.campo)) state.m.campo = DATA.M.campi[0];
  const P = DATA.M.periods.length;
  if (state.m.period !== "all" && !(state.m.period >= 0 && state.m.period < P)) state.m.period = P - 1;
}

/* ------------------------------------------------------------------------ */
/* Motore di query                                                          */
/* ------------------------------------------------------------------------ */

// per ogni intervallo, l'insieme degli indici-anno confrontabili (null = report senza anno)
function mComparableSets(ds) {
  const comp = DATA.M.comparable[ds];
  if (!comp) return null;
  return comp.map((labels) => new Set(labels.map((l) => DATA.M.annoLabels.indexOf(l))));
}

function mFilterSets() { return { ...buildFilterSets(), anno: null }; }

function mRowPredicate() {
  const ds = state.dataset;
  const t = mTable(ds);
  const rowOk = makeFilterPredicate("M" + ds, mFilterSets());
  const campo = ds === "D" ? DATA.M.campi.indexOf(state.m.campo) : -1;
  return (i) => (campo < 0 || t.campo[i] === campo) && rowOk(i);
}

function emptyRec() {
  return { dims: [], tot: new Float64Array(DATA.M.dates.length), vr: new Float64Array(DATA.M.periods.length), count: 0 };
}

/* Aggrega per groupBy: per ogni gruppo il totale a ogni scarico (tot) e la variazione di ogni
 * intervallo (vr) sulle sole righe confrontabili. Un solo passaggio sulle righe. */
function mQuery(groupBy) {
  const ds = state.dataset;
  const t = mTable(ds);
  const S = DATA.M.dates.length, P = DATA.M.periods.length;
  const ok = mRowPredicate();
  const comp = mComparableSets(ds);
  const out = new Map();
  for (let i = 0; i < t.n; i++) {
    if (!ok(i)) continue;
    const dims = groupBy.map((dim) => getDimValue(t, dim, i));
    const key = dims.join("||");
    let rec = out.get(key);
    if (!rec) { rec = { ...emptyRec(), dims }; out.set(key, rec); }
    for (let k = 0; k < S; k++) rec.tot[k] += t.tot[k][i];
    for (let p = 0; p < P; p++) if (!comp || comp[p].has(t.anno[i])) rec.vr[p] += t.tot[p + 1][i] - t.tot[p][i];
    rec.count++;
  }
  return [...out.values()];
}

function mergeRecs(recs) {
  const out = emptyRec();
  for (const r of recs) {
    r.tot.forEach((v, k) => { out.tot[k] += v; });
    r.vr.forEach((v, p) => { out.vr[p] += v; });
    out.count += r.count;
  }
  return out;
}

/* valore di un gruppo nell'intervallo r secondo la misura; null = non calcolabile (% senza base) */
function mValue(rec, r, measure) {
  let v = 0;
  for (let p = r.from; p <= r.to; p++) v += rec.vr[p];
  if (measure === "perday") return v / mRangeDays(r);
  if (measure === "pct") { const base = rec.tot[r.from]; return base > 0 ? v / base : null; }
  return v;
}

// variazione totale non filtrata di un intervallo: usata dal self-check del browser
function mVarTotal(ds, p) {
  const t = mTable(ds);
  const comp = mComparableSets(ds);
  let s = 0;
  for (let i = 0; i < t.n; i++) if (!comp || comp[p].has(t.anno[i])) s += t.tot[p + 1][i] - t.tot[p][i];
  return s;
}

/* ------------------------------------------------------------------------ */
/* Formattazione                                                            */
/* ------------------------------------------------------------------------ */

function mUnit() { return state.dataset === "D" ? "" : unitLabel(); }

function mFmt(v, measure, { exact = false, signed = false } = {}) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "n.d.";
  const sign = signed && v > 0 ? "+" : "";
  if (measure === "pct") return sign + formatPct(v);
  const perDay = measure === "perday";
  if (state.dataset === "D") return sign + (perDay ? nfDec1.format(v) + "/giorno" : formatInt(v));
  if (perDay) return sign + formatQty(v, mUnit()) + "/giorno";
  return sign + (exact ? formatQtyExact(v, mUnit()) : formatQty(v, mUnit()));
}
function mFmtTot(v) { return state.dataset === "D" ? formatInt(v) : formatQtyExact(v, mUnit()); }
function mSignClass(v) { return typeof v === "number" && v < 0 ? " neg" : (typeof v === "number" && v > 0 ? " pos" : ""); }

function splitValueUnit(txt) {
  const i = txt.lastIndexOf(" ");
  return i < 0 ? [txt, ""] : [txt.slice(0, i), txt.slice(i + 1)];
}

/* scala colori: sequenziale se tutti >= 0, divergente e simmetrica attorno a zero se ci sono
 * variazioni negative (marrone = negativo, verde-acqua = positivo) */
function mVisualRange(values) {
  const vals = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  const min = vals.length ? Math.min(0, ...vals) : 0;
  const max = vals.length ? Math.max(0, ...vals) : 1;
  if (min < 0) { const m = Math.max(-min, max) || 1; return { min: -m, max: m, colors: PALETTE_DIVERGING }; }
  return { min: 0, max: max || 1, colors: PALETTE_SEQUENTIAL_TEAL };
}

/* ------------------------------------------------------------------------ */
/* Builder ECharts                                                          */
/* ------------------------------------------------------------------------ */

function mBuildTrendOption(cats, series, cum, measure, asBars) {
  const cumIdx = series.length;
  const option = {
    color: PALETTE_CATEGORICAL,
    grid: { left: 20, right: 20, top: 40, bottom: 20, containLabel: true },
    legend: { top: 0, type: "scroll" },
    tooltip: tooltipBase({
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params) => {
        let s = `${params[0].axisValueLabel.replace("\n", " · ")}<br/>`;
        for (const p of params) {
          const v = p.seriesIndex === cumIdx ? mFmt(p.value, "abs", { exact: true }) : mFmt(p.value, measure, { exact: true, signed: true });
          s += `${p.marker} ${p.seriesName}: ${v}<br/>`;
        }
        return s;
      },
    }),
    xAxis: { type: "category", data: cats, axisLabel: { fontSize: 11, interval: 0 } },
    yAxis: [{ type: "value", axisLabel: { formatter: (v) => mFmt(v, measure) } }],
    series: series.map((se, i) => ({
      name: se.name,
      type: asBars ? "bar" : "line",
      stack: asBars ? "variazione" : undefined,
      data: se.data.map((v) => (v === null ? "-" : v)),
      barMaxWidth: 80,
      itemStyle: { color: se.isOther ? "#94A3B8" : PALETTE_CATEGORICAL[i % PALETTE_CATEGORICAL.length] },
    })),
  };
  if (cum) {
    option.yAxis.push({ type: "value", position: "right", splitLine: { show: false }, axisLabel: { formatter: (v) => mFmt(v, "abs") } });
    option.series.push({
      name: "Totale cumulato a fine intervallo", type: "line", yAxisIndex: 1, data: cum,
      symbolSize: 8, lineStyle: { width: 2 }, itemStyle: { color: COLOR_HAZ_P },
    });
  }
  return option;
}

function mBuildMapOption(mapName, rows, measure) {
  const vr = mVisualRange(rows.map((r) => r.value));
  return {
    tooltip: tooltipBase({
      formatter: (p) => (typeof p.value !== "number" || isNaN(p.value))
        ? `${p.name}<br/>nessun dato confrontabile`
        : `${p.name}<br/>${mFmt(p.value, measure, { exact: true, signed: true })}`,
    }),
    visualMap: {
      min: vr.min, max: vr.max, left: "left", bottom: 10, calculable: true,
      inRange: { color: vr.colors }, formatter: (v) => mFmt(v, measure), textStyle: { fontSize: 10 },
    },
    series: [{
      type: "map", map: mapName, roam: true,
      emphasis: { label: { show: true, fontSize: 10 }, itemStyle: { areaColor: "#FBBF24" } },
      select: { itemStyle: { areaColor: "#0F766E" } },
      selectedMode: "multiple",
      itemStyle: { areaColor: COLOR_MISSING, borderColor: "#fff", borderWidth: 0.8 },
      label: { show: false },
      data: rows.filter((r) => r.value !== null).map((r) => ({ name: r.label, value: r.value })),
    }],
  };
}

function mBuildRankingOption(rows, measure) {
  // rows gia' ordinate per la lettura (prima riga in alto): l'asse categorico va dal basso
  const shown = rows.slice().reverse();
  return {
    grid: { left: 10, right: 70, top: 10, bottom: 20, containLabel: true },
    tooltip: tooltipBase({ formatter: (p) => `${p.name}<br/>${mFmt(p.value, measure, { exact: true, signed: true })}` }),
    xAxis: { type: "value", axisLabel: { formatter: (v) => mFmt(v, measure) } },
    yAxis: { type: "category", data: shown.map((r) => r.label), axisLabel: { fontSize: 11, width: 280, overflow: "truncate" } },
    series: [{
      type: "bar",
      data: shown.map((r) => ({ value: r.value, code: r.code })),
      itemStyle: {
        color: (p) => (shown[p.dataIndex].isOther ? "#94A3B8" : p.value < 0 ? PALETTE_DIVERGING[1] : PALETTE_CATEGORICAL[0]),
      },
      label: { show: true, position: "right", fontSize: 10, formatter: (p) => mFmt(p.value, measure, { signed: true }) },
    }],
  };
}

function mBuildHeatmapOption(xCats, yCats, cells, measure) {
  const vr = mVisualRange(cells.map((c) => c[2]));
  return {
    tooltip: tooltipBase({
      formatter: (p) => `${yCats[p.value[1]]}<br/>${xCats[p.value[0]].replace("\n", " · ")}: ${mFmt(p.value[2], measure, { exact: true, signed: true })}`,
    }),
    grid: { left: 10, right: 20, top: 10, bottom: 70, containLabel: true },
    xAxis: { type: "category", data: xCats, axisLabel: { fontSize: 10, interval: 0 }, splitArea: { show: true } },
    yAxis: { type: "category", data: yCats, axisLabel: { fontSize: 10, width: 240, overflow: "truncate" }, splitArea: { show: true } },
    visualMap: {
      min: vr.min, max: vr.max, calculable: true, orient: "horizontal", left: "center", bottom: 0,
      inRange: { color: vr.colors }, formatter: (v) => mFmt(v, measure),
    },
    series: [{
      type: "heatmap", data: cells,
      label: { show: yCats.length <= 25, fontSize: 9, formatter: (p) => mFmt(p.value[2], measure) },
      itemStyle: { borderColor: "#fff", borderWidth: 1 },
    }],
  };
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                */
/* ------------------------------------------------------------------------ */

function mFootnote(extra) {
  const base = "Variazione = differenza tra due scarichi successivi: è l'attività registrata nell'intervallo "
    + "(incluse registrazioni tardive e correzioni), non necessariamente quella svolta. Valori negativi = correzioni o annullamenti.";
  document.getElementById("chart-footnote").textContent = [extra, base].filter(Boolean).join(" ");
}

function mPctFootnote(nExcluded) {
  if (state.m.measure !== "pct") return "";
  return "% = variazione / totale cumulato a inizio intervallo."
    + (nExcluded ? ` ${nExcluded} gruppi senza totale iniziale (comparsi nell'intervallo) non hanno una % e sono esclusi.` : "");
}

function selectPeriod(p) {
  state.m.period = p;
  render();
  showToast(`Intervallo ${mPeriodLabel(p)} selezionato (KPI, mappa e classifica)`);
}

function mRenderTrend() {
  const P = DATA.M.periods;
  const measure = state.m.measure;
  const cats = P.map((x, p) => `${mPeriodLabel(p)}\n${x.days} gg`);
  const all = { from: 0, to: P.length - 1 };
  const perPeriod = (rec) => P.map((_, p) => mValue(rec, { from: p, to: p }, measure));
  let series, cum = null;
  if (state.m.seriesDim) {
    const dim = state.m.seriesDim;
    // serie = gruppi con piu' movimento sull'intero monitoraggio; il resto in "Altro"
    const ranked = mQuery([dim])
      .map((rec) => ({ rec, label: mLabelForDim(dim, rec.dims[0]), weight: Math.abs(mValue(rec, all, "abs")) }))
      .sort((a, b) => b.weight - a.weight);
    const head = ranked.slice(0, state.m.topN), tail = ranked.slice(state.m.topN);
    const groups = head.map((g) => ({ name: g.label, rec: g.rec }));
    if (tail.length) groups.push({ name: `Altro (${tail.length})`, rec: mergeRecs(tail.map((g) => g.rec)), isOther: true });
    series = groups.map((g) => ({ name: g.name, data: perPeriod(g.rec), isOther: g.isOther }));
  } else {
    const rec = mQuery([])[0] || emptyRec();
    series = [{ name: mMeasureLabel(), data: perPeriod(rec) }];
    cum = P.map((_, p) => rec.tot[p + 1]);
  }
  // le % non si sommano: con piu' serie diventano linee affiancate invece di barre impilate
  const asBars = !(state.m.seriesDim && measure === "pct");
  echartInstance.setOption(mBuildTrendOption(cats, series, cum, measure, asBars), true);
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType === "series" && params.dataIndex >= 0) selectPeriod(params.dataIndex);
  });
  mFootnote(mPctFootnote(0));
}

function mRenderMap() {
  const dim = state.m.mapLevel === "prov" ? "prov" : "region";
  const r = mPeriodRange();
  const measure = state.m.measure;
  const recs = mQuery([dim]);
  let rows, mapName = "rentri_regioni";
  if (dim === "prov") {
    // province soppresse sommate sui confini attuali, come nella mappa annuale (si sommano i
    // record, non i valori: la % va ricalcolata sul totale iniziale aggregato)
    mapName = "rentri_province";
    const bySigla = new Map();
    for (const rec of recs) {
      const sigla = DATA.provinceMapSigla[rec.dims[0]];
      if (!bySigla.has(sigla)) bySigla.set(sigla, []);
      bySigla.get(sigla).push(rec);
    }
    rows = [...bySigla.entries()].map(([sigla, list]) => ({ label: sigla, value: mValue(mergeRecs(list), r, measure) }));
  } else {
    rows = recs.map((rec) => ({ label: DATA.regions[rec.dims[0]], code: rec.dims[0], value: mValue(rec, r, measure) }));
  }
  echartInstance.setOption(mBuildMapOption(mapName, rows, measure), true);
  wireMapClick(dim);
  const nNull = rows.filter((x) => x.value === null).length;
  mFootnote([mPctFootnote(nNull), dim === "prov" ? "Le 4 province soppresse nel 2016 (CI, VS, OG, OT) sono aggregate sui confini attuali (SU/NU/SS)." : ""].filter(Boolean).join(" "));
}

function mRenderRanking() {
  const dim = state.m.xDim;
  const r = mPeriodRange();
  const measure = state.m.measure;
  const all = mQuery([dim]).map((rec) => ({ rec, code: rec.dims[0], label: mLabelForDim(dim, rec.dims[0]), value: mValue(rec, r, measure) }));
  const valid = all.filter((x) => x.value !== null);
  const dir = state.m.sort === "asc" ? 1 : -1;
  valid.sort((a, b) => dir * (a.value - b.value));
  // regioni e province sempre per intero (mai in "Altro"), come nei grafici annuali
  const n = isTerritorialDim(dim) ? valid.length : state.m.topN;
  let rows = valid;
  if (valid.length > n) {
    const tail = valid.slice(n);
    rows = valid.slice(0, n);
    rows.push({ label: `Altro (${tail.length})`, code: "__other__", value: mValue(mergeRecs(tail.map((x) => x.rec)), r, measure), isOther: true });
  }
  echartInstance.setOption(mBuildRankingOption(rows, measure), true);
  wireGenericClick(dim);
  mFootnote(mPctFootnote(all.length - valid.length));
}

function mRenderHeatmap() {
  const dim = state.m.xDim;
  const P = DATA.M.periods;
  const measure = state.m.measure;
  const all = { from: 0, to: P.length - 1 };
  const ranked = mQuery([dim])
    .map((rec) => ({ rec, label: mLabelForDim(dim, rec.dims[0]), weight: Math.abs(mValue(rec, all, "abs")) }))
    .sort((a, b) => b.weight - a.weight);
  const rows = isTerritorialDim(dim) ? ranked : ranked.slice(0, state.m.topN);
  const xCats = P.map((x, p) => `${mPeriodLabel(p)}\n${x.days} gg`);
  const yCats = rows.map((g) => g.label).reverse();  // il piu' movimentato in alto
  const cells = [];
  rows.slice().reverse().forEach((g, yi) => P.forEach((_, p) => {
    const v = mValue(g.rec, { from: p, to: p }, measure);
    cells.push([p, yi, v === null ? "-" : v]);
  }));
  echartInstance.setOption(mBuildHeatmapOption(xCats, yCats, cells, measure), true);
  echartInstance.off("click");
  echartInstance.on("click", (params) => {
    if (params.componentType === "series" && params.value) selectPeriod(params.value[0]);
  });
  mFootnote(mPctFootnote(0));
}

function mChartTitle() {
  const what = state.dataset === "D" ? D_MEASURE_LABELS[state.m.campo] : DATASET_LABELS[state.dataset];
  const ct = state.m.chartType;
  let s;
  if (ct === "trend") s = `${what} — variazione tra scarichi` + (state.m.seriesDim ? ` per ${mDimLabel(state.m.seriesDim)}` : "");
  else if (ct === "map") s = `${what} — variazione per ${state.m.mapLevel === "prov" ? "Provincia" : "Regione"}`;
  else if (ct === "heatmap") s = `${what} — variazione per ${mDimLabel(state.m.xDim)} e intervallo`;
  else s = `${what} — variazione per ${mDimLabel(state.m.xDim)}`;
  if (state.m.measure === "perday") s += " (media giornaliera)";
  if (state.m.measure === "pct") s += " (% sul totale iniziale)";
  return s;
}

function mRenderBadges() {
  const el = document.getElementById("chart-badges");
  el.innerHTML = "";
  const P = DATA.M.periods;
  const ct = state.m.chartType;
  const badges = [];
  if (M_CHART_CAPS[ct].usesPeriod) badges.push(["", "Intervallo: " + mRangeLabel(mPeriodRange())]);
  else badges.push(["", `${P.length} intervalli: ${fmtDateIt(P[0].from)} → ${fmtDateIt(P[P.length - 1].to)}`]);
  if (state.dataset !== "D") badges.push(["", "Anno di registrazione " + DATA.M.annoLabels.join(", ")]);
  if (state.dataset === "A") badges.push(["", "Provincia = del produttore · kg (litri convertiti)"]);
  if (state.dataset === "C") badges.push(["", "Provincia = dell'impianto di trattamento"]);
  if (!M_CHART_CAPS[ct].usesPeriod && state.m.measure === "abs" && new Set(P.map((x) => x.days)).size > 1) {
    badges.push(["warn", "Intervalli di durata diversa: per confrontarli usa «Media giornaliera»"]);
  }
  badges.forEach(([kind, text]) => {
    const span = document.createElement("span");
    span.className = "badge" + (kind === "warn" ? " badge-warn" : "");
    span.textContent = text;
    el.appendChild(span);
  });
}

function mRenderChart() {
  ensureEchartsInstance();
  document.getElementById("chart-title").textContent = mChartTitle();
  mRenderBadges();
  switch (state.m.chartType) {
    case "map": return mRenderMap();
    case "ranking": return mRenderRanking();
    case "heatmap": return mRenderHeatmap();
    default: return mRenderTrend();
  }
}

function mRenderKPIs() {
  const el = document.getElementById("kpi-strip");
  const r = mPeriodRange();
  const rec = mQuery([])[0] || emptyRec();
  const last = DATA.M.dates.length - 1;
  const totTxt = state.dataset === "D" ? [formatInt(rec.tot[last]), ""] : splitValueUnit(formatQty(rec.tot[last], mUnit()));
  const absTxt = splitValueUnit(mFmt(mValue(rec, r, "abs"), "abs", { signed: true }));
  const dayTxt = splitValueUnit(mFmt(mValue(rec, r, "perday"), "perday", { signed: true }));
  const pct = mValue(rec, r, "pct");
  const what = state.dataset === "D" ? D_MEASURE_LABELS[state.m.campo] : "Totale cumulato";
  el.innerHTML = kpiTile(totTxt[0], totTxt[1], `${what} al ${fmtDateIt(DATA.M.dates[last])}`)
    + kpiTile(absTxt[0], absTxt[1], `Registrato ${mRangeLabel(r)}`)
    + kpiTile(dayTxt[0], dayTxt[1], "Media giornaliera nell'intervallo")
    + kpiTile(mFmt(pct, "pct", { signed: true }), "", "Crescita sul totale a inizio intervallo");
}

/* ------------------------------------------------------------------------ */
/* Tabella + export                                                         */
/* ------------------------------------------------------------------------ */

// dimensione di raggruppamento della tabella = quella della vista corrente
function mCurrentTableDim() {
  const ct = state.m.chartType;
  if (ct === "map") return state.m.mapLevel === "prov" ? "prov" : "region";
  if (ct === "trend") return state.m.seriesDim || null;
  return state.m.xDim;
}

function mAggregateTable() {
  const dim = mCurrentTableDim();
  const r = mPeriodRange();
  const header = [dim ? mDimLabel(dim) : "Aggregato",
    ...DATA.M.dates.map((d) => `Totale al ${fmtDateIt(d)}`),
    ...DATA.M.periods.map((_, p) => `Var. ${mPeriodLabel(p)}`),
    `${mMeasureLabel()} · ${mRangeLabel(r)}`];
  const rows = mQuery(dim ? [dim] : []).map((rec) => ({
    label: dim ? mLabelForDim(dim, rec.dims[0]) : "Totale (filtri attivi)",
    tot: [...rec.tot], vr: [...rec.vr], value: mValue(rec, r, state.m.measure),
  }));
  rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  return { header, rows };
}

function mRenderTable() {
  const { header, rows } = mAggregateTable();
  const measure = state.m.measure;
  const thead = document.querySelector("#data-table thead");
  const tbody = document.querySelector("#data-table tbody");
  thead.innerHTML = "<tr>" + header.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("") + "</tr>";
  tbody.innerHTML = rows.map((row) => "<tr>"
    + `<td>${row.label}</td>`
    + row.tot.map((v) => `<td class="num">${mFmtTot(v)}</td>`).join("")
    + row.vr.map((v) => `<td class="num${mSignClass(v)}">${mFmt(v, "abs", { exact: true, signed: true })}</td>`).join("")
    + `<td class="num${mSignClass(row.value)}"><strong>${mFmt(row.value, measure, { exact: true, signed: true })}</strong></td>`
    + "</tr>").join("");
  document.getElementById("chart-title").textContent = mChartTitle();
}

function mDetailRowObject(ds, t, i, comp) {
  const prov = DATA.provinces[t.prov[i]];
  const regione = DATA.regions[DATA.provRegionIdx[t.prov[i]]];
  let row;
  if (ds === "A") row = { Anno: DATA.M.annoLabels[t.anno[i]], "Provincia produttore": prov, Regione: regione, "Codice EER": DATA.eerCodes[t.eer[i]], Pericoloso: t.haz[i] ? "P" : "NP", "Descrizione EER": DATA.eerDesc[t.eer[i]], "Unita di misura": "kg" };
  else if (ds === "B") row = { Anno: DATA.M.annoLabels[t.anno[i]], "Provincia produttore": prov, Regione: regione, Materiale: DATA.materiali[t.mat[i]], "Unita di misura": "kg" };
  else if (ds === "C") row = { Anno: DATA.M.annoLabels[t.anno[i]], "Provincia impianto": prov, Regione: regione, "Codice EER": DATA.eerCodes[t.eer[i]], Pericoloso: t.haz[i] ? "P" : "NP", "Attivita a destinazione": DATA.attivita[t.att[i]], "Tipo operazione": t.tipo[i] === 0 ? "R" : t.tipo[i] === 1 ? "D" : "", "Unita di misura": "kg" };
  else row = { Provincia: prov, Regione: regione, Campo: DATA.M.campi[t.campo[i]] };
  DATA.M.dates.forEach((d, k) => { row[`Tot_${d}`] = t.tot[k][i]; });
  DATA.M.periods.forEach((x, p) => {
    row[`Var_${x.to}`] = (!comp || comp[p].has(t.anno[i])) ? t.tot[p + 1][i] - t.tot[p][i] : null;
  });
  return row;
}

function mCollectDetailRows(cap) {
  const ds = state.dataset;
  const t = mTable(ds);
  const ok = mRowPredicate();
  const comp = mComparableSets(ds);
  const out = [];
  for (let i = 0; i < t.n && out.length < cap; i++) if (ok(i)) out.push(mDetailRowObject(ds, t, i, comp));
  return out;
}

function mCountFilteredRows() {
  const t = mTable();
  const ok = mRowPredicate();
  let c = 0;
  for (let i = 0; i < t.n; i++) if (ok(i)) c++;
  return c;
}

function mNotesLines() {
  return [
    "Il monitor mensile scarica periodicamente l'anno di registrazione corrente: ogni scarico è il totale cumulato esposto da RENTRI a quella data.",
    "Variazione = differenza tra due scarichi successivi, riga per riga (provincia, codice EER, attività, materiale): è l'attività REGISTRATA nell'intervallo, non necessariamente quella svolta (comprende registrazioni tardive e correzioni).",
    "Valori negativi = correzioni o annullamenti di registrazioni precedenti.",
    "Gli intervalli tra scarichi hanno durate diverse: per confrontarli usare la misura «media giornaliera».",
    "Una riga comparsa in un intervallo vale 0 nello scarico precedente; un anno non coperto da uno dei due scarichi non ha variazione (resta vuota, non zero).",
    "Il passato non è ricostruibile: la serie parte dal primo scarico archiviato.",
  ];
}

function mDoExport() {
  const includeChart = document.getElementById("export-chart").checked;
  const includeDetail = document.getElementById("export-detail").checked;
  const wb = XLSX.utils.book_new();
  if (includeChart) {
    const { header, rows } = mAggregateTable();
    const aoa = [header, ...rows.map((r) => [r.label, ...r.tot, ...r.vr, r.value])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Aggregato");
  }
  if (includeDetail) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mCollectDetailRows(200000)), "Dati_dettaglio");
  const prov = [
    ["Esportato il", new Date().toLocaleString("it-IT")],
    ["Strumento", "RENTRI Esploratore dati · Monitor mensile"],
    ["Dataset", DATASET_LABELS[state.dataset] + (state.dataset === "D" ? " · " + D_MEASURE_LABELS[state.m.campo] : "")],
    ["Vista", (M_CHART_TYPES.find((x) => x.id === state.m.chartType) || {}).label],
    ["Misura", mMeasureLabel()],
    ["Intervallo selezionato", mRangeLabel(mPeriodRange())],
    ["Scarichi disponibili", DATA.M.dates.map(fmtDateIt).join(", ")],
    ["Fonte", DATA.meta.build_source],
    [],
    ["Filtri attivi", ""],
    ...filterSummaryText(),
    [],
    ["Righe totali nel dataset", mTable().n],
    ["Righe dopo i filtri", mCountFilteredRows()],
    [],
    ["Riutilizzo", "Libero citando la fonte"],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prov), "Filtri_e_fonte");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note metodologiche"], ...mNotesLines().map((l) => [l])]), "Note_metodologiche");
  const filename = `RENTRI_mensile_${state.dataset}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
  closeOverlay("export-modal");
  showToast("File Excel generato: " + filename);
}

/* ------------------------------------------------------------------------ */
/* Pannelli: filtro intervallo (rail) e configurazione                       */
/* ------------------------------------------------------------------------ */

function renderMPeriodFilter() {
  const show = state.mode === "monthly";
  toggleHidden("group-mperiod", !show);
  if (!show) return;
  const el = document.getElementById("filter-mperiod");
  el.innerHTML = "";
  const opts = DATA.M.periods.map((x, p) => [p, mPeriodLabel(p), `${fmtDateIt(x.from)} → ${fmtDateIt(x.to)}: ${x.days} giorni`]);
  opts.push(["all", "Intero monitoraggio", `${fmtDateIt(DATA.M.dates[0])} → ${fmtDateIt(DATA.M.dates[DATA.M.dates.length - 1])}`]);
  opts.forEach(([val, label, title]) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.m.period === val ? " selected" : "");
    chip.textContent = label;
    chip.title = title;
    chip.onclick = () => { state.m.period = val; render(); };
    el.appendChild(chip);
  });
  const usesPeriod = M_CHART_CAPS[state.m.chartType].usesPeriod;
  document.getElementById("mperiod-note").textContent = (usesPeriod ? "" : "La vista corrente mostra tutti gli intervalli: la scelta vale per i KPI. ")
    + (DATA.M.annoLabels.length ? `Anno di registrazione monitorato: ${DATA.M.annoLabels.join(", ")}.` : "");
}

function mUpdateConfigPanelUI() {
  const ds = state.dataset;
  const cap = M_CHART_CAPS[state.m.chartType];
  const dims = mDims();

  toggleHidden("field-category", true);
  document.getElementById("label-charttype").textContent = "1 · Vista";
  const grid = document.getElementById("chart-type-grid");
  grid.innerHTML = "";
  M_CHART_TYPES.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "type-btn" + (state.m.chartType === t.id ? " selected" : "");
    btn.textContent = t.label;
    btn.onclick = () => { state.m.chartType = t.id; render(); };
    grid.appendChild(btn);
  });
  document.getElementById("chart-type-note").textContent = cap.note;

  const isMap = state.m.chartType === "map";
  toggleHidden("field-maplevel", !isMap);
  if (isMap) {
    const el = document.getElementById("config-maplevel");
    el.innerHTML = "";
    [["region", "Regione"], ["prov", "Provincia"]].forEach(([val, label]) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (state.m.mapLevel === val ? " selected" : "");
      chip.textContent = label;
      chip.onclick = () => { state.m.mapLevel = val; render(); };
      el.appendChild(chip);
    });
  }

  toggleHidden("section-title-dati", false);
  toggleHidden("field-xdim", !cap.usesXDim);
  toggleHidden("field-seriesdim", !cap.usesSeries);
  toggleHidden("field-measure", false);
  toggleHidden("field-campo", ds !== "D");

  const xSel = document.getElementById("config-xdim");
  if (cap.usesXDim) {
    fillSelect(xSel, dims, state.m.xDim);
    xSel.onchange = () => { state.m.xDim = xSel.value; render(); };
  }
  const sSel = document.getElementById("config-seriesdim");
  if (cap.usesSeries) {
    fillSelect(sSel, [["", "Nessuna (totale + cumulato)"], ...dims], state.m.seriesDim);
    sSel.onchange = () => { state.m.seriesDim = sSel.value; render(); };
  }
  const mSel = document.getElementById("config-measure");
  fillSelect(mSel, mMeasureOptions(), state.m.measure);
  mSel.onchange = () => { state.m.measure = mSel.value; render(); };
  if (ds === "D") {
    const cSel = document.getElementById("config-campo");
    fillSelect(cSel, DATA.M.campi.map((c) => [c, D_MEASURE_LABELS[c] || c]), state.m.campo);
    cSel.onchange = () => { state.m.campo = cSel.value; render(); };
  }

  // Top-N: sulle serie dell'andamento (solo se c'e' una serie), sui gruppi di classifica/heatmap
  // tranne regioni e province, che restano sempre per intero
  const topNApplies = cap.usesTopN === "series" ? !!state.m.seriesDim : (cap.usesTopN && !isTerritorialDim(state.m.xDim));
  toggleHidden("field-topn", !topNApplies);
  toggleHidden("field-sort", !cap.usesSort);
  toggleHidden("field-orientation", true);
  toggleHidden("field-labels", true);
  toggleHidden("section-title-aspetto", !topNApplies && !cap.usesSort);
  document.getElementById("config-hint").textContent = (cap.usesXDim && cap.usesTopN && isTerritorialDim(state.m.xDim))
    ? "Regioni e province sono sempre mostrate per intero: non vengono mai raggruppate in \"Altro\"."
    : (cap.usesTopN === "series" && state.m.seriesDim ? "Top-N = numero di serie mostrate; le altre sono sommate in \"Altro\"." : "");

  const topSel = document.getElementById("config-topn");
  topSel.value = String(state.m.topN);
  topSel.onchange = (e) => { state.m.topN = parseInt(e.target.value, 10); render(); };
  const sortSel = document.getElementById("config-sort");
  sortSel.value = state.m.sort;
  sortSel.onchange = (e) => { state.m.sort = e.target.value; render(); };
}

function mRender() {
  mUpdateConfigPanelUI();
  mRenderKPIs();
  if (state.view === "table") { mRenderTable(); showView("table"); }
  else { mRenderChart(); showView("chart"); }
}
