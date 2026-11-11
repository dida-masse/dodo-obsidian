# dodo för Obsidian

Håller en dodo-lista i takt med en vanlig anteckning i valvet, åt båda hållen: det du skriver i Obsidian hamnar i dodo, och det andra gör i dodo syns i anteckningen.

Anteckningen är samma text som Markdown-läget i dodo: bara `- [ ]` och `- [x]` är uppgifter, resten (stycken, vanliga punkter, tabeller, kod) är textstycken som står kvar på sin plats. Överst står `dodo: <länk till listan>` i frontmatter, så pluginet hittar rätt lista även om du byter namn på filen eller flyttar den.

## Installera

Tills pluginet finns i Obsidians katalog: bygg det (`npm install && npm run build`) eller hämta `main.js`, `manifest.json` och `styles.css`, och lägg dem (och `styles.css`) i `<valvet>/.obsidian/plugins/dodo/`. Starta om Obsidian och slå på *dodo* under *Community plugins*.

## Logga in och välj listor

1. I dodo: ⋯ → *Logga in på annan enhet*, kopiera länken (den gäller en gång i 10 minuter).
2. I Obsidian: *Inställningar → dodo*, klistra in länken. Det står sedan *Inloggad som … på …*.
3. Bocka för de listor du vill ha. Varje lista blir `dodo/<listans namn>.md` (mappen går att ändra). Finns filen redan skrivs den aldrig över, utan den nya får ett annat namn. Kommandot *dodo: Lägg till lista* gör samma sak. Med inställningen *Lägg till nya listor automatiskt* (på som standard) blir nya listor i dodo anteckningar av sig själva, högst en kontroll var 30:e sekund; en lista du har stängt av läggs inte till igen.

Sessionen sparas bara i pluginets egna data (`data.json`), aldrig i anteckningarna, och syns i dodo under *Användare (admin)*. *Logga ut* i inställningarna stänger den.

## Så fungerar det

- På datorn säger servern till direkt när något ändras (en ström som hålls öppen), och pluginet frågar bara var 30:e sekund som säkerhet. På mobilen, eller medan strömmen ligger nere, frågar det varannan sekund. Allt hämtas också när Obsidian startar eller får fokus. Medan du skriver väntar uppdateringen tills du har slutat skriva en stund; markören och scrollen står kvar.
- Det du skriver skickas cirka 1 sekund efter att du slutat, och när du lämnar anteckningen. Bara det som har ändrats skickas, och en ändrad rad behåller sin uppgift. Skulle en ändring ta bort 10 uppgifter eller fler, eller minst 3 och mer än hälften av listan, skickas ingenting av anteckningen: den står kvar som den är, du får en notis och statusraden visar *dodo !* tills du har bestämt dig. *Ta bort ändå* (eller kommandot *dodo: Spara borttagningen ändå*) skickar den, *Hämta från dodo* (eller *dodo: Hämta listan från dodo igen*) skriver om anteckningen med det dodo har, och då försvinner ändringen. Ångrar du själv i anteckningen går den vidare som vanligt.
- Har både du och någon annan ändrat samma uppgift står dodos version kvar, och din text läggs som en kommentar på uppgiften, med en notis.
- Offline sparas allt i anteckningen och skickas när nätet är tillbaka. Är du utloggad får du en notis med en knapp för att logga in igen. Försvinner du ur en lista får anteckningen en rad överst om det och hålls inte längre i takt; filen tas aldrig bort utan flyttas till `dodo/Borttagna/` (länkar följer med).
- Statusraden (dator) visar *dodo ✓*, *dodo …* eller *dodo !*; ett klick visar vad som gick fel.
- Har någon annan ändrat en lista sedan du senast hade anteckningen framme får den en prick ● efter namnet i fillistan, och statusraden visar *· 2 uppdaterade*; ett klick där öppnar den senast ändrade. När du öppnar den visar sidopanelen *Nytt sedan sist* (vem som lade till, ändrade, bockade av eller tog bort vad; ett klick går till raden, och en borttagen uppgift kan tas tillbaka med *Ångra*), och de ändrade raderna får en färgad kant tills du lämnar anteckningen. Är panelen stängd kommer det som en notis med en knapp. Sett är gemensamt med webben och dina andra datorer: öppnar du listan där försvinner pricken här, och tvärtom. Byter en lista namn i dodo byter anteckningen namn också, om du inte har gett den ett eget namn. Byter du namn på anteckningen i Obsidian och är listans admin byter listan namn i dodo för alla; annars behåller anteckningen sitt eget namn (du får en notis om det).
- Klockslag: `^fredag 14:30` eller `^fredag 14:30-15:30` (även `14.30`) sätter ett klockslag och en sluttid vid datumet, som i dodo. Tiden gäller bara direkt efter datumet; ett `14:30` i vanlig text rörs inte. Tar du bort tiden i anteckningen tas den bort i dodo, och datumet står kvar. Kräver dodo från 2026-11-08.
- Period: `^2026-11-20..2026-11-22` eller `^fredag..söndag` sätter ett slutdatum (en period över flera dagar), som i dodo; kombinerbart med klockslag (`^fredag..söndag 14:30-10:00` är start första dagen och slut sista dagen). Tar du bort slutet i anteckningen tas det bort i dodo, och startdatumet står kvar. Kräver dodo från 2026-11-08.
- Inställningen *Dölj klara uppgifter* tar bort dem ur anteckningen utan att ta bort dem i dodo.

## Mappar

dodos mappar för listor (de du har lagt dina listor i på webben) blir riktiga mappar i `dodo/`: en lista i *HT26* under *Kurser* ligger som `dodo/Kurser/HT26/DA101.md`. Det gäller åt båda hållen.

