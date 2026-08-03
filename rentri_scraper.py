#!/usr/bin/env python3
"""
RENTRI - area consultazione: download e parsing multi-anno (reportId 56,57,58,59).

Architettura a batch annuali indipendenti (2026-07-24): ogni anno viene scaricato, parsato
e salvato su disco (rentri_out/_interim/) come batch a se stante, PRIMA di essere unificato
nell'export finale. Se il processo viene interrotto o si aggiunge un nuovo anno in seguito,
gli anni gia' completati non vengono ripetuti (si legge l'interim cache).

Strategia (validata empiricamente il 2026-07-24, vedi REPORT_VALIDAZIONE.md):
- Il PDF scaricato con territorio VUOTO (livello nazionale) contiene GIA' il dettaglio
  riga-per-riga a livello di PROVINCIA (non e' un aggregato). Verificato confrontando
  bit-a-bit un PDF regione-filtrato contro le righe estratte dal corrispondente PDF
  nazionale: risultato identico per tutti i report. Questo supera l'assunzione originaria
  del brief ("il territorio e' un filtro, serve 1 PDF a provincia") e riduce il download da
  ~350+80+4 richieste per anno a sole 4 richieste per anno, mantenendo IDENTICO dettaglio.
- Endpoint unico dati: POST https://www.rentri.gov.it/reportapi/Render -> application/pdf.
- Ogni POST richiede token anti-forgery FRESCO + cookie appaiato (GET pagina -> token -> POST),
  piu' reportId e contesto ESPLICITI (senza -> 500).
- Il campo Anno (56/57/58) e' testo libero: il server accetta qualunque anno. Verificato che
  1999-2023 restituiscono PDF vuoti (nessuna registrazione), 2024 in avanti contengono dati
  reali (2026, anno corrente, gia' quasi voluminoso quanto il 2025 completo). Il report 59
  ("stato attuale") non ha il campo Anno: e' un singolo snapshot, non ripetuto per anno.
- Mappa provincia -> regione estratta DINAMICAMENTE dall'attributo data-masterkey delle
  <option> di ProvinciaProduttore (non hard-codata).
- report 58: DestinatoAttivita lasciato "" -> l'attivita' (R../D..) e' tabellata DENTRO
  il PDF come colonna propria (non va iterata x29 come ipotizzato nel brief originale).
- Pericolosita': codificata come suffisso "*" sul Codice EER (56, 58); non e' una colonna
  separata nel PDF sorgente.
- Formato numerico: migliaia = punto, decimali = virgola.
- Riga "Totali" di chiusura (ultima pagina) = oracolo di riconciliazione; esclusa dai
  fogli dati.
- pdfplumber tiene in vita TUTTI gli oggetti pagina per la durata del `with pdfplumber.open()`:
  su PDF da migliaia di pagine questo fa crescere la RAM senza limite (osservato: ~2.9 GB dopo
  900/2651 pagine del report 58) se non si chiama esplicitamente page.close() dopo ogni pagina.

Dipendenze:
    pip install requests beautifulsoup4 lxml pdfplumber pandas openpyxl
"""

import hashlib
import json
import pathlib
import re
import time
from datetime import datetime

import pandas as pd
import requests
from bs4 import BeautifulSoup

BASE = "https://www.rentri.gov.it"
PAGE = f"{BASE}/area-consultazione"
RENDER = f"{BASE}/reportapi/Render"
UA = "ricerca-REF/1.0 (analisi dati pubblici RENTRI-MASE)"
MAX_RETRY = 4

ANNI = ["2024", "2025", "2026"]  # anni da scaricare per 56/57/58 (59 non ha "Anno": stato attuale)

RUN_DATE = datetime.now().strftime("%Y-%m-%d")
CACHE = pathlib.Path("rentri_pdf_cache") / RUN_DATE
OUT = pathlib.Path("rentri_out")
INTERIM = OUT / "_interim"


# ------------------------------------------------------------------ client

