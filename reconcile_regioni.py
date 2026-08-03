#!/usr/bin/env python3
"""
Validazione estesa su tutte le 20 regioni: per ciascun (report, anno, regione) scarica il PDF
regionale ufficiale SOLO in memoria (mai scritto su disco, scartato subito dopo il parsing) e
confronta la somma delle proprie righe con la propria riga "Totali" — stesso identico fetch,
nessuna dipendenza dalla cache nazionale gia' scaricata.

Nota importante (scoperta durante lo sviluppo): i dati RENTRI usano "Anno registrazione", non
un anno di competenza chiuso - anche un anno "passato" come il 2025 continua a ricevere
correzioni/registrazioni tardive nell'ordine di ore. Per questo il confronto e' fatto SEMPRE
contro un fetch fresco (mai contro la cache di rentri_scraper.py, che a distanza di tempo
avrebbe valori leggermente diversi per lo stesso motivo - non un bug, e' il fenomeno stesso da
documentare).

Uso:
    python reconcile_regioni.py
"""

import io
import time

import pandas as pd

from rentri_scraper import ANNI, OUT, PAYLOAD_BASE, PARSERS, Rentri

REGIONE_FIELD = {56: "RegioneProduttore", 57: "RegioneULDest", 58: "RegioneULDest", 59: "RegioneUL"}
COLONNE_59 = ["Numero operatori iscritti", "Numero unita locali iscritte", "di cui Produttore",
              "di cui Trasportatore", "di cui Intermediario senza detenzione", "di cui Recuperatore",
              "di cui Smaltitore", "di cui Centro di raccolta"]


def check_report_anno(api, rid, anno, cod, nome_reg):
    payload = dict(PAYLOAD_BASE[rid])
    if anno:
        payload["Anno"] = anno
    payload[REGIONE_FIELD[rid]] = cod

    r = api.render(payload)
    df, footer, anomalies = PARSERS[rid](io.BytesIO(r.content))  # PDF mai scritto su disco

    rows_out = []
    if rid == 59:
        for f in footer:
            vals = f.get("valori", [])
            for i, col in enumerate(COLONNE_59):
                if i >= len(vals):
                    continue
                calcolato = df[col].sum() if col in df.columns else None
                dichiarato = vals[i]
                delta = (calcolato - dichiarato) if (calcolato is not None and dichiarato is not None) else None
                rows_out.append({"report_id": rid, "anno": anno, "cod_regione": cod, "regione": nome_reg,
                                 "campo": col, "calcolato": calcolato, "dichiarato": dichiarato,
                                 "delta": delta, "n_righe": len(df)})
    else:
        for f in footer:
            unit = f["unita_misura"]
            declared = f["quantita"]
            computed = df.loc[df["Unita di misura"] == unit, "Quantita"].sum()
            delta = (computed - declared) if declared is not None else None
            rows_out.append({"report_id": rid, "anno": anno, "cod_regione": cod, "regione": nome_reg,
                             "unita_misura": unit, "calcolato": computed, "dichiarato": declared,
                             "delta": delta, "n_righe": len(df)})
    for a in anomalies:
        rows_out.append({"report_id": rid, "anno": anno, "cod_regione": cod, "regione": nome_reg,
                         "anomalia": a})
    return rows_out


def main():
    api = Rentri()
    reg_nomi = dict(api.options("RegioneProduttore"))
    codici = sorted(reg_nomi.keys(), key=int)
    print(f"{len(codici)} regioni da verificare: {codici}")

    tutte_righe = []
    for rid in (56, 57, 58):
        for anno in ANNI:
            print(f"=== r{rid} {anno}: {len(codici)} regioni ===")
            for cod in codici:
                nome_reg = reg_nomi[cod]
                try:
                    righe = check_report_anno(api, rid, anno, cod, nome_reg)
                    tutte_righe += righe
                    print(f"  regione {cod} ({nome_reg}): {righe}")
                except Exception as e:
                    print(f"  regione {cod} ({nome_reg}): ERRORE {e}")
                    tutte_righe.append({"report_id": rid, "anno": anno, "cod_regione": cod,
                                        "regione": nome_reg, "errore": str(e)})
                time.sleep(1.2)

    print(f"=== r59 (stato attuale): {len(codici)} regioni ===")
    for cod in codici:
        nome_reg = reg_nomi[cod]
        try:
            righe = check_report_anno(api, 59, None, cod, nome_reg)
            tutte_righe += righe
            print(f"  regione {cod} ({nome_reg}): {righe}")
        except Exception as e:
            print(f"  regione {cod} ({nome_reg}): ERRORE {e}")
            tutte_righe.append({"report_id": 59, "anno": None, "cod_regione": cod,
                                "regione": nome_reg, "errore": str(e)})
        time.sleep(1.2)

    df_out = pd.DataFrame(tutte_righe)
    out_path = OUT / "riconciliazione_regionale_completa.csv"
    df_out.to_csv(out_path, index=False, sep=";", encoding="utf-8-sig")
    print(f"\nSalvato: {out_path}")

    xlsx_path = OUT / "rentri.xlsx"
    with pd.ExcelWriter(xlsx_path, engine="openpyxl", mode="a", if_sheet_exists="replace") as writer:
        df_out.to_excel(writer, sheet_name="Riconciliazione_Regionale", index=False)
    print(f"Aggiunto foglio Riconciliazione_Regionale a {xlsx_path}")

    n_err = df_out["errore"].notna().sum() if "errore" in df_out.columns else 0
    n_anom = df_out["anomalia"].notna().sum() if "anomalia" in df_out.columns else 0
    if "delta" in df_out.columns:
        deltas = df_out["delta"].dropna()
        print(f"\nRighe totali: {len(df_out)} | errori HTTP: {n_err} | anomalie numeriche: {n_anom}")
        print(f"delta: min={deltas.min()} max={deltas.max()} | |delta|>10000: {(deltas.abs() > 10000).sum()}")


if __name__ == "__main__":
    main()
