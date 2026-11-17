import { createClient } from '@supabase/supabase-js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Doplňte VITE_SUPABASE_URL a VITE_SUPABASE_ANON_KEY v .env.local.');
}
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const $ = (selector) => document.querySelector(selector);
const loginView = $('#login-view');
const chatView = $('#chat-view');
const loginError = $('#login-error');
const chatError = $('#chat-error');
const chatNotice = $('#chat-notice');
const createForm = $('#create-room-form');
const joinForm = $('#join-room-form');
const rolePicker = $('#join-role-picker');
const roleButtons = $('#join-role-buttons');
const participantsInputs = $('#participants-inputs');
const messagesElement = $('#chat-messages');
const messageInput = $('#message-input');
const coachDrawer = $('#coach-drawer');
const coachResult = $('#coach-result');
const coachUse = $('#coach-use');
const timeoutOverlay = $('#timeout-overlay');
const inviteDialog = $('#invite-dialog');
const modeSelect = $('#mediator-mode-select');
const headerMoreToggle = $('#header-more-toggle');
const sessionCaseKey = 'mediation-active-case';
const safetyNotice = 'Možné ohrozenie: uprednostnite bezpečie. Pri bezprostrednom nebezpečenstve kontaktujte miestne tiesňové služby.';
const timeFormatter = new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' });

let currentUser;
let currentCase;
let currentParticipant;
let casePassword;
let verifiedInvitePassword;
let inviteVersion = 0;
let channel;
let previewCase;
let coachSuggestion = '';
let timeoutTimer;
let caseVersion = 0;
let lobbyBusy = false;
const messages = new Map();
const agreements = new Map();

class CaseUnavailableError extends Error {}

const errorMessages = new Map([
  ['Posielaš správy príliš rýchlo. Počkaj chvíľu.', 'Správy odosielate príliš rýchlo. Počkajte, prosím, chvíľu.'],
  ['Prihlás sa do chatu.', 'Prihláste sa do chatu.'],
  ['Mediátora môžeš požiadať znova o chvíľu.', 'Mediátora môžete požiadať znova o chvíľu.'],
  ['Mediátor momentálne neodpovedá. Skús neskôr.', 'Mediátor momentálne neodpovedá. Skúste to neskôr.'],
  ['Mediátor vrátil neplatnú odpoveď. Skús neskôr.', 'Mediátor vrátil neplatnú odpoveď. Skúste to neskôr.'],
  ['Invalid case code or password', 'Kód prípadu alebo heslo nie sú správne.'],
  ['Participant name is not listed in this case', 'Zvolené meno nie je uvedené v tomto prípade.'],
  ['Authentication required', 'Prihláste sa, prosím, do prípadu.'],
  ['Password must be between 1 and 72 bytes', 'Heslo musí mať 1 až 72 bajtov.'],
  ['Participants must have distinct, non-empty names and include the creator', 'Zadajte jedinečné mená všetkých účastníkov vrátane zakladateľa.'],
  ['Case membership is required to send messages', 'Na odoslanie správy musíte byť členom prípadu.'],
  ['Case membership is required', 'Na túto operáciu musíte byť členom prípadu.'],
  ['Agreement not found', 'Dohoda sa nenašla.'],
  ['Agreement is no longer pending', 'Dohodu už nie je možné potvrdiť ani odmietnuť.'],
]);

function showError(element, error) {
  element.textContent = errorMessages.get(error?.message) || error?.message || 'Operáciu sa nepodarilo dokončiť. Skúste to znova.';
  element.hidden = false;
}

function clearMessage(element) {
  element.hidden = true;
  element.textContent = '';
}

function showNotice(text) {
  chatNotice.textContent = text;
  chatNotice.hidden = false;
}

function switchTab(tab) {
  const isCreate = tab === 'create';
  $('#tab-create').setAttribute('aria-selected', String(isCreate));
  $('#tab-join').setAttribute('aria-selected', String(!isCreate));
  $('#tab-create').tabIndex = isCreate ? 0 : -1;
  $('#tab-join').tabIndex = isCreate ? -1 : 0;
  $('#create-panel').hidden = !isCreate;
  $('#join-panel').hidden = isCreate;
  clearMessage(loginError);
}

function updateParticipants() {
  const oldNames = [...participantsInputs.querySelectorAll('input')].map((input) => input.value);
  const count = Number($('#participant-count').value);
  participantsInputs.replaceChildren();
  for (let index = 0; index < count; index += 1) {
    const field = document.createElement('div');
    field.className = 'participant-field';
    const label = document.createElement('label');
    label.htmlFor = `participant-${index + 1}`;
    label.textContent = index === 0 ? 'Zakladateľ' : `Účastník ${index + 1}`;
    const input = document.createElement('input');
    input.id = label.htmlFor;
    input.autocomplete = 'off';
    input.maxLength = 100;
    input.placeholder = index === 0 ? 'Vaše meno' : 'Meno účastníka';
    input.required = true;
    input.value = oldNames[index] || '';
    field.append(label, input);
    participantsInputs.append(field);
  }
}