class Rentri:
    def __init__(self):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self._page_html = None

    def _get_page(self):
        r = self.s.get(PAGE, timeout=60)
        r.raise_for_status()
        self._page_html = r.text
        return r.text

    def _token(self):
        html = self._get_page()
        m = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', html)
        if not m:
            raise RuntimeError("Token anti-forgery non trovato nella pagina")
        return m.group(1)

    def soup(self):
        if self._page_html is None:
            self._get_page()
        return BeautifulSoup(self._page_html, "lxml")

    def options(self, field_name):
        sel = self.soup().find("select", attrs={"name": field_name})
        if sel is None:
            return []
        out = []
        for o in sel.find_all("option"):
            val = (o.get("value") or "").strip()
            if val == "":
                continue
            out.append((val, o.get_text(strip=True)))
        return out

    def province_regione_map(self):
        """{sigla_provincia: (cod_regione, nome_provincia)} da data-masterkey (dinamico)."""
        sel = self.soup().find("select", attrs={"name": "ProvinciaProduttore"})
        out = {}
        for o in sel.find_all("option"):
            val = (o.get("value") or "").strip()
            if not val:
                continue
            out[val] = (o.get("data-masterkey"), o.get_text(strip=True))
        return out

    def render(self, payload):
        last = None
        for attempt in range(1, MAX_RETRY + 1):
            tok = self._token()
            data = {"__RequestVerificationToken": tok, "formato": "PDF", "CausaleOperazione": ""}
            data.update(payload)
            r = self.s.post(RENDER, data=data, timeout=600)
            ct = r.headers.get("content-type", "")
            if r.status_code == 200 and "application/pdf" in ct:
                return r
            last = r
            time.sleep(1.5 * attempt)
        raise RuntimeError(f"Render fallito {payload} (ultimo status {last.status_code})")


PAYLOAD_BASE = {
    56: {"reportId": "56", "contesto": "public-movimenti-analisi",
         "CodiceEER": "", "RegioneProduttore": "", "ProvinciaProduttore": ""},
    57: {"reportId": "57", "contesto": "public-movimenti-analisi",
         "MaterialeId": "", "RegioneULDest": "", "ProvinciaULDest": ""},
    58: {"reportId": "58", "contesto": "public-movimenti-analisi",
         "CodiceEER": "", "DestinatoAttivita": "", "RegioneULDest": "", "ProvinciaULDest": ""},
    59: {"reportId": "59", "contesto": "public-operatori-analisi", "RegioneUL": ""},
}

# campioni usati SOLO per la riconciliazione incrociata (non serve scaricare tutto)
VALIDATION_EXTRA = {
    56: {"cod": "13", "payload_extra": {"RegioneProduttore": "13", "ProvinciaProduttore": ""}},
    57: {"cod": "13", "payload_extra": {"RegioneULDest": "13", "ProvinciaULDest": ""}},
    58: {"cod": "13", "payload_extra": {"RegioneULDest": "13", "ProvinciaULDest": ""}},
    59: {"cod": "13", "payload_extra": {"RegioneUL": "13"}},
}

PARSERS_LABEL = {56: "56", 57: "57", 58: "58", 59: "59"}
PROV_COL = {56: "Provincia produttore", 57: "Provincia produttore", 58: "Provincia impianto", 59: "Provincia"}
SHEET_NAMES = {56: "56_RifiutiProdotti", 57: "57_MaterialiEoW", 58: "58_RifiutiTrattati", 59: "59_OperatoriUL"}


# ------------------------------------------------------------------ download

def _save(dest: pathlib.Path, content: bytes, meta_rows: list, report_id, anno, livello, cod_terr, status, dt):
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)
    meta_rows.append({
        "file": str(dest), "report_id": report_id, "anno": anno, "livello": livello, "cod_territorio": cod_terr,
        "timestamp_download": datetime.now().isoformat(timespec="seconds"),
        "http_status": status, "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(), "download_time_s": round(dt, 1),
    })


def _fetch(api, dest, payload, meta_rows, report_id, anno, livello, cod_terr, label):
    if dest.exists() and dest.stat().st_size > 1000:
        print(f"  [cache] {label} gia' presente ({dest.stat().st_size // 1024} KB)")
        return
    t0 = time.time()
    r = api.render(payload)
    dt = time.time() - t0
    _save(dest, r.content, meta_rows, report_id, anno, livello, cod_terr, r.status_code, dt)
    print(f"  [OK] {label}: {len(r.content) // 1024} KB in {dt:.1f}s")
    time.sleep(1.5)


