# Pipinky Chat

Mobilný skupinový chat pre Android vytvorený pomocou Vite, Capacitor a Supabase.

## Konfigurácia Supabase

1. Skopíruj `.env.example` do `.env.local` a nastav `VITE_SUPABASE_ANON_KEY` na projektový publishable key. Publishable key je určený pre klienta; nikdy do klienta nevkladaj `service_role` kľúč ani databázové heslo.
2. Nainštaluj Supabase CLI a prihlás sa:

   ```powershell
   npx supabase login
   npx supabase link --project-ref ldjkfobspnmripeipboc
   ```

3. V Supabase Authentication povoľ anonymné prihlásenie (`enable_anonymous_sign_ins`).
4. Vytvor tabuľky, politiky RLS a realtime publikáciu:

   ```powershell
   npx supabase db push --remote
   ```

5. Profily používateľov sa vytvoria automaticky pri registrácii.
6. V **Edge Functions > Secrets** nastav `GEMINI_API_KEY`.
7. Nasaď AI mediátora:

   ```powershell
   npx supabase functions deploy mediate
   ```

**Pozor:** Migrácia mediačných prípadov presunie existujúce správy do tabuľky
`chat_messages_legacy_archive`, ktorá nie je prístupná bežným používateľom.
Pred nasadením klienta použite všetky migrácie a nasaďte aktuálnu funkciu
`mediate`. Účastníci sa pripájajú pomocou kódu, hesla a zvoleného mena.
Tlačidlo pozvánky kopíruje odkaz, kód aj heslo; celú pozvánku posielajte iba
dôveryhodnej osobe bezpečným kanálom. Heslo sa neukladá do `sessionStorage`:
po obnovení stránky ho treba pred kopírovaním pozvánky znovu overiť.
Osobný obnovovací kľúč sa do pozvánky nikdy nepridáva.

Používatelia získavajú anonymnú reláciu a pri prvom obsadení miesta si
vygenerujú osobný obnovovací kľúč. Každý účastník si ho musí bezpečne uložiť
a nikomu ho neposkytnúť. Pri strate relácie sa dá miesto obnoviť pomocou kódu,
spoločného hesla a vlastného kľúča; pôvodná relácia tým stratí členstvo.
Pri strate kľúča nemožno identitu bezpečne obnoviť. Kľúče neukladajte spolu
s heslom a používajte TLS. Databáza uchováva iba ich odtlačky.
Prvé obsadenie voľného mena je stále chránené iba spoločným heslom: systém
neoveruje, či meno obsadila zamýšľaná osoba.

Existujúci členovia musia pred stratou relácie vstúpiť znovu pod svojím menom,
vygenerovať si kľúč a potvrdiť jeho uloženie. Staré obsadené miesto bez
nastaveného kľúča nemožno po strate relácie obnoviť. Pred širším použitím
nastav ochranu proti zneužitiu, napríklad CAPTCHA a obmedzenie pokusov
o pripojenie k prípadu.

Tlačidlo **Odísť** zavrie aktuálny prípad, ale ponechá anonymnú reláciu a
členstvo, aby sa používateľ mohol neskôr vrátiť na svoje miesto. Time-out je
lokálny. Exportovaná Markdown zápisnica obsahuje pamäť prípadu, potvrdené dohody
a verejnú históriu, nie súkromné konzultácie. Údaje aktívneho prípadu zostávajú
v `sessionStorage` aktuálnej karty prehliadača; po obnovení sa členstvo znovu
overí voči databáze.

### Mediačný engine

Funkcia `mediate` vyžaduje prihláseného člena prípadu a JSON s `caseId`,
`action` (`mediate` alebo `private_coach`) a `mode` (`auto`, `facilitate`, `reframe`,
`needs`, `agreement` alebo `reality_check`). Voliteľná otázka sa posiela ako
`userQuestion`; iba pri súkromnej konzultácii možno pridať `draftMessage`.
Súkromný výsledok sa vracia iba volajúcemu, verejný sa uloží do prípadu.
Texty prípadu a prípadný súkromný koncept sa pri spracovaní odosielajú Gemini.
Verejný výsledok aktualizuje tempo rozhovoru a pamäť prípadu; historický
`temperature_score` sa zachováva, ale neaktualizuje ani nezobrazuje.
Bezpečnostné upozornenie je iba odhad modelu, nie spoľahlivá detekcia
nebezpečenstva ani náhrada odbornej alebo krízovej pomoci.
Krízová karta uvádza tiesňové číslo [112 v EÚ](https://digital-strategy.ec.europa.eu/en/policies/112)
a slovenskú [Národnú linku pre ženy zažívajúce násilie](https://zastavmenasilie.gov.sk/linka-pre-zeny/);
mimo EÚ je potrebné použiť miestne tiesňové číslo.
Verejné požiadavky sú obmedzené na jednu za 20 sekúnd na prípad a súkromné
na jednu za 5 sekúnd na používateľa; limit sa započíta aj pri chybe modelu.

## Spustenie webovej verzie

```powershell
npm install
npm run dev
```

Zostavenie vyžaduje nastavené `VITE_SUPABASE_URL` a `VITE_SUPABASE_ANON_KEY`;
bez nich (alebo s ukážkovou hodnotou kľúča) skončí chybou. Po nastavení
`.env.local` môžeš nasadiť webovú verziu na Firebase Hosting:

```powershell
npm install -g firebase-tools
firebase login
npm run deploy:web
```

Existujúca stránka GitHub Pages používa zostavené súbory na vetve `gh-pages`. Zmeny vo vetve `main` ju automaticky neaktualizujú; po zmene treba web znovu zostaviť a nasadiť.

## Vytvorenie Android aplikácie

Vyžaduje Node.js 20+, Android Studio, Android SDK a JDK 21. Android projekt je už súčasťou repozitára.

```powershell
npm install
npm run android:sync
npm run android:open
```

V Android Studio spusti aplikáciu na zariadení/emulátore alebo vytvor APK/AAB cez **Build > Generate Signed Bundle / APK**. Po zmenách vo webovom kóde spusti `npm run android:sync`.

GitHub Actions tiež zostaví inštalačné debug APK a uloží ho ako artefakt `pipinky-chat-android-debug`. Zostavenie vyžaduje repozitárový secret `PIPINKY_SUPABASE_PUBLISHABLE_KEY` s verejným Supabase publishable key. Debug APK je určené na testovanie; pre distribúciu a spoľahlivé aktualizácie treba vytvoriť release zostavenie podpísané vlastným bezpečne uloženým kľúčom.