- Flyttas en lista i dodo flyttas filen vid nästa synk. Flyttar du filen till en annan mapp i Obsidian flyttas listan i dodo. Ny mapp, omdöpt mapp och borttagen mapp följer också med åt båda håll.
- En mapp som tas bort tar aldrig med sig något: innehållet hamnar en nivå upp, i dodo och i Obsidian. En tom mapp finns kvar i dodo tills någon tar bort den.
- Pluginet hämtar alltid dodos senaste träd först och ändrar bara det du ändrat i Obsidian, så en ändring på webben skrivs inte över. Har du och webben flyttat samma lista åt olika håll vinner dodo och filen flyttas.
- Tecken som inte går i filnamn (`/ \ : * ? " < > |`) blir mellanrum. Två mappar med samma namn på samma nivå heter `Namn` och `Namn (2)` i valvet. dodo tillåter högst 5 nivåer och 60 tecken i ett mappnamn: lägger du en anteckning djupare får du en notis och den hamnar på femte nivån.
- Är hela valvet dodo-mappen (inställningen *Mapp* är tom) blir en mapp i Obsidian bara en mapp i dodo om en dodo-anteckning ligger i den. Tas fler än hälften av dina mappar bort på en gång, eller saknas en listas anteckning (valvet är kanske inte färdigsynkat), tas inget bort i dodo: mapparna läggs tillbaka och du får en notis med *Ta bort ändå*.
- Ordningen på mappar och listor följer inte med: Obsidian sorterar efter namn, och ordningen skrivs aldrig tillbaka.
- Första gången följer filerna dodo: ligger dina anteckningar platt i `dodo/` flyttas de till sina mappar. Kräver en dodo med mappar (dida-masse/dodo#119).

## Det som inte finns i anteckningen

Kommentarer skrivs aldrig in i anteckningen, och inte heller vem som bockade av och när eller historiken. De finns kvar i dodo och påverkas inte av att anteckningen skrivs om.

## Kommentarer

Kommandot *dodo: Visa kommentarer* (eller ikonen i vänsterkanten) öppnar en sidopanel med kommentarerna på uppgiften där markören står: författare, tid och text (markdown), svar indragna under tråden, lösta trådar ihopvikta. Längst ner skriver du en ny kommentar (Ctrl/Cmd+Enter skickar), och *Svara* finns på varje kommentar. Rader med kommentarer får en liten *💬 n* sist på raden (bara en markering i editorn, inte text i filen); den är färgad när någon annan har skrivit något du inte har sett, och ett klick öppnar panelen. När någon annan kommenterar får du en notis. En rad du precis har skrivit och som inte är skickad än har inga kommentarer.

## Kopiera en uppgift till en annan lista

Kommandot *dodo: Kopiera uppgiften till en annan lista…* kopierar uppgiften där markören står (med deluppgifter) till en annan av dina listor, som du väljer ur en lista. Kopian är en ny, fristående uppgift: den får egna id och tar inte med kommentarer, länkar eller källa, och personer som inte är med i den andra listan tas bort. Finns en rubrik med samma namn i målet hamnar kopian under den, annars utan rubrik. Uppgiften i den här listan är orörd, och du får en notis med målets namn. Ligger målet också som anteckning fylls den på direkt.

Osända ändringar i anteckningen skickas först, så rätt uppgift kopieras. Kommandot säger ifrån (i stället för att kopiera fel) om markören står på en rubrik, ett textstycke eller en rad som inte har kunnat skickas. Kräver dodo från dida-masse/dodo#103.

## Kurslistor

En kurslista (dodo #38) har en uppgift per kurs, hämtad från Kursredan. Den är en vanlig dodo-lista i Obsidian, med några skillnader:

- **Tabellen är källans.** Den står under uppgiften mellan två markörer (`<!-- dodo:källa -->` och `<!-- /dodo:källa -->`). I Obsidian döljs markörraderna bakom texten *Från Kursredan, kan inte ändras här*, tabellen får en dämpad bakgrund och det du skriver inuti den avvisas (med en notis första gången). Din egen text skriver du under tabellen. Tar du bort hela kursen försvinner den i dodo, men källan lägger tillbaka den vid nästa hämtning (högst en timme).
- **Skadade markörer** (en markör borttagen med ett annat verktyg) lagas av pluginet innan det skickar: källans tabell sätts tillbaka, de lösa markörerna och de tabellrader som är källans tas bort, och det du skrev under tabellen står kvar.
- **Taggar är `kategori/värde`**, t.ex. `#termin/ht26`, `#läsperiod/lp1`, `#fart/50`. De är nästlade taggar i Obsidian och fungerar i taggpanelen och sökningen.
- **Rubriker** som `HT26 LP1` sätts av källan; flyttar du en kurs under en annan rubrik sätts den tillbaka vid nästa hämtning.
- **Bockar** du av en kurs står kvar tills kursens data ändras; då bockas den ur och ändringen står som `**12** ← 10` i tabellen.

## Gäster

En besökare av en publik länk (kommentar, anteckning, avbockning) heter *Namn (publik länk)* i kommentarspanelen, i notiserna och i *Nytt sedan sist*; mejl heter *Mejl* och en API-nyckel *Namn (nyckel)*.

## Utveckling

`npm run md` kopierar reglerna för texten från `../dodo/public/md.js` (till `src/md.js`, som är incheckad). `npm run build` bygger `main.js`. `npm test` säger till om `src/md.js` inte längre är det `npm run md` gör av `../dodo/public/md.js` (finns inte dodo bredvid hoppas det över). Det startar också en riktig dodo-server från `../dodo` i en tillfällig mapp och provar synken mot den (Node 22+).
