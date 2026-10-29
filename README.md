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
- Det du skriver skickas cirka 1 sekund efter att du slutat, och när du lämnar anteckningen. Bara det som har ändrats skickas, och en ändrad rad behåller sin uppgift. Tar du bort mer än hälften av uppgifterna på en gång frågar pluginet först.
- Har både du och någon annan ändrat samma uppgift står dodos version kvar, och din text läggs som en kommentar på uppgiften, med en notis.
- Offline sparas allt i anteckningen och skickas när nätet är tillbaka. Är du utloggad får du en notis med en knapp för att logga in igen. Försvinner du ur en lista får anteckningen en rad överst om det och hålls inte längre i takt; filen tas aldrig bort utan flyttas till `dodo/Borttagna/` (länkar följer med).
- Statusraden (dator) visar *dodo ✓*, *dodo …* eller *dodo !*; ett klick visar vad som gick fel.
- Har någon annan ändrat en lista sedan du senast hade anteckningen framme får den en prick ● efter namnet i fillistan, och statusraden visar *· 2 uppdaterade*; ett klick där öppnar den senast ändrade. När du öppnar den visar sidopanelen *Nytt sedan sist* (vem som lade till, ändrade, bockade av eller tog bort vad; ett klick går till raden, och en borttagen uppgift kan tas tillbaka med *Ångra*), och de ändrade raderna får en färgad kant tills du lämnar anteckningen. Är panelen stängd kommer det som en notis med en knapp. Sett är gemensamt med webben och dina andra datorer: öppnar du listan där försvinner pricken här, och tvärtom. Byter en lista namn i dodo byter anteckningen namn också, om du inte har gett den ett eget namn.
- Inställningen *Dölj klara uppgifter* tar bort dem ur anteckningen utan att ta bort dem i dodo.

## Det som inte finns i anteckningen

Kommentarer skrivs aldrig in i anteckningen, och inte heller vem som bockade av och när eller historiken. De finns kvar i dodo och påverkas inte av att anteckningen skrivs om.

## Kommentarer

Kommandot *dodo: Visa kommentarer* (eller ikonen i vänsterkanten) öppnar en sidopanel med kommentarerna på uppgiften där markören står: författare, tid och text (markdown), svar indragna under tråden, lösta trådar ihopvikta. Längst ner skriver du en ny kommentar (Ctrl/Cmd+Enter skickar), och *Svara* finns på varje kommentar. Rader med kommentarer får en liten *💬 n* sist på raden (bara en markering i editorn, inte text i filen); den är färgad när någon annan har skrivit något du inte har sett, och ett klick öppnar panelen. När någon annan kommenterar får du en notis. En rad du precis har skrivit och som inte är skickad än har inga kommentarer.

## Nästa steg

Stöd för Tasks-pluginet (Tasks format för datum och prioritet, avbockning i Tasks-frågor) kommer i nästa steg.

## Utveckling

`npm run md` kopierar reglerna för texten från `../dodo/public/md.js` (till `src/md.js`, som är incheckad). `npm run build` bygger `main.js`. `npm test` startar en riktig dodo-server från `../dodo` i en tillfällig mapp och provar synken mot den (Node 22+).
