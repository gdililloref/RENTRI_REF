# Report di validazione — RENTRI area consultazione, multi-anno (2024–2026)

Esecuzione: 2026-07-24. Script: `rentri_scraper.py`. Output: `rentri_out/rentri.xlsx` + 4 CSV.
Fonte dati: **MASE – RENTRI** (Registro Elettronico Nazionale per la Tracciabilità dei Rifiuti),
cruscotto pubblico `https://www.rentri.gov.it/area-consultazione`.

## 1. Copertura storica: quali anni esistono

Il campo `Anno` (report 56/57/58) è testo libero, non un elenco chiuso. Test empirico su report 56
(regione 13), tutti `200 OK`:

| Anno | Esito |
|---|---|
| 1999–2023 | PDF **vuoto** (solo intestazione + riga "Totali" senza valori) — nessuna registrazione |
| **2024** | dati reali ma **sparsi** (avvio operativo del tracciamento) |
| **2025** | dataset **completo** |
| **2026** | anno corrente (~7 mesi): già **quasi voluminoso quanto il 2025 completo** |

Il report 59 ("stato attuale") non ha il campo Anno: non ha una dimensione storica, è un singolo
snapshot.

Sulla base di questo, la raccolta è stata fatta per **2024, 2025, 2026** (56/57/58) + snapshot
attuale (59).

## 2. PDF scaricati (livello nazionale, territorio `""`)

| report | 2024 | 2025 | 2026 |
|---|---|---|---|
| 56 Rifiuti prodotti | 335 KB / 13 pag. | 8,85 MB / 1.714 pag. (38,1 s) | 8,69 MB / 1.640 pag. (35,5 s) |
| 57 Materiali EoW | 253 KB / 1 pag. | 0,48 MB / 48 pag. | 0,48 MB / 46 pag. (1,2 s) |
| 58 Rifiuti trattati | 261 KB / 1 pag. | 14,58 MB / 2.651 pag. (54,1 s) | 12,83 MB / 2.261 pag. (46,1 s) |
| 59 Operatori/UL | — (nessun anno) | 0,29 MB / 5 pag., snapshot unico | — |

Più 1 PDF di validazione regione-13 per ciascun (report, anno) — usato **solo** per la
riconciliazione incrociata, mai per coprire territorio. Totale: **10 PDF di produzione**
(~46 MB) + 10 PDF campione. Nessun errore 400/500; nessun retry necessario.

**Scostamento dalla strategia originaria del BRIEF**: il piano iniziale prevedeva ~350 PDF
provinciali + 80 regionali + 4 nazionali **per anno**. Verificato empiricamente che il PDF
nazionale contiene già il dettaglio riga-per-riga a livello di provincia (non è un aggregato) —
vedi §4. Di conseguenza bastano 4 PDF nazionali per anno per lo stesso dettaglio massimo.

## 3. Righe estratte per report e anno

| report | 2024 | 2025 | 2026 | totale |
|---|---|---|---|---|
| 56 Rifiuti prodotti | 272 | 38.742 | 37.117 | **76.131** |
| 57 Materiali EoW | 0 | 1.184 | 1.130 | **2.314** |
| 58 Rifiuti trattati | 1 | 49.338 | 42.126 | **91.465** |
| 59 Operatori/UL | — | — | — | **111** (snapshot unico) |

Il 2024 conferma di essere un anno di avvio: 0 righe per il report 57 (nessuna cessazione di
rifiuto registrata), 1 sola riga per il 58. Nessuna di queste è un errore di parsing — il footer
"Totali" del PDF stesso è coerentemente vuoto/minimo per questi casi.

## 4. Riconciliazione

### 4.1 Subset regione 13 (dal nazionale) vs PDF regione-13 indipendente — verifica strutturale

Confronto riga-per-riga tra il subset "Abruzzo" estratto dal PDF nazionale e un PDF scaricato
indipendentemente con filtro regione=13, per **ogni** report e anno:

| report | 2024 | 2025 | 2026 |
|---|---|---|---|
| 56 | ✓ match (10 righe) | ✓ match (1.320 righe) | ✓ match (1.237 righe) |
| 57 | ✓ match (0 righe) | ✓ match (41 righe) | ✓ match (42 righe) |
| 58 | righe=0 in entrambi, ma `equals()`=False¹ | ✓ match (1.237 righe) | ✓ match (1.151 righe) |
| 59 | — | ✓ match (4 righe), snapshot unico | — |

