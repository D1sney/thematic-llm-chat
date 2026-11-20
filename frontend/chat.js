import { createAnswerSuggestions } from './answer-suggestions.js';
import { createMarkdownInput } from './markdown-input.js';
import { createVoiceInput } from './voice-input.js';
import { createIconSwap } from './motion.js';
import { createMessageFeedback } from './message-feedback.js';
import { createMessageEditor } from './message-edit.js';
import { createMessageActionHint, node, uiIcon } from './message-actions.js';
import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/dompurify.js';

const get = id => document.getElementById(id);
const loginView = get('login-view');
const chatView = get('chat-view');
const startup = get('startup');
const loginForm = get('login-form');
const composer = get('composer');
const keyField = get('access-key');
const input = get('message-input');
const { editor } = createMarkdownInput(input);
const loginError = get('login-error');
const messageError = get('message-error');
const loginButton = get('login-button');
const sendButton = get('send-button');
const logout = get('logout');
const clearChat = get('clear-chat');
const clearDialog = get('clear-dialog');
const historyList = get('history');
const scroll = get('scroll');
const starters = document.querySelectorAll('[data-prompt]');
const keyPattern = /^[A-Za-z0-9_-]{8,255}$/;
const dateFormat = new Intl.DateTimeFormat('ru-RU', {dateStyle: 'short', timeStyle: 'short'});
const safeTags = ['p', 'br', 'strong', 'em', 'del', 'a', 'h1', 'h2', 'h3', 'h4', 'blockquote',
  'ul', 'ol', 'li', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
const limit = 500;
const length = value => Array.from(value).length;

let loggingIn = false;
let sending = false;
let switching = false;
let composing = false;
let editing = null;
let branchId;
let demo = false;
let starterInsertion = null;
let lastMessage = null;
let retryAction = null;
const retryButton = get('retry-button');

function readDraft(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function writeDraft(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* The editor works without browser storage. */ }
}

function clearDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('interview-ai:draft:') || key.startsWith('interview-ai:answer-insertion:')) {
        sessionStorage.removeItem(key);
      }
    }
  } catch { /* The editor works without browser storage. */ }
}

function saveDraft() {
  if (branchId && !sending) writeDraft(`interview-ai:draft:${branchId}`, input.value);
}

const answerSuggestions = createAnswerSuggestions({
  host: get('answer-suggestions'), input, announce, read: readDraft, write: writeDraft,
  onChange: () => { saveDraft(); syncComposer(); },
});

function clearChatError() {
  messageError.textContent = '';
  retryAction = null;
  retryButton.hidden = true;
}

function retryableAction(error, action) {
  if (error.status === 409) return () => openChat(true);
  return !error.status || error.status >= 500 ? action : null;
}

function renderError(text, retry = null, label = 'Повторить') {
  messageError.textContent = text;
  retryAction = retry;
  retryButton.textContent = label;
  retryButton.hidden = !retry;
}

retryButton.addEventListener('click', async () => {
  if (!retryAction || sending || switching) return;
  retryButton.disabled = true;
  try { await retryAction(); }
  catch (error) { showChatError(error, retryAction); }
  finally { retryButton.disabled = false; }
});

function announce(text) {
  get('chat-announcement').textContent = text;
}

const voice = createVoiceInput({
  composer,
  canStart: () => !demo && !sending && !switching && !editing && !chatView.hidden,
  onChange: syncComposer,
  onResult: (transcript, send) => {
    input.value = [input.value.trimEnd(), transcript].filter(Boolean).join(' ');
    starterInsertion = null;
    saveDraft();
    syncComposer();
    if (length(input.value) > limit) {
      renderError('Сократите расшифровку до 500 символов перед отправкой.');
    } else if (send) {
      composer.requestSubmit();
    }
    if (!sending) input.focus();
  },
  announce,
});

for (const [id, label] of [
  ['voice-start', 'Записать голосом'],
  ['voice-stop', 'Остановить и вернуть текст'],
  ['send-button', () => sendButton.getAttribute('aria-label')],
]) {
  const button = get(id);
  button.append(createMessageActionHint(button, label, {placement: 'top', messageAction: false}));
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, {method = 'GET', body} = {}) {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    headers: body ? {'Content-Type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, typeof result.detail === 'string'
      ? result.detail : 'Сервер не смог обработать запрос. Попробуйте ещё раз.');
  }
  return result;
}

function errorText(error) {
  return error instanceof ApiError ? error.message : 'Не удалось связаться с сервером. Попробуйте ещё раз.';
}

function showChatError(error, retry = null) {
  if (error.status === 401) openLogin('Время входа истекло. Введите ключ ещё раз.', true);
  else renderError(errorText(error), retryableAction(error, retry), error.status === 409 ? 'Обновить историю' : 'Повторить');
}

