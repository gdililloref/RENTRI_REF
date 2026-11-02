#!/usr/bin/env python3
"""Build RENTRI single-file HTML dashboard.

Reads the 4 scraped CSVs + the Mappatura_Territorio sheet from rentri.xlsx,
cleans them, dictionary-encodes them into compact columnar binary blocks,
gzips + base64s the result, and stitches it together with the vendored JS
libraries and the app source into one self-contained HTML file.

Usage:
    python build_tool.py
"""
import gzip
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent           # Scarichi/rentri_aggregato (CSV + rentri.xlsx)
DASH_DIR = HERE.parent.parent / "Dashboard"      # Dashboard/ (sorgenti in build/, output HTML)
DATA_DIR = HERE
VENDOR_DIR = DASH_DIR / "build" / "vendor"
SRC_DIR = DASH_DIR / "build" / "src"
DIST_DIR = DASH_DIR                              # rentri_dashboard.html direttamente in Dashboard/
REPORT_DIR = DASH_DIR / "build" / "dist"         # build_report.json
REPORT_DIR.mkdir(parents=True, exist_ok=True)

SOURCE_CITATION = "MASE - RENTRI - cruscotto pubblico area-consultazione (www.rentri.gov.it/area-consultazione)"


def _extraction_date():
    """Data dell'ultimo run di rentri_scraper.py = quella dei CSV in uso (da _storico/)."""
    date_re = re.compile(r"_(\d{4}-\d{2}-\d{2})\.parquet$")
    dates = [m.group(1) for p in (HERE / "_storico").glob("r56_*.parquet")
             if (m := date_re.search(p.name))]
    if not dates:
        raise SystemExit("Nessun run in _storico/: impossibile determinare la data di estrazione")
    return max(dates)


EXTRACTION_DATE = _extraction_date()

# Provinces abolished in the 2016 Sardinian reorganisation, remapped to their
# successor for map-geometry joins only (never for the underlying data/export).
ABOLISHED_PROVINCE_REMAP = {"CI": "SU", "VS": "SU", "OG": "NU", "OT": "SS"}

# Region-name display fixes (backtick -> apostrophe, missing hyphens) applied
# only to the label shown to the user; joins to ISTAT codes go through the
# province sigla, never through this string.
REGION_DISPLAY_FIX = {
    "Valle d`Aosta": "Valle d'Aosta",
    "Emilia Romagna": "Emilia-Romagna",
    "Friuli Venezia Giulia": "Friuli-Venezia Giulia",
    "Trentino Alto Adige": "Trentino-Alto Adige",
}

CSV_READ_KW = dict(sep=";", encoding="utf-8-sig", dtype=str, keep_default_na=False)


