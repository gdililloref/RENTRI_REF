# Brief per Claude Code — Scraping e aggregazione dati RENTRI (area consultazione)

## 0. Obiettivo
Scaricare in modo sistematico e **testare strategie di parsing/aggregazione** dei PDF prodotti dal
cruscotto pubblico RENTRI, per l'anno **2025**, dai report **56, 57, 58, 59**, fino al **massimo
dettaglio territoriale**. Output finale: dataset normalizzati in **CSV + Excel** con i valori numerici
già convertiti, più un breve report di validazione.

Esiste uno **script di partenza**: `rentri_scraper.py` (download + cache + parsing difensivo).
Va **verificato, calibrato e migliorato**, in particolare la funzione `parse()` (mai validata su PDF reali).

---

## 1. Cosa è già stato accertato (non ri-scoprirlo, ma verifica che valga ancora)

### Architettura
- Sito Orchard Core (.NET), modulo `Ecocerved.OrchardCore.Mvc.ReportPubblici`.
- I dati **non sono nell'HTML**: tutto è generato server-side su richiesta.
- **Unico endpoint dati**: `POST https://www.rentri.gov.it/reportapi/Render` → `application/pdf`.
  - `formato` diverso da `PDF` (EXCEL/CSV/XLSX/JSON/HTML) → **400**. Non esiste output strutturato.
- `POST /reportapi/RenderChartImg` → `image/png` (grafici): **ignorare**, non contiene dati estraibili.

### Meccaniche obbligatorie della richiesta
1. **Token anti-forgery fresco per ogni POST.** `GET /area-consultazione` imposta il cookie
   anti-forgery e incorpora `__RequestVerificationToken` (input hidden). Il POST deve includere quel
   token nel body **e** avere il cookie di sessione appaiato. Token stantìo → **500**.
   Flusso robusto: `GET → estrai token → POST subito`; su 500/400, **rigenera token e riprova**.
   (`requests.Session` gestisce da solo i cookie, inclusi i due cookie JWT HttpOnly anti-forgery.)
2. **`reportId` e `contesto` vanno impostati esplicitamente** nel body, altrimenti **500**
   (i nomi-campo di 57/58 sono ambigui e il server non disambigua da solo).
3. Gli header di telemetria Azure (`request-id`, `traceparent`) **non** servono.

### Template body POST (multipart o urlencoded)
```
__RequestVerificationToken = <token fresco>
reportId                   = 56|57|58|59
contesto                   = public-movimenti-analisi   (56,57,58)  |  public-operatori-analisi (59)
formato                    = PDF
CausaleOperazione          = ""            (sempre vuoto)
Anno                       = 2025          (56,57,58; il 59 NON ha Anno)
<campo-chiave>             = ""            (lascia vuoto → tutte le chiavi in un solo PDF)
<campo-territorio>         = <codice> | "" (filtro; "" = tutto il territorio)
```

### Schema campi per report (nomi ESATTI)
| reportId | contesto | Anno | Campo REGIONE | Campo PROVINCIA | Campo-CHIAVE (lascia `""`) | Altri filtri |
|---|---|---|---|---|---|---|
| 56 Rifiuti prodotti | public-movimenti-analisi | sì | `RegioneProduttore` | `ProvinciaProduttore` | `CodiceEER` | — |
| 57 Materiali End-of-Waste | public-movimenti-analisi | sì | `RegioneULDest` | `ProvinciaULDest` | `MaterialeId` | — |
| 58 Rifiuti trattati | public-movimenti-analisi | sì | `RegioneULDest` | `ProvinciaULDest` | `CodiceEER` | `DestinatoAttivita` (lascia `""`) |
| 59 Operatori/unità locali | public-operatori-analisi | **no** | `RegioneUL` | **(assente)** | — (nessuna) | `TipoAttivita` |

### Codifiche dei valori (estrarle DINAMICAMENTE dagli `<option>`, non hard-codare)
- **Regione**: codici **numerici** — es. `13`=Abruzzo, `17`=Basilicata, `18`=Calabria… (21 opzioni con "[Tutte]").
- **Provincia**: **sigla** — es. `AQ`, `CH`… (114 opzioni). Funziona **anche da sola**, con `Regione=""`.
- **CodiceEER**: codice **senza separatori**, es. `010101` (1.127 opzioni).
- **MaterialeId**: **numerico** — es. `23`. ATTENZIONE: le sigle visibili (ACM, CSS, PLA…) sono
  **etichette**; il valore da inviare è l'id numerico. Mappa id↔etichetta dagli `<option>`.
- **DestinatoAttivita**: es. `D1` (operazioni R/D, 29 opzioni).
- **TipoAttivita**: es. `C` (7 opzioni).
- **"Tutte"/"Tutti" = `""`** (stringa vuota).

