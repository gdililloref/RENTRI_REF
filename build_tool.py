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
import struct
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "rentri_out"
VENDOR_DIR = ROOT / "build" / "vendor"
SRC_DIR = ROOT / "build" / "src"
DIST_DIR = ROOT / "build" / "dist"
DIST_DIR.mkdir(parents=True, exist_ok=True)

SOURCE_CITATION = "MASE - RENTRI - cruscotto pubblico area-consultazione (www.rentri.gov.it/area-consultazione)"
EXTRACTION_DATE = "2026-07-24"

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

DTYPE_CODES = {"u8": 0, "u16": 1, "u32": 2}
NP_DTYPE = {"u8": "<u1", "u16": "<u2", "u32": "<u4"}


class BinaryWriter:
    def __init__(self):
        self.columns = []  # list of (name, dtype, np.ndarray)

    def add(self, name, dtype, values):
        arr = np.asarray(values, dtype=NP_DTYPE[dtype])
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
# Self-check: known-good totals verified by hand during planning
# ---------------------------------------------------------------------------


def self_check(df56, df58, df59):
    checks = {}

    v = int(df56[(df56["Anno"] == "2025") & (df56["Unita di misura"] == "kg")]["Quantita"].sum())
    checks["report_56 2025 kg totale"] = (v, 114362059541)

    v = int(df58[df58["Anno"] == "2025"]["Quantita"].sum())
    checks["report_58 2025 kg totale"] = (v, 188340733867)

    v = int(df59["Numero operatori iscritti"].astype(np.int64).sum())
    checks["report_59 operatori totale"] = (v, 341647)

    v = int(
        df56[
            (df56["Anno"] == "2025")
            & (df56["Regione"] == "Lombardia")
            & (df56["Unita di misura"] == "kg")
        ]["Quantita"].sum()
    )
    checks["report_56 2025 kg Lombardia"] = (v, 23796868970)

    failed = []
    for label, (actual, expected) in checks.items():
        status = "OK" if actual == expected else "FAIL"
        log(f"self-check [{status}] {label}: atteso={expected} calcolato={actual}")
        if actual != expected:
            failed.append(label)
    if failed:
        raise SystemExit(f"Self-check FALLITO su: {', '.join(failed)} - build interrotta.")
    return {k: v[0] for k, v in checks.items()}


# ---------------------------------------------------------------------------
# Dictionary building
# ---------------------------------------------------------------------------


def build_dictionaries(df56, df57, df58, df59, mapp):
    # --- province: canonical list from report_59 (all 111) -----------------
    provinces = sorted(df59["Provincia"].unique())
    assert len(provinces) == 111
    prov_index = {p: i for i, p in enumerate(provinces)}

    for name, df, col in [
        ("56", df56, "Provincia produttore"),
        ("57", df57, "Provincia produttore"),
        ("58", df58, "Provincia impianto"),
    ]:
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
    eer_codes = sorted(desc_by_code)
    eer_index = {c: i for i, c in enumerate(eer_codes)}
    eer_desc = [desc_by_code[c] for c in eer_codes]
    eer_chapter = [int(c[:2]) for c in eer_codes]

    # --- materiale (report 57) ----------------------------------------------
    materiali = sorted(df57["Materiale"].unique())
    materiale_index = {m: i for i, m in enumerate(materiali)}

    # --- attivita a destinazione (report 58) --------------------------------
    attivita = sorted(df58["Attivita a destinazione"].unique())
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
        unit=(df["Unita di misura"] == "l").astype(np.uint8).to_numpy(),
        qty=df["Quantita"].to_numpy(),
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

    log("Self-check sui totali noti...")
    self_check_totals = self_check(df56, df58, df59)

    log("Costruzione dizionari...")
    dicts = build_dictionaries(df56, df57, df58, df59, mapp)

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
    bw.add("A_unit", "u8", a_cols["unit"])
    bw.add("A_qty", "u32", a_cols["qty"])
    # Table B
    bw.add("B_anno", "u8", b_cols["anno"])
    bw.add("B_prov", "u8", b_cols["prov"])
    bw.add("B_mat", "u8", b_cols["mat"])
    bw.add("B_qty", "u32", b_cols["qty"])
    # Table C
    bw.add("C_anno", "u8", c_cols["anno"])
    bw.add("C_prov", "u8", c_cols["prov"])
    bw.add("C_eer", "u16", c_cols["eer"])
    bw.add("C_haz", "u8", c_cols["haz"])
    bw.add("C_att", "u8", c_cols["att"])
    bw.add("C_tipo", "u8", c_cols["tipo"])
    bw.add("C_qty", "u32", c_cols["qty"])
    # Table D
    bw.add("D_prov", "u8", d_cols["prov"])
    for c in d_measure_cols:
        bw.add(f"D_{c}", "u32", d_cols[c])

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
        data_payload_mb=round(len(data_b64) / 1e6, 3),
        geo_regions_mb=round(len(geo_regions_b64) / 1e6, 3),
        geo_provinces_mb=round(len(geo_provinces_b64) / 1e6, 3),
    )
    (DIST_DIR / "build_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log("Build completata con successo.")


if __name__ == "__main__":
    main()
