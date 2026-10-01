/* chart_registry.js
 * Metadati dei tipi di grafico, palette, formattazione numerica e i builder
 * di opzioni ECharts. Nessuna dipendenza da app.js: riceve dati già
 * aggregati (array di {label, code, sum, count, ...}) e restituisce una
 * option ECharts pronta per setOption().
 */

/* ---------------------------------------------------------------------- */
/* Palette e costanti visive                                              */
/* ---------------------------------------------------------------------- */

const PALETTE_CATEGORICAL = [
  "#0F766E", "#B45309", "#3B6FA0", "#7C5FBF", "#B0413E",
  "#5B8A3C", "#C77DA0", "#8A6D3B", "#4A7C82", "#A3A34E",
  "#6B5CA5", "#94A3B8",
];

const PALETTE_SEQUENTIAL_TEAL = [
  "#E9F3F1", "#C7E3DE", "#9ED0C7", "#6FB8AB", "#469E8F",
  "#277F72", "#0F6157",
];

const PALETTE_DIVERGING = ["#8C510A", "#BF812D", "#DFC27D", "#F5F0E9", "#80CDC1", "#35978F", "#01665E"];

const COLOR_HAZ_P = "#B45309";
const COLOR_HAZ_NP = "#94A3B8";
const COLOR_R = "#0F766E";
const COLOR_D = "#8A6D3B";
const COLOR_MISSING = "#E9ECEF";

const CHAPTER_LABELS = {
  "01": "Prospezione, estrazione, trattamento minerali e cave",
  "02": "Agricoltura, zootecnia, silvicoltura, pesca, alimentare",
  "03": "Lavorazione legno e produzione carta/cartone",
  "04": "Industrie conciarie e tessili",
  "05": "Raffinazione petrolio e trattamento gas naturale",
  "06": "Processi chimici inorganici",
  "07": "Processi chimici organici",
  "08": "Rivestimenti, adesivi, sigillanti, inchiostri",
  "09": "Industria fotografica",
  "10": "Processi termici",
  "11": "Trattamento chimico superficiale dei metalli",
  "12": "Lavorazione fisico/meccanica di metalli e plastica",
  "13": "Oli esauriti",
  "14": "Solventi organici, refrigeranti e propellenti",
  "15": "Imballaggi, assorbenti, stracci, materiali filtranti",
  "16": "Rifiuti non specificati altrimenti",
  "17": "Costruzione e demolizione",
  "18": "Attività sanitaria umana e veterinaria",
  "19": "Impianti di trattamento rifiuti",
  "20": "Rifiuti urbani e assimilabili",
};

const MACRO_AREA_BY_REGION = {
  "Piemonte": "Nord", "Valle d'Aosta": "Nord", "Lombardia": "Nord",
  "Trentino-Alto Adige": "Nord", "Veneto": "Nord", "Friuli-Venezia Giulia": "Nord",
  "Liguria": "Nord", "Emilia-Romagna": "Nord",
  "Toscana": "Centro", "Umbria": "Centro", "Marche": "Centro", "Lazio": "Centro",
  "Abruzzo": "Sud", "Molise": "Sud", "Campania": "Sud", "Puglia": "Sud",
  "Basilicata": "Sud", "Calabria": "Sud",
  "Sicilia": "Isole", "Sardegna": "Isole",
};

const ATTIVITA_LABELS = {
  "": "N/D (non specificata)", "CR": "CR - Centro di raccolta",
  R1: "R1 - Combustibile/comb. rifiuti", R2: "R2 - Recupero solventi", R3: "R3 - Recupero sostanze organiche",
  R4: "R4 - Recupero metalli/composti", R5: "R5 - Recupero altre sostanze inorganiche", R6: "R6 - Rigenerazione acidi/basi",
  R7: "R7 - Recupero prodotti da abbattimento inquinamento", R8: "R8 - Recupero prodotti da catalizzatori",
  R9: "R9 - Rigenerazione oli", R10: "R10 - Spandimento su suolo", R11: "R11 - Utilizzo rifiuti da R1-R10",
  R12: "R12 - Scambio rifiuti destinati a R1-R11", R13: "R13 - Deposito rifiuti destinati a R1-R12",
  D1: "D1 - Deposito su/sotto suolo", D2: "D2 - Trattamento in ambiente terrestre", D3: "D3 - Iniezione in profondità",
  D4: "D4 - Lagunaggio", D5: "D5 - Messa in discarica attrezzata", D6: "D6 - Scarico in ambiente idrico",
  D7: "D7 - Immissione in mare", D8: "D8 - Trattamento biologico", D9: "D9 - Trattamento chimico-fisico",
  D10: "D10 - Incenerimento a terra", D11: "D11 - Incenerimento in mare", D12: "D12 - Deposito permanente",
  D13: "D13 - Raggruppamento preliminare", D14: "D14 - Ricondizionamento preliminare",
  D15: "D15 - Deposito preliminare",
};