function syncLogin() {
  const valid = keyPattern.test(keyField.value);
  loginButton.disabled = loggingIn || !valid;
  loginButton.textContent = loggingIn ? 'Входим…' : 'Войти';
  keyField.readOnly = loggingIn;
  keyField.setAttribute('aria-invalid', String(!!loginError.textContent || (!!keyField.value && !valid)));
}

function syncComposer() {
  const busy = sending || switching || !!editing;
  const tooLong = length(input.value) > limit;
  get('input-status').textContent = tooLong ? 'До 500 символов' : '';
  editor.setAttribute('aria-invalid', String(tooLong));
  sendButton.disabled = busy || (voice.active ? !voice.recording : tooLong || !input.value.trim());
  sendButton.setAttribute('aria-label', voice.recording ? 'Распознать и отправить' : 'Отправить сообщение');
  input.readOnly = busy || voice.active;
  voice.update(busy || demo);
  get('voice-start').hidden = get('voice-start').hidden || demo;
  answerSuggestions.update({
    chatId: branchId, message: lastMessage?.role === 'assistant' ? lastMessage : null,
    disabled: busy || voice.active || chatView.hidden, hidden: busy || voice.active || chatView.hidden,
    pending: sending,
  });
  for (const button of starters) button.disabled = busy || voice.active;
  get('welcome').hidden = historyList.childElementCount > 0;
  logout.disabled = sending || switching;
  clearChat.hidden = chatView.hidden;
  clearChat.disabled = busy || voice.active || !lastMessage;
}

function messageAction(glyph, label, handler) {
  const button = node('button', 'icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.append(uiIcon(glyph), createMessageActionHint(button, label));
  button.addEventListener('click', handler);
  return button;
}

function makeCopy(text) {
  const label = 'Скопировать сообщение';
  let hintText = label;
  let reset;
  const button = node('button', 'icon-button copy-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  const glyphs = createIconSwap(uiIcon('copy'), uiIcon('check'));
  button.append(glyphs, createMessageActionHint(button, () => hintText));
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      glyphs.dataset.state = 'b';
      hintText = 'Скопировано';
      announce(hintText);
      clearTimeout(reset);
      reset = setTimeout(() => { glyphs.dataset.state = 'a'; hintText = label; }, 1800);
    } catch {
      announce('Не удалось скопировать. Выделите текст вручную.');
    }
  });
  return button;
}

function addVersions(actions, versions, currentId) {
  if (versions.length < 2) return;
  const index = versions.findIndex(version => version.message_id === currentId);
  const group = node('span', 'message-versions');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Версии сообщения');
  const makeArrow = (slot, glyph, label) => {
    const target = versions[slot];
    const arrow = messageAction(glyph, label, () => selectBranch(target?.branch_id));
    arrow.disabled = !target;
    return arrow;
  };
  group.append(
    makeArrow(index - 1, 'chevron-left', 'Предыдущая версия'),
    node('span', '', `${index + 1} / ${versions.length}`),
    makeArrow(index + 1, 'chevron-right', 'Следующая версия'),
  );
  actions.append(group);
}

function makeEntry(message, versions = [], rating = null) {
  const {role, text, created_at: createdAt} = message;
  const isUser = role === 'user';
  const article = node('article', `message message-${role}`);
  article.setAttribute('aria-label', isUser ? 'Ваше сообщение' : 'Ответ интервьюера');
  if (message.id !== undefined) article.dataset.messageId = message.id;
  const content = node('div', isUser ? 'message-user-content' : 'message-content');
  if (isUser) content.textContent = text;
  else content.innerHTML = DOMPurify.sanitize(marked.parse(text), {ALLOWED_TAGS: safeTags, ALLOWED_ATTR: ['href']});
  const actions = node('div', 'message-actions');
  const time = node('time', 'message-timestamp', dateFormat.format(new Date(createdAt)));
  time.dateTime = createdAt;
  if (isUser) actions.append(time);
  addVersions(actions, versions, message.id);
  actions.append(makeCopy(text));
  if (message.id !== undefined && isUser) {
    const edit = messageAction('edit', 'Изменить сообщение', () => editMessage(message, article, edit));
    actions.append(edit);
  } else if (message.id !== undefined) {
    const messageBranch = branchId;
    actions.append(createMessageFeedback(rating, {
      save: value => api(`messages/${message.id}/feedback?branch_id=${messageBranch}`, {
        method: 'PUT', body: {rating: value},
      }),
      onError: showChatError, announce,
    }));
  }
  if (!isUser) actions.append(time);
  article.append(content, actions);
  return article;
}