function setLobbyBusy(busy) {
  lobbyBusy = busy;
  document.querySelectorAll('#create-room-form input, #create-room-form select, #create-room-form button, #join-room-form input, #join-room-form button, .lobby-tabs button')
    .forEach((element) => { element.disabled = busy; });
}

async function ensureUser(name = '') {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session?.user) return sessionData.session.user;
  const { data, error } = await supabase.auth.signInAnonymously({
    options: { data: { display_name: name || 'Účastník' } },
  });
  if (error) throw error;
  if (!data.user) throw new Error('Nepodarilo sa vytvoriť reláciu.');
  return data.user;
}

async function stopListening() {
  if (!channel) return;
  const oldChannel = channel;
  channel = undefined;
  await supabase.removeChannel(oldChannel);
}

function setPhase(phase) {
  const phaseIndex = { intake: 0, exploration: 0, needs: 1, compromise: 2, resolved: 3 }[phase] ?? 0;
  document.querySelectorAll('[data-phase-step]').forEach((step, index) => {
    step.classList.toggle('is-active', index === phaseIndex);
    step.classList.toggle('is-complete', index < phaseIndex);
    if (index === phaseIndex) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

function renderCase(data) {
  currentCase = data;
  sessionStorage.setItem(sessionCaseKey, JSON.stringify({
    id: data.id,
    case_code: data.case_code,
    title: data.title,
    participantName: currentParticipant,
    participants: data.participants,
    phase: data.phase,
    pace_status: data.pace_status,
  }));
  $('#case-title-display').textContent = data.title;
  $('#case-code-badge').textContent = data.case_code;
  $('#current-user').textContent = currentParticipant;
  const pace = {
    calm: 'Pokojné tempo',
    active: 'Aktívne tempo',
    slow_down: 'Spomaľme',
  }[data.pace_status];
  $('#pace-indicator').dataset.pace = pace ? data.pace_status : 'unavailable';
  $('#tension-label').textContent = pace || 'Nedostupné';
  setPhase(data.phase);
}

function createSafetyCard() {
  const card = document.createElement('section');
  card.className = 'safety-card';
  const heading = document.createElement('h3');
  heading.textContent = 'Bezpečie je na prvom mieste';
  const notice = document.createElement('p');
  notice.textContent = safetyNotice;
  const contacts = document.createElement('ul');
  const entries = [
    { label: 'Pri bezprostrednom ohrození v EÚ: 112', href: 'tel:112' },
    { label: 'Slovensko – linka pre ženy zažívajúce násilie: 0800 212 212', href: 'tel:0800212212' },
  ];
  entries.forEach(({ label, href }) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    item.append(link);
    contacts.append(item);
  });
  const location = document.createElement('p');
  location.textContent = 'Mimo EÚ kontaktujte miestne tiesňové služby. Linka pre ženy na Slovensku je bezplatná a dostupná nonstop.';
  card.append(heading, notice, contacts, location);
  return card;
}

function addAgreementControls(article, agreementId) {
  const agreement = agreements.get(agreementId);
  const status = document.createElement('p');
  status.className = 'agreement-status';
  if (!agreement) {
    status.textContent = 'Načítava sa stav dohody…';
    article.append(status);
    return;
  }
  const labels = { pending: 'Čaká na potvrdenie', accepted: 'Dohoda je prijatá', rejected: 'Dohoda bola odmietnutá' };
  status.textContent = labels[agreement.status] || agreement.status;
  article.append(status);
  const signatures = document.createElement('div');
  signatures.className = 'agreement-signatures';
  for (const name of currentCase?.participants || []) {
    const accepted = agreement.accepted_by.includes(name);
    const badge = document.createElement('span');
    badge.className = `signature-badge${accepted ? ' is-accepted' : ''}`;
    const state = accepted ? 'súhlasí' : agreement.status === 'pending' ? 'čaká sa' : 'nepotvrdené';
    badge.textContent = `${name} · ${state}`;
    signatures.append(badge);
  }
  article.append(signatures);
  if (agreement.status !== 'pending') return;
  const controls = document.createElement('div');
  controls.className = 'agreement-actions';
  for (const [label, accept] of [['Súhlasím s dohodou', true], ['Odmietnuť', false]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = accept ? 'button button-primary' : 'button button-quiet';
    button.textContent = label;
    button.disabled = accept && agreement.accepted_by.includes(currentParticipant);
    button.addEventListener('click', async () => {
      controls.querySelectorAll('button').forEach((item) => { item.disabled = true; });
      clearMessage(chatError);
      const { data, error } = await supabase.rpc('respond_to_agreement', {
        p_agreement_id: agreementId, p_accept: accept,
      });
      if (error) {
        showError(chatError, error);
        renderMessages();
        return;
      }
      if (currentCase?.id !== agreement.case_id) return;
      agreements.set(agreementId, data);
      renderMessages();
      await refreshCase().catch((error) => showError(loginError, error));
    });
    controls.append(button);
  }
  const suggest = document.createElement('button');
  suggest.type = 'button';
  suggest.className = 'button button-quiet';
  suggest.textContent = 'Navrhnúť úpravu';
  suggest.addEventListener('click', () => {
    if (!messageInput.value.trim()) messageInput.value = 'Navrhujem upraviť dohodu: ';
    showNotice('Napíšte a odošlite svoju navrhovanú úpravu do rozhovoru.');
    messageInput.focus();
  });
  controls.insertBefore(suggest, controls.lastElementChild);
  article.append(controls);
}

function renderMessage(message) {
  const article = document.createElement('article');
  const data = message.structured_data;
  const structured = data && typeof data === 'object' && !Array.isArray(data);
  const isMediator = message.is_mediator || message.message_type === 'mediator'
    || message.message_type === 'agreement' || structured;
  article.className = `message${message.sender_id === currentUser?.id && !isMediator ? ' message-own' : ''}${isMediator ? ' message-mediator mediator-card' : ''}`;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const sender = document.createElement('strong');
  sender.className = isMediator ? 'mediator-badge' : '';
  sender.textContent = isMediator ? '✳ AI MEDIÁTOR' : message.sender_name;
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.created_at;
  time.textContent = timeFormatter.format(new Date(message.created_at));
  meta.append(sender, time);
  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = structured && typeof data.summary === 'string' ? data.summary : message.message;
  article.append(meta, body);

  if (structured) {
    if (data.safety_alert === true) {
      article.append(createSafetyCard());
      return article;
    }
    if (Array.isArray(data.detected_patterns) && data.detected_patterns.length) {
      const tags = document.createElement('div');
      tags.className = 'pattern-tags';
      data.detected_patterns.filter((item) => typeof item === 'string').forEach((item) => {
        const tag = document.createElement('span');
        tag.className = 'pattern-tag';
        tag.textContent = item;
        tags.append(tag);
      });
      meta.append(tags);
    }
    if (Array.isArray(data.participant_perspectives) && data.participant_perspectives.length) {
      const perspectives = data.participant_perspectives
        .filter((item) => item && typeof item.name === 'string' && typeof item.underlying_need === 'string');
      if (perspectives.length) {
        const heading = document.createElement('p');
        heading.className = 'card-label';
        heading.textContent = 'MOŽNÉ POTREBY ÚČASTNÍKOV';
        const grid = document.createElement('div');
        grid.className = 'needs-grid';
        perspectives.forEach((item) => {
          const box = document.createElement('div');
          box.className = 'need-item';
          const name = document.createElement('strong');
          name.textContent = item.name;
          const need = document.createElement('p');
          need.textContent = item.underlying_need;
          box.append(name, need);
          grid.append(box);
        });
        article.append(heading, grid);
      }
    }
    if (typeof data.suggested_reframe === 'string' && data.suggested_reframe) {
      const box = document.createElement('div');
      box.className = 'reframe-box';
      const heading = document.createElement('p');
      heading.className = 'card-label';
      heading.textContent = 'ODPORÚČANÝ JA-VÝROK';
      const text = document.createElement('p');
      text.className = 'reframe-text';
      text.textContent = data.suggested_reframe;
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'button button-quiet';
      use.textContent = 'Použiť formuláciu';
      use.addEventListener('click', () => {
        messageInput.value = data.suggested_reframe;
        messageInput.focus();
      });
      box.append(heading, text, use);
      article.append(box);
    }
  }
  const agreement = message.agreement_id && agreements.get(message.agreement_id);
  const proposal = agreement?.proposal_text || data?.agreement_proposal;
  if ((typeof proposal === 'string' && proposal) || message.agreement_id || message.message_type === 'agreement') {
    const card = document.createElement('section');
    card.className = 'agreement-card';
    const title = document.createElement('h3');
    title.textContent = 'Návrh dohody';
    card.append(title);
    if (typeof proposal === 'string' && proposal) {
      const list = document.createElement('ul');
      list.className = 'agreement-points';
      proposal.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
        const item = document.createElement('li');
        item.textContent = line.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '');
        list.append(item);
      });
      card.append(list);
    }
    if (message.agreement_id) addAgreementControls(card, message.agreement_id);
    else if (message.message_type === 'agreement') {
      const status = document.createElement('p');
      status.className = 'agreement-status';
      status.textContent = 'Stav dohody nie je dostupný.';
      card.append(status);
    }
    article.append(card);
  }
  return article;
}

