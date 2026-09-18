#!/usr/bin/env python3
"""
RENTRI - variazione MENSILE al massimo dettaglio (riga del PDF sorgente).

Ruolo di questo script nella coppia:
  - QUESTO (mensile, leggero): scarica solo l'ANNO CORRENTE, ogni volta che viene lanciato
    (previsto: il 3 di ogni mese), archivia lo snapshot datato e ricostruisce le variazioni
    riga per riga tra scarichi consecutivi. Output: variazione_mensile_dettaglio.xlsx.
  - rentri_scraper.py (2024 -> anno corrente, pesante): serve a intercettare i cambiamenti
    RETROATTIVI sugli anni precedenti, si lancia sporadicamente. Output separato in rentri_out/.
I due output non si mescolano mai: file Excel distinti, cartelle distinte.

--- Semantica del dato ---
RENTRI espone solo lo stato CUMULATO corrente: non esiste un endpoint "movimenti del mese".
La variazione di periodo e' quindi per costruzione una DIFFERENZA TRA DUE SCARICHI:
    Var_<data> = totale scaricato il <data> - totale scaricato allo scarico precedente
cioe' l'attivita' REGISTRATA nell'intervallo tra i due scarichi, non necessariamente
l'attivita' SVOLTA in quell'intervallo (include registrazioni tardive e correzioni). Il foglio
"Periodi" documenta gli intervalli esatti e i giorni coperti da ogni colonna Var.
Il passato non e' ricostruibile: la serie parte dal primo snapshot e cresce in avanti.

Chiave di riga = il massimo dettaglio del PDF: anno, provincia, codice EER (+ pericolosita'),
attivita' a destinazione (R../D..), materiale, unita' di misura. Nessuna aggregazione.
Una chiave presente in uno solo dei due scarichi vale 0 nell'altro (riga nuova -> variazione =
valore pieno; riga scomparsa -> variazione negativa). Se invece un ANNO non e' coperto da uno
dei due scarichi la variazione resta VUOTA (non comparabile), non zero.

--- ATTENZIONE al rollover di gennaio ---
ANNI_MONITOR contiene di default solo l'anno corrente. A gennaio l'anno appena chiuso smette di
essere scaricato: le sue righe diventano "anno non coperto" e le variazioni restano vuote
(corretto: non vengono lette come un crollo a zero), ma le registrazioni tardive su quell'anno
non sono piu' visibili qui. Se servono, aggiungere l'anno chiuso a ANNI_MONITOR (costo: raddoppia
il tempo di esecuzione) oppure affidarsi al controllo retroattivo di rentri_scraper.py.

Uso:
    python rentri_monitor_mensile.py        # snapshot alla data odierna + ricostruzione Excel
Se lo snapshot della data odierna esiste gia', lo scarico viene saltato e si ricostruisce solo
l'Excel (idempotente: rilanciarlo nello stesso giorno non duplica nulla).

Output (in questa cartella):
    snapshots/r{56,57,58,59}_<data>.parquet     archivio storico - NON cancellare: irripetibile,
                                                RENTRI espone solo lo stato corrente
    snapshots/_index.csv                        anni coperti / n. righe per ogni snapshot
    variazione_mensile_dettaglio.xlsx           2 fogli per report: _Totale e _Variazione
    dettaglio_r{rid}_{totale,variazione}.csv    stesso contenuto, senza il limite di righe Excel

Dipendenze: le stesse di rentri_scraper.py + pyarrow (parquet).
"""

import io
import json
import pathlib
import sys
from datetime import datetime

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
# chiave di riga, colonne descrittive e normalizzazione vengono da rentri_scraper: unica fonte
# di verita' condivisa dai due script, altrimenti col tempo divergono
from rentri_scraper import (CHIAVI_DETTAGLIO, DESCR_DETTAGLIO, PARSERS, PAYLOAD_BASE,  # noqa: E402
                           PROV_COL, Rentri, enrich, normalizza_long)

HERE = pathlib.Path(__file__).resolve().parent
SNAP_DIR = HERE / "snapshots"
INDEX_FILE = SNAP_DIR / "_index.csv"
XLSX_FILE = HERE / "variazione_mensile_dettaglio.xlsx"

