# V11 a malé účty: výsledky simulace

**NONPROMOTABLE — historická studie. Žádná změna strategie, schválení vydání ani pokyn brokerovi.**

Stávající pravidla V11 při nákupech celých akcií nechávají u malých účtů velkou část peněz v hotovosti. Důležité je proto sledovat skutečně dosaženou expozici a počet pozic vedle samotného výnosu.

## Novější období: 2025-01-02 až 2026-09-04

Níže je varianta se 7 bps nákladů na každou stranu obchodu. Období obsahuje 420 obchodních dnů a bylo již použito při vývoji; není to nový nezávislý test.

| Počáteční účet | Průměrná expozice | Max. počet pozic | Dnů zcela v hotovosti | Nákupy / prodeje | Konečná hodnota | Max. propad |
|---:|---:|---:|---:|---:|---:|---:|
| 100 USD | 0.00 % | 0 | 420/420 | 0/0 | 100.00 USD | 0.00 % |
| 250 USD | 3.61 % | 2 | 291/420 | 3/3 | 249.40 USD | -3.72 % |
| 500 USD | 11.30 % | 3 | 104/420 | 11/9 | 508.38 USD | -6.38 % |
| 1000 USD | 23.43 % | 6 | 1/420 | 40/30 | 1085.41 USD | -8.17 % |

Účet se 100 USD neuskutečnil žádný nákup v žádném z obou období ani při žádné ze tří nákladových variant. Vyšší testované částky umožnily více obchodů, ale jednotlivé běhy stále nemusely naplnit zamýšlené cílové portfolio.

## Proč se to děje

V11 omezuje jednu pozici nejvýše na 9 % hodnoty účtu v běžném režimu. Na jednu cílovou pozici tak zpočátku připadá nejvýše 9 / 22,50 / 45 / 90 USD. Akcii dražší než tento prostor nelze koupit celou, ani když je na účtu dost celkové hotovosti. Risk režim může přidělenou váhu ještě snížit. Cena pro výběr se přitom měří předchozí den, takže samotný limit není matematickou zárukou nulových nákupů při libovolném budoucím otevíracím gapu.

Cílový plán vybírá více titulů; počet skutečně nakoupených titulů může být kvůli celým akciím výrazně nižší. Studie neřeší tento rozdíl změnou vah, uvolněním filtrů ani zavedením zlomkových akcií.

## Co přesně bylo měřeno

- Beze změny použitý existující kauzální backtest engine a výchozí pravidla V11. Žádné ladění parametrů.
- Účty 100 / 250 / 500 / 1 000 USD; náklady 7 / 15 / 25 bps na nákup i prodej.
- Vývojové období 2021-01-04 až 2024-12-31 a znovu použité novější období 2025-01-02 až 2026-09-04; každý z 24 běhů začíná nezávisle v hotovosti.
- Signál využívá dokončená data předchozího dne, provedení je na následujícím open. Prodej a náhradní nákup dodržují původní oddělení do různých seancí.
- Denní expozice a propad vycházejí z ocenění na open; intradenní propady nejsou zachyceny. Konečné otevřené pozice jsou oceněny, nejsou nuceně zlikvidovány.
- Počty obchodů zahrnují skutečně provedené simulované nákupy a prodeje, nikoli jen záznamy o uzavřených pozicích. Modelované náklady již jsou v konečné hodnotě.

## Podstatná omezení

- Historické OHLC ceny jsou upravené o korporátní události. Celá jednotka za upravenou cenu nemusí odpovídat dostupnosti jedné skutečné akcie za tehdejší nominální cenu, zejména okolo splitů. Výsledky měří chování stávajícího enginu, nejsou přesnou rekonstrukcí historického brokerského účtu.
- Používá se současný místní seznam titulů, nikoli tehdejší úplné členství v univerzu. Chybějící zaniklé tituly a survivorship bias mohou výsledky zkreslovat; částečná dostupnost jednotlivých titulů je popsána v JSON.
- Obě období byla již při vývoji viděna. Historický výnos není důkazem budoucího výnosu ani oprávněním pro live nasazení.
- Hotovost nenese úrok. Model zahrnuje uvedené zhoršení plnění; nezahrnuje samostatné regulatorní poplatky, daně, realistický dopad objednávky na trh ani náhodná částečná plnění.
- Procentní benchmark SPY je beznákladový zlomkový index open–open. JSON navíc obsahuje oddělený příklad SPY s celými akciemi, vstupními náklady a hotovostí; u malého účtu může počet akcií vyjít nula.
- Počty nedostupných titulů jsou pozorování čekajících plánů po jednotlivých dnech. Jeden stejný titul se může objevit opakovaně; nejde o odmítnuté pokyny brokera.

## Soubory a reprodukce

- [Úplné tabulky obou období a tří nákladových variant](README.md)
- [Úplná data JSON zabalená v gzip, včetně denních průběhů a všech simulovaných transakcí](study.json.gz)
- [Souhrnné metriky CSV](summary.csv)
- [Přesný zdroj použitého pozorovacího runneru](runner-source.txt)
- [SHA256 souborů](SHA256SUMS)

JSON rozbalíte standardním gzip, například `gzip -dc study.json.gz > /tmp/nate-small-account-study.json`. Komprese nemění datové podklady; hash rozbalených bajtů je v `artifact.json`.

Výpočet běžel v izolovaném checkoutu `22a89f477f3432cca7b6d4ddf70f4dd4d00e4365`. Původní strategické soubory nebyly upraveny; nový pozorovací runner je svázán vlastním hashem v JSON. Pozdější produkční opravy mají jinou identitu.

Pro přesné opakování vytvořte pracovní kopii uvedeného commitu, zkopírujte `runner-source.txt` do `scripts/backtest/small_account_study.py` a použijte závislosti z `requirements.lock`. Příkaz ke spuštění je v úplném reportu. Pozorovací a paralelní izolaci ověřuje 13 testů; proběhla i nezávislá kontrola kódu.

Ranking zahrnuje 532 titulů. Zdrojové soubory a přesný datový prefix byly po dokončení znovu ověřeny. Během studie nebyly stahovány ceny ani volán broker.