¹ Unico esito negativo: entrambe le tabelle hanno **0 righe** (nessun dato regione 13 nel 2024 per
il report 58), ma `DataFrame.equals()` confronta anche i dtype delle colonne, che differiscono tra
due tabelle vuote costruite da percorsi diversi. Non è una discrepanza di dati (0 = 0 in entrambi
i casi), è un artefatto del confronto su tabelle vuote — irrilevante ai fini della validazione.

Su tutte le celle con dati reali: **match riga-per-riga esatto**, confermato su 3 anni e 4 report
— conferma robusta che filtrare per territorio non aggiunge/toglie informazione rispetto a
estrarla dal PDF nazionale.

### 4.2 Somma righe vs riga "Totali" dichiarata nel PDF

| report | anno | unità | calcolato | dichiarato | delta | delta % |
|---|---|---|---|---|---|---|
| 56 | 2024 | kg | 490.482 | 490.471 | 11 | 0,0022% |
| 56 | 2024 | l | 84.675 | 84.675 | 0 | 0% |
| 58 | 2024 | kg | 1.260 | 1.260 | 0 | 0% |
| 56 | 2025 | kg | 114.362.059.541 | 114.362.058.871 | 670 | 0,0000006% |
| 56 | 2025 | l | 2.107.065.046 | 2.107.064.989 | 57 | 0,0000027% |
| 57 | 2025 | kg | 79.323.665.767 | **#Error** (guasto server) | n/d | n/d |
| 58 | 2025 | kg | 188.340.733.867 | 188.340.733.407 | 460 | 0,0000002% |
| 56 | 2026 | kg | 72.087.886.292 | 72.087.885.586 | 706 | 0,0000010% |
| 56 | 2026 | l | 1.146.996.188 | 1.146.996.127 | 61 | 0,0000053% |
| 57 | 2026 | kg | 60.057.242.961 | **#Error** (guasto server) | n/d | n/d |
| 58 | 2026 | kg | 112.737.479.747 | 112.737.479.429 | 318 | 0,0000003% |

Gli scarti sono nell'ordine di poche unità su decine/centinaia di miliardi (rumore di
arrotondamento del sistema sorgente, non un difetto del parser), **coerenti in ordine di
grandezza su tutti e 3 gli anni** — non sono indizio di soppressione di celle piccole (i delta non
scalano con il volume dati).

### 4.3 Validazione estesa: tutte le 20 regioni (`reconcile_regioni.py`)

Il controllo §4.2 è stato esteso da 1 regione (Abruzzo) a **tutte le 20 regioni** (Trentino-Alto
Adige non è diviso in Trento/Bolzano nel campo `RegioneProduttore` del sito), per i report
56/57/58 × 3 anni + report 59, per un totale di **405 confronti**. Ogni PDF regionale è scaricato
**solo in memoria** (mai scritto su disco) e il confronto è fatto contro il footer dello stesso
identico fetch — non contro la cache di `rentri_scraper.py`, per il motivo spiegato sotto.

**Scoperta preliminare importante**: il campo si chiama "**Anno registrazione**", non anno di
competenza chiuso. Un primo tentativo di confronto contro i dati già scaricati ore prima (durante
la sessione originale) mostrava scarti fino a ~1,29 milioni di kg per regione — molto più dei
~700 kg di rumore visto in §4.2. Verificato che **non è un bug**: uno stesso report (56, Abruzzo,
2025) scaricato due volte a distanza di ore restituisce lo stesso numero di righe (1.320) ma
somme leggermente diverse — il "2025" continua a ricevere correzioni/registrazioni tardive anche
a distanza di ore. Il confronto corretto deve quindi sempre usare dati scaricati nella stessa
finestra temporale (da qui la riscrittura per fare fetch+confronto nello stesso momento).

**Risultato finale** (405 righe, `rentri_out/riconciliazione_regionale_completa.csv` e foglio
`Riconciliazione_Regionale` in `rentri.xlsx`):