function renderHistory({messages, demo: isDemo, branch_id, versions, ratings}) {
  demo = isDemo;
  if (branchId !== branch_id) {
    input.value = readDraft(`interview-ai:draft:${branch_id}`) ?? '';
    starterInsertion = null;
  }
  branchId = branch_id;
  lastMessage = messages.at(-1);
  get('demo-label').hidden = !demo;
  historyList.replaceChildren(...messages.map(message => makeEntry(message, versions[message.id], ratings[message.id])));
  syncComposer();
}

function startWaiting(requestId, anchor = null) {
  const waiting = node('div', 'waiting');
  waiting.setAttribute('role', 'status');
  const label = node('span', 't-shimmer');
  label.setAttribute('aria-hidden', 'true');
  waiting.append(label);
  let timer;
  let active = true;
  let shown = 0;
  const setLabel = count => {
    const text = count ? `Повторная попытка · ${count}/2` : 'Обдумываю ваш ответ…';
    waiting.setAttribute('aria-label', text);
    label.textContent = label.dataset.text = text;
  };
  setLabel(0);
  if (anchor) anchor.after(waiting);
  else historyList.append(waiting);
  async function poll() {
    if (!document.hidden) {
      try {
        const {retry_count: count} = await api(`reply-state/${requestId}`);
        if (active && count > shown && count <= 2) { shown = count; setLabel(count); }
      } catch { /* The primary request reports errors. */ }
    }
    if (active) timer = setTimeout(poll, 1000);
  }
  timer = setTimeout(poll, 1000);
  return () => { active = false; clearTimeout(timer); waiting.remove(); };
}

function scrollToLatest() {
  scroll.scrollTop = scroll.scrollHeight;
}

function openLogin(message = '', focus = false) {
  startup.hidden = true;
  chatView.hidden = true;
  logout.hidden = true;
  clearChat.hidden = true;
  get('demo-label').hidden = true;
  historyList.replaceChildren();
  editing = null;
  lastMessage = null;
  voice.cancel();
  loginView.hidden = false;
  loginError.textContent = message;
  syncLogin();
  if (focus) keyField.focus();
}

async function openChat(focus = false) {
  const data = await api('messages');
  loginView.hidden = true;
  startup.hidden = true;
  chatView.hidden = false;
  logout.hidden = false;
  renderHistory(data);
  scrollToLatest();
  if (focus) input.focus();
}

async function selectBranch(target) {
  if (!target || editing || sending || switching || voice.active) return;
  switching = true;
  clearChatError();
  syncComposer();
  try {
    renderHistory(await api(`branches/${target}`, {method: 'POST'}));
    scrollToLatest();
    announce('Версия диалога открыта');
  } catch (error) {
    showChatError(error);
  } finally {
    switching = false;
    syncComposer();
  }
}

function editMessage(message, article, trigger) {
  if (editing || sending || switching || voice.active) return;
  const content = article.querySelector('.message-user-content');
  const actions = article.querySelector('.message-actions');
  function close() {
    clearChatError();
    form.remove();
    article.classList.remove('is-editing');
    content.hidden = false;
    actions.hidden = false;
    editing = null;
    syncComposer();
    trigger.focus({preventScroll: true});
  }
  const form = createMessageEditor({
    content: message.text,
    original: message.text,
    onChange: clearChatError,
    onCancel: () => { if (!sending) close(); },
    onSend: async text => {
      if (sending) return;
      sending = true;
      fieldset.disabled = true;
      clearChatError();
      const requestId = crypto.randomUUID();
      const stopWaiting = startWaiting(requestId, article);
      syncComposer();
      let saved = false;
      try {
        const data = await api(`messages/${message.id}`, {method: 'PUT', body: {text, branch_id: branchId, request_id: requestId}});
        saved = true;
        editing = null;
        renderHistory(data);
        scrollToLatest();
      } catch (error) {
        if (error.status === 401) showChatError(error);
        else showChatError(error, () => form.requestSubmit());
      } finally {
        stopWaiting();
        sending = false;
        fieldset.disabled = false;
        syncComposer();
        if (saved) input.focus({preventScroll: true});
      }
    },
  });
  const fieldset = node('fieldset', 'message-edit-fields');
  fieldset.append(...form.children);
  form.append(fieldset);
  editing = form;
  article.classList.add('is-editing');
  content.hidden = true;
  actions.hidden = true;
  article.append(form);
  syncComposer();
}

