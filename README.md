# Pacchetto: scraping RENTRI (area consultazione) — reportId 56/57/58/59, multi-anno

**Stato: completato (2026-07-24), struttura riorganizzata il 2026-10-01.** Download, parsing e
riconciliazione eseguiti per **2024, 2025, 2026** (56/57/58) + stato attuale (59) — vedi
[REPORT_VALIDAZIONE.md](Scarichi/REPORT_VALIDAZIONE.md) per il dettaglio dei risultati e
[BRIEF.md §6-7](Scarichi/BRIEF.md) per le scoperte empiriche e l'estensione multi-anno.

## Struttura

```
RENTRI/
├── Scarichi/                      tutto cio' che scarica e archivia dati
│   ├── requirements.txt
│   ├── BRIEF.md, REPORT_VALIDAZIONE.md, reconcile_regioni.log
│   ├── rentri_aggregato/          dataset completo 2024 -> anno corrente (+ build_tool.py)
│   ├── rentri_mensile/            variazione mensile riga per riga
│   └── rentri_pdf_cache/          PDF scaricati per data di run (rigenerabile)
├── Dashboard/                     dashboard HTML standalone
│   ├── rentri_dashboard.html      output (generato da build_tool.py, non modificare a mano)
│   └── build/                     src/ (template, css, app.js, monthly.js, chart_registry.js),
│                                  vendor/ (librerie), dist/ (build_report.json)
└── RENTRI_indagine/               materiale di studio (dati grezzi, conversioni, fac-simile)
```

## Contenuto
- `Scarichi/rentri_aggregato/rentri_scraper.py` — script definitivo: download (token anti-forgery
  fresco + retry, cache su disco con resume), parser calibrato per i 4 report, batch annuali
  indipendenti con cache intermedia, riconciliazione automatica, export CSV + Excel unico
  multi-anno. Tutti i percorsi sono ancorati alla posizione dello script, non alla cartella da
  cui lo si lancia.
- `Scarichi/rentri_aggregato/reconcile_regioni.py` — validazione estesa: confronta nazionale vs
  footer regionale ufficiale su tutte le 20 regioni (PDF scaricati solo in memoria). Vedi
  [REPORT_VALIDAZIONE.md §4.3](Scarichi/REPORT_VALIDAZIONE.md).
- `Scarichi/rentri_aggregato/build_tool.py` — legge i CSV/xlsx di `rentri_aggregato/` e i sorgenti
  in `Dashboard/build/`, scrive `Dashboard/rentri_dashboard.html`.
- `Scarichi/rentri_mensile/` — **variazione mensile al massimo dettaglio** (riga del PDF), calcolata
  come differenza tra scarichi successivi: scarica il solo anno corrente, archivia lo snapshot
  datato e produce 2 fogli per report (totale scaricato / variazione per riga).
  `run_scheduled.ps1` e' il wrapper per il Task Scheduler (usa il percorso UNC `\\nas-storage\...`).
  Pensato per diventare una routine cloud (repo GitHub `gdililloref/RENTRI_REF`).

## Le due misure di variazione (aggiornamento 2026-08-03)

RENTRI espone **solo lo stato cumulato corrente**: non esiste un endpoint "movimenti del mese".
Qualunque variazione di periodo e' quindi per costruzione una **differenza tra due scarichi**, e il
passato non e' ricostruibile: le serie partono dal primo scarico archiviato e crescono in avanti.
Da qui due script con ruoli distinti e **output separati**:

| | `rentri_mensile/rentri_monitor_mensile.py` | `rentri_aggregato/rentri_scraper.py` |
|---|---|---|
| Cosa misura | variazione **mensile** riga per riga | variazione **retroattiva** sugli anni chiusi |
| Anni scaricati | solo l'anno corrente | 2024 -> anno corrente |
| Quando | periodicamente (task schedulato) | sporadicamente, per controllo |
| Durata | ~15 min | ~30-45 min |
| Archivio (non cancellare) | `rentri_mensile/snapshots/` | `rentri_aggregato/_storico/` |
| Output | `rentri_mensile/variazione_mensile_dettaglio.xlsx` | `rentri_aggregato/rentri.xlsx` |