# solo l'anno corrente: il retroattivo sugli anni chiusi e' compito di rentri_scraper.py
# (vedi "ATTENZIONE al rollover di gennaio" nel docstring)
ANNI_MONITOR = [str(datetime.now().year)]

NOMI = {56: "56_RifiutiProdotti", 57: "57_MaterialiEoW",
        58: "58_RifiutiTrattati", 59: "59_OperatoriUL"}


# ------------------------------------------------------------------ scarico + normalizzazione

def scarica_normalizza(api, rid, anno, prov_map, reg_nomi, materiale_map):
    """Scarica il PDF nazionale (solo in memoria, nessun file su disco) e lo restituisce in
    forma normalizzata long: colonne chiave + descrittive + 'Valore'."""
    payload = dict(PAYLOAD_BASE[rid])
    if anno is not None:
        payload["Anno"] = anno
    r = api.render(payload)
    df, _footer, anomalie = PARSERS[rid](io.BytesIO(r.content))

    df = enrich(df, PROV_COL[rid], prov_map, reg_nomi)
    if rid == 57:
        df["Materiale_ID"] = df["Materiale"].str.lower().map(materiale_map)
    return normalizza_long(df, rid), anomalie


def esegui_snapshot(data_snapshot, anni):
    """Scarica tutto e salva uno snapshot parquet per report, piu' l'indice e l'elenco delle
    anomalie di questo scarico (che vengono persistiti, non solo restituiti)."""
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    api = Rentri()
    prov_map = api.province_regione_map()
    reg_nomi = dict(api.options("RegioneProduttore"))
    materiale_map = api.materiale_map()
    print(f"  {len(prov_map)} province, {len(reg_nomi)} regioni, {len(materiale_map)} materiali")

    anomalie_tot, righe_index = [], []
    for rid in (57, 56, 58):  # dal piu' piccolo al piu' grande
        parti = []
        for anno in anni:
            print(f"  r{rid} anno {anno}...", flush=True)
            df, anomalie = scarica_normalizza(api, rid, anno, prov_map, reg_nomi, materiale_map)
            print(f"    -> {len(df)} righe", flush=True)
            parti.append(df)
            anomalie_tot += [dict(a, report_id=rid, anno=anno) for a in anomalie]
        df_tot = pd.concat(parti, ignore_index=True)
        df_tot["data_snapshot"] = data_snapshot
        df_tot.to_parquet(SNAP_DIR / f"r{rid}_{data_snapshot}.parquet", index=False)
        righe_index.append({"data_snapshot": data_snapshot, "report_id": rid,
                            "anni_coperti": ",".join(anni), "n_righe": len(df_tot),
                            "timestamp": datetime.now().isoformat(timespec="seconds")})
        print(f"  r{rid}: {len(df_tot)} righe totali salvate", flush=True)

    print("  r59 (stato attuale, nessun anno)...", flush=True)
    df59, anomalie = scarica_normalizza(api, 59, None, prov_map, reg_nomi, materiale_map)
    anomalie_tot += [dict(a, report_id=59, anno=None) for a in anomalie]
    df59["data_snapshot"] = data_snapshot
    df59.to_parquet(SNAP_DIR / f"r59_{data_snapshot}.parquet", index=False)
    righe_index.append({"data_snapshot": data_snapshot, "report_id": 59, "anni_coperti": "",
                        "n_righe": len(df59),
                        "timestamp": datetime.now().isoformat(timespec="seconds")})
    print(f"  r59: {len(df59)} righe salvate", flush=True)

    # le anomalie vanno persistite con lo snapshot: se restassero solo in memoria, una
    # ricostruzione dell'Excel (che non ri-parsa i PDF) le perderebbe
    (SNAP_DIR / f"_anomalie_{data_snapshot}.json").write_text(
        json.dumps(anomalie_tot, default=str), encoding="utf-8")

    df_idx = pd.DataFrame(righe_index)
    if INDEX_FILE.exists():
        vecchio = pd.read_csv(INDEX_FILE, dtype=str)
        # se rieseguito nella stessa data, la riga viene sostituita (idempotenza)
        vecchio = vecchio[vecchio["data_snapshot"] != data_snapshot]
        df_idx = pd.concat([vecchio, df_idx.astype(str)], ignore_index=True)
    df_idx.to_csv(INDEX_FILE, index=False)
    return anomalie_tot