/* ---------------------------------------------------------------------- */
/* Formattazione numerica (it-IT)                                         */
/* ---------------------------------------------------------------------- */

const nfInt = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 });
const nfDec1 = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const nfPct1 = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function formatInt(n) { return nfInt.format(Math.round(n)); }

function formatQty(value, unit) {
  // value in kg or litres (unit: 'kg'|'l'). Auto-scale kg->t->kt->Mt, l->l->kl->Ml.
  const isL = unit === "l";
  const steps = isL
    ? [{ d: 1, s: "l" }, { d: 1e3, s: "kl" }, { d: 1e6, s: "Ml" }]
    : [{ d: 1, s: "kg" }, { d: 1e3, s: "t" }, { d: 1e6, s: "kt" }, { d: 1e9, s: "Mt" }];
  let chosen = steps[0];
  for (const s of steps) { if (Math.abs(value) >= s.d) chosen = s; }
  const scaled = value / chosen.d;
  return `${nfDec1.format(scaled)} ${chosen.s}`;
}

function formatQtyExact(value, unit) {
  return `${formatInt(value)} ${unit === "l" ? "l" : "kg"}`;
}

function formatPct(fraction) { return `${nfPct1.format(fraction * 100)}%`; }

/* fmt/fmtExact: unified value formatter respecting the active measure mode
 * (sum in kg/l, row count, % of national total, or a per-operator ratio). */
function fmt(value, opts) {
  if (opts.isPercent) return formatPct(value);
  if (opts.isCount) return `${formatInt(value)} righe`;
  if (opts.isRatio) return `${nfDec1.format(value)} kg/op.`;
  return formatQty(value, opts.unit);
}
function fmtExact(value, opts) {
  if (opts.isPercent) return formatPct(value);
  if (opts.isCount) return `${formatInt(value)} righe`;
  if (opts.isRatio) return `${nfDec1.format(value)} kg/operatore`;
  return formatQtyExact(value, opts.unit);
}

/* ---------------------------------------------------------------------- */
/* Aggregazione: top-N + "Altro"                                          */
/* ---------------------------------------------------------------------- */

function topNBucket(rows, n, valueKey = "sum") {
  if (!n || rows.length <= n) return rows.slice().sort((a, b) => b[valueKey] - a[valueKey]);
  const sorted = rows.slice().sort((a, b) => b[valueKey] - a[valueKey]);
  const head = sorted.slice(0, n);
  const tail = sorted.slice(n);
  const otherSum = tail.reduce((s, r) => s + r[valueKey], 0);
  const otherCount = tail.reduce((s, r) => s + (r.count || 0), 0);
  if (otherSum > 0 || otherCount > 0) {
    head.push({ label: "Altro", code: "__other__", sum: otherSum, count: otherCount, isOther: true });
  }
  return head;
}

/* ---------------------------------------------------------------------- */
/* Compatibilità tipo-grafico / contesto                                  */
/* ---------------------------------------------------------------------- */

const CHART_TYPES = [
  { id: "map", label: "Mappa", group: "territorio" },
  { id: "bar", label: "Barre", group: "confronto" },
  { id: "bar_grouped", label: "Barre raggruppate", group: "confronto" },
  { id: "bar_stacked", label: "Barre impilate", group: "confronto" },
  { id: "bar_stacked_pct", label: "Barre 100% impilate", group: "confronto" },
  { id: "ranking", label: "Classifica", group: "confronto" },
  { id: "pie", label: "Torta / ciambella", group: "composizione" },
  { id: "treemap", label: "Treemap", group: "composizione" },
  { id: "sunburst", label: "Sunburst", group: "composizione" },
  { id: "scatter", label: "Scatter / bolle", group: "relazione" },
  { id: "heatmap", label: "Heatmap", group: "relazione" },
  { id: "sankey", label: "Sankey (R/D)", group: "relazione" },
  { id: "boxplot", label: "Boxplot", group: "distribuzione" },
  { id: "radar", label: "Radar (ruoli)", group: "distribuzione" },
];