keyField.addEventListener('input', () => {
  loginError.textContent = keyField.value && !keyPattern.test(keyField.value) ? 'Проверьте длину и символы ключа.' : '';
  syncLogin();
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (loginButton.disabled) return;
  loginError.textContent = '';
  loggingIn = true;
  syncLogin();
  let authenticated = false;
  try {
    await api('session', {method: 'POST', body: {key: keyField.value}});
    authenticated = true;
    keyField.value = '';
    await openChat(true);
  } catch (error) {
    if (authenticated) showStartupError(error);
    else loginError.textContent = errorText(error);
  } finally {
    loggingIn = false;
    syncLogin();
  }
});

clearChat.addEventListener('click', () => {
  get('clear-error').textContent = '';
  clearDialog.showModal();
});
get('cancel-clear').addEventListener('click', () => clearDialog.close());
clearDialog.addEventListener('cancel', event => { if (switching) event.preventDefault(); });
get('clear-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (switching) return;
  const confirm = get('confirm-clear');
  const cancel = get('cancel-clear');
  const errorTarget = get('clear-error');
  switching = true;
  confirm.disabled = cancel.disabled = true;
  errorTarget.textContent = '';
  syncComposer();
  let cleared = false;
  try {
    const data = await api(`messages?branch_id=${branchId}`, {method: 'DELETE'});
    clearDrafts();
    clearChatError();
    renderHistory(data);
    clearDialog.close();
    announce('Общий чат очищен');
    cleared = true;
  } catch (error) {
    if (error.status === 401) {
      clearDialog.close();
      showChatError(error);
    } else if (error.status === 409) {
      clearDialog.close();
      showChatError(error);
    } else {
      errorTarget.textContent = errorText(error);
    }
  } finally {
    switching = false;
    confirm.disabled = cancel.disabled = false;
    syncComposer();
    if (cleared) input.focus({preventScroll: true});
  }
});

logout.addEventListener('click', async () => {
  logout.disabled = true;
  clearChatError();
  try {
    await api('session', {method: 'DELETE'});
    input.value = '';
    saveDraft();
    writeDraft(`interview-ai:answer-insertion:${branchId}`, null);
    branchId = undefined;
    starterInsertion = null;
    openLogin('', true);
  } catch (error) {
    showChatError(error);
  } finally {
    logout.disabled = false;
  }
});

input.addEventListener('input', () => {
  if (starterInsertion && input.value !== starterInsertion.result) starterInsertion = null;
  clearChatError();
  saveDraft();
  syncComposer();
});
input.addEventListener('draft-limit', () => renderError('Сообщение может содержать до 500 символов.'));
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; });
input.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing) return;
  event.preventDefault();
  if (!sendButton.disabled) composer.requestSubmit();
});

for (const button of starters) {
  button.addEventListener('click', () => {
    const base = starterInsertion?.result === input.value ? starterInsertion.base : input.value.trimEnd();
    const result = [base, button.dataset.prompt].filter(Boolean).join('\n\n');
    if (length(result) > limit) {
      renderError('Сократите черновик, чтобы добавить подсказку.');
    } else {
      starterInsertion = {base, result};
      input.value = result;
      clearChatError();
      saveDraft();
      syncComposer();
    }
    input.focus();
  });
}

composer.addEventListener('submit', async event => {
  event.preventDefault();
  if (sendButton.disabled) return;
  if (voice.recording) {
    await voice.finish(true);
    return;
  }
  const text = input.value;
  const restoreFocus = [sendButton, editor].includes(document.activeElement);
  const pending = makeEntry({role: 'user', text: text.trim(), created_at: new Date().toISOString()});
  clearChatError();
  sending = true;
  historyList.append(pending);
  const requestId = crypto.randomUUID();
  const stopWaiting = startWaiting(requestId);
  input.value = '';
  syncComposer();
  scrollToLatest();
  try {
    const turn = await api('messages', {method: 'POST', body: {text, branch_id: branchId, request_id: requestId}});
    pending.replaceWith(makeEntry(turn.user), makeEntry(turn.assistant));
    lastMessage = turn.assistant;
    writeDraft(`interview-ai:draft:${branchId}`, null);
    starterInsertion = null;
  } catch (error) {
    pending.remove();
    input.value = text;
    showChatError(error, () => composer.requestSubmit());
  } finally {
    stopWaiting();
    sending = false;
    syncComposer();
    scrollToLatest();
    if (restoreFocus && !chatView.hidden && [document.body, sendButton].includes(document.activeElement)) {
      input.focus({preventScroll: true});
    }
  }
});

function showStartupError(error) {
  loginView.hidden = true;
  startup.hidden = false;
  get('startup-message').textContent = errorText(error);
  get('reload').hidden = false;
}

get('reload').addEventListener('click', () => window.location.reload());
openChat().catch(error => {
  if (error.status === 401) openLogin();
  else showStartupError(error);
});
