import { createClient } from '@supabase/supabase-js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Doplň VITE_SUPABASE_URL a VITE_SUPABASE_ANON_KEY v .env.local.');
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const loginView = document.querySelector('#login-view');
const chatView = document.querySelector('#chat-view');
const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginError = document.querySelector('#login-error');
const displayNameInput = document.querySelector('#display-name');
const nameForm = document.querySelector('#name-form');
const newNameInput = document.querySelector('#new-name');
const nameButton = document.querySelector('#name-button');
const messagesElement = document.querySelector('#chat-messages');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const mediateButton = document.querySelector('#mediate-button');
const modeButtons = document.querySelectorAll('.mode-chip');
const chatError = document.querySelector('#chat-error');

const MESSAGE_HISTORY_LIMIT = 40;
const VISIBLE_MESSAGE_LIMIT = 100;
const MAX_RENDERED_MESSAGES = 150;
const SENDER_COLORS = ['#a5b4fc', '#6ee7b7', '#f9a8d4', '#93c5fd', '#fdba74', '#d8b4fe'];
const timeFormatter = new Intl.DateTimeFormat('sk-SK', {
  hour: '2-digit',
  minute: '2-digit',
});
const recentMessages = [];
const renderedMessages = new Set();
let currentUser;
let activeUserId;
let messageChannel;
let isMediating = false;

function getSenderColor(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash);
  }
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
}

function showError(element, error) {
  element.textContent = error?.message || 'Operáciu sa nepodarilo dokončiť. Skontroluj pripojenie a skús to znova.';
  element.classList.remove('message-success');
  element.hidden = false;
}

function clearMessage(element) {
  element.textContent = '';
  element.hidden = true;
}

function compareMessages(first, second) {
  const timeDifference = Date.parse(first.created_at) - Date.parse(second.created_at);
  return timeDifference || Number(first.id) - Number(second.id);
}

function setMediatorControlsDisabled(disabled, statusText) {
  isMediating = disabled;
  mediateButton.disabled = disabled;
  modeButtons.forEach((button) => {
    button.disabled = disabled;
  });

  const label = mediateButton.querySelector('.mediator-label');
  if (label) label.textContent = statusText;
}

async function triggerMediation({
  mode = 'general',
  userQuestion = '',
  requireLocalMessages = true,
} = {}) {
  if (isMediating) return;
  clearMessage(chatError);

  if (requireLocalMessages && !recentMessages.length) {
    showError(chatError, new Error('Najprv musí v chate prebehnúť aspoň jedna správa.'));
    return;
  }

  setMediatorControlsDisabled(true, 'AI mediátor premýšľa…');

  try {
    const body = { mode };
    if (userQuestion) body.userQuestion = userQuestion;

    const { error } = await supabase.functions.invoke('mediate', { body });
    if (error) {
      const serverPayload = await error.context?.json?.().catch(() => null);
      throw new Error(serverPayload?.error || error.message);
    }
  } catch (error) {
    showError(chatError, error);
  } finally {
    setMediatorControlsDisabled(false, 'Pomoc AI mediátora');
  }
}

function renderMessage(message) {
  const id = String(message.id);
  if (renderedMessages.has(id)) return;
  renderedMessages.add(id);
  const isNearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 80;

  const isMediator = message.is_mediator === true;
  const isOwnMessage = !isMediator && message.sender_id === currentUser?.id;
  const senderName = message.sender_name || 'Používateľ';
  const article = document.createElement('article');
  article.className = `message${isOwnMessage ? ' message-own' : ''}${isMediator ? ' message-mediator' : ''}`;
  article.dataset.messageId = id;
  article.dataset.createdAt = message.created_at;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const sender = document.createElement('strong');
  sender.className = 'message-sender';
  sender.textContent = isMediator ? `✦ ${senderName}` : senderName;
  if (!isOwnMessage && !isMediator) {
    sender.style.color = getSenderColor(senderName);
  }
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.created_at;
  time.textContent = timeFormatter.format(new Date(message.created_at));
  meta.append(sender, time);

  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = message.message || '';
  article.append(meta, body);

  const before = Array.from(messagesElement.children).find((element) =>
    compareMessages(
      { id, created_at: message.created_at },
      { id: element.dataset.messageId, created_at: element.dataset.createdAt },
    ) < 0,
  );
  messagesElement.insertBefore(article, before || null);
  while (messagesElement.children.length > MAX_RENDERED_MESSAGES) {
    const oldestMessage = messagesElement.firstElementChild;
    if (!oldestMessage) break;
    renderedMessages.delete(oldestMessage.dataset.messageId);
    oldestMessage.remove();
  }
  if (isNearBottom) messagesElement.scrollTop = messagesElement.scrollHeight;

  recentMessages.push({
    id,
    created_at: message.created_at,
    sender_name: senderName,
    message: message.message || '',
  });
  recentMessages.sort(compareMessages);
  if (recentMessages.length > MESSAGE_HISTORY_LIMIT) {
    recentMessages.splice(0, recentMessages.length - MESSAGE_HISTORY_LIMIT);
  }
}