function renderMessages(newMessageId = null) {
  const nearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 100;
  const sorted = [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id));
  messagesElement.replaceChildren(...sorted.map((message) => {
    const article = renderMessage(message);
    if (String(message.id) === newMessageId) article.classList.add('is-new');
    return article;
  }));
  $('#chat-empty').hidden = sorted.length > 0;
  if (nearBottom) messagesElement.scrollTop = messagesElement.scrollHeight;
}

async function refreshCase() {
  if (!currentCase) return;
  const caseId = currentCase.id;
  const version = caseVersion;
  const { data, error } = await supabase.from('conflict_cases')
    .select('id, case_code, title, participants, phase, pace_status')
    .eq('id', caseId).maybeSingle();
  if (version !== caseVersion) return;
  if (error) showError(chatError, error);
  else if (data) renderCase(data);
  else {
    await closeCase();
    showError(loginError, new Error('Prípad už nie je dostupný.'));
  }
}

async function openCase(caseId, user) {
  const version = ++caseVersion;
  const [caseResponse, memberResponse] = await Promise.all([
    supabase.from('conflict_cases').select('id, case_code, title, participants, phase, pace_status')
      .eq('id', caseId).maybeSingle(),
    supabase.from('case_members').select('participant_name')
      .eq('case_id', caseId).eq('user_id', user.id).maybeSingle(),
  ]);
  if (version !== caseVersion) return;
  if (caseResponse.error) throw caseResponse.error;
  if (memberResponse.error) throw memberResponse.error;
  if (!caseResponse.data || !memberResponse.data) throw new CaseUnavailableError('Prípad nie je dostupný.');

  await stopListening();
  if (version !== caseVersion) return;
  currentUser = user;
  currentParticipant = memberResponse.data.participant_name;
  messages.clear();
  agreements.clear();
  renderCase(caseResponse.data);
  const pageUrl = new URL(window.location.href);
  if (pageUrl.searchParams.has('case')) {
    pageUrl.searchParams.delete('case');
    window.history.replaceState(window.history.state, '', pageUrl);
  }
  loginView.hidden = true;
  chatView.hidden = false;
  clearMessage(loginError);
  clearMessage(chatError);
  clearMessage(chatNotice);
  renderMessages();

  const receiveMessage = ({ eventType, new: message }) => {
    if (version !== caseVersion) return;
    const id = String(message.id);
    const isNew = eventType === 'INSERT' && !messages.has(id);
    messages.set(id, message);
    trimMessages();
    renderMessages(isNew ? id : null);
  };
  channel = supabase.channel(`case:${caseId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `case_id=eq.${caseId}` }, receiveMessage)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: `case_id=eq.${caseId}` }, receiveMessage)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'case_agreements', filter: `case_id=eq.${caseId}` }, ({ eventType, new: agreement, old }) => {
      if (version !== caseVersion) return;
      if (eventType === 'DELETE') agreements.delete(old.id);
      else agreements.set(agreement.id, agreement);
      renderMessages();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conflict_cases', filter: `id=eq.${caseId}` }, () => {
      if (version === caseVersion) void refreshCase().catch((error) => showError(loginError, error));
    })
    .subscribe((status) => {
      if (version !== caseVersion) return;
      if (status === 'SUBSCRIBED') {
        void loadCaseData(caseId, version).catch((error) => showError(chatError, error));
        void refreshCase().catch((error) => showError(loginError, error));
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        showError(chatError, new Error('Pripojenie k živému prípadu zlyhalo.'));
      }
    });
  void loadCaseData(caseId, version).catch((error) => showError(chatError, error));
}

async function loadCaseData(caseId, version) {
  const messageSnapshot = new Map(messages);
  const agreementSnapshot = new Map(agreements);
  const [messageResponse, agreementResponse] = await Promise.all([
    supabase.from('chat_messages')
      .select('id, case_id, sender_id, sender_name, message, is_mediator, message_type, structured_data, agreement_id, created_at')
      .eq('case_id', caseId).order('id', { ascending: false }).limit(100),
    supabase.from('case_agreements').select('id, case_id, proposal_text, accepted_by, status, created_at')
      .eq('case_id', caseId),
  ]);
  if (version !== caseVersion) return;
  if (messageResponse.error || agreementResponse.error) {
    showError(chatError, messageResponse.error || agreementResponse.error);
    return;
  }
  messageResponse.data.forEach((message) => {
    const id = String(message.id);
    if (messages.get(id) === messageSnapshot.get(id)) messages.set(id, message);
  });
  agreementResponse.data.forEach((agreement) => {
    if (agreements.get(agreement.id) === agreementSnapshot.get(agreement.id)) {
      agreements.set(agreement.id, agreement);
    }
  });
  trimMessages();
  renderMessages();
}

function trimMessages() {
  const ids = [...messages.keys()].sort((a, b) => Number(a) - Number(b));
  while (ids.length > 150) messages.delete(ids.shift());
}

function closeCoach() {
  coachDrawer.hidden = true;
  coachResult.textContent = '';
  coachSuggestion = '';
  coachUse.hidden = true;
}

function closeTimeout() {
  clearInterval(timeoutTimer);
  timeoutTimer = undefined;
  timeoutOverlay.hidden = true;
  chatView.inert = false;
  $('#timeout-button').focus();
}

async function closeCase() {
  caseVersion += 1;
  currentCase = undefined;
  currentParticipant = undefined;
  casePassword = undefined;
  if (inviteDialog.open) inviteDialog.close();
  sessionStorage.removeItem(sessionCaseKey);
  closeCoach();
  if (!timeoutOverlay.hidden) closeTimeout();
  const stopping = stopListening();
  messages.clear();
  agreements.clear();
  messagesElement.replaceChildren();
  messageInput.value = '';
  modeSelect.value = 'auto';
  chatView.hidden = true;
  loginView.hidden = false;
  await stopping;
}

$('#tab-create').addEventListener('click', () => switchTab('create'));
$('#tab-join').addEventListener('click', () => switchTab('join'));
document.querySelector('.lobby-tabs').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const next = $('#tab-create').getAttribute('aria-selected') === 'true' ? 'join' : 'create';
  switchTab(next);
  $(`#tab-${next}`).focus();
});
$('#participant-count').addEventListener('change', updateParticipants);
headerMoreToggle.addEventListener('click', () => {
  const expanded = headerMoreToggle.getAttribute('aria-expanded') === 'true';
  headerMoreToggle.setAttribute('aria-expanded', String(!expanded));
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.header-more')) headerMoreToggle.setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && headerMoreToggle.getAttribute('aria-expanded') === 'true') {
    headerMoreToggle.setAttribute('aria-expanded', 'false');
    headerMoreToggle.focus();
  }
});
updateParticipants();

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (lobbyBusy) return;
  clearMessage(loginError);
  setLobbyBusy(true);
  try {
    const names = [...participantsInputs.querySelectorAll('input')].map((input) => input.value.trim());
    const title = $('#create-title').value.trim();
    const password = $('#create-password').value;
    if (names.some((name) => !name) || new Set(names).size !== names.length) {
      throw new Error('Zadajte jedinečné mená všetkých účastníkov.');
    }
    if (new TextEncoder().encode(password).length > 72) {
      throw new Error('Heslo môže mať najviac 72 bajtov.');
    }
    const user = await ensureUser(names[0]);
    const { data, error } = await supabase.rpc('create_conflict_case', {
      p_title: title,
      p_password: password,
      p_participants: names,
      p_creator_name: names[0],
    });
    if (error) throw error;
    try {
      await openCase(data.id, user);
      if (currentCase?.id === data.id) casePassword = password;
    } catch {
      throw new Error(`Prípad bol vytvorený s kódom ${data.case_code}, ale nepodarilo sa ho otvoriť. Použite kód a heslo na opätovný vstup.`);
    }
    createForm.reset();
    updateParticipants();
  } catch (error) {
    showError(loginError, error);
  } finally {
    setLobbyBusy(false);
  }
});