const CHART_CATEGORIES = [
  { id: "territorio", label: "Territorio" },
  { id: "confronto", label: "Confronto" },
  { id: "composizione", label: "Composizione" },
  { id: "relazione", label: "Relazione" },
  { id: "distribuzione", label: "Distribuzione" },
];

/* Capacità di ogni tipo di grafico: quali controlli del pannello "Configura
 * grafico" hanno un effetto reale. Il pannello si adatta a questa tabella
 * invece di mostrare sempre tutti i controlli — evita che un click su un
 * controllo senza effetto sembri "non fare nulla". */
const CHART_CAPABILITIES = {
  map: { usesXDim: false, usesSeries: false, usesMeasure: true, usesTopN: false, usesSort: false, usesOrientation: false, usesLabels: false, note: "Il livello geografico (Regione/Provincia) si sceglie qui sopra, non tramite \"Raggruppa per\"." },
  bar: { usesXDim: true, usesSeries: false, usesMeasure: true, usesTopN: true, usesSort: true, usesOrientation: true, usesLabels: true },
  bar_grouped: { usesXDim: true, usesSeries: true, seriesRequired: true, usesMeasure: true, usesTopN: true, usesSort: true, usesOrientation: false, usesLabels: false },
  bar_stacked: { usesXDim: true, usesSeries: true, seriesRequired: true, usesMeasure: true, usesTopN: true, usesSort: true, usesOrientation: false, usesLabels: false },
  bar_stacked_pct: { usesXDim: true, usesSeries: true, seriesRequired: true, usesMeasure: false, usesTopN: true, usesSort: true, usesOrientation: false, usesLabels: false, note: "I valori sono sempre in % (la misura non si applica)." },
  ranking: { usesXDim: true, usesSeries: false, usesMeasure: true, usesTopN: true, usesSort: true, usesOrientation: false, usesLabels: false, note: "Orientamento sempre orizzontale (è una classifica)." },
  pie: { usesXDim: true, usesSeries: false, usesMeasure: true, usesTopN: true, usesSort: false, usesOrientation: false, usesLabels: false, note: "Ordinata sempre per valore decrescente." },
  treemap: { usesXDim: true, usesSeries: false, usesMeasure: true, usesTopN: true, usesSort: false, usesOrientation: false, usesLabels: false, note: "Ordinato sempre per valore (dimensione dei riquadri)." },
  sunburst: { usesXDim: false, usesSeries: false, usesMeasure: false, usesTopN: false, usesSort: false, usesOrientation: false, usesLabels: false, note: "Vista fissa: capitolo EER → codice EER (non dipende dai campi Dati)." },
  scatter: { usesXDim: false, usesSeries: false, usesMeasure: false, usesTopN: false, usesSort: false, usesOrientation: false, usesLabels: false, note: "Vista fissa: prodotto vs trattato per regione (non dipende dai campi Dati)." },
  heatmap: { usesXDim: true, usesSeries: true, seriesRequired: true, usesMeasure: true, usesTopN: true, usesSort: false, usesOrientation: false, usesLabels: false, note: "Le celle si leggono per riga e colonna: non serve un ordinamento unico." },
  sankey: { usesXDim: false, usesSeries: false, usesMeasure: false, usesTopN: false, usesSort: false, usesOrientation: false, usesLabels: false, note: "Vista fissa: Recupero/Smaltimento → operazione specifica (non dipende dai campi Dati)." },
  boxplot: { usesXDim: false, usesSeries: false, usesMeasure: true, usesTopN: false, usesSort: false, usesOrientation: false, usesLabels: false, note: "Vista fissa: distribuzione dei totali provinciali per macro-area (Nord/Centro/Sud/Isole)." },
  radar: { usesXDim: "limited", usesSeries: false, usesMeasure: false, usesTopN: false, usesSort: false, usesOrientation: false, usesLabels: false, note: "Confronta i 3 territori (Provincia o Regione) con più unità locali tra quelli selezionati nel Territorio." },
};

/* Every chart type degrades gracefully now (top-N + "Altro" bucketing, or a
 * fixed dedicated view) regardless of the current grouping, so no chart-type
 * button is ever disabled — this removes an entire class of "click does
 * nothing" confusion (see CHART_CAPABILITIES for what actually adapts). */

/* ---------------------------------------------------------------------- */
/* ECharts base theming                                                    */
/* ---------------------------------------------------------------------- */