def _write_manifest(meta_rows):
    if not meta_rows:
        return
    manifest = CACHE / "_manifest.csv"
    df_new = pd.DataFrame(meta_rows)
    if manifest.exists():
        df_new = pd.concat([pd.read_csv(manifest), df_new], ignore_index=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    df_new.to_csv(manifest, index=False)


# ------------------------------------------------------------------ numeri IT

def it_num(s, anomalies, contesto=None):
    """Converte un numero in formato IT (migliaia=punto, decimali=virgola).
    Ritorna None (e registra l'anomalia nella lista passata) se il PDF sorgente contiene un
    valore non numerico (es. '#Error': riscontrato nel footer 'Totali' del report 57 nazionale
    2025 - guasto lato server RENTRI nel calcolo del totale, non un problema di parsing)."""
    if s is None:
        return None
    s = s.strip()
    if s in ("", "-"):
        return None
    neg = s.startswith("-")
    s2 = s.lstrip("-")
    s2 = s2.replace(".", "")
    try:
        if "," in s2:
            val = float(s2.replace(",", "."))
        else:
            val = int(s2)
    except ValueError:
        anomalies.append({"contesto": contesto, "valore_grezzo": s})
        return None
    return -val if neg else val


def clean_text(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


# ------------------------------------------------------------------ parser per report

def _pages(pdf_path, progress_every=None, label=""):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        n = len(pdf.pages)
        for i, pg in enumerate(pdf.pages):
            if progress_every and i % progress_every == 0:
                print(f"    ...{label} pagina {i}/{n}", flush=True)
            tables = pg.extract_tables() or []
            for tbl in tables:
                yield tbl
            pg.close()  # pdfplumber.PDF tiene in vita pdf.pages per l'intera durata del `with`:
            # senza chiudere esplicitamente ogni pagina, le proprieta' cache (chars/rects/lines)
            # di TUTTE le pagine gia' processate restano in memoria -> RAM cresce senza limite
            # sui PDF da migliaia di pagine.


def parse_56(pdf_path, progress=False):
    rows, footer, anomalies = [], [], []
    label = f"r56 {getattr(pdf_path, 'name', 'transient')}"
    for tbl in _pages(pdf_path, 300 if progress else None, label):
        for row in tbl:
            row = (row + [None] * 6)[:6]
            c0, c1, c2, c3, c4, c5 = row
            if c1 is None:
                continue  # riga titolo
            if c0 == "Anno":
                continue  # riga intestazione
            if c0 in (None, ""):
                if any(isinstance(v, str) and v.strip().lower() == "totali" for v in row) or footer:
                    footer.append({"quantita": it_num(c4, anomalies, f"{label} footer Totali"), "unita_misura": c5})
                continue
            eer_raw = (c2 or "").strip()
            pericoloso = "P" if eer_raw.endswith("*") else "NP"
            rows.append([c0, c1, eer_raw.rstrip("*"), pericoloso, clean_text(c3),
                         it_num(c4, anomalies, f"{label} {c1}/{eer_raw}"), c5])
    cols = ["Anno", "Provincia produttore", "Codice EER", "Pericoloso", "Descrizione EER", "Quantita", "Unita di misura"]
    return pd.DataFrame(rows, columns=cols), footer, anomalies


def parse_57(pdf_path, progress=False):
    rows, footer, anomalies = [], [], []
    label = f"r57 {getattr(pdf_path, 'name', 'transient')}"
    for tbl in _pages(pdf_path, 300 if progress else None, label):
        for row in tbl:
            row = (row + [None] * 6)[:6]
            c0, c1, c2, c3, _c4gap, c5 = row
            if c1 is None:
                continue
            if c0 == "Anno":
                continue
            if c0 in (None, ""):
                if any(isinstance(v, str) and v.strip().lower() == "totali" for v in row) or footer:
                    footer.append({"quantita": it_num(c3, anomalies, f"{label} footer Totali"), "unita_misura": c5})
                continue
            rows.append([c0, c1, clean_text(c2), it_num(c3, anomalies, f"{label} {c1}/{c2}"), c5])
    cols = ["Anno", "Provincia produttore", "Materiale", "Quantita", "Unita di misura"]
    return pd.DataFrame(rows, columns=cols), footer, anomalies


def parse_58(pdf_path, progress=False):
    rows, footer, anomalies = [], [], []
    label = f"r58 {getattr(pdf_path, 'name', 'transient')}"
    for tbl in _pages(pdf_path, 300 if progress else None, label):
        for row in tbl:
            row = (row + [None] * 7)[:7]
            c0, c1, c2, c3, c4, c5, c6 = row
            if c0 == "Anno":
                continue  # intestazione (nessuna riga titolo in questo report)
            if c0 in (None, ""):
                if any(isinstance(v, str) and v.strip().lower() == "totali" for v in row) or footer:
                    footer.append({"quantita": it_num(c5, anomalies, f"{label} footer Totali"), "unita_misura": c6})
                continue
            eer_raw = (c2 or "").strip()
            pericoloso = "P" if eer_raw.endswith("*") else "NP"
            attivita = (c4 or "").strip()
            tipo_op = attivita[0] if attivita[:1] in ("R", "D") else None
            rows.append([c0, c1, eer_raw.rstrip("*"), pericoloso, clean_text(c3), attivita, tipo_op,
                         it_num(c5, anomalies, f"{label} {c1}/{eer_raw}"), c6])
    cols = ["Anno", "Provincia impianto", "Codice EER", "Pericoloso", "Descrizione EER",
            "Attivita a destinazione", "Tipo operazione", "Quantita", "Unita di misura"]
    return pd.DataFrame(rows, columns=cols), footer, anomalies


def parse_59(pdf_path, progress=False):
    rows, footer, anomalies = [], [], []
    label = f"r59 {getattr(pdf_path, 'name', 'transient')}"
    for tbl in _pages(pdf_path, None, label):
        for row in tbl:
            row = (row + [None] * 10)[:10]
            c0 = row[0]
            if c0 is None:
                continue
            c0s = clean_text(c0)
            if c0s.startswith("Provincia") or "Operatori" in c0s:
                continue  # titolo o intestazione
            vals = [row[1], row[2], row[3], row[4], row[5], row[6], row[8], row[9]]
            if c0s == "Totali":
                footer.append({"categoria": "Totali",
                               "valori": [it_num(v, anomalies, f"{label} footer Totali") for v in vals]})
                continue
            rows.append([c0s] + [it_num(v, anomalies, f"{label} {c0s}") for v in vals])
    cols = ["Provincia", "Numero operatori iscritti", "Numero unita locali iscritte",
            "di cui Produttore", "di cui Trasportatore", "di cui Intermediario senza detenzione",
            "di cui Recuperatore", "di cui Smaltitore", "di cui Centro di raccolta"]
    return pd.DataFrame(rows, columns=cols), footer, anomalies


PARSERS = {56: parse_56, 57: parse_57, 58: parse_58, 59: parse_59}


# ------------------------------------------------------------------ arricchimento + riconciliazione

def enrich(df, prov_col, prov_map, reg_nomi):
    df = df.copy()
    cod_reg = df[prov_col].map(lambda p: prov_map.get(p, (None, None))[0])
    df.insert(df.columns.get_loc(prov_col) + 1, "Regione", cod_reg.map(lambda c: reg_nomi.get(c, c)))
    return df


def reconcile_year(rid, anno, df_anno, footer, df_val, prov_map):
    """Confronta, per un singolo (report, anno): (a) somma righe vs riga 'Totali' del PDF
    nazionale; (b) subset regione 13 calcolato dal nazionale vs PDF di validazione scaricato
    indipendentemente per regione 13."""
    rows = []
    for f in footer:
        unit = f["unita_misura"]
        declared = f["quantita"]
        computed = df_anno.loc[df_anno["Unita di misura"] == unit, "Quantita"].sum()
        delta = (computed - declared) if declared is not None else None
        rows.append({"report_id": rid, "anno": anno, "confronto": "somma righe vs Totali PDF nazionale",
                     "unita_misura": unit, "valore_calcolato": computed, "valore_dichiarato": declared,
                     "delta": delta, "delta_%": round(100 * delta / declared, 6) if declared else None,
                     "match_esatto": None})

    abruzzo = [sigla for sigla, (cod, _) in prov_map.items() if cod == "13"]
    prov_col = PROV_COL[rid]
    sub = df_anno[df_anno[prov_col].isin(abruzzo)].drop(columns=["Regione", "Materiale_ID"], errors="ignore")
    common_cols = [c for c in sub.columns if c in df_val.columns]
    match = (sub[common_cols].sort_values(common_cols).reset_index(drop=True)
             .equals(df_val[common_cols].sort_values(common_cols).reset_index(drop=True)))
    rows.append({"report_id": rid, "anno": anno,
                 "confronto": "subset regione 13 (nazionale) vs PDF regione 13 indipendente",
                 "unita_misura": None, "valore_calcolato": len(sub), "valore_dichiarato": len(df_val),
                 "delta": len(sub) - len(df_val), "delta_%": None, "match_esatto": match})
    return rows


def reconcile_59(df, df_val, prov_map):
    abruzzo = [sigla for sigla, (cod, _) in prov_map.items() if cod == "13"]
    sub = df[df["Provincia"].isin(abruzzo)].drop(columns=["Regione"])
    match = (sub.sort_values("Provincia").reset_index(drop=True)
             .equals(df_val.sort_values("Provincia").reset_index(drop=True)[sub.columns]))
    return [{"report_id": 59, "anno": None,
             "confronto": "subset regione 13 (nazionale) vs PDF regione 13 indipendente",
             "unita_misura": None, "valore_calcolato": len(sub), "valore_dichiarato": len(df_val),
             "delta": len(sub) - len(df_val), "delta_%": None, "match_esatto": match}]


# ------------------------------------------------------------------ batch per (report, anno)

def _interim_paths(rid, anno):
    tag = anno or "attuale"
    return {
        "df": INTERIM / f"r{rid}_{tag}.pkl",
        "reconcile": INTERIM / f"reconcile_r{rid}_{tag}.json",
        "anomalies": INTERIM / f"anomalies_r{rid}_{tag}.json",
    }


def process_report_year(api, rid, anno, prov_map, reg_nomi, materiale_map, meta_rows):
    """Batch indipendente per un (report, anno): download + parsing + riconciliazione, con
    risultati persistiti su disco. Se gia' presenti, li ricarica senza riscaricare/riparsare."""
    tag = anno or "attuale"
    ip = _interim_paths(rid, anno)
    if ip["df"].exists():
        print(f"  [batch cache] r{rid} {tag} gia' elaborato in un run precedente")
        df = pd.read_pickle(ip["df"])
        reconcile_rows = json.loads(ip["reconcile"].read_text(encoding="utf-8"))
        anomalies = json.loads(ip["anomalies"].read_text(encoding="utf-8"))
        return df, reconcile_rows, anomalies

    payload = dict(PAYLOAD_BASE[rid])
    if anno:
        payload["Anno"] = anno
    dest = CACHE / "nazionale" / f"r{rid}_{tag}_IT.pdf"
    _fetch(api, dest, payload, meta_rows, rid, anno, "nazionale", "IT", f"r{rid} {tag} nazionale")

    cfg = VALIDATION_EXTRA[rid]
    payload_v = dict(payload); payload_v.update(cfg["payload_extra"])
    dest_v = CACHE / "validazione_regione" / f"r{rid}_{tag}_reg{cfg['cod']}.pdf"
    _fetch(api, dest_v, payload_v, meta_rows, rid, anno, "regione", cfg["cod"],
           f"r{rid} {tag} validazione regione {cfg['cod']}")

    print(f"  parsing r{rid} {tag} nazionale...")
    df, footer, anomalies = PARSERS[rid](dest, progress=True)
    print(f"    -> {len(df)} righe, footer: {footer}")
    df = enrich(df, PROV_COL[rid], prov_map, reg_nomi)
    if rid == 57:
        df["Materiale_ID"] = df["Materiale"].map(materiale_map)
        df = df[["Anno", "Provincia produttore", "Regione", "Materiale", "Materiale_ID", "Quantita", "Unita di misura"]]

    df_val, footer_val, anomalies_val = PARSERS[rid](dest_v)
    df_val = enrich(df_val, PROV_COL[rid], prov_map, reg_nomi)
    if rid == 57:
        df_val["Materiale_ID"] = df_val["Materiale"].map(materiale_map)
    anomalies = anomalies + anomalies_val

    if rid == 59:
        reconcile_rows = reconcile_59(df, df_val, prov_map)
    else:
        reconcile_rows = reconcile_year(rid, anno, df, footer, df_val, prov_map)

    INTERIM.mkdir(parents=True, exist_ok=True)
    df.to_pickle(ip["df"])
    ip["reconcile"].write_text(json.dumps(reconcile_rows, default=str), encoding="utf-8")
    ip["anomalies"].write_text(json.dumps(anomalies, default=str), encoding="utf-8")
    return df, reconcile_rows, anomalies


def main():
    print("=== Setup: mappe dinamiche (regioni, province, materiali) ===")
    api = Rentri()
    prov_map = api.province_regione_map()
    reg_nomi = dict(api.options("RegioneProduttore"))
    materiale_map = {label: val for val, label in api.options("MaterialeId")}
    print(f"  {len(prov_map)} province, {len(reg_nomi)} regioni, {len(materiale_map)} materiali")

    meta_rows, all_reconcile, all_anomalies = [], [], []
    dfs_by_rid = {56: [], 57: [], 58: []}

    for anno in ANNI:
        print(f"\n=== Batch anno {anno} ===")
        for rid in (57, 56, 58):  # dal piu' piccolo al piu' grande
            df, rec, anom = process_report_year(api, rid, anno, prov_map, reg_nomi, materiale_map, meta_rows)
            dfs_by_rid[rid].append(df)
            all_reconcile += rec
            all_anomalies += anom

    print("\n=== Batch report 59 (stato attuale, nessun anno) ===")
    df59, rec59, anom59 = process_report_year(api, 59, None, prov_map, reg_nomi, materiale_map, meta_rows)
    all_reconcile += rec59
    all_anomalies += anom59

    _write_manifest(meta_rows)

    print("\n=== Unificazione ===")
    dfs = {rid: pd.concat(parts, ignore_index=True) for rid, parts in dfs_by_rid.items()}
    dfs[59] = df59
    df_reconcile = pd.DataFrame(all_reconcile)
    print(df_reconcile.to_string())

    print("\n=== Export ===")
    OUT.mkdir(exist_ok=True)
    df_prov = pd.DataFrame(
        [(s, nome, cod, reg_nomi.get(cod, cod)) for s, (cod, nome) in prov_map.items()],
        columns=["cod_provincia", "provincia", "cod_regione", "regione"],
    ).sort_values("cod_provincia")
    df_anom = pd.DataFrame(all_anomalies)

    xlsx_path = OUT / "rentri.xlsx"
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        for rid, df in dfs.items():
            df.to_excel(writer, sheet_name=SHEET_NAMES[rid], index=False)
            df.to_csv(OUT / f"report_{rid}.csv", index=False, sep=";", encoding="utf-8-sig")
        df_reconcile.to_excel(writer, sheet_name="Riconciliazione", index=False)
        df_prov.to_excel(writer, sheet_name="Mappatura_Territorio", index=False)
        df_anom.to_excel(writer, sheet_name="Anomalie_Numeriche", index=False)

    print(f"Excel: {xlsx_path}")
    for rid, df in dfs.items():
        anni_info = f" (anni: {sorted(df['Anno'].unique())})" if "Anno" in df.columns else ""
        print(f"  report {rid}: {len(df)} righe{anni_info}")
    if len(df_anom):
        print(f"ATTENZIONE: {len(df_anom)} valori non numerici nei PDF sorgente (vedi foglio Anomalie_Numeriche)")

    return dfs, df_reconcile


if __name__ == "__main__":
    main()