### Fatti empirici verificati (Anno=2025) — usali come oracoli di regressione
| Chiamata | Esito | Peso | Pagine |
|---|---|---|---|
| 56 `RegioneProduttore=""`, `CodiceEER=""` | 200 | ~9,28 MB | molte (nazionale, tutti EER) |
| 56 `RegioneProduttore=""`, `CodiceEER=010101` | 200 | ~275 KB | 1 |
| 56 `RegioneProduttore=13`, `CodiceEER=""` | 200 | ~595 KB | 59 |
| 56 `RegioneProduttore=13`, `CodiceEER=010101` | 200 | ~261 KB | 1 |
| 56 `ProvinciaProduttore=AQ`, `CodiceEER=""` | 200 | ~356 KB | 15 |
| 57 `RegioneULDest=13`, `MaterialeId=""` | 200 | ~279 KB | 2 |
| 58 `RegioneULDest=13`, `CodiceEER=010101` | 200 | ~261 KB | 1 |
| 59 tutto vuoto | 200 | ~308 KB | 5 |
| 59 `RegioneUL=13` | 200 | ~271 KB | 1 |

### Natura del PDF
Testo **vettoriale reale** (≈33 font, stream FlateDecode) + 1 sola immagine (logo).
→ **estraibile con `pdfplumber`/`pdftotext`, senza OCR**.

### Interpretazione strutturale (da confermare col parsing)
- L'asse **tabellare interno** al PDF è il **campo-chiave** del report (EER / Materiale / TipoAttività):
  1 sezione per chiave; le pagine crescono col numero di chiavi con dati.
- Il **territorio è un FILTRO**, non un asse interno → il dettaglio provinciale si ottiene **solo**
  scaricando **1 PDF per provincia**.
  **[SUPERATO, vedi §6: falso — il PDF nazionale contiene già il dettaglio per provincia riga per riga.]**

### Strategia di download (già implementata in `rentri_scraper.py`)
| Granularità | 56 | 57 | 58 | 59 | Totale PDF |
|---|---|---|---|---|---|
| Nazionale | 1 | 1 | 1 | 1 | 4 |
| Regionale | 20 | 20 | 20 | 20 | 80 |
| Provinciale (max) | ~110 | ~110 | ~110 | 20¹ | ~350 |

¹ Il 59 non ha filtro provincia → dettaglio massimo = regione.
Principio: **scaricare solo al grano più fine** (provincia per 56/57/58; regione per 59) e **derivare
regione/nazionale per aggregazione**; scaricare anche i 4 PDF nazionali come **controllo di riconciliazione**.
**[SUPERATO, vedi §6: bastano i 4 PDF nazionali, stesso dettaglio massimo.]**

---

## 2. Cosa devi TESTARE (linee guida operative, in ordine)

### Fase A — Validazione meccaniche (piccolo campione)
- Verifica che i nomi-campo, le codifiche e gli esiti della tabella sopra siano ancora validi
  (estrai gli `<option>` live; le liste possono cambiare).
- Scarica 1 PDF per report a livello **regione** (es. Abruzzo=13) e conferma `200` + `application/pdf`.
- Verifica il flusso token: forza un token stantìo e conferma il retry con refresh.

### Fase B — Calibrazione del PARSING (il punto critico, mai validato)
- Apri i PDF campione e **ispeziona il layout reale** (`pdfplumber` `page.extract_tables()`,
  `page.extract_words()`, `page.lines`/`rects` per capire la griglia).
- Determina, **per ciascun report**, la struttura effettiva delle tabelle:
  - quali **colonne/dimensioni** sono presenti (chiave EER/Materiale, descrizione, quantità,
    **pericoloso/non pericoloso**, unità di misura, eventuale ripartizione per attività R/D nel 58);
  - se il territorio o l'attività compaiono come **sotto-righe** dentro il PDF o solo come filtro;
  - gestione di **intestazioni ripetute** ad ogni pagina e di sezioni multi-pagina.
- Gestisci le insidie:
  - **Formato numerico italiano** `#.###,#` → converti a float (punto=migliaia, virgola=decimali).
  - **Unità di misura**: la pagina avverte che i valori in **litri** sono esclusi da alcune sintesi;
    distingui kg/t da litri e non sommare unità diverse.
  - **PDF senza dati** per una chiave/territorio (celle vuote, "0", o assenza di righe).
- Confronta due parser alternativi e scegli il più robusto:
  1. `extract_tables()` con `table_settings` calibrati;
  2. clustering per posizione dei `words` (x/y) quando la griglia non è rilevata.