joinForm.addEventListener('input', () => {
  previewCase = undefined;
  rolePicker.hidden = true;
  roleButtons.replaceChildren();
});
joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (lobbyBusy) return;
  clearMessage(loginError);
  setLobbyBusy(true);
  rolePicker.hidden = true;
  try {
    const code = $('#join-case-code').value.trim().toUpperCase();
    const password = $('#join-password').value;
    const user = await ensureUser();
    const { data, error } = await supabase.rpc('join_conflict_case', {
      p_case_code: code, p_password: password,
    });
    if (error) throw error;
    previewCase = { data, user, code, password };
    roleButtons.replaceChildren();
    data.participants.forEach((name) => {
      const role = document.createElement('button');
      role.type = 'button';
      role.className = 'role-button';
      const roleName = document.createElement('strong');
      roleName.textContent = `Vstúpiť ako ${name}`;
      role.append(roleName);
      role.addEventListener('click', async () => {
        if (lobbyBusy) return;
        setLobbyBusy(true);
        clearMessage(loginError);
        roleButtons.querySelectorAll('button').forEach((item) => { item.disabled = true; });
        try {
          if (!previewCase) throw new Error('Najprv overte kód a heslo prípadu.');
          const joiningCase = previewCase;
          const { error: joinError } = await supabase.rpc('join_conflict_case', {
            p_case_code: previewCase.code, p_password: previewCase.password, p_participant_name: name,
          });
          if (joinError) throw joinError;
          await openCase(joiningCase.data.id, joiningCase.user);
          if (currentCase?.id === joiningCase.data.id) casePassword = joiningCase.password;
          previewCase = undefined;
          joinForm.reset();
          rolePicker.hidden = true;
        } catch (joinError) {
          showError(loginError, joinError);
          previewCase = undefined;
          rolePicker.hidden = true;
        } finally {
          setLobbyBusy(false);
        }
      });
      roleButtons.append(role);
    });
    rolePicker.hidden = false;
  } catch (error) {
    showError(loginError, error);
  } finally {
    setLobbyBusy(false);
  }
});

