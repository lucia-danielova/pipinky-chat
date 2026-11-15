const { randomUUID } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { defineSecret, defineString } = require('firebase-functions/params');
const { HttpsError, onCall } = require('firebase-functions/v2/https');

initializeApp();

const chatPassword = defineSecret('CHAT_PASSWORD');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const databaseUrl = defineString('DATABASE_URL');
const MAX_HISTORY = 40;
const MAX_MESSAGE_LENGTH = 2000;

function getChatDatabase() {
  return getDatabase(undefined, databaseUrl.value());
}

exports.enterChat = onCall({ region: 'europe-west1', secrets: [chatPassword] }, async (request) => {
  const suppliedPassword = request.data?.password;
  if (typeof suppliedPassword !== 'string' || suppliedPassword !== chatPassword.value()) {
    throw new HttpsError('permission-denied', 'Nesprávne heslo do chatu.');
  }

  const uid = `chat_${randomUUID()}`;
  const token = await getAuth().createCustomToken(uid, { chatMember: true });
  return { token };
});

exports.mediate = onCall({ region: 'europe-west1', secrets: [geminiApiKey] }, async (request) => {
  if (!request.auth || request.auth.token.chatMember !== true) {
    throw new HttpsError('unauthenticated', 'Prihlás sa do chatu.');
  }

  const messages = request.data?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_HISTORY) {
    throw new HttpsError('invalid-argument', 'Konverzácia nemá platný formát.');
  }

  const history = messages.map((entry) => {
    if (
      !entry ||
      typeof entry.senderName !== 'string' ||
      typeof entry.message !== 'string' ||
      entry.senderName.length > 40 ||
      entry.message.length > MAX_MESSAGE_LENGTH
    ) {
      throw new HttpsError('invalid-argument', 'Správa v konverzácii nemá platný formát.');
    }
    return `${entry.senderName}: ${entry.message}`;
  });

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': geminiApiKey.value(),
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Si neutrálny a empatický mediátor v slovenskom jazyku. Stručne poraď, ako môžu účastníci komunikovať konštruktívne a bez hádok. Nepredstieraj, že poznáš celý kontext.\n\nKonverzácia:\n${history.join('\n')}`,
          }],
        }],
        generationConfig: { maxOutputTokens: 512 },
      }),
    },
  );

  if (!response.ok) {
    console.error('Gemini request failed with status', response.status);
    throw new HttpsError('unavailable', 'Mediátor momentálne neodpovedá. Skús neskôr.');
  }

  const payload = await response.json();
  const answer = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new HttpsError('unavailable', 'Mediátor nevrátil odpoveď. Skús neskôr.');
  }

  await getChatDatabase().ref('chat_messages').push({
    senderUid: 'mediator',
    senderName: 'Mediátor',
    message: answer.trim(),
    timestamp: Date.now(),
  });
  return { ok: true };
});