# ------------------------------------------------------------------ confronto tra snapshot

def carica_snapshots(rid):
    """{data: DataFrame} per tutti gli snapshot presenti su disco per quel report."""
    out = {}
    for path in sorted(SNAP_DIR.glob(f"r{rid}_*.parquet")):
        data = path.stem.split("_", 1)[1]
        out[data] = pd.read_parquet(path)
    return out


def anni_coperti_per_data(rid):
    if not INDEX_FILE.exists():
        return {}
    idx = pd.read_csv(INDEX_FILE, dtype=str)
    idx = idx[idx["report_id"] == str(rid)]
    # attenzione: per il report 59 anni_coperti e' vuoto e pandas lo rilegge come NaN, che e'
    # truthy -> "NaN or ''" resta NaN. Va intercettato con isna(), non con un or.
    return {r["data_snapshot"]: (set() if pd.isna(r["anni_coperti"])
                                else set(filter(None, str(r["anni_coperti"]).split(","))))
            for _, r in idx.iterrows()}


def costruisci_viste(rid):
    """Ritorna (totale, variazione, periodi) in formato wide: una riga per chiave di dettaglio,
    una colonna per data di scarico."""
    snaps = carica_snapshots(rid)
    if not snaps:
        return None, None, None
    key, descr = CHIAVI_DETTAGLIO[rid], DESCR_DETTAGLIO[rid]
    date = sorted(snaps)

    tot = pd.DataFrame({d: snaps[d].set_index(key)["Valore"] for d in date}).sort_index()

    # colonne descrittive: dallo snapshot piu' recente in cui la chiave appare
    dim = pd.concat([snaps[d][key + descr].assign(_ord=i) for i, d in enumerate(date)],
                    ignore_index=True)
    dim = (dim.sort_values("_ord").drop_duplicates(key, keep="last")
              .drop(columns="_ord").set_index(key))

    coperti = anni_coperti_per_data(rid)
    var, periodi = pd.DataFrame(index=tot.index), []
    for prec, cur in zip(date, date[1:]):
        delta = tot[cur].fillna(0) - tot[prec].fillna(0)
        comuni = coperti.get(prec, set()) & coperti.get(cur, set())
        if rid != 59:
            # confrontabile solo per gli anni presenti in ENTRAMBI gli scarichi
            anno_riga = pd.Index(tot.index.get_level_values("Anno"))
            delta = delta.where(anno_riga.isin(comuni))
        giorni = (datetime.strptime(cur, "%Y-%m-%d") - datetime.strptime(prec, "%Y-%m-%d")).days
        var[f"Var_{cur}"] = delta
        periodi.append({"report_id": rid, "colonna": f"Var_{cur}", "da_scarico": prec,
                        "a_scarico": cur, "giorni": giorni,
                        "anni_confrontabili": ",".join(sorted(comuni))})

    tot = tot.rename(columns={d: f"Tot_{d}" for d in date})
    tot_out = dim.join(tot, how="right").reset_index()
    var_out = dim.join(var, how="right").reset_index() if len(var.columns) else None
    return tot_out, var_out, pd.DataFrame(periodi)


NOTE = [
    "Var_<data> = differenza della singola riga tra lo scarico <data> e il precedente: "
    "attivita' REGISTRATA nell'intervallo (include registrazioni tardive e correzioni).",
    "Tot_<data> = valore cumulato della singola riga come esposto da RENTRI a quella data.",
    "Cella Var vuota = anno non coperto da uno dei due scarichi (non comparabile). "
    "Var su chiave nuova = valore pieno; chiave scomparsa = variazione negativa.",
    "Il foglio Periodi riporta i giorni effettivi coperti da ogni colonna Var (gli scarichi "
    "non cadono a distanza esattamente mensile).",
    "Dettaglio = riga del PDF sorgente: anno, provincia, EER, pericolosita', attivita' R/D, "
    "materiale, unita'. Regione e descrizioni sono derivate.",
    "kg e l NON vanno sommati tra loro: l'unita' di misura e' parte della chiave di riga.",
    "Questo file copre il solo anno corrente. I cambiamenti retroattivi sugli anni precedenti "
    "si controllano con rentri_scraper.py (output separato in rentri_out/).",
    "Archivio snapshots/ irripetibile: RENTRI espone solo lo stato corrente, non lo storico.",
    "Fonte: MASE - RENTRI, cruscotto pubblico area-consultazione.",
]


