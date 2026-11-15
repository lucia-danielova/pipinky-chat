import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithCustomToken, signOut } from 'firebase/auth';
import { getDatabase, limitToLast, onChildAdded, push, query, ref, serverTimestamp } from 'firebase/database';
import { getFunctions, httpsCallable } from 'firebase/functions';
import './styles.css';

const requiredConfig = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_DATABASE_URL',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
];

const missingConfig = requiredConfig.filter((key) => !import.meta.env[key]);
if (missingConfig.length) {
  throw new Error(`Chýba konfigurácia Firebase: ${missingConfig.join(', ')}. Pozri README.md.`);
}

const firebaseApp = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});
const auth = getAuth(firebaseApp);
const database = getDatabase(firebaseApp);
const functions = getFunctions(firebaseApp, 'europe-west1');
const chatMessagesRef = ref(database, 'chat_messages');
const recentChatMessages = query(chatMessagesRef, limitToLast(100));
const enterChat = httpsCallable(functions, 'enterChat');
const requestMediation = httpsCallable(functions, 'mediate');

const loginView = document.querySelector('#login-view');
const chatView = document.querySelector('#chat-view');
const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginError = document.querySelector('#login-error');
const displayNameInput = document.querySelector('#display-name');
const passwordInput = document.querySelector('#chat-password');
const messagesElement = document.querySelector('#chat-messages');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const mediateButton = document.querySelector('#mediate-button');
const chatError = document.querySelector('#chat-error');

let displayName = '';
let unsubscribeMessages;
const recentMessages = [];
const MESSAGE_HISTORY_LIMIT = 40;

function showError(element, error) {
  element.textContent = error instanceof Error ? error.message : 'Nastala neočakávaná chyba.';
  element.hidden = false;
}

function getErrorMessage(error) {
  if (error?.code === 'functions/permission-denied') return 'Nesprávne heslo do chatu.';
  if (error?.code === 'functions/unauthenticated') return 'Relácia vypršala. Znova sa prihlás.';
  return error?.message || 'Operáciu sa nepodarilo dokončiť. Skontroluj pripojenie a skús to znova.';
}

function clearError(element) {
  element.textContent = '';
  element.hidden = true;
}

function appendMessage(message) {
  const isMediator = message.senderUid === 'mediator';
  const isOwnMessage = !isMediator && message.senderUid === auth.currentUser?.uid;
  const article = document.createElement('article');
  article.className = `message${isOwnMessage ? ' message-own' : ''}${isMediator ? ' message-mediator' : ''}`;

  const sender = document.createElement('strong');
  sender.className = 'message-sender';
  sender.textContent = message.senderName || 'Používateľ';
  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = message.message || '';
  article.append(sender, body);
  messagesElement.append(article);
  messagesElement.scrollTop = messagesElement.scrollHeight;

  recentMessages.push({
    senderName: message.senderName || 'Používateľ',
    message: message.message || '',
  });
  if (recentMessages.length > MESSAGE_HISTORY_LIMIT) recentMessages.shift();
}

function startListening() {
  if (unsubscribeMessages) unsubscribeMessages();
  messagesElement.replaceChildren();
  recentMessages.length = 0;
  unsubscribeMessages = onChildAdded(
    recentChatMessages,
    (snapshot) => appendMessage(snapshot.val() || {}),
    (error) => showError(chatError, error),
  );
}

function openChat() {
  loginView.hidden = true;
  chatView.hidden = false;
  clearError(chatError);
  startListening();
  messageInput.focus();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError(loginError);
  loginButton.disabled = true;
  loginButton.textContent = 'Prihlasujem…';
  displayName = displayNameInput.value.trim();

  if (!displayName) {
    showError(loginError, 'Zadaj svoje meno.');
    loginButton.disabled = false;
    loginButton.textContent = 'Vstúpiť do chatu';
    return;
  }

  try {
    const result = await enterChat({ password: passwordInput.value });
    localStorage.setItem('pipinky-chat-name', displayName);
    await signInWithCustomToken(auth, result.data.token);
    passwordInput.value = '';
  } catch (error) {
    localStorage.removeItem('pipinky-chat-name');
    showError(loginError, getErrorMessage(error));
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Vstúpiť do chatu';
  }
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError(chatError);
  const message = messageInput.value.trim();
  if (!message || !auth.currentUser) return;

  sendButton.disabled = true;
  try {
    await push(chatMessagesRef, {
      senderUid: auth.currentUser.uid,
      senderName: displayName,
      message,
      timestamp: serverTimestamp(),
    });
    messageInput.value = '';
  } catch (error) {
    showError(chatError, getErrorMessage(error));
  } finally {
    sendButton.disabled = false;
    messageInput.focus();
  }
});

mediateButton.addEventListener('click', async () => {
  clearError(chatError);
  if (!recentMessages.length) {
    showError(chatError, 'Najprv musí v chate prebehnúť aspoň jedna správa.');
    return;
  }

  mediateButton.disabled = true;
  mediateButton.innerHTML = '<span aria-hidden="true">…</span> Mediátor premýšľa';
  try {
    await requestMediation({ messages: recentMessages });
  } catch (error) {
    showError(chatError, getErrorMessage(error));
  } finally {
    mediateButton.disabled = false;
    mediateButton.innerHTML = '<span aria-hidden="true">✦</span> Pomoc mediátora';
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  clearError(chatError);
  if (unsubscribeMessages) {
    unsubscribeMessages();
    unsubscribeMessages = undefined;
  }
  try {
    await signOut(auth);
    localStorage.removeItem('pipinky-chat-name');
  } catch (error) {
    showError(chatError, getErrorMessage(error));
  }
});

onAuthStateChanged(auth, (user) => {
  if (user && localStorage.getItem('pipinky-chat-name')) {
    displayName = localStorage.getItem('pipinky-chat-name').trim();
    if (displayName) openChat();
    else signOut(auth);
  }
  else {
    if (unsubscribeMessages) {
      unsubscribeMessages();
      unsubscribeMessages = undefined;
    }
    chatView.hidden = true;
    loginView.hidden = false;
  }
});