async function invokeMediator(body) {
  const { data, error } = await supabase.functions.invoke('mediate', { body });
  if (error) {
    let response;
    if (error.context?.json) {
      try { response = await error.context.json(); } catch { /* Use the original error below. */ }
    }
    throw new Error(response?.error || error.message);
  }
  if (!data?.ok) throw new Error(data?.error || 'Mediátor nevrátil platnú odpoveď.');
  return data;
}

async function mediate(userQuestion = '') {
  if (!currentCase) return;
  const version = caseVersion;
  const button = $('#mediate-button');
  button.disabled = true;
  button.querySelector('.mediator-label').textContent = 'Mediátor premýšľa…';
  clearMessage(chatError);
  try {
    await invokeMediator({ caseId: currentCase.id, action: 'mediate', mode: modeSelect.value, userQuestion });
    if (version === caseVersion) showNotice('Vstup mediátora bol pridaný do rozhovoru.');
  } catch (error) {
    if (version === caseVersion) showError(chatError, error);
  } finally {
    button.disabled = false;
    button.querySelector('.mediator-label').textContent = 'Zavolať mediátora';
  }
}

$('#mediate-button').addEventListener('click', () => { void mediate(); });
$('#message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage(chatError);
  clearMessage(chatNotice);
  const message = messageInput.value.trim();
  if (!message || !currentCase || !currentUser) return;
  const mentionsMediator = /@(mediator|mediátor|ai)\b/i.test(message);
  const userQuestion = mentionsMediator
    ? message.replace(/@(mediator|mediátor|ai)\b/gi, '').trim() || message
    : '';
  if (userQuestion.length > 500) {
    showError(chatError, new Error('Otázka pre mediátora môže mať najviac 500 znakov.'));
    return;
  }
  const version = caseVersion;
  const button = $('#send-button');
  button.disabled = true;
  try {
    const { error } = await supabase.from('chat_messages').insert({
      case_id: currentCase.id, sender_id: currentUser.id, message,
    });
    if (error) throw error;
    if (version !== caseVersion) return;
    if (messageInput.value.trim() === message) messageInput.value = '';
    await loadCaseData(currentCase.id, version);
    if (version !== caseVersion) return;
    if (mentionsMediator) await mediate(userQuestion);
  } catch (error) {
    if (version === caseVersion) showError(chatError, error);
  } finally {
    button.disabled = false;
    if (version === caseVersion) messageInput.focus();
  }
});
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#message-form').requestSubmit();
  }
});