def carica_anomalie():
    """Anomalie di tutti gli snapshot archiviati. Uno snapshot senza file di anomalie viene
    dichiarato esplicitamente: un foglio vuoto non deve poter essere letto come 'zero anomalie'."""
    righe = []
    for path in sorted(SNAP_DIR.glob("r56_*.parquet")):
        data = path.stem.split("_", 1)[1]
        f = SNAP_DIR / f"_anomalie_{data}.json"
        if f.exists():
            righe += [dict(a, data_snapshot=data) for a in json.loads(f.read_text(encoding="utf-8"))]
        else:
            righe.append({"data_snapshot": data, "contesto": "elenco anomalie non registrato "
                          "per questo snapshot", "valore_grezzo": None})
    return pd.DataFrame(righe)


def esporta():
    fogli, tutti_periodi = {}, []
    for rid in (56, 57, 58, 59):
        tot, var, per = costruisci_viste(rid)
        if tot is None:
            continue
        nome = NOMI[rid]
        fogli[f"{nome}_Totale"] = tot
        tot.to_csv(HERE / f"dettaglio_r{rid}_totale.csv", index=False, sep=";",
                   encoding="utf-8-sig")
        n_var = 0
        if var is not None:
            fogli[f"{nome}_Variazione"] = var
            var.to_csv(HERE / f"dettaglio_r{rid}_variazione.csv", index=False, sep=";",
                       encoding="utf-8-sig")
            n_var = len([c for c in var.columns if c.startswith("Var_")])
        print(f"  r{rid}: {len(tot)} chiavi di dettaglio, {n_var} colonne di variazione")
        if per is not None and len(per):
            tutti_periodi.append(per)

    with pd.ExcelWriter(XLSX_FILE, engine="openpyxl") as w:
        for nome, df in fogli.items():
            df.to_excel(w, sheet_name=nome, index=False)
        per_df = pd.concat(tutti_periodi, ignore_index=True) if tutti_periodi else pd.DataFrame(
            columns=["report_id", "colonna", "da_scarico", "a_scarico", "giorni",
                     "anni_confrontabili"])
        per_df.to_excel(w, sheet_name="Periodi", index=False)
        carica_anomalie().to_excel(w, sheet_name="Anomalie_Numeriche", index=False)
        pd.DataFrame({"nota": NOTE}).to_excel(w, sheet_name="Note", index=False)
    print(f"\nExcel: {XLSX_FILE}")


def main():
    oggi = datetime.now().strftime("%Y-%m-%d")
    print(f"=== Snapshot mensile {oggi} | anno monitorato: {', '.join(ANNI_MONITOR)} ===",
          flush=True)

    if (SNAP_DIR / f"r56_{oggi}.parquet").exists():
        print(f"  snapshot {oggi} gia' presente: salto lo scarico, ricostruisco solo l'Excel")
    else:
        esegui_snapshot(oggi, ANNI_MONITOR)

    print("\n=== Ricostruzione viste totale/variazione ===", flush=True)
    esporta()

    n_snap = len(list(SNAP_DIR.glob("r56_*.parquet")))
    print(f"\nSnapshot storici disponibili: {n_snap}")
    if n_snap < 2:
        print("Questo e' il mese base: serve il prossimo scarico per avere le variazioni.")
    n_anom = len(carica_anomalie())
    if n_anom:
        print(f"Foglio Anomalie_Numeriche: {n_anom} righe (valori non numerici nei PDF sorgente "
              f"o snapshot senza elenco registrato)")


if __name__ == "__main__":
    main()