function baseGrid() {
  return { left: 90, right: 30, top: 40, bottom: 60, containLabel: true };
}

function tooltipBase(extra) {
  return Object.assign({ trigger: "item", confine: true, textStyle: { fontSize: 12 } }, extra || {});
}

/* ---------------------------------------------------------------------- */
/* Builders                                                                */
/* ---------------------------------------------------------------------- */

function buildBarOption(rows, opts) {
  const horizontal = !!opts.horizontal;
  const labels = rows.map((r) => r.label);
  const values = rows.map((r) => ({ value: r.sum, code: r.code }));
  const axisFormatter = (v) => fmt(v, opts);
  const catAxis = {
    type: "category",
    data: labels,
    axisLabel: { interval: 0, rotate: horizontal ? 0 : (labels.length > 8 ? 30 : 0), fontSize: 11 },
  };
  const valAxis = { type: "value", axisLabel: { formatter: axisFormatter } };
  return {
    color: PALETTE_CATEGORICAL,
    grid: baseGrid(),
    tooltip: tooltipBase({
      formatter: (p) => `${p.name}<br/>${fmtExact(p.value, opts)}`,
    }),
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? catAxis : valAxis,
    series: [{
      type: "bar",
      data: values,
      itemStyle: { color: PALETTE_CATEGORICAL[0], borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] },
      label: opts.showLabels ? {
        show: true, position: horizontal ? "right" : "top",
        formatter: (p) => fmt(p.value, opts),
        fontSize: 10,
      } : undefined,
    }],
  };
}

function buildRankingOption(rows, opts) {
  const sorted = rows.slice().sort((a, b) => (opts.asc ? a.sum - b.sum : b.sum - a.sum));
  const bucketed = topNBucket(sorted, opts.topN || 15);
  const total = rows.reduce((s, r) => s + r.sum, 0);
  const labels = bucketed.map((r) => r.label);
  const values = bucketed.map((r) => ({ value: r.sum, code: r.code }));
  return {
    color: PALETTE_CATEGORICAL,
    grid: baseGrid(),
    tooltip: tooltipBase({
      formatter: (p) => {
        const pct = total ? formatPct(p.value / total) : "";
        return `${p.name}<br/>${fmtExact(p.value, opts)} (${pct} del totale)`;
      },
    }),
    xAxis: { type: "value", axisLabel: { formatter: (v) => fmt(v, opts) } },
    yAxis: { type: "category", data: labels.slice().reverse(), axisLabel: { fontSize: 11 } },
    series: [{
      type: "bar",
      data: values.slice().reverse(),
      itemStyle: {
        color: (p) => (bucketed[bucketed.length - 1 - p.dataIndex].isOther ? "#94A3B8" : PALETTE_CATEGORICAL[0]),
        borderRadius: [0, 3, 3, 0],
      },
      label: {
        show: true, position: "right", fontSize: 10,
        formatter: (p) => fmt(p.value, opts),
      },
    }],
  };
}

function buildGroupedStackedOption(pivot, opts) {
  // pivot: {categories:[...], series:[{name, data:[...]}]}, opts.mode: 'group'|'stack'|'stack_pct'
  let seriesData = pivot.series;
  if (opts.mode === "stack_pct") {
    const totals = pivot.categories.map((_, i) => seriesData.reduce((s, se) => s + se.data[i], 0));
    seriesData = seriesData.map((se) => ({ name: se.name, data: se.data.map((v, i) => (totals[i] ? v / totals[i] : 0)) }));
  }
  const stackKey = opts.mode === "group" ? undefined : "total";
  return {
    color: PALETTE_CATEGORICAL,
    grid: baseGrid(),
    legend: { top: 0, type: "scroll" },
    tooltip: tooltipBase({
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params) => {
        let s = `${params[0].axisValueLabel}<br/>`;
        for (const p of params) {
          const v = opts.mode === "stack_pct" ? formatPct(p.value) : fmtExact(p.value, opts);
          s += `${p.marker} ${p.seriesName}: ${v}<br/>`;
        }
        return s;
      },
    }),
    xAxis: { type: "category", data: pivot.categories, axisLabel: { interval: 0, rotate: pivot.categories.length > 8 ? 30 : 0, fontSize: 11 } },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: (v) => (opts.mode === "stack_pct" ? `${Math.round(v * 100)}%` : fmt(v, opts)),
      },
      max: opts.mode === "stack_pct" ? 1 : undefined,
    },
    series: seriesData.map((se, i) => ({
      name: se.name,
      type: "bar",
      stack: stackKey,
      data: se.data,
      itemStyle: { color: PALETTE_CATEGORICAL[i % PALETTE_CATEGORICAL.length] },
    })),
  };
}

