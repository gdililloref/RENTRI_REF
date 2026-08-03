#!/usr/bin/env python3
"""
Monitoraggio mensile RENTRI: scarica l'anno corrente (56/57/58) + lo snapshot attuale (59),
confronta i totali - nazionali e per regione - con l'ultimo stato salvato, e appende la
variazione a un Excel dedicato (separato da rentri_out/rentri.xlsx).

Nota fondamentale: il campo "Anno" di RENTRI e' "Anno registrazione", NON un anno di competenza
chiuso - anche l'anno corrente accumula progressivamente e un anno "passato" puo' ricevere
correzioni tardive (osservato: stesso numero di righe, valori diversi a distanza di ore).
Di conseguenza la "variazione mensile" qui calcolata e' un delta tra due fotografie cumulative
nel tempo (snapshot_mese_N - snapshot_mese_N-1), non un dato di competenza del singolo mese:
include sia le nuove registrazioni sia eventuali correzioni retroattive.

Nessun PDF viene salvato su disco: si scaricano in memoria, si calcolano i totali, si scartano.

Uso:
    python rentri_monitor_mensile.py
Output:
    rentri_variazioni_mensili.xlsx  (accumula una riga per ogni run, in questa stessa cartella)
    stato_precedente.json           (ultimo snapshot, per calcolare il prossimo delta)
"""

import io
import json
import pathlib
import sys
from datetime import datetime

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from rentri_scraper import PAYLOAD_BASE, PARSERS, Rentri  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
STATE_FILE = HERE / "stato_precedente.json"
XLSX_FILE = HERE / "rentri_variazioni_mensili.xlsx"

COLONNE_59 = ["Numero operatori iscritti", "Numero unita locali iscritte", "di cui Produttore",
              "di cui Trasportatore", "di cui Intermediario senza detenzione", "di cui Recuperatore",
              "di cui Smaltitore", "di cui Centro di raccolta"]


def snapshot_report_anno(api, rid, anno, prov_map, reg_nomi):
    """Scarica (solo in memoria) il PDF nazionale per (report, anno) e calcola i totali
    nazionali e per regione. Ritorna {"nazionale": {...}, "regioni": {cod: {...}}}."""
    payload = dict(PAYLOAD_BASE[rid])
    if anno:
        payload["Anno"] = anno
    r = api.render(payload)
    df, _footer, _anomalie = PARSERS[rid](io.BytesIO(r.content))

    if rid == 59:
        naz = {col: int(df[col].sum()) for col in COLONNE_59}
        regioni = {}
        cod_reg = df["Provincia"].map(lambda p: prov_map.get(p, (None, None))[0])
        for cod, gruppo in df.groupby(cod_reg):
            regioni[cod] = {col: int(gruppo[col].sum()) for col in COLONNE_59}
        return {"nazionale": naz, "regioni": regioni}

    df = df[df["Unita di misura"].isin(["kg", "l"])]  # scarta righe con unita' vuota (quantita'=0, dato reale ma senza contenuto informativo)
    naz = {unit: int(v) for unit, v in df.groupby("Unita di misura")["Quantita"].sum().items()}
    prov_col = "Provincia produttore" if rid in (56, 57) else "Provincia impianto"
    cod_reg = df[prov_col].map(lambda p: prov_map.get(p, (None, None))[0])
    regioni = {}
    for (cod, unit), gruppo in df.groupby([cod_reg, "Unita di misura"])["Quantita"].sum().items():
        regioni.setdefault(cod, {})[unit] = int(gruppo)
    return {"nazionale": naz, "regioni": regioni}


def calcola_delta(corrente, precedente):
    """Confronta due dict {"nazionale":{...}, "regioni":{cod:{...}}}. Ritorna lista di righe
    long-format: livello, cod_territorio, campo, valore_corrente, valore_precedente, delta."""
    righe = []

    def confronta_dict(livello, cod_terr, cur_vals, prev_vals):
        for campo, cur in cur_vals.items():
            prev = (prev_vals or {}).get(campo)
            delta = (cur - prev) if prev is not None else None
            righe.append({"livello": livello, "cod_territorio": cod_terr, "campo": campo,
                         "valore_corrente": cur, "valore_precedente": prev, "delta": delta})

    confronta_dict("nazionale", "IT", corrente["nazionale"], (precedente or {}).get("nazionale"))
    for cod, cur_vals in corrente["regioni"].items():
        prev_vals = (precedente or {}).get("regioni", {}).get(cod) if precedente else None
        confronta_dict("regione", cod, cur_vals, prev_vals)
    return righe


def main():
    now = datetime.now()
    anno_corrente = str(now.year)
    data_snapshot = now.strftime("%Y-%m-%d")

    print(f"=== Snapshot mensile {data_snapshot} (anno registrazione {anno_corrente}) ===")
    api = Rentri()
    prov_map = api.province_regione_map()
    reg_nomi = dict(api.options("RegioneProduttore"))

    stato_precedente = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}
    stato_corrente = {"data_snapshot": data_snapshot, "anno": anno_corrente, "report": {}}

    tutte_righe = []
    for rid in (56, 57, 58):
        print(f"  scarico r{rid} anno {anno_corrente}...")
        snap = snapshot_report_anno(api, rid, anno_corrente, prov_map, reg_nomi)
        stato_corrente["report"][str(rid)] = snap

        prev_report = stato_precedente.get("report", {}).get(str(rid))
        stesso_anno = stato_precedente.get("anno") == anno_corrente
        righe = calcola_delta(snap, prev_report if stesso_anno else None)
        for riga in righe:
            riga.update({"report_id": rid, "anno": anno_corrente, "data_snapshot": data_snapshot})
            if not stesso_anno and prev_report is not None:
                riga["nota"] = f"nuovo anno registrazione (precedente: {stato_precedente.get('anno')}), nessun confronto"
        tutte_righe += righe

    print("  scarico r59 (stato attuale)...")
    snap59 = snapshot_report_anno(api, 59, None, prov_map, reg_nomi)
    stato_corrente["report"]["59"] = snap59
    righe59 = calcola_delta(snap59, stato_precedente.get("report", {}).get("59"))
    for riga in righe59:
        riga.update({"report_id": 59, "anno": None, "data_snapshot": data_snapshot})
    tutte_righe += righe59

    df_nuove = pd.DataFrame(tutte_righe)
    if XLSX_FILE.exists():
        df_storico = pd.read_excel(XLSX_FILE, sheet_name="Variazioni")
        df_tot = pd.concat([df_storico, df_nuove], ignore_index=True)
    else:
        df_tot = df_nuove

    with pd.ExcelWriter(XLSX_FILE, engine="openpyxl") as writer:
        df_tot.to_excel(writer, sheet_name="Variazioni", index=False)

    STATE_FILE.write_text(json.dumps(stato_corrente, indent=2), encoding="utf-8")

    print(f"\n{len(df_nuove)} righe aggiunte a {XLSX_FILE} (totale storico: {len(df_tot)})")
    naz_rows = df_nuove[df_nuove["livello"] == "nazionale"]
    print(naz_rows[["report_id", "campo", "valore_corrente", "delta"]].to_string(index=False))


if __name__ == "__main__":
    main()