### Fase C — Modello dati e output
Produci per ogni report una tabella **long-format** normalizzata, es.:
```
report_id, anno, livello_terr (nazionale|regione|provincia), cod_terr, desc_terr,
tipo_chiave (EER|Materiale|TipoAttivita), cod_chiave, desc_chiave,
pericolosita (P|NP|NA), quantita, unita_misura, fonte_pdf
```
Esporta: 1 CSV per report (sep `;`) + 1 Excel multi-foglio. Numeri come float.
**[AGGIORNATO, vedi §6/§7: su richiesta utente, i fogli dati replicano la struttura del PDF
originale (non il long-format sopra), con l'aggiunta di colonne calcolate (Regione, Pericoloso,
Materiale_ID, Tipo operazione).]**

### Fase D — Riconciliazione (validazione dei dati, obbligatoria)
- **Somma province → confronta con PDF regione**; **somma regioni → confronta con PDF nazionale**.
- Quantifica gli scarti: se `Σprovince ≠ regione`, sospetta **soppressione di celle piccole** o
  arrotondamenti a livello fine. Riporta i delta per report e per chiave.
- Decidi la fonte "autoritativa" per ogni livello sulla base della riconciliazione (probabile:
  usare il livello più aggregato come verità e il fine solo dove concorda).

### Fase E — Robustezza e scala
- Cache dei PDF su disco con **resume** (non ri-scaricare); idempotenza per (report, anno, territorio).
- Retry con backoff su 400/500 (refresh token); distinzione 400 (validazione) vs 500 (token/errore).
- **Politeness**: delay 1,5–3 s tra chiamate, User-Agent identificabile, niente burst sul PDF
  nazionale (pesante); `robots.txt` non blocca `/area-consultazione` né `/reportapi`.
- Solo dopo che B+D funzionano su un campione, **scala** al livello provinciale completo (~350 PDF).

### Fase F — Casi limite da coprire
- `MaterialeId` numerico vs etichetta (mappa esplicita).
- Provincia usata da sola (`Regione=""`).
- `58 DestinatoAttivita`: confermare se l'attività è tabellata *dentro* il PDF (lasciandolo `""`) o se
  va iterata come dimensione (×29). Decidere di conseguenza.
- `59` è "stato attuale" (nessun Anno): non confrontarlo come flusso 2025 con 56/57/58.

---

## 3. Deliverable attesi
1. Script di download robusto (parti da `rentri_scraper.py`, miglioralo).
2. Parser calibrato e documentato, con test di regressione sugli oracoli della tabella §1.
3. CSV per report + Excel multi-foglio nel modello long-format.
4. **Report di validazione** (Markdown): n° PDF scaricati, n° righe per report, chiavi con/senza dati,
   tabella dei delta di riconciliazione province→regione→nazionale, note sulle unità e le soppressioni.
5. Breve README con istruzioni d'uso e dipendenze
   (`requests`, `beautifulsoup4`, `lxml`, `pdfplumber`, `pandas`, `openpyxl`).

## 4. Vincoli
- Non usare l'endpoint `RenderChartImg` (immagini, niente dati).
- Non tentare formati diversi da `formato=PDF` (danno 400).
- Dati MASE–RENTRI liberamente riutilizzabili citando la fonte; cita "MASE – RENTRI" negli output.
- Riporta esplicitamente ogni assunzione fatta in fase di parsing e ogni scostamento dagli oracoli.

## 5. Primo passo consigliato
Scarica **un solo PDF** (report 56, `ProvinciaProduttore=AQ`, `CodiceEER=""`, atteso ~356 KB, 15 pagine),
ispezionane la struttura, e proponi il modello di parsing PRIMA di scalare.

---

## 6. Aggiornamento post-esecuzione (2026-07-24) — risultati e scostamenti dalle assunzioni iniziali

Esecuzione completata. Dettaglio completo in [REPORT_VALIDAZIONE.md](REPORT_VALIDAZIONE.md). Punti principali:

### Scoperta che supera l'assunzione §1 ("il territorio è un filtro, non un asse interno")
**Falso, verificato empiricamente**: il PDF scaricato con territorio **vuoto** (livello nazionale)
contiene già, riga per riga, il dettaglio di **provincia** — non è un aggregato. Confermato
confrontando bit-a-bit, per tutti e 4 i report, il subset "regione Abruzzo" estratto dal PDF
nazionale contro un PDF regione-13 scaricato in modo indipendente: **match esatto** in ogni caso
(righe identiche, stesso conteggio). Conseguenza pratica:

- **Bastano 4 richieste HTTP totali per anno** (una per report, territorio `""`) per ottenere lo
  stesso identico dettaglio massimo che si sarebbe ottenuto con ~350 PDF provinciali + 80 regionali
  + 4 nazionali previsti nella strategia originaria (§1, tabella "Strategia di download").