def log(msg):
    print(f"[build] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Binary column framing
# ---------------------------------------------------------------------------

DTYPE_CODES = {"u8": 0, "u16": 1, "u32": 2, "f64": 3}
NP_DTYPE = {"u8": "<u1", "u16": "<u2", "u32": "<u4", "f64": "<f8"}
INT_RANGE = {"u8": (0, 0xFF), "u16": (0, 0xFFFF), "u32": (0, 0xFFFFFFFF)}


def qty_dtype(values):
    """u32 se tutti i valori ci stanno, altrimenti f64 (interi esatti fino a 2^53).
    Le righe cumulate dell'anno corrente superano gia' i 4,29 miliardi di kg."""
    v = np.asarray(values)
    if v.size == 0 or (v.min() >= 0 and v.max() <= 0xFFFFFFFF):
        return "u32"
    return "f64"


class BinaryWriter:
    def __init__(self):
        self.columns = []  # list of (name, dtype, np.ndarray)

    def add(self, name, dtype, values):
        src = np.asarray(values)
        if dtype in INT_RANGE and src.size:
            # astype() su interi fuori range tronca in silenzio: meglio fermare il build
            if src.dtype.kind == "f" and np.isnan(src).any():
                raise SystemExit(f"Colonna {name}: valori mancanti (NaN) non codificabili come {dtype}")
            lo, hi = INT_RANGE[dtype]
            if src.min() < lo or src.max() > hi:
                raise SystemExit(f"Colonna {name}: valori [{src.min()}, {src.max()}] fuori dal range di {dtype}")
        arr = src.astype(NP_DTYPE[dtype])
        self.columns.append((name, dtype, arr))

    def pack(self, meta_obj):
        meta_bytes = json.dumps(meta_obj, ensure_ascii=False).encode("utf-8")
        out = bytearray()
        out += b"RNT1"
        out += struct.pack("<I", len(meta_bytes))
        out += meta_bytes
        out += struct.pack("<H", len(self.columns))
        for name, dtype, arr in self.columns:
            name_b = name.encode("ascii")
            out += struct.pack("<B", len(name_b))
            out += name_b
            out += struct.pack("<B", DTYPE_CODES[dtype])
            out += struct.pack("<I", arr.size)
            out += arr.tobytes()
        return bytes(out)


def gzip_b64(raw_bytes):
    compressed = gzip.compress(raw_bytes, compresslevel=9, mtime=0)
    import base64

    return base64.b64encode(compressed).decode("ascii")


# ---------------------------------------------------------------------------
# Load + clean
# ---------------------------------------------------------------------------


def load_mappatura():
    xlsx = DATA_DIR / "rentri.xlsx"
    df = pd.read_excel(xlsx, sheet_name="Mappatura_Territorio", dtype=str, keep_default_na=False)
    df["cod_regione"] = df["cod_regione"].astype(int)
    return df


def load_report59():
    df = pd.read_csv(DATA_DIR / "report_59.csv", **CSV_READ_KW)
    assert len(df) == 111, f"report_59 expected 111 rows, got {len(df)}"
    assert (df["Provincia"] == "NA").any(), "Napoli (NA) row missing - keep_default_na regression"
    return df


def load_report56():
    df = pd.read_csv(DATA_DIR / "report_56.csv", **CSV_READ_KW)
    df["Quantita"] = df["Quantita"].astype(np.int64)
    dup_key = ["Anno", "Provincia produttore", "Codice EER", "Unita di misura"]
    assert not df.duplicated(dup_key).any(), "report_56 grain violated"
    return df


def load_report57():
    df = pd.read_csv(DATA_DIR / "report_57.csv", **CSV_READ_KW)
    df = df.drop(columns=["Materiale_ID"])
    before = len(df)
    df = df[df["Unita di misura"] == "kg"].copy()
    log(f"report_57: dropped {before - len(df)} junk rows (Quantita=0/blank unit)")
    df["Quantita"] = df["Quantita"].astype(np.int64)
    df["Materiale"] = df["Materiale"].str.replace("�", "–", regex=False)
    return df


def load_report58():
    df = pd.read_csv(DATA_DIR / "report_58.csv", **CSV_READ_KW)
    df["Quantita"] = df["Quantita"].astype(np.int64)
    assert (df["Unita di misura"] == "kg").all(), "report_58 has a non-kg row"
    dup_key = ["Anno", "Provincia impianto", "Codice EER", "Attivita a destinazione"]
    assert not df.duplicated(dup_key).any(), "report_58 grain violated"
    return df


# ---------------------------------------------------------------------------
# Monitor mensile (rentri_mensile/): totali per scarico + variazioni tra scarichi
# ---------------------------------------------------------------------------

MONTHLY_DIR = HERE.parent / "rentri_mensile"
MONTHLY_DS = {56: "A", 57: "B", 58: "C", 59: "D"}


def _date_cols(df, prefix):
    return [c for c in df.columns if c.startswith(prefix)]


def load_monthly():
    """Legge dettaglio_r{rid}_{totale,variazione}.csv. None se il monitor non ha ancora
    almeno 2 scarichi (nessuna variazione da mostrare): la dashboard nasconde la sezione."""
    if not (MONTHLY_DIR / "dettaglio_r56_totale.csv").exists():
        log(f"Monitor mensile: nessun dato in {MONTHLY_DIR} - sezione mensile esclusa")
        return None

    tables, dates = {}, None
    for rid in MONTHLY_DS:
        tot = pd.read_csv(MONTHLY_DIR / f"dettaglio_r{rid}_totale.csv", **CSV_READ_KW)
        var = pd.read_csv(MONTHLY_DIR / f"dettaglio_r{rid}_variazione.csv", **CSV_READ_KW)
        tot_cols, var_cols = _date_cols(tot, "Tot_"), _date_cols(var, "Var_")
        rid_dates = [c[4:] for c in tot_cols]
        if dates is None:
            dates = rid_dates
        assert rid_dates == dates, f"r{rid}: date degli scarichi diverse dagli altri report"
        assert var_cols == [f"Var_{d}" for d in dates[1:]], f"r{rid}: colonne Var_ incoerenti con Tot_"

        key = [c for c in tot.columns if c not in tot_cols]
        assert key == [c for c in var.columns if c not in var_cols], f"r{rid}: chiavi diverse tra totale e variazione"
        df = tot.merge(var, on=key, how="outer", validate="one_to_one", indicator=True)
        assert (df["_merge"] == "both").all(), f"r{rid}: righe presenti in un solo dei due CSV"
        df = df.drop(columns="_merge")

        for c in tot_cols + var_cols:
            v = pd.to_numeric(df[c].replace("", np.nan))
            assert ((v.dropna() % 1) == 0).all(), f"r{rid} {c}: valori non interi"
            df[c] = v
        # Tot vuoto = chiave assente in quello scarico (vale 0); Var vuota = anno non confrontabile
        df[tot_cols] = df[tot_cols].fillna(0).astype(np.int64)
        if rid == 57:
            before = len(df)
            df = df[df["Unita di misura"] == "kg"].copy()
            if before != len(df):
                log(f"mensile r57: escluse {before - len(df)} righe non in kg")
            df["Materiale"] = df["Materiale"].str.replace("�", "–", regex=False)
        tables[rid] = df

    if len(dates) < 2:
        log("Monitor mensile: un solo scarico, nessuna variazione - sezione mensile esclusa")
        return None

    # anni confrontabili per ogni intervallo = anni coperti da ENTRAMBI gli scarichi (dall'indice
    # del monitor): una variazione su un anno non coperto da uno dei due non esiste, non e' zero
    idx = pd.read_csv(MONTHLY_DIR / "snapshots" / "_index.csv", dtype=str, keep_default_na=False)
    anni = {(r.data_snapshot, int(r.report_id)): [a for a in r.anni_coperti.split(",") if a]
            for r in idx.itertuples()}
    periods, comparable = [], {}
    for p in range(len(dates) - 1):
        d0, d1 = dates[p], dates[p + 1]
        giorni = (pd.Timestamp(d1) - pd.Timestamp(d0)).days
        periods.append({"from": d0, "to": d1, "days": int(giorni)})
    for rid in (56, 57, 58):
        comparable[MONTHLY_DS[rid]] = [
            sorted(set(anni[(dates[p], rid)]) & set(anni[(dates[p + 1], rid)])) for p in range(len(periods))
        ]
    log(f"Monitor mensile: {len(dates)} scarichi ({dates[0]} -> {dates[-1]}), {len(periods)} intervalli")
    return dict(tables=tables, dates=dates, periods=periods, comparable=comparable)


# ---------------------------------------------------------------------------
# Conversione litri -> kg (report 56): la dashboard mostra un unico totale in kg
# ---------------------------------------------------------------------------

KFO_FILE = DASH_DIR / "tassi_conversione_litri_ton.xlsx"
KEY_56 = ["Anno", "Provincia produttore", "Codice EER"]


def load_kfo():
    """{codice EER senza spazi/asterisco: KFO medio t/m3}. t/m3 = kg/l, quindi kg = litri * KFO."""
    df = pd.read_excel(KFO_FILE, dtype={"Codice EER": str})
    codes = df["Codice EER"].astype(str).str.replace(" ", "", regex=False).str.replace("*", "", regex=False).str.strip()
    fattori = pd.to_numeric(df["KFO medio t/m3"], errors="raise")
    assert not codes.duplicated().any(), f"{KFO_FILE.name}: codici EER duplicati"
    assert (fattori > 0).all(), f"{KFO_FILE.name}: fattori non positivi"
    return dict(zip(codes, fattori))


def litri_to_kg(df, kfo, qty_cols, label):
    """Converte in kg le righe in litri (arrotondando all'intero) e somma kg + litri convertiti
    della stessa chiave in un'unica riga in kg. Si ferma se un codice in litri non ha fattore:
    meglio un build fallito che litri spariti in silenzio dal totale."""
    is_l = df["Unita di misura"] == "l"
    mancanti = sorted(set(df.loc[is_l, "Codice EER"]) - set(kfo))
    if mancanti:
        raise SystemExit(f"{label}: codici EER in litri senza fattore in {KFO_FILE.name}: {mancanti}")
    f = df.loc[is_l, "Codice EER"].map(kfo).to_numpy()
    df = df.copy()
    for c in qty_cols:
        df[c] = df[c].astype(np.float64)
        df.loc[is_l, c] = np.rint(df.loc[is_l, c].to_numpy() * f)
        df[c] = df[c].astype(np.int64)
    df["Unita di misura"] = "kg"
    other = [c for c in df.columns if c not in KEY_56 + qty_cols]
    agg = {**{c: "sum" for c in qty_cols}, **{c: "first" for c in other}}
    out = df.groupby(KEY_56, as_index=False, sort=False).agg(agg)[df.columns]
    log(f"{label}: {int(is_l.sum())} righe in litri convertite in kg ({len(df)} -> {len(out)} righe)")
    return out


def stima_litri_per_anno(df56_raw, kfo):
    """Per le note della dashboard: quanta parte del totale kg e' stimata da litri."""
    out = {}
    for anno, g in df56_raw.groupby("Anno"):
        l = g[g["Unita di misura"] == "l"]
        kg_stim = float(np.rint(l["Quantita"] * l["Codice EER"].map(kfo)).sum())
        kg_dich = float(g.loc[g["Unita di misura"] == "kg", "Quantita"].sum())
        out[anno] = dict(litri=int(l["Quantita"].sum()), kg_stimati=int(kg_stim),
                         quota=(kg_stim / (kg_stim + kg_dich)) if (kg_stim + kg_dich) else 0.0)
    return out


def self_check_monthly(m):
    """La variazione esposta dal monitor deve coincidere con la differenza dei totali, riga per
    riga, sulle righe confrontabili - e mancare del tutto su quelle non confrontabili. La
    dashboard ricalcola le variazioni dai totali, quindi questa e' la garanzia che i numeri
    mostrati coincidono con variazione_mensile_dettaglio.xlsx."""
    dates, failed, expected = m["dates"], [], {}
    for rid, df in m["tables"].items():
        ds = MONTHLY_DS[rid]
        for p in range(len(m["periods"])):
            t0, t1, vc = f"Tot_{dates[p]}", f"Tot_{dates[p + 1]}", f"Var_{dates[p + 1]}"
            if ds == "D":
                ok_rows = np.ones(len(df), dtype=bool)
            else:
                ok_rows = df["Anno"].isin(m["comparable"][ds][p]).to_numpy()
            diff = (df[t1] - df[t0]).to_numpy()
            var = df[vc].to_numpy()
            bad = int((ok_rows & (np.isnan(var) | (np.nan_to_num(var) != diff))).sum())
            bad += int((~ok_rows & ~np.isnan(var)).sum())
            label = f"mensile r{rid} {vc}"
            log(f"self-check [{'OK' if not bad else 'FAIL'}] {label}: righe incoerenti={bad}")
            if bad:
                failed.append(label)
            expected[(ds, p)] = int(np.nansum(var))
    if failed:
        raise SystemExit(f"Self-check mensile FALLITO su: {', '.join(failed)} - build interrotta.")
    return expected


# ---------------------------------------------------------------------------
# Self-check: known-good totals verified by hand during planning
# ---------------------------------------------------------------------------


# Scarto massimo ammesso tra somma righe e riga "Totali" del PDF (frazione). Gli scarti reali
# sono di pochi kg su ~1e11 (arrotondamenti del PDF): 1e-4 = 0,01% intercetta righe perse o
# duplicate senza far fallire il build per il rumore di arrotondamento.
SELF_CHECK_TOL = 1e-4


def self_check(df56, df58, df59):
    """Verifica che la pulizia dei CSV non abbia perso/duplicato righe.

    Riferimento = i totali ufficiali della riga "Totali" dei PDF (foglio Riconciliazione di
    rentri.xlsx, scritto dallo stesso run che ha prodotto i CSV): si aggiorna a ogni scarico.
    Costanti fisse non reggono: l'anno di registrazione riceve correzioni tardive e i totali
    cambiano di scarico in scarico (vedi README, "Lettura obbligata dei numeri").
    """
    xlsx = DATA_DIR / "rentri.xlsx"
    ric = pd.read_excel(xlsx, sheet_name="Riconciliazione")
    ric = ric[ric["confronto"].astype(str).str.contains("Totali PDF nazionale")
              & ric["valore_dichiarato"].notna()]
    ufficiale = {
        (int(r.report_id), str(int(r.anno)), r.unita_misura): float(r.valore_dichiarato)
        for r in ric.itertuples()
    }

    checks = {}  # label -> (calcolato, atteso)
    for (rid, anno, unit), atteso in sorted(ufficiale.items()):
        if rid == 56:
            df = df56[(df56["Anno"] == anno) & (df56["Unita di misura"] == unit)]
        elif rid == 58:
            df = df58[(df58["Anno"] == anno) & (df58["Unita di misura"] == unit)]
        else:
            continue  # 57: il PDF non espone un totale dichiarato
        checks[f"report_{rid} {anno} {unit} totale PDF"] = (int(df["Quantita"].sum()), atteso)

    if not checks:
        raise SystemExit("Self-check impossibile: nessun totale ufficiale in Riconciliazione "
                         f"({xlsx}) - rilanciare rentri_scraper.py")

    # report 59 (stato attuale, nessun totale nel foglio): CSV pulito vs foglio Excel dello
    # stesso run, due file scritti separatamente
    x59 = pd.read_excel(xlsx, sheet_name="59_OperatoriUL", keep_default_na=False)
    checks["report_59 operatori totale (xlsx)"] = (
        int(df59["Numero operatori iscritti"].astype(np.int64).sum()),
        int(pd.to_numeric(x59["Numero operatori iscritti"]).sum()),
    )

    failed = []
    for label, (actual, expected) in checks.items():
        scarto = abs(actual - expected) / expected if expected else float(actual != 0)
        ok = scarto <= SELF_CHECK_TOL
        log(f"self-check [{'OK' if ok else 'FAIL'}] {label}: atteso={expected:.0f} "
            f"calcolato={actual} scarto={scarto:.2e}")
        if not ok:
            failed.append(label)
    if failed:
        raise SystemExit(f"Self-check FALLITO su: {', '.join(failed)} - build interrotta.")
    return {k: v[0] for k, v in checks.items()}


# ---------------------------------------------------------------------------
# Dictionary building
# ---------------------------------------------------------------------------


def build_dictionaries(df56, df57, df58, df59, mapp, monthly=None):
    # tabelle del monitor mensile: possono contenere codici registrati dopo l'ultimo scarico
    # annuale, quindi i dizionari sono l'unione dei due
    mt = monthly["tables"] if monthly else {}
    m56, m57, m58, m59 = (mt.get(r, pd.DataFrame()) for r in (56, 57, 58, 59))

    # --- province: canonical list from report_59 (all 111) -----------------
    provinces = sorted(df59["Provincia"].unique())
    assert len(provinces) == 111
    prov_index = {p: i for i, p in enumerate(provinces)}

    for name, df, col in [
        ("56", df56, "Provincia produttore"),
        ("57", df57, "Provincia produttore"),
        ("58", df58, "Provincia impianto"),
        ("56 mensile", m56, "Provincia produttore"),
        ("57 mensile", m57, "Provincia produttore"),
        ("58 mensile", m58, "Provincia impianto"),
        ("59 mensile", m59, "Provincia"),
    ]:
        if df.empty:
            continue
        missing = set(df[col].unique()) - set(provinces)
        assert not missing, f"report_{name} has provinces not in canonical list: {missing}"

    # province -> region (canonical, from report_59) + province -> cod_regione (from Mappatura)
    prov_to_region_name = dict(zip(df59["Provincia"], df59["Regione"]))
    mapp_lookup = dict(zip(mapp["cod_provincia"], mapp["cod_regione"]))
    missing_mapp = set(provinces) - set(mapp_lookup)
    assert not missing_mapp, f"Mappatura_Territorio missing provinces: {missing_mapp}"

    # --- region: canonical list ordered by ISTAT cod_regione (1..20) -------
    cod_regione_by_prov = {p: mapp_lookup[p] for p in provinces}
    region_name_by_cod = {}
    for p in provinces:
        cod = cod_regione_by_prov[p]
        raw_name = prov_to_region_name[p]
        region_name_by_cod.setdefault(cod, raw_name)
    assert len(region_name_by_cod) == 20, f"expected 20 regions, got {len(region_name_by_cod)}"

    region_cods_sorted = sorted(region_name_by_cod)  # 1..20
    region_cod_to_idx = {cod: i for i, cod in enumerate(region_cods_sorted)}
    region_display_names = [
        REGION_DISPLAY_FIX.get(region_name_by_cod[c], region_name_by_cod[c]) for c in region_cods_sorted
    ]
    region_istat_codes = [f"{c:02d}" for c in region_cods_sorted]

    province_region_idx = [region_cod_to_idx[cod_regione_by_prov[p]] for p in provinces]

    # province -> map-geometry sigla index (abolished-province remap, for the map layer only)
    province_map_sigla = [ABOLISHED_PROVINCE_REMAP.get(p, p) for p in provinces]

    # --- EER codes: union of 56 + 58, description = first-seen (56 wins) ---
    desc_by_code = {}
    for code, desc in zip(df56["Codice EER"], df56["Descrizione EER"]):
        desc_by_code.setdefault(code, desc)
    for code, desc in zip(df58["Codice EER"], df58["Descrizione EER"]):
        desc_by_code.setdefault(code, desc)
    for mdf in (m56, m58):
        if not mdf.empty:
            for code, desc in zip(mdf["Codice EER"], mdf["Descrizione EER"]):
                desc_by_code.setdefault(code, desc)
    eer_codes = sorted(desc_by_code)
    eer_index = {c: i for i, c in enumerate(eer_codes)}
    eer_desc = [desc_by_code[c] for c in eer_codes]
    eer_chapter = [int(c[:2]) for c in eer_codes]

    # --- materiale (report 57) ----------------------------------------------
    materiali = sorted(set(df57["Materiale"]) | set(m57.get("Materiale", [])))
    materiale_index = {m: i for i, m in enumerate(materiali)}

    # --- attivita a destinazione (report 58) --------------------------------
    attivita = sorted(set(df58["Attivita a destinazione"]) | set(m58.get("Attivita a destinazione", [])))
    attivita_index = {a: i for i, a in enumerate(attivita)}

    return dict(
        provinces=provinces,
        prov_index=prov_index,
        province_region_idx=province_region_idx,
        province_map_sigla=province_map_sigla,
        region_display_names=region_display_names,
        region_istat_codes=region_istat_codes,
        eer_codes=eer_codes,
        eer_index=eer_index,
        eer_desc=eer_desc,
        eer_chapter=eer_chapter,
        materiali=materiali,
        materiale_index=materiale_index,
        attivita=attivita,
        attivita_index=attivita_index,
    )


# ---------------------------------------------------------------------------
# Row encoding
# ---------------------------------------------------------------------------


def encode_table_a(df, dicts, anno_index):
    n = len(df)
    return dict(
        anno=df["Anno"].map(anno_index).to_numpy(),
        prov=df["Provincia produttore"].map(dicts["prov_index"]).to_numpy(),
        eer=df["Codice EER"].map(dicts["eer_index"]).to_numpy(),
        haz=(df["Pericoloso"] == "P").astype(np.uint8).to_numpy(),
        qty=df["Quantita"].to_numpy(),  # sempre kg: i litri sono gia' convertiti (litri_to_kg)
    ), n


def encode_table_b(df, dicts, anno_index_b):
    n = len(df)
    return dict(
        anno=df["Anno"].map(anno_index_b).to_numpy(),
        prov=df["Provincia produttore"].map(dicts["prov_index"]).to_numpy(),
        mat=df["Materiale"].map(dicts["materiale_index"]).to_numpy(),
        qty=df["Quantita"].to_numpy(),
    ), n


def encode_table_c(df, dicts, anno_index):
    n = len(df)
    tipo_map = {"R": 0, "D": 1, "": 2}
    tipo_raw = df["Tipo operazione"].map(tipo_map)
    assert not tipo_raw.isna().any(), "unexpected value in Tipo operazione"
    return dict(
        anno=df["Anno"].map(anno_index).to_numpy(),
        prov=df["Provincia impianto"].map(dicts["prov_index"]).to_numpy(),
        eer=df["Codice EER"].map(dicts["eer_index"]).to_numpy(),
        haz=(df["Pericoloso"] == "P").astype(np.uint8).to_numpy(),
        att=df["Attivita a destinazione"].map(dicts["attivita_index"]).to_numpy(),
        tipo=tipo_raw.to_numpy(),
        qty=df["Quantita"].to_numpy(),
    ), n


def encode_table_d(df, dicts):
    n = len(df)
    cols = [
        "Numero operatori iscritti",
        "Numero unita locali iscritte",
        "di cui Produttore",
        "di cui Trasportatore",
        "di cui Intermediario senza detenzione",
        "di cui Recuperatore",
        "di cui Smaltitore",
        "di cui Centro di raccolta",
    ]
    out = dict(prov=df["Provincia"].map(dicts["prov_index"]).to_numpy())
    for c in cols:
        out[c] = df[c].astype(np.int64).to_numpy()
    return out, n, cols


def encode_monthly(bw, m, dicts, d_measure_cols):
    """Tabelle MA/MB/MC/MD: stesse dimensioni delle annuali + un totale per scarico (M?_t{k}).
    Le variazioni NON sono codificate: il browser le ricava come t{k+1}-t{k} sulle righe
    confrontabili, identiche al CSV del monitor per costruzione (vedi self_check_monthly)."""
    t = m["tables"]
    anno_labels = sorted(set().union(*(set(t[r]["Anno"]) for r in (56, 57, 58))))
    anno_index = {a: i for i, a in enumerate(anno_labels)}
    tipo_map = {"R": 0, "D": 1, "": 2}
    assert set(t[59]["Campo"]) == set(d_measure_cols), "r59 mensile: campi diversi dal report annuale"
    campo_index = {c: i for i, c in enumerate(d_measure_cols)}

    dims = {
        "A": (t[56], dict(
            anno=("u8", t[56]["Anno"].map(anno_index)),
            prov=("u8", t[56]["Provincia produttore"].map(dicts["prov_index"])),
            eer=("u16", t[56]["Codice EER"].map(dicts["eer_index"])),
            haz=("u8", (t[56]["Pericoloso"] == "P").astype(np.uint8)),
        )),
        "B": (t[57], dict(
            anno=("u8", t[57]["Anno"].map(anno_index)),
            prov=("u8", t[57]["Provincia produttore"].map(dicts["prov_index"])),
            mat=("u8", t[57]["Materiale"].map(dicts["materiale_index"])),
        )),
        "C": (t[58], dict(
            anno=("u8", t[58]["Anno"].map(anno_index)),
            prov=("u8", t[58]["Provincia impianto"].map(dicts["prov_index"])),
            eer=("u16", t[58]["Codice EER"].map(dicts["eer_index"])),
            haz=("u8", (t[58]["Pericoloso"] == "P").astype(np.uint8)),
            att=("u8", t[58]["Attivita a destinazione"].map(dicts["attivita_index"])),
            tipo=("u8", t[58]["Tipo operazione"].map(tipo_map)),
        )),
        "D": (t[59], dict(
            prov=("u8", t[59]["Provincia"].map(dicts["prov_index"])),
            campo=("u8", t[59]["Campo"].map(campo_index)),
        )),
    }
    row_counts = {}
    for ds, (df, cols) in dims.items():
        for name, (dtype, values) in cols.items():
            bw.add(f"M{ds}_{name}", dtype, values.to_numpy())
        for k, d in enumerate(m["dates"]):
            v = df[f"Tot_{d}"].to_numpy()
            bw.add(f"M{ds}_t{k}", qty_dtype(v), v)
        row_counts[ds] = int(len(df))
    return dict(
        dates=m["dates"],
        periods=m["periods"],
        comparable=m["comparable"],
        anno_labels=anno_labels,
        campi=list(d_measure_cols),
        row_counts=row_counts,
    )


def browser_checks(df56, df57, df58, df59, monthly):
    """Totali calcolati qui sui DataFrame (gia' convertiti in kg, prima della codifica) che il
    browser ricalcola dopo la decodifica: intercetta qualunque errore di codifica/decodifica."""
    checks = []
    for ds, df in (("A", df56), ("B", df57), ("C", df58)):
        for anno, g in df.groupby("Anno"):
            checks.append(dict(kind="annual", ds=ds, anno=anno, unit=None,
                               expected=int(g["Quantita"].sum()), label=f"{ds} {anno} kg"))
    checks.append(dict(kind="annualD", col="Numero operatori iscritti",
                       expected=int(df59["Numero operatori iscritti"].astype(np.int64).sum()), label="D operatori"))
    if monthly:
        for rid, df in monthly["tables"].items():
            ds = MONTHLY_DS[rid]
            for k, d in enumerate(monthly["dates"]):
                checks.append(dict(kind="monthlyTot", ds=ds, snap=k, expected=int(df[f"Tot_{d}"].sum()),
                                   label=f"mensile {ds} Tot_{d}"))
            # attesa = differenza dei totali (convertiti) sulle righe confrontabili: che coincida
            # con la Var del monitor l'ha gia' verificato self_check_monthly sui dati grezzi
            for p in range(len(monthly["periods"])):
                d0, d1 = monthly["dates"][p], monthly["dates"][p + 1]
                ok = np.ones(len(df), dtype=bool) if ds == "D" else df["Anno"].isin(monthly["comparable"][ds][p]).to_numpy()
                checks.append(dict(kind="monthlyVar", ds=ds, period=p, expected=int((df[f"Tot_{d1}"] - df[f"Tot_{d0}"])[ok].sum()),
                                   label=f"mensile {ds} Var_{d1}"))
    return checks


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    log("Lettura CSV/xlsx sorgente...")
    mapp = load_mappatura()
    df59 = load_report59()
    df56 = load_report56()
    df57 = load_report57()
    df58 = load_report58()

    monthly = load_monthly()

    log("Self-check sui totali noti...")
    self_check_totals = self_check(df56, df58, df59)
    if monthly:
        self_check_monthly(monthly)

    # i self-check qui sopra girano sui dati grezzi (kg e litri separati, come nei PDF); da qui
    # in poi il report 56 e' solo in kg, con i litri convertiti tramite il KFO medio per EER
    log("Conversione litri -> kg (report 56)...")
    kfo = load_kfo()
    litri_stima = stima_litri_per_anno(df56, kfo)
    df56 = litri_to_kg(df56, kfo, ["Quantita"], "report_56")
    if monthly:
        m56 = monthly["tables"][56]
        tot_cols = [c for c in m56.columns if c.startswith("Tot_")]
        m56 = m56.drop(columns=[c for c in m56.columns if c.startswith("Var_")])  # superate dalla conversione
        monthly["tables"][56] = litri_to_kg(m56, kfo, tot_cols, "mensile r56")

    log("Costruzione dizionari...")
    dicts = build_dictionaries(df56, df57, df58, df59, mapp, monthly)

    anno_a = sorted(set(df56["Anno"].unique()) | set(df58["Anno"].unique()))
    anno_b = sorted(df57["Anno"].unique())
    anno_a_index = {a: i for i, a in enumerate(anno_a)}
    anno_b_index = {a: i for i, a in enumerate(anno_b)}
    log(f"Anni A/C: {anno_a} - Anni B: {anno_b}")

    log("Codifica righe...")
    a_cols, a_n = encode_table_a(df56, dicts, anno_a_index)
    b_cols, b_n = encode_table_b(df57, dicts, anno_b_index)
    c_cols, c_n = encode_table_c(df58, dicts, anno_a_index)
    d_cols, d_n, d_measure_cols = encode_table_d(df59, dicts)

    n_prov = len(dicts["provinces"])
    n_eer = len(dicts["eer_codes"])

    bw = BinaryWriter()
    # Table A
    bw.add("A_anno", "u8", a_cols["anno"])
    bw.add("A_prov", "u8", a_cols["prov"])
    bw.add("A_eer", "u16", a_cols["eer"])
    bw.add("A_haz", "u8", a_cols["haz"])
    bw.add("A_qty", qty_dtype(a_cols["qty"]), a_cols["qty"])
    # Table B
    bw.add("B_anno", "u8", b_cols["anno"])
    bw.add("B_prov", "u8", b_cols["prov"])
    bw.add("B_mat", "u8", b_cols["mat"])
    bw.add("B_qty", qty_dtype(b_cols["qty"]), b_cols["qty"])
    # Table C
    bw.add("C_anno", "u8", c_cols["anno"])
    bw.add("C_prov", "u8", c_cols["prov"])
    bw.add("C_eer", "u16", c_cols["eer"])
    bw.add("C_haz", "u8", c_cols["haz"])
    bw.add("C_att", "u8", c_cols["att"])
    bw.add("C_tipo", "u8", c_cols["tipo"])
    bw.add("C_qty", qty_dtype(c_cols["qty"]), c_cols["qty"])
    # Table D
    bw.add("D_prov", "u8", d_cols["prov"])
    for c in d_measure_cols:
        bw.add(f"D_{c}", "u32", d_cols[c])
    # Monitor mensile
    monthly_meta = encode_monthly(bw, monthly, dicts, d_measure_cols) if monthly else None

    meta = dict(
        build_source=SOURCE_CITATION,
        extraction_date=EXTRACTION_DATE,
        row_counts=dict(A=int(a_n), B=int(b_n), C=int(c_n), D=int(d_n)),
        self_check=self_check_totals,
        anno_labels_ac=anno_a,
        anno_labels_b=anno_b,
        provinces=dicts["provinces"],
        province_region_idx=dicts["province_region_idx"],
        province_map_sigla=dicts["province_map_sigla"],
        region_display_names=dicts["region_display_names"],
        region_istat_codes=dicts["region_istat_codes"],
        eer_codes=dicts["eer_codes"],
        eer_desc=dicts["eer_desc"],
        eer_chapter=dicts["eer_chapter"],
        materiali=dicts["materiali"],
        attivita=dicts["attivita"],
        d_measure_cols=d_measure_cols,
        n_prov=n_prov,
        n_eer=n_eer,
        monthly=monthly_meta,
        browser_checks=browser_checks(df56, df57, df58, df59, monthly),
        litri_convertiti=dict(fonte=KFO_FILE.name, per_anno=litri_stima),
    )

    log("Compressione payload dati...")
    raw = bw.pack(meta)
    data_b64 = gzip_b64(raw)
    log(f"Payload dati: {len(raw)/1e6:.2f} MB raw -> {len(data_b64)/1e6:.2f} MB base64(gzip)")

    log("Compressione geometrie...")
    geo_regions_raw = (VENDOR_DIR / "limits_IT_regions.topo.json").read_bytes()
    geo_provinces_raw = (VENDOR_DIR / "limits_IT_provinces.topo.json").read_bytes()
    geo_regions_b64 = gzip_b64(geo_regions_raw)
    geo_provinces_b64 = gzip_b64(geo_provinces_raw)

    log("Lettura sorgenti app e vendor...")
    template_html = (SRC_DIR / "template.html").read_text(encoding="utf-8")
    app_css = (SRC_DIR / "app.css").read_text(encoding="utf-8")
    chart_registry_js = (SRC_DIR / "chart_registry.js").read_text(encoding="utf-8")
    monthly_js = (SRC_DIR / "monthly.js").read_text(encoding="utf-8")
    app_js = (SRC_DIR / "app.js").read_text(encoding="utf-8")
    echarts_js = (VENDOR_DIR / "echarts.min.js").read_text(encoding="utf-8")
    xlsx_js = (VENDOR_DIR / "xlsx.full.min.js").read_text(encoding="utf-8")
    topojson_js = (VENDOR_DIR / "topojson-client.min.js").read_text(encoding="utf-8")

    log("Assemblaggio HTML finale...")
    html = template_html
    replacements = {
        "{{APP_CSS}}": app_css,
        "{{ECHARTS_JS}}": echarts_js,
        "{{XLSX_JS}}": xlsx_js,
        "{{TOPOJSON_JS}}": topojson_js,
        "{{CHART_REGISTRY_JS}}": chart_registry_js,
        "{{MONTHLY_JS}}": monthly_js,
        "{{APP_JS}}": app_js,
        "{{DATA_B64}}": data_b64,
        "{{GEO_REGIONS_B64}}": geo_regions_b64,
        "{{GEO_PROVINCES_B64}}": geo_provinces_b64,
    }
    for placeholder, content in replacements.items():
        if placeholder not in html:
            raise SystemExit(f"Placeholder mancante nel template: {placeholder}")
        html = html.replace(placeholder, content)

    out_path = DIST_DIR / "rentri_dashboard.html"
    out_path.write_text(html, encoding="utf-8")
    size_mb = out_path.stat().st_size / 1e6
    log(f"Scritto {out_path} ({size_mb:.2f} MB)")

    report = dict(
        output=str(out_path),
        size_mb=round(size_mb, 3),
        row_counts=meta["row_counts"],
        self_check=self_check_totals,
        monthly=None if not monthly_meta else dict(dates=monthly_meta["dates"], row_counts=monthly_meta["row_counts"]),
        data_payload_mb=round(len(data_b64) / 1e6, 3),
        geo_regions_mb=round(len(geo_regions_b64) / 1e6, 3),
        geo_provinces_mb=round(len(geo_provinces_b64) / 1e6, 3),
    )
    (REPORT_DIR / "build_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log("Build completata con successo.")


if __name__ == "__main__":
    main()