function buildPieOption(rows, opts) {
  const bucketed = topNBucket(rows, opts.topN || 8);
  const total = bucketed.reduce((s, r) => s + r.sum, 0);
  return {
    color: PALETTE_CATEGORICAL,
    tooltip: tooltipBase({ formatter: (p) => `${p.name}<br/>${fmtExact(p.value, opts)} (${p.percent}%)` }),
    legend: { orient: "vertical", left: 0, top: "middle", textStyle: { fontSize: 11 } },
    series: [{
      type: "pie",
      radius: opts.donut ? ["45%", "72%"] : "72%",
      center: ["62%", "50%"],
      data: bucketed.map((r) => ({ name: r.label, value: r.sum, code: r.code })),
      label: { formatter: (p) => `${p.name}\n${formatPct(p.value / total)}`, fontSize: 10 },
      itemStyle: { borderColor: "#fff", borderWidth: 1 },
    }],
  };
}

function buildTreemapOption(rows, opts) {
  const bucketed = topNBucket(rows, opts.topN || 30);
  return {
    tooltip: tooltipBase({ formatter: (p) => `${p.name}<br/>${fmtExact(p.value, opts)}` }),
    series: [{
      type: "treemap",
      data: bucketed.map((r) => ({ name: r.label, value: r.sum, code: r.code })),
      breadcrumb: { show: false },
      label: { fontSize: 11, formatter: (p) => `${p.name}\n${fmt(p.value, opts)}` },
      itemStyle: { borderColor: "#fff", gapWidth: 2 },
      color: PALETTE_CATEGORICAL,
      roam: false,
    }],
  };
}

function buildSunburstOption(hierarchy, opts) {
  return {
    tooltip: tooltipBase({ formatter: (p) => `${p.name}<br/>${fmtExact(p.value, opts)}` }),
    series: [{
      type: "sunburst",
      data: hierarchy,
      radius: [0, "90%"],
      label: { fontSize: 10, minAngle: 8 },
      itemStyle: { borderColor: "#fff", borderWidth: 1 },
      color: PALETTE_CATEGORICAL,
    }],
  };
}

function buildScatterOption(points, opts) {
  return {
    color: PALETTE_CATEGORICAL,
    grid: baseGrid(),
    tooltip: tooltipBase({
      formatter: (p) => `${p.data.name}<br/>${opts.xLabel}: ${formatQty(p.data.value[0], opts.unit)}<br/>${opts.yLabel}: ${formatQty(p.data.value[1], opts.unit)}`,
    }),
    xAxis: { type: opts.logX ? "log" : "value", name: opts.xLabel, nameLocation: "middle", nameGap: 30, axisLabel: { formatter: (v) => formatQty(v, opts.unit) } },
    yAxis: { type: opts.logY ? "log" : "value", name: opts.yLabel, nameLocation: "middle", nameGap: 55, axisLabel: { formatter: (v) => formatQty(v, opts.unit) } },
    series: [{
      type: "scatter",
      symbolSize: (d) => Math.max(8, Math.min(45, Math.sqrt(d[2] || 1) / 40)),
      data: points.map((p) => ({ name: p.name, value: [p.x, p.y, p.size || 1] })),
      itemStyle: { color: PALETTE_CATEGORICAL[0], opacity: 0.75 },
      label: { show: points.length <= 15, formatter: (p) => p.data.name, position: "top", fontSize: 10 },
    }],
  };
}

function buildHeatmapOption(matrix, opts) {
  // matrix: {xCats, yCats, cells: [[xi, yi, value], ...]}
  const values = matrix.cells.map((c) => c[2]);
  const maxV = Math.max(1, ...values);
  return {
    tooltip: tooltipBase({ formatter: (p) => `${matrix.yCats[p.value[1]]} · ${matrix.xCats[p.value[0]]}<br/>${fmtExact(p.value[2], opts)}` }),
    grid: { left: 130, right: 20, top: 30, bottom: 90, containLabel: false },
    xAxis: { type: "category", data: matrix.xCats, axisLabel: { rotate: 45, fontSize: 10, interval: 0 }, splitArea: { show: true } },
    yAxis: { type: "category", data: matrix.yCats, axisLabel: { fontSize: 10 }, splitArea: { show: true } },
    visualMap: {
      min: 0, max: maxV, calculable: true, orient: "horizontal", left: "center", bottom: 0,
      inRange: { color: PALETTE_SEQUENTIAL_TEAL },
      formatter: (v) => fmt(v, opts),
    },
    series: [{ type: "heatmap", data: matrix.cells, itemStyle: { borderColor: "#fff", borderWidth: 1 } }],
  };
}