- Dimensioni reali osservate (Anno 2025): 56 → 8,85 MB / 1.714 pagine; 57 → 0,48 MB / 48 pagine;
  58 → 14,58 MB / 2.651 pagine; 59 → 0,29 MB / 5 pagine. Tempo di download totale ~93 s.
- Continuano a essere scaricati alcuni PDF regionali (regione 13) **solo** come campione di
  riconciliazione indipendente, non per coprire il territorio.

### Altre conferme/scostamenti rispetto al §1-§2
- **Report 58, `DestinatoAttivita=""`**: confermato che l'attività (R../D..) è tabellata **dentro**
  il PDF come colonna propria — non va iterata ×29 come ipotizzato in Fase F.
- **Pericolosità**: non è una colonna a parte nel PDF sorgente; è il suffisso `*` sul Codice EER
  (report 56 e 58). Il parser lo separa in una colonna `Pericoloso` (P/NP) calcolata.
- **Provincia → Regione**: mappa ottenuta **dinamicamente** dall'attributo `data-masterkey` delle
  `<option>` di `ProvinciaProduttore` (non hard-codata, come richiesto).
- **Struttura tabellare**: `pdfplumber.extract_tables()` (strategia `lines`, quella di default)
  si è rivelato affidabile su tutti i report, incluse le descrizioni EER multi-riga (correttamente
  unite in un'unica cella grazie alla griglia vettoriale reale) — non è stato necessario il
  fallback a clustering per posizione delle `words` previsto come piano B.
- **Anomalia di dati lato server**: il footer "Totali" del report 57 nazionale contiene il valore
  letterale `#Error` invece di un numero (guasto nel motore di reportistica di RENTRI, non un
  problema di parsing). Gestito senza interrompere l'esecuzione; il totale calcolato riga-per-riga
  resta affidabile perché verificato in modo indipendente sul campione regionale.
- **Righe con `Attività a destinazione` vuota** (report 58, 1.148 righe su 49.338 nel 2025): trattate
  come dato mancante legittimo (`Tipo operazione = null`), non come errore.

### Costo di parsing (per pianificare eventuali ri-esecuzioni)
`extract_tables()` costa ~150–255 ms/pagina (collo di bottiglia: estrazione dei tracciati
vettoriali per la rilevazione della griglia). Sui volumi 2025 questo significa ~5-7 minuti per il
report 56 e ~7-11 minuti per il report 58 per anno — accettabile per un job batch, da eseguire in
background.

### Due bug corretti durante l'esecuzione (non presenti nel design iniziale)
1. **Memory leak di `pdfplumber`**: `pdf.pages` resta vivo per l'intera durata del `with
   pdfplumber.open()`, quindi le proprietà cache (chars/rects/lines) di tutte le pagine già
   processate restavano in memoria — osservato ~2,9 GB dopo 900/2.651 pagine del report 58. Risolto
   chiamando `page.close()` dopo ogni pagina.
2. **`parse_58` hardcodava l'anno `"2025"`** come condizione per riconoscere una riga dati (invece
   di un controllo generico su cella vuota/intestazione) — funzionava per coincidenza nel primo run
   a singolo anno, ma azzerava silenziosamente tutte le righe di anni diversi. Scoperto e corretto
   testando il 2024. Lezione: qualunque valore letterale specifico dell'anno nel codice di parsing è
   un indizio di bug quando si passa a multi-anno.

---

## 7. Estensione multi-anno (2026-07-24)

Su richiesta, l'architettura è stata estesa per gestire **più anni in batch indipendenti**,
unificati in un solo Excel a fine esecuzione. Dettagli architetturali e risultati in
[REPORT_VALIDAZIONE.md §7](REPORT_VALIDAZIONE.md).

- **Il campo `Anno`** (56/57/58) è testo libero, non un dropdown: il server accetta qualunque anno.
  Verificato: **1999–2023 → PDF vuoti** (nessuna registrazione, il sistema non era operativo);
  **2024 → dati reali ma sparsi** (avvio operativo); **2025 → dataset completo**; **2026 (anno
  corrente, ~7 mesi) → già quasi voluminoso quanto il 2025 completo**.
- **Report 59** non ha il campo Anno (è "stato attuale"): resta un singolo snapshot indipendente
  dagli anni scelti per 56/57/58.
- Ogni **batch (report, anno)** viene scaricato, parsato e persistito su disco
  (`rentri_out/_interim/`) **prima** di essere unificato: un'interruzione o l'aggiunta di un nuovo
  anno in seguito non richiede di rielaborare gli anni già completati.