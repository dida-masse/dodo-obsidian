# dodo för Obsidian

Håller en dodo-lista i takt med en vanlig anteckning i valvet, åt båda hållen: det du skriver i Obsidian hamnar i dodo, och det andra gör i dodo syns i anteckningen.

Anteckningen är samma text som Markdown-läget i dodo: bara `- [ ]` och `- [x]` är uppgifter, resten (stycken, vanliga punkter, tabeller, kod) är textstycken som står kvar på sin plats. Överst står `dodo: <länk till listan>` i frontmatter, så pluginet hittar rätt lista även om du byter namn på filen eller flyttar den.

## Installera

Tills pluginet finns i Obsidians katalog: bygg det (`npm install && npm run build`) eller hämta `main.js` och `manifest.json`, och lägg dem i `<valvet>/.obsidian/plugins/dodo/`. Starta om Obsidian och slå på *dodo* under *Community plugins*.

## Logga in och välj listor

1. I dodo: ⋯ → *Logga in på annan enhet*, kopiera länken (den gäller en gång i 10 minuter).
2. I Obsidian: *Inställningar → dodo*, klistra in länken. Det står sedan *Inloggad som … på …*.
3. Bocka för de listor du vill ha. Varje lista blir `dodo/<listans namn>.md` (mappen går att ändra). Finns filen redan skrivs den aldrig över, utan den nya får ett annat namn. Kommandot *dodo: Lägg till lista* gör samma sak.

Sessionen sparas bara i pluginets egna data (`data.json`), aldrig i anteckningarna, och syns i dodo under *Användare (admin)*. *Logga ut* i inställningarna stänger den.

## Så fungerar det

- Ändringar i dodo hämtas var fjärde sekund och när Obsidian startar eller får fokus. Medan du skriver väntar uppdateringen tills du har slutat skriva en stund; markören och scrollen står kvar.
- Det du skriver skickas cirka 1,5 sekunder efter att du slutat, och när du lämnar anteckningen. Bara det som har ändrats skickas, och en ändrad rad behåller sin uppgift. Tar du bort mer än hälften av uppgifterna på en gång frågar pluginet först.
- Har både du och någon annan ändrat samma uppgift står dodos version kvar, och din text läggs som en kommentar på uppgiften, med en notis.
- Offline sparas allt i anteckningen och skickas när nätet är tillbaka. Är du utloggad får du en notis med en knapp för att logga in igen. Försvinner du ur en lista får anteckningen en rad överst om det och hålls inte längre i takt; filen tas aldrig bort.
- Statusraden (dator) visar *dodo ✓*, *dodo …* eller *dodo !*; ett klick visar vad som gick fel.
- Inställningen *Dölj klara uppgifter* tar bort dem ur anteckningen utan att ta bort dem i dodo.

## Det som inte finns i anteckningen

Kommentarer, vem som bockade av och när, och historiken. De finns kvar i dodo och påverkas inte av att anteckningen skrivs om.

## Nästa steg

Stöd för Tasks-pluginet (Tasks format för datum och prioritet, avbockning i Tasks-frågor) kommer i nästa steg.

## Utveckling

`npm run md` kopierar reglerna för texten från `../dodo/public/md.js` (till `src/md.js`, som är incheckad). `npm run build` bygger `main.js`. `npm test` startar en riktig dodo-server från `../dodo` i en tillfällig mapp och provar synken mot den (Node 22+).
