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

## Come rieseguire / aggiungere un anno
```
pip install requests beautifulsoup4 lxml pdfplumber pandas openpyxl
python rentri_scraper.py
```
Gli anni da scaricare per i report 56/57/58 sono in `ANNI` (inizio file `rentri_scraper.py`) —
per aggiungerne uno basta aggiungerlo alla lista e rilanciare: i batch già completati
(`rentri_out/_interim/r{report}_{anno}.pkl`) **non vengono ripetuti**, si scaricano/parsano solo
quelli mancanti. Il report 59 non ha concetto di anno (stato attuale), è un batch a sé.

Il parsing dei report 56/58 (i più voluminosi: ~1.700-2.650 pagine **per anno**) richiede
~5-11 minuti ciascuno; consigliato lanciare lo script in background. I PDF già scaricati in
`rentri_pdf_cache/<data>/` non vengono ri-scaricati (resume/idempotenza su nome file + dimensione).

## Output
- `rentri_out/rentri.xlsx` — un foglio per report, **anni impilati nella stessa tabella**
  (colonna `Anno` presente in 56/57/58; struttura colonne = PDF originale + Regione/Pericoloso/
  Materiale_ID/Tipo operazione calcolati) + fogli `Riconciliazione` (per report **e** anno),
  `Mappatura_Territorio`, `Anomalie_Numeriche`.
- `rentri_out/report_{56,57,58,59}.csv` — stessi dati, un CSV per report (separatore `;`),
  multi-anno.
- `rentri_out/_interim/` — cache intermedia per batch (report, anno): non cancellare se si vuole
  evitare di rielaborare gli anni già fatti.

## Dipendenze Python
```
pip install requests beautifulsoup4 lxml pdfplumber pandas openpyxl
```