Lettura obbligata dei numeri: la differenza tra due scarichi e' l'attivita' **registrata**
nell'intervallo, non quella **svolta** — comprende registrazioni tardive e correzioni di periodi
precedenti (il campo RENTRI e' "Anno registrazione", non un anno di competenza chiuso). Per questo
il foglio `Retroattivo_Sintesi` distingue `retroattiva (anno chiuso)` da `accumulo anno corrente`,
e il foglio `Periodi` del file mensile riporta i giorni effettivi coperti da ogni colonna `Var_`.

Gli **archivi** (`snapshots/`, `_storico/`) sono irripetibili e vanno versionati: senza il run
precedente non esiste alcuna variazione da calcolare. La cache di lavoro (`_interim/`,
`rentri_pdf_cache/`) e' invece rigenerabile e non versionata.

## Come si eseguono

```
pip install -r Scarichi/requirements.txt
```

### Variazione mensile (~15 min)
```
python Scarichi/rentri_mensile/rentri_monitor_mensile.py
```
Scarica l'anno corrente (nessun PDF su disco), archivia lo snapshot e riscrive l'Excel. Rilanciarlo
nello stesso giorno **non riscarica** e ricostruisce solo l'Excel. L'anno monitorato e' in
`ANNI_MONITOR` (inizio file): **a gennaio** va aggiunto l'anno appena chiuso, altrimenti le sue
righe smettono di essere confrontabili (le variazioni restano vuote — mai lette come un crollo a
zero, ma le registrazioni tardive su quell'anno non si vedono piu' qui).

Esecuzione schedulata: il Task Scheduler deve lanciare
`Scarichi\rentri_mensile\run_scheduled.ps1` (log in `rentri_mensile\logs\`, ultimi 24 conservati).
Se il task era stato registrato prima della riorganizzazione, va aggiornato al nuovo percorso.

### Controllo retroattivo / dataset completo (sporadico, ~30-45 min)
```
python Scarichi/rentri_aggregato/rentri_scraper.py
```
Anni in `ANNI` (inizio file). Ogni lancio **riscarica e riarchivia** (la cache interim e' datata al
giorno del run): e' il presupposto per confrontare i run e vedere i cambiamenti retroattivi. Il
parsing dei report 56/58 (~1.700-2.650 pagine per anno) costa ~5-11 minuti ciascuno: conviene
lanciarlo in background. I PDF di `rentri_pdf_cache/<data>/` non vengono ri-scaricati nello stesso
giorno. Il report 59 non ha concetto di anno (stato attuale), e' un batch a se'.

### Dashboard
```
python Scarichi/rentri_aggregato/build_tool.py
```
Rigenera `Dashboard/rentri_dashboard.html`. Il menu ha due sezioni:
- **Dati annuali** — dai CSV di `rentri_aggregato/` (ultimo `rentri_scraper.py`);
- **Monitor mensile** — dai `dettaglio_r*_{totale,variazione}.csv` di `rentri_mensile/`: variazione
  tra scarichi successivi, viste Andamento / Mappa / Classifica / Heatmap, misure variazione
  assoluta, media giornaliera (gli intervalli hanno durate diverse) e % sul totale iniziale.
  La sezione compare solo se il monitor ha almeno 2 scarichi.

Unita' di misura: la dashboard e' interamente in kg. Le righe del report 56 dichiarate in litri
sono convertite nel build con il fattore medio KFO (t/m3 = kg/l) del codice EER, preso da
`Dashboard/tassi_conversione_litri_ton.xlsx`, e sommate ai kg della stessa chiave
(anno, provincia, EER); vale per i dati annuali e per il monitor mensile. Se compare un codice in
litri assente dalla tabella il build si ferma e lo elenca: va aggiunto il fattore. I CSV/xlsx in
`Scarichi/` restano invece con kg e litri separati, come nei PDF RENTRI.

Self-check prima del build: le somme dei CSV annuali devono tornare con i totali ufficiali dei PDF
(foglio `Riconciliazione` di `rentri.xlsx`, tolleranza 0,01%) e ogni variazione mensile deve
coincidere, riga per riga, con la differenza dei totali dei due scarichi; il browser ricalcola poi
gli stessi totali dopo la decodifica (console). La data di estrazione mostrata e' quella
dell'ultimo run in `_storico/`. Va rilanciato dopo ogni `rentri_scraper.py` **e** dopo ogni
`rentri_monitor_mensile.py`, altrimenti la dashboard resta ferma ai dati del build precedente.

## Output
### `Scarichi/rentri_mensile/variazione_mensile_dettaglio.xlsx`
- `<report>_Totale` — una riga per chiave di dettaglio, una colonna `Tot_<data>` per scarico:
  il valore cumulato esposto da RENTRI a quella data.
- `<report>_Variazione` — stesse righe, una colonna `Var_<data>` per intervallo tra scarichi.
- `Periodi` (giorni coperti e anni confrontabili per ogni colonna `Var_`), `Anomalie_Numeriche`,
  `Note`. Stessi dati anche in `dettaglio_r{rid}_{totale,variazione}.csv` (senza limiti Excel).

### `Scarichi/rentri_aggregato/rentri.xlsx`
- un foglio per report, **anni impilati nella stessa tabella** (colonna `Anno` in 56/57/58;
  struttura colonne = PDF originale + Regione/Pericoloso/Materiale_ID/Tipo operazione calcolati).
- `Retroattivo_Sintesi` — per (report, anno, unita'): righe nuove/scomparse/modificate e delta tra
  i due run archiviati piu' recenti, con `tipo_variazione` che separa gli anni chiusi (variazione
  retroattiva vera) dall'anno corrente (normale accumulo).
- `Retro_Dettaglio_{56,57,58,59}` — le sole righe cambiate, con valore precedente/attuale e delta
  (completo in `variazioni_retroattive_r{rid}.csv`).
- `Riconciliazione`, `Mappatura_Territorio`, `Anomalie_Numeriche`.
- `report_{56,57,58,59}.csv` — stessi dati dei fogli report, un CSV per report (`;`).