$('#coach-button').addEventListener('click', async () => {
  if (!currentCase) return;
  const draft = messageInput.value.trim();
  if (!draft) {
    showError(chatError, new Error('Najprv napíšte koncept správy pre súkromného kouča.'));
    messageInput.focus();
    return;
  }
  const version = caseVersion;
  const button = $('#coach-button');
  button.disabled = true;
  clearMessage(chatError);
  coachDrawer.hidden = false;
  coachUse.hidden = true;
  coachSuggestion = '';
  coachResult.textContent = 'Kouč premýšľa nad vašou správou…';
  try {
    const data = await invokeMediator({
      caseId: currentCase.id, action: 'private_coach', mode: 'reframe', draftMessage: draft,
    });
    if (version !== caseVersion || coachDrawer.hidden) return;
    if (typeof data.coaching?.summary !== 'string' || typeof data.coaching?.suggested_reframe !== 'string') {
      throw new Error('Kouč nevrátil platný návrh.');
    }
    coachSuggestion = data.coaching.suggested_reframe;
    const analysis = [data.coaching.summary];
    if (Array.isArray(data.coaching.detected_patterns) && data.coaching.detected_patterns.length) {
      analysis.push(`Komunikačné vzorce: ${data.coaching.detected_patterns.join(', ')}`);
    }
    if (Array.isArray(data.coaching.participant_perspectives)) {
      const perspectives = data.coaching.participant_perspectives
        .filter((item) => item && typeof item.name === 'string' && typeof item.underlying_need === 'string')
        .map((item) => `${item.name}: ${item.underlying_need}`);
      if (perspectives.length) analysis.push(`Možné potreby: ${perspectives.join(' · ')}`);
    }
    if (coachSuggestion) analysis.push(`Návrh: ${coachSuggestion}`);
    coachResult.textContent = analysis.join('\n\n');
    if (data.coaching.safety_alert === true) coachResult.append(createSafetyCard());
    coachUse.hidden = !coachSuggestion;
  } catch (error) {
    if (version === caseVersion && !coachDrawer.hidden) {
      coachResult.textContent = '';
      showError(chatError, error);
    }
  } finally {
    button.disabled = false;
  }
});
$('#coach-close').addEventListener('click', closeCoach);
coachUse.addEventListener('click', () => {
  if (!coachSuggestion) return;
  messageInput.value = coachSuggestion;
  closeCoach();
  messageInput.focus();
});

async function copyInvite(password) {
  if (!currentCase) return;
  const { case_code: code } = currentCase;
  const version = caseVersion;
  const dialogVersion = inviteVersion;
  clearMessage(chatError);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Kopírovanie nie je v tomto prehliadači dostupné.');
    const url = `${window.location.origin}${window.location.pathname}?case=${encodeURIComponent(code)}`;
    await navigator.clipboard.writeText(`Pozvánka do mediačného prípadu\nOdkaz: ${url}\nKód prípadu: ${code}\nHeslo: ${password}`);
    if (version !== caseVersion || dialogVersion !== inviteVersion) return;
    casePassword = password;
    if (inviteDialog.open) inviteDialog.close();
    showNotice('Pozvánka bola skopírovaná. Obsahuje heslo, preto ju zdieľajte iba bezpečnou cestou.');
  } catch (error) {
    if (version === caseVersion && dialogVersion === inviteVersion) {
      showError(inviteDialog.open ? $('#invite-error') : chatError, error);
    }
  }
}

