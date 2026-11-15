# Pipinky Chat

Mobilný skupinový chat pre Android vytvorený pomocou Vite, Capacitor a Supabase.

## Konfigurácia Supabase

1. Skopíruj `.env.example` do `.env.local` a nastav `VITE_SUPABASE_ANON_KEY` na projektový publishable key. Publishable key je určený pre klienta; nikdy do klienta nevkladaj `service_role` kľúč ani databázové heslo.
2. Nainštaluj Supabase CLI a prihlás sa:

   ```powershell
   npx supabase login
   npx supabase link --project-ref ldjkfobspnmripeipboc
   ```

3. V Supabase Authentication povoľ registráciu a potvrdenie e-mailovej adresy.
4. Vytvor tabuľky, politiky RLS a realtime publikáciu:

   ```powershell
   npx supabase db push --remote
   ```

5. Profily používateľov sa vytvoria automaticky pri registrácii.
6. V **Edge Functions > Secrets** nastav nový `GEMINI_API_KEY`. Supabase predvolene posiela prihlasovací odkaz; predvolený e-mailový server má obmedzený počet príjemcov a pre ďalších používateľov je potrebné nakonfigurovať vlastné SMTP.
7. Nasaď AI mediátora:

   ```powershell
   npx supabase functions deploy mediate
   ```

Používatelia sa prihlasujú pomocou jednorazového e-mailového odkazu, bez hesla. Odkaz otvorí webovú verziu chatu. Zaregistrovať sa môže ktokoľvek s e-mailovou adresou; každý prihlásený používateľ môže čítať celý chat.

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

## Vytvorenie Android aplikácie

Vyžaduje Node.js 20+, Android Studio, Android SDK a JDK 17.

```powershell
npm install
npm run android:add
npm run android:sync
npm run android:open
```

V Android Studio spusti aplikáciu na zariadení/emulátore alebo vytvor APK/AAB cez **Build > Generate Signed Bundle / APK**. Po zmenách vo webovom kóde spusti `npm run android:sync`.