function buildSankeyOption(nodes, links, opts) {
  return {
    tooltip: tooltipBase({ trigger: "item", formatter: (p) => (p.dataType === "edge" ? `${p.data.source} → ${p.data.target}<br/>${formatQtyExact(p.value, opts.unit)}` : p.name) }),
    series: [{
      type: "sankey",
      data: nodes,
      links: links,
      emphasis: { focus: "adjacency" },
      lineStyle: { color: "gradient", curveness: 0.5, opacity: 0.4 },
      itemStyle: { color: "#0F766E", borderColor: "#fff" },
      label: { fontSize: 11 },
    }],
  };
}

function buildBoxplotOption(groups, opts) {
  return {
    grid: baseGrid(),
    tooltip: tooltipBase({ trigger: "item" }),
    xAxis: { type: "category", data: groups.map((g) => g.label), axisLabel: { fontSize: 11 } },
    yAxis: { type: "value", axisLabel: { formatter: (v) => fmt(v, opts) } },
    series: [{ type: "boxplot", data: groups.map((g) => g.stats), itemStyle: { color: PALETTE_SEQUENTIAL_TEAL[2], borderColor: PALETTE_CATEGORICAL[0] } }],
  };
}

function buildRadarOption(series, indicators, opts) {
  return {
    color: PALETTE_CATEGORICAL,
    tooltip: tooltipBase({ trigger: "item" }),
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    radar: { indicator: indicators, radius: "65%", axisName: { fontSize: 10 } },
    series: [{
      type: "radar",
      data: series.map((s, i) => ({ name: s.name, value: s.values, areaStyle: { opacity: 0.15 }, lineStyle: { color: PALETTE_CATEGORICAL[i % PALETTE_CATEGORICAL.length] }, itemStyle: { color: PALETTE_CATEGORICAL[i % PALETTE_CATEGORICAL.length] } })),
    }],
  };
}

function buildMapOption(mapName, rows, opts) {
  const values = rows.map((r) => r.sum).filter((v) => v > 0);
  const max = Math.max(1, ...values);
  return {
    tooltip: tooltipBase({
      formatter: (p) => {
        if (p.value === undefined || p.value === null || isNaN(p.value)) return `${p.name}<br/>dato assente`;
        return `${p.name}<br/>${fmtExact(p.value, opts)}`;
      },
    }),
    visualMap: {
      min: 0, max, left: "left", bottom: 10, calculable: true,
      inRange: { color: PALETTE_SEQUENTIAL_TEAL },
      formatter: (v) => fmt(v, opts),
      textStyle: { fontSize: 10 },
    },
    series: [{
      type: "map", map: mapName, roam: true,
      emphasis: { label: { show: true, fontSize: 10 }, itemStyle: { areaColor: "#FBBF24" } },
      select: { itemStyle: { areaColor: "#0F766E" } },
      selectedMode: "multiple",
      itemStyle: { areaColor: COLOR_MISSING, borderColor: "#fff", borderWidth: 0.8 },
      label: { show: false },
      data: rows.map((r) => ({ name: r.label, value: r.sum, code: r.code })),
    }],
  };
}

function buildBubbleMapOption(mapName, rows, opts) {
  return {
    tooltip: tooltipBase({ formatter: (p) => `${p.name}<br/>${fmtExact(p.value[2], opts)}` }),
    geo: { map: mapName, roam: true, itemStyle: { areaColor: "#F1F3F5", borderColor: "#D7DCE1" }, emphasis: { itemStyle: { areaColor: "#E9F3F1" } } },
    series: [{
      type: "scatter", coordinateSystem: "geo",
      data: rows.map((r) => ({ name: r.label, value: [r.lng, r.lat, r.sum] })),
      symbolSize: (d) => Math.max(6, Math.min(55, 55 * Math.sqrt(d[2] / (opts.maxVal || 1)))),
      itemStyle: { color: PALETTE_CATEGORICAL[0], opacity: 0.7, borderColor: "#fff" },
    }],
  };
}