$('#copy-invite-button').addEventListener('click', () => {
  if (!currentCase) return;
  if (casePassword) {
    void copyInvite(casePassword);
    return;
  }
  $('#invite-form').reset();
  $('#invite-password').disabled = false;
  $('#invite-verify').disabled = false;
  $('#invite-verify').hidden = false;
  $('#invite-copy').hidden = true;
  clearMessage($('#invite-error'));
  inviteVersion += 1;
  inviteDialog.showModal();
  $('#invite-password').focus();
});
$('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentCase) return;
  const button = $('#invite-verify');
  if (button.hidden || button.disabled) return;
  const password = $('#invite-password').value;
  const caseId = currentCase.id;
  const version = caseVersion;
  const dialogVersion = inviteVersion;
  button.disabled = true;
  $('#invite-password').disabled = true;
  clearMessage($('#invite-error'));
  try {
    const { data, error } = await supabase.rpc('join_conflict_case', {
      p_case_code: currentCase.case_code, p_password: password,
    });
    if (error) throw error;
    if (!data || data.id !== caseId) throw new Error('Prípad sa nepodarilo overiť.');
    if (version !== caseVersion || dialogVersion !== inviteVersion || !inviteDialog.open) return;
    verifiedInvitePassword = password;
    $('#invite-password').value = '';
    $('#invite-password').disabled = true;
    button.hidden = true;
    $('#invite-copy').hidden = false;
    $('#invite-copy').focus();
  } catch (error) {
    if (version === caseVersion && dialogVersion === inviteVersion && inviteDialog.open) {
      showError($('#invite-error'), error);
    }
  } finally {
    if (dialogVersion === inviteVersion) {
      button.disabled = false;
      if (!verifiedInvitePassword) $('#invite-password').disabled = false;
    }
  }
});
$('#invite-copy').addEventListener('click', () => {
  if (verifiedInvitePassword) void copyInvite(verifiedInvitePassword);
});
$('#invite-cancel').addEventListener('click', () => inviteDialog.close());
inviteDialog.addEventListener('close', () => {
  inviteVersion += 1;
  verifiedInvitePassword = undefined;
  $('#invite-password').value = '';
});

$('#timeout-button').addEventListener('click', () => {
  const endsAt = Date.now() + 60_000;
  timeoutOverlay.hidden = false;
  chatView.inert = true;
  const update = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    $('#timeout-countdown').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    if (remaining === 0) closeTimeout();
  };
  update();
  timeoutTimer = setInterval(update, 250);
  $('#timeout-close').focus();
});
$('#timeout-close').addEventListener('click', closeTimeout);
timeoutOverlay.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTimeout();
  if (event.key === 'Tab') {
    event.preventDefault();
    $('#timeout-close').focus();
  }
});