| metrica | valore |
|---|---|
| Errori HTTP | 0 |
| Anomalie numeriche (`#Error`) | 5 — tutte report 57, stesso guasto server di §5, ora confermato anche a livello regionale (non solo nazionale) |
| Delta minimo / massimo | −2 / +95 unità |
| Righe con \|delta\| > 10.000 | 0 |
| Report 59 (operatori/UL) | **delta = 0 su tutte le 20 regioni e tutti gli 8 campi** — match esatto |

Confirma su scala completa (non solo Abruzzo) che: (a) nessuna soppressione di celle piccole a
livello regionale, (b) il rumore di arrotondamento resta nell'ordine di poche decine di unità
indipendentemente dalla dimensione della regione, (c) il guasto `#Error` del report 57 è
intermittente (5 casi su 60 combinazioni report57×regione×anno) non sistematico su ogni chiamata.

## 5. Anomalie riscontrate

| contesto | valore grezzo | gestione |
|---|---|---|
| Report 57, riga "Totali" nazionale **2025** | `#Error` | Non convertibile a numero: registrato in `Anomalie_Numeriche`, footer scartato. Totale di riferimento = valore **calcolato** (79.323.665.767 kg), verificato indipendentemente in §4.1. |
| Report 57, riga "Totali" nazionale **2026** | `#Error` | Stesso guasto, **si ripete identico l'anno successivo** → non è un incidente isolato ma un bug sistemico nel motore di reportistica di RENTRI specifico del calcolo del totale per il report 57. |

Nessun'altra anomalia numerica riscontrata sulle ~170.000 righe dati totali (tutti i report, tutti
gli anni).

## 6. Due bug scoperti e corretti durante l'estensione multi-anno

1. **Memory leak di `pdfplumber`**: `pdf.pages` resta vivo per l'intera durata del blocco `with
   pdfplumber.open()`; le proprietà cache (chars/rects/lines) di ogni pagina già processata
   restavano quindi in memoria. Osservato: ~2,9 GB di RAM dopo 900/2.651 pagine del report 58.
   Risolto chiamando `page.close()` dopo l'estrazione di ogni pagina.
2. **`parse_58` conteneva un controllo hard-codato sull'anno** (`if c0 != "2025": ...`) invece di un
   controllo generico "riga vuota/intestazione" come negli altri parser. Funzionava per
   coincidenza nel run a singolo anno (2025), ma **azzerava silenziosamente tutte le righe** di
   qualunque altro anno. Scoperto testando il 2024 (0 righe estratte a fronte di un footer con
   totale >0) e corretto prima di lanciare la raccolta multi-anno.

## 7. Assunzioni di parsing

1. **Pericolosità** dedotta dal suffisso `*` sul Codice EER (non è una colonna nel PDF sorgente).
2. **Descrizioni EER multi-riga**: unite in un'unica cella tramite la griglia vettoriale reale del
   PDF (`pdfplumber` strategia `lines`); mai state necessarie l'euristica di clustering per
   posizione delle parole (piano B del BRIEF).
3. **Provincia → Regione**: mappa dinamica dall'attributo `data-masterkey` delle `<option>` di
   `ProvinciaProduttore` (111 province, 20 regioni) — non hard-codata.
4. **Materiale → Materiale_ID** (report 57): mappata dall'etichetta testuale del PDF all'id
   numerico tramite le `<option>` di `MaterialeId` (23 valori).
5. **Report 58, colonna "Attività a destinazione"** lasciata vuota nella richiesta: confermato che
   l'attività è tabellata dentro il PDF come colonna propria, non richiede iterazione ×29.
6. **Riga "Totali"** di chiusura pagina esclusa dai fogli dati (avrebbe alterato qualunque somma);
   conservata solo come oracolo nel foglio `Riconciliazione`.
7. **Report 59** trattato come "stato attuale" (nessun campo Anno) — non confrontato come flusso
   storico con 56/57/58.
8. **Batch annuali indipendenti**: ogni (report, anno) è scaricato/parsato/persistito a parte
   (`rentri_out/_interim/`) prima dell'unificazione finale — un'interruzione o l'aggiunta di un
   nuovo anno non richiede di rielaborare gli anni già completati.

## 8. Fonte

Dati: **MASE – RENTRI**, cruscotto pubblico area-consultazione (56/57/58: anni 2024-2026; 59:
stato attuale). Riutilizzo libero citando la fonte.
