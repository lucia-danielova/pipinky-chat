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
Súčasný webový klient ani funkcia `mediate` zatiaľ nepodporujú povinné `case_id`
a po jej nasadení nebudú môcť odosielať správy. Pred nasadením migrácie ich
treba upraviť na vytváranie a pripájanie prípadov a prácu v rámci konkrétneho prípadu.

Používatelia získavajú anonymnú reláciu. Pri jej strate sa anonymný účet nedá
obnoviť. Pred širším použitím nastav ochranu proti zneužitiu, napríklad CAPTCHA
a obmedzenie volaní mediátora.

## Spustenie webovej verzie

```powershell
npm install
npm run dev
```

Po nastavení `.env.local` môžeš nasadiť webovú verziu na Firebase Hosting:

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