function markdownText(value) {
  return String(value).replace(/[\\`*_{}[\]()#+.!|<>~-]/g, '\\$&');
}

function markdownInline(value) {
  return markdownText(value).replace(/\r\n?|\n/g, ' ');
}

function markdownQuote(value) {
  return String(value).split(/\r\n?|\n/).map((line) => `> ${markdownText(line)}`).join('\n');
}

async function loadExportMessages(caseId) {
  const newest = await supabase.from('chat_messages').select('id')
    .eq('case_id', caseId).order('id', { ascending: false }).limit(1);
  if (newest.error) throw newest.error;
  if (!newest.data.length) return [];

  const maximumId = newest.data[0].id;
  const allMessages = [];
  let cursor;
  while (true) {
    let query = supabase.from('chat_messages')
      .select('id, sender_name, message, created_at, structured_data')
      .eq('case_id', caseId).lte('id', maximumId).order('id', { ascending: true }).limit(500);
    if (cursor !== undefined) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw error;
    if (!data.length) return allMessages;
    const next = data[data.length - 1].id;
    if (String(next) === String(cursor)) throw new Error('Zápisnicu sa nepodarilo stránkovať.');
    allMessages.push(...data);
    cursor = next;
  }
}

async function loadConfirmedAgreements(caseId) {
  const result = [];
  let cursor;
  while (true) {
    let query = supabase.from('case_agreements')
      .select('id, proposal_text, accepted_by').eq('case_id', caseId).eq('status', 'accepted')
      .order('id', { ascending: true }).limit(500);
    if (cursor !== undefined) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw error;
    if (!data.length) return result;
    const next = data[data.length - 1].id;
    if (String(next) === String(cursor)) throw new Error('Dohody sa nepodarilo stránkovať.');
    result.push(...data);
    cursor = next;
  }
}

function createMinutes(caseData, allMessages, confirmedAgreements) {
  const memory = caseData.case_memory && typeof caseData.case_memory === 'object'
    && !Array.isArray(caseData.case_memory) ? caseData.case_memory : {};
  const lines = [
    `# Zápisnica: ${markdownInline(caseData.title)}`,
    '',
    `**Kód prípadu:** ${markdownInline(caseData.case_code)}`,
    `**Dátum exportu:** ${markdownInline(new Date().toLocaleString('sk-SK'))}`,
    `**Účastníci:** ${caseData.participants.map(markdownInline).join(', ')}`,
    '',
    '## Pamäť prípadu',
  ];
  const appendList = (heading, values) => {
    lines.push('', `### ${heading}`);
    if (!values.length) lines.push('- Nie sú zaznamenané.');
    else values.forEach((value) => lines.push(`- ${markdownInline(value)}`));
  };
  appendList('Fakty', Array.isArray(memory.facts) ? memory.facts : []);
  const needs = memory.needs && typeof memory.needs === 'object' && !Array.isArray(memory.needs)
    ? Object.entries(memory.needs).map(([name, value]) => {
      const description = typeof value === 'string' ? value : JSON.stringify(value);
      return `${name}: ${description}`;
    }) : [];
  appendList('Potreby', needs);
  appendList('Otvorené otázky', Array.isArray(memory.open_questions) ? memory.open_questions : []);
  lines.push('', '## Potvrdené dohody', '');
  if (!confirmedAgreements.length) lines.push('Zatiaľ nie sú potvrdené žiadne dohody.', '');
  confirmedAgreements.forEach((agreement, index) => {
    lines.push(
      `### Dohoda ${index + 1}`,
      '',
      markdownQuote(agreement.proposal_text),
      '',
      `**Potvrdili:** ${agreement.accepted_by.map(markdownInline).join(', ')}`,
      '',
    );
  });
  lines.push('## História konverzácie', '');
  if (!allMessages.length) lines.push('Zatiaľ nie sú žiadne správy.', '');
  allMessages.forEach((message) => {
    lines.push(
      `### ${markdownInline(new Date(message.created_at).toLocaleString('sk-SK'))} · ${markdownInline(message.sender_name)}`,
      '',
      markdownQuote(message.message),
      '',
    );
    const data = message.structured_data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (typeof data.summary === 'string' && data.summary !== message.message) {
      lines.push('**Zhrnutie mediátora:**', '', markdownQuote(data.summary), '');
    }
    if (data.safety_alert === true) lines.push('**Bezpečnostné upozornenie:**', '', markdownQuote(safetyNotice), '');
    if (Array.isArray(data.detected_patterns) && data.detected_patterns.length) {
      lines.push(`**Komunikačné vzorce:** ${data.detected_patterns.map(markdownInline).join(', ')}`, '');
    }
    if (Array.isArray(data.participant_perspectives)) {
      const perspectives = data.participant_perspectives.filter(
        (item) => item && typeof item.name === 'string' && typeof item.underlying_need === 'string',
      );
      if (perspectives.length) {
        lines.push('**Možné potreby:**');
        perspectives.forEach((item) => lines.push(`- ${markdownInline(item.name)}: ${markdownInline(item.underlying_need)}`));
        lines.push('');
      }
    }
    if (typeof data.suggested_reframe === 'string' && data.suggested_reframe) {
      lines.push('**Odporúčaná formulácia:**', '', markdownQuote(data.suggested_reframe), '');
    }
    if (typeof data.agreement_proposal === 'string' && data.agreement_proposal) {
      lines.push('**Návrh dohody:**', '', markdownQuote(data.agreement_proposal), '');
    }
  });
  return lines.join('\n');
}

$('#export-button').addEventListener('click', async () => {
  if (!currentCase) return;
  const caseId = currentCase.id;
  const version = caseVersion;
  const button = $('#export-button');
  button.disabled = true;
  clearMessage(chatError);
  try {
    const [caseResponse, allMessages, confirmedAgreements] = await Promise.all([
      supabase.from('conflict_cases').select('title, case_code, participants, case_memory')
        .eq('id', caseId).maybeSingle(),
      loadExportMessages(caseId),
      loadConfirmedAgreements(caseId),
    ]);
    if (caseResponse.error) throw caseResponse.error;
    if (!caseResponse.data) throw new Error('Prípad už nie je dostupný.');
    if (version !== caseVersion) return;
    const minutes = createMinutes(caseResponse.data, allMessages, confirmedAgreements);
    const url = URL.createObjectURL(new Blob([minutes], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Zapisnica-${caseResponse.data.case_code}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotice('Zápis bol exportovaný.');
  } catch (error) {
    if (version === caseVersion) showError(chatError, error);
  } finally {
    button.disabled = false;
  }
});
$('#logout-button').addEventListener('click', () => {
  void closeCase().catch((error) => showError(loginError, error));
});

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session && currentCase) void closeCase().catch((error) => showError(loginError, error));
});
const invitedCase = new URLSearchParams(window.location.search).get('case');
if (invitedCase !== null) {
  switchTab('join');
  $('#join-case-code').value = invitedCase;
  $('#join-password').focus();
}
const storedCase = sessionStorage.getItem(sessionCaseKey);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let savedCaseId;
if (storedCase) {
  try {
    const saved = JSON.parse(storedCase);
    if (saved && typeof saved.id === 'string' && uuidPattern.test(saved.id)) savedCaseId = saved.id;
  } catch {
    if (uuidPattern.test(storedCase)) savedCaseId = storedCase;
  }
  if (!savedCaseId) {
    sessionStorage.removeItem(sessionCaseKey);
    showError(loginError, new Error('Uložený prípad sa nepodarilo obnoviť.'));
  }
}
if (savedCaseId && invitedCase === null) {
  setLobbyBusy(true);
  void (async () => {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session?.user) {
        sessionStorage.removeItem(sessionCaseKey);
        return;
      }
      await openCase(savedCaseId, data.session.user);
    } catch (error) {
      if (error instanceof CaseUnavailableError) sessionStorage.removeItem(sessionCaseKey);
      showError(loginError, error);
    } finally {
      setLobbyBusy(false);
    }
  })();
}
