# Pacchetto: scraping RENTRI (area consultazione) — reportId 56/57/58/59, multi-anno

**Stato: completato (2026-07-24).** Download, parsing e riconciliazione eseguiti per **2024, 2025,
2026** (56/57/58) + stato attuale (59) — vedi [REPORT_VALIDAZIONE.md](REPORT_VALIDAZIONE.md) per il
dettaglio completo dei risultati e [BRIEF.md §6-7](BRIEF.md) per le scoperte empiriche e
l'estensione multi-anno.

## Contenuto
- `BRIEF.md` — istruzioni originali (fasi A→F) + §6-7 con i risultati, le scoperte empiriche che
  hanno superato alcune assunzioni iniziali (bastano 4 PDF nazionali per anno, non serve scaricare
  1 PDF per provincia) e l'estensione multi-anno.
- `REPORT_VALIDAZIONE.md` — deliverable di validazione: PDF scaricati, righe estratte per
  report/anno, tabella dei delta di riconciliazione, anomalie riscontrate, assunzioni di parsing.
- `rentri_scraper.py` — script definitivo: download (token anti-forgery fresco + retry, cache su
  disco con resume), parser calibrato per i 4 report, batch annuali indipendenti con cache
  intermedia, riconciliazione automatica, export CSV + Excel unico multi-anno.
- `reconcile_regioni.py` — validazione estesa: confronta nazionale vs footer regionale ufficiale
  su tutte le 20 regioni (PDF scaricati solo in memoria, mai salvati su disco). Vedi
  [REPORT_VALIDAZIONE.md §4.3](REPORT_VALIDAZIONE.md).
- `monitor_mensile/` — **variazione mensile al massimo dettaglio** (riga del PDF), calcolata come
  differenza tra scarichi successivi: scarica il solo anno corrente, archivia lo snapshot datato e
  produce 2 fogli per report (totale scaricato / variazione per riga). Da lanciare il 3 di ogni
  mese; pensato per diventare una routine cloud (repo GitHub `gdililloref/RENTRI_REF`).
  Vedi `monitor_mensile/rentri_monitor_mensile.py` e §"Le due misure" qui sotto.
- `build_tool.py` + `build/` — genera `build/dist/rentri_dashboard.html`, una dashboard HTML
  standalone (mappe/grafici) a partire dai CSV in `rentri_out/`.

## Le due misure di variazione (aggiornamento 2026-08-03)

RENTRI espone **solo lo stato cumulato corrente**: non esiste un endpoint "movimenti del mese".
Qualunque variazione di periodo e' quindi per costruzione una **differenza tra due scarichi**, e il
passato non e' ricostruibile: le serie partono dal primo scarico archiviato e crescono in avanti.
Da qui due script con ruoli distinti e **output separati**:

| | `monitor_mensile/rentri_monitor_mensile.py` | `rentri_scraper.py` |
|---|---|---|
| Cosa misura | variazione **mensile** riga per riga | variazione **retroattiva** sugli anni chiusi |
| Anni scaricati | solo l'anno corrente | 2024 -> anno corrente |
| Quando | il 3 di ogni mese | sporadicamente, per controllo |
| Durata | ~15 min | ~30-45 min |
| Archivio (non cancellare) | `monitor_mensile/snapshots/` | `rentri_out/_storico/` |
| Output | `monitor_mensile/variazione_mensile_dettaglio.xlsx` | `rentri_out/rentri.xlsx` |

Lettura obbligata dei numeri: la differenza tra due scarichi e' l'attivita' **registrata**
nell'intervallo, non quella **svolta** — comprende registrazioni tardive e correzioni di periodi
precedenti (il campo RENTRI e' "Anno registrazione", non un anno di competenza chiuso). Per questo
il foglio `Retroattivo_Sintesi` distingue `retroattiva (anno chiuso)` da `accumulo anno corrente`,
e il foglio `Periodi` del file mensile riporta i giorni effettivi coperti da ogni colonna `Var_`.

Gli **archivi** (`snapshots/`, `_storico/`) sono irripetibili e vanno versionati: senza il run
precedente non esiste alcuna variazione da calcolare. La cache di lavoro (`rentri_out/_interim/`,
`rentri_pdf_cache/`) e' invece rigenerabile e non versionata.

## Come si eseguono

```
pip install -r requirements.txt
```

### Variazione mensile (il 3 di ogni mese, ~15 min)
```
python monitor_mensile/rentri_monitor_mensile.py
```
Scarica l'anno corrente (nessun PDF su disco), archivia lo snapshot e riscrive l'Excel. Rilanciarlo
nello stesso giorno **non riscarica** e ricostruisce solo l'Excel. L'anno monitorato e' in
`ANNI_MONITOR` (inizio file): **a gennaio** va aggiunto l'anno appena chiuso, altrimenti le sue
righe smettono di essere confrontabili (le variazioni restano vuote — mai lette come un crollo a
zero, ma le registrazioni tardive su quell'anno non si vedono piu' qui).

### Controllo retroattivo / dataset completo (sporadico, ~30-45 min)
```
python rentri_scraper.py
```
Anni in `ANNI` (inizio file). Ogni lancio **riscarica e riarchivia** (la cache interim e' datata al
giorno del run): e' il presupposto per confrontare i run e vedere i cambiamenti retroattivi. Il
parsing dei report 56/58 (~1.700-2.650 pagine per anno) costa ~5-11 minuti ciascuno: conviene
lanciarlo in background. I PDF di `rentri_pdf_cache/<data>/` non vengono ri-scaricati nello stesso
giorno. Il report 59 non ha concetto di anno (stato attuale), e' un batch a se'.

## Output
### `monitor_mensile/variazione_mensile_dettaglio.xlsx`
- `<report>_Totale` — una riga per chiave di dettaglio, una colonna `Tot_<data>` per scarico:
  il valore cumulato esposto da RENTRI a quella data.
- `<report>_Variazione` — stesse righe, una colonna `Var_<data>` per intervallo tra scarichi.
- `Periodi` (giorni coperti e anni confrontabili per ogni colonna `Var_`), `Anomalie_Numeriche`,
  `Note`. Stessi dati anche in `dettaglio_r{rid}_{totale,variazione}.csv` (senza limiti Excel).

### `rentri_out/rentri.xlsx`
- un foglio per report, **anni impilati nella stessa tabella** (colonna `Anno` in 56/57/58;
  struttura colonne = PDF originale + Regione/Pericoloso/Materiale_ID/Tipo operazione calcolati).
- `Retroattivo_Sintesi` — per (report, anno, unita'): righe nuove/scomparse/modificate e delta tra
  i due run archiviati piu' recenti, con `tipo_variazione` che separa gli anni chiusi (variazione
  retroattiva vera) dall'anno corrente (normale accumulo).
- `Retro_Dettaglio_{56,57,58,59}` — le sole righe cambiate, con valore precedente/attuale e delta
  (completo in `variazioni_retroattive_r{rid}.csv`).
- `Riconciliazione`, `Mappatura_Territorio`, `Anomalie_Numeriche`.
- `rentri_out/report_{56,57,58,59}.csv` — stessi dati dei fogli report, un CSV per report (`;`).

### Cartelle
- `monitor_mensile/snapshots/`, `rentri_out/_storico/` — **archivi storici, non cancellare**:
  irripetibili (RENTRI espone solo l'attuale) e unica base delle variazioni.
- `rentri_out/_interim/`, `rentri_pdf_cache/` — cache di lavoro rigenerabile, non versionata.
