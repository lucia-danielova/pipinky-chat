# Pipinky Chat

Mobilný chat pre Android vytvorený pomocou Vite, Firebase a Capacitor.

## Nastavenie Firebase

1. Vytvor alebo vyber Firebase webovú aplikáciu v projekte `chat-c1dea` a nastav obmedzenia jej web API kľúča.
2. Skopíruj `.env.example` do `.env.local` a doplň Firebase Web App API key a App ID. Tieto hodnoty konfigurujú klienta; tajné kľúče do `.env.local` nepatria.
3. V adresári `functions` skopíruj `.env.example` do `.env.chat-c1dea`.
4. V Cloud Functions nastav tajomstvá:

   ```powershell
   firebase functions:secrets:set CHAT_PASSWORD
   firebase functions:secrets:set GEMINI_API_KEY
   ```

   Zadaj hodnoty cez interaktívne výzvy. Nevkladaj ich do zdrojového kódu ani do Git.
5. Nainštaluj Firebase CLI, prihlás sa a nasaď backend spolu s pravidlami databázy:

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase deploy --only database,functions
   ```

   Firebase Authentication, Realtime Database a Cloud Functions musia byť povolené v projekte. Použi plán Firebase, ktorý povoľuje nasadenie Cloud Functions.

## Spustenie webovej verzie

```powershell
npm install
npm run dev
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

## Bezpečnostná poznámka

Pôvodný prototyp obsahoval heslo chatu aj Gemini API kľúč v klientskom HTML. Heslo sa teraz overuje serverovou funkciou a Gemini kľúč sa používa iba na serveri. Pred nasadením zruš alebo otoč predtým zverejnené tajomstvo Gemini; obmedz Firebase Web API kľúč na potrebné API a aplikácie.