async function stopListening() {
  if (!messageChannel) return;
  const channel = messageChannel;
  messageChannel = undefined;
  await supabase.removeChannel(channel);
}

async function startListening() {
  await stopListening();
  messagesElement.replaceChildren();
  recentMessages.length = 0;
  renderedMessages.clear();

  messageChannel = supabase
    .channel('public:chat_messages')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_messages' },
      ({ new: message }) => renderMessage(message),
    )
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        showError(chatError, new Error('Pripojenie k živému chatu zlyhalo.'));
      }
    });

  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, sender_id, sender_name, message, is_mediator, created_at')
    .order('id', { ascending: false })
    .limit(VISIBLE_MESSAGE_LIMIT);

  if (error) {
    showError(chatError, error);
    return;
  }
  data.reverse().forEach(renderMessage);
}

function resizeMessageInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 110)}px`;
  messageInput.style.overflowY = messageInput.scrollHeight > 110 ? 'auto' : 'hidden';
}

async function openChat(user) {
  if (activeUserId === user.id && !chatView.hidden) return;
  activeUserId = user.id;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .single();

  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.user.id !== user.id) {
    if (activeUserId === user.id) activeUserId = undefined;
    return;
  }

  currentUser = user;
  activeUserId = user.id;
  loginView.hidden = true;
  chatView.hidden = false;
  clearMessage(chatError);

  if (error) showError(chatError, error);
  document.querySelector('#current-user').textContent =
    profile?.display_name || user.user_metadata?.display_name || user.email || '';
  await startListening();
}

async function closeChat() {
  currentUser = undefined;
  activeUserId = undefined;
  await stopListening();
  messagesElement.replaceChildren();
  recentMessages.length = 0;
  renderedMessages.clear();
  chatView.hidden = true;
  loginView.hidden = false;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage(loginError);
  loginButton.disabled = true;
  const displayName = displayNameInput.value.trim();

  try {
    if (!displayName) throw new Error('Zadaj svoje meno.');
    const { error } = await supabase.auth.signInAnonymously({
      options: { data: { display_name: displayName } },
    });
    if (error) throw error;
  } catch (error) {
    showError(loginError, error);
  } finally {
    loginButton.disabled = false;
  }
});

nameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage(chatError);
  const displayName = newNameInput.value.trim();
  if (!displayName) {
    showError(chatError, new Error('Zadaj svoje meno.'));
    return;
  }
  if (!currentUser) {
    showError(chatError, new Error('Relácia vypršala. Znova vstúp do chatu.'));
    return;
  }

  nameButton.disabled = true;
  try {
    const { data, error } = await supabase.from('profiles')
      .update({ display_name: displayName })
      .eq('id', currentUser.id)
      .select('display_name')
      .single();
    if (error) throw error;
    document.querySelector('#current-user').textContent = data.display_name;
    newNameInput.value = '';
    document.querySelector('.name-settings').open = false;
  } catch (error) {
    showError(chatError, error);
  } finally {
    nameButton.disabled = false;
  }
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage(chatError);
  const message = messageInput.value.trim();
  if (!message || !currentUser) return;

  sendButton.disabled = true;
  try {
    const { error } = await supabase.from('chat_messages').insert({
      sender_id: currentUser.id,
      message,
    });
    if (error) throw error;
    messageInput.value = '';
    resizeMessageInput();

    if (/@(mediator|mediátor|ai)\b/i.test(message)) {
      const userQuestion = message.replace(/@(mediator|mediátor|ai)\b/gi, '').trim();
      await triggerMediation({
        userQuestion: userQuestion || message,
        requireLocalMessages: false,
      });
    }
  } catch (error) {
    showError(chatError, error);
  } finally {
    sendButton.disabled = false;
    messageInput.focus();
  }
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

messageInput.addEventListener('input', resizeMessageInput);

mediateButton.addEventListener('click', async () => {
  await triggerMediation({ mode: 'general' });
});

modeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    triggerMediation({ mode: button.dataset.mode || 'general' });
  });
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  clearMessage(chatError);
  const { error } = await supabase.auth.signOut();
  if (error) showError(chatError, error);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser) {
    void startListening().catch((error) => showError(chatError, error));
  }
});

supabase.auth.onAuthStateChange((_event, session) => {
  const user = session?.user;
  const stateChange = user ? openChat(user) : closeChat();
  void stateChange.catch((error) => {
    showError(user ? loginError : chatError, error);
  });
});
