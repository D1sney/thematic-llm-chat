"use strict";

const get = (id) => document.getElementById(id);
const startup = get("startup");
const loginView = get("login-view");
const chatView = get("chat-view");
const loginForm = get("login-form");
const messageForm = get("message-form");
const keyField = get("access-key");
const messageField = get("message");
const loginError = get("login-error");
const messageError = get("message-error");
const loginButton = get("login-button");
const sendButton = get("send-button");
const logout = get("logout");
const historyList = get("history");
const welcome = get("welcome");
const scroll = get("scroll");
const starterButtons = document.querySelectorAll("[data-prompt]");
const keyPattern = /^[A-Za-z0-9_-]{8,255}$/;
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
});
let loggingIn = false;
let sending = false;
let composing = false;
let selectedPrompt = "";

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof result.detail === "string"
      ? result.detail : "Сервер не смог обработать запрос. Попробуйте ещё раз.";
    throw new ApiError(response.status, detail);
  }
  return result;
}

function errorText(error) {
  return error instanceof ApiError ? error.message : "Не удалось связаться с сервером. Попробуйте ещё раз.";
}

function showError(target, text = "") {
  target.textContent = text;
}

function syncLogin() {
  const valid = keyPattern.test(keyField.value);
  loginButton.disabled = loggingIn || !valid;
  loginButton.textContent = loggingIn ? "Входим…" : "Войти";
  keyField.readOnly = loggingIn;
  keyField.setAttribute("aria-invalid", String(
    !!loginError.textContent || (!!keyField.value && !valid)
  ));
}

function syncComposer() {
  const length = Array.from(messageField.value).length;
  const tooLong = length > 500;
  const counter = get("message-count");
  counter.textContent = `${length} / 500`;
  counter.classList.toggle("invalid", tooLong);
  messageField.setAttribute("aria-invalid", String(tooLong));
  sendButton.disabled = sending || tooLong || !messageField.value.trim();
  messageField.readOnly = sending;
  get("waiting").textContent = sending ? "Интервьюер готовит ответ…" : "";
  for (const button of starterButtons) {
    button.disabled = sending || (!!messageField.value.trim() && messageField.value !== selectedPrompt);
  }
  welcome.hidden = historyList.childElementCount > 0;
  logout.disabled = sending;
}

function makeEntry({ role, text, created_at: createdAt }) {
  const entry = get("message-template").content.firstElementChild.cloneNode(true);
  entry.classList.add(role);
  entry.querySelector(".sender").textContent = role === "user" ? "Вы" : "Интервьюер";
  entry.querySelector(".message-text").textContent = text;
  const time = entry.querySelector("time");
  time.dateTime = createdAt;
  time.textContent = dateFormat.format(new Date(createdAt));
  return entry;
}

function scrollToLatest() {
  scroll.scrollTop = scroll.scrollHeight;
}

function openLogin(message = "", focus = false) {
  startup.hidden = true;
  chatView.hidden = true;
  logout.hidden = true;
  get("demo-label").hidden = true;
  historyList.replaceChildren();
  loginView.hidden = false;
  showError(loginError, message);
  syncLogin();
  if (focus) keyField.focus();
}

async function openChat(focus = false) {
  const { messages, demo } = await api("messages");
  historyList.replaceChildren(...messages.map(makeEntry));
  loginView.hidden = true;
  startup.hidden = true;
  chatView.hidden = false;
  logout.hidden = false;
  get("demo-label").hidden = !demo;
  syncComposer();
  scrollToLatest();
  if (focus) messageField.focus();
}

function showStartupError(error) {
  loginView.hidden = true;
  startup.hidden = false;
  get("startup-message").textContent = errorText(error);
  get("reload").hidden = false;
}

keyField.addEventListener("input", () => {
  const invalid = keyField.value && !keyPattern.test(keyField.value);
  showError(loginError, invalid ? "Проверьте длину и символы ключа." : "");
  syncLogin();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginButton.disabled) return;
  showError(loginError);
  loggingIn = true;
  syncLogin();
  let authenticated = false;
  try {
    await api("session", { method: "POST", body: { key: keyField.value } });
    authenticated = true;
    keyField.value = "";
    await openChat(true);
  } catch (error) {
    if (authenticated) showStartupError(error);
    else showError(loginError, errorText(error));
  } finally {
    loggingIn = false;
    syncLogin();
  }
});

logout.addEventListener("click", async () => {
  logout.disabled = true;
  showError(messageError);
  try {
    await api("session", { method: "DELETE" });
    messageField.value = "";
    selectedPrompt = "";
    openLogin("", true);
  } catch (error) {
    showError(messageError, errorText(error));
  } finally {
    logout.disabled = false;
  }
});

messageField.addEventListener("input", () => {
  showError(messageError, Array.from(messageField.value).length > 500
    ? "Сократите сообщение до 500 символов." : "");
  syncComposer();
});

messageField.addEventListener("compositionstart", () => { composing = true; });
messageField.addEventListener("compositionend", () => { composing = false; });
messageField.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing) {
    event.preventDefault();
    if (!sendButton.disabled) messageForm.requestSubmit();
  }
});

starterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedPrompt = button.dataset.prompt;
    messageField.value = selectedPrompt;
    showError(messageError);
    syncComposer();
    messageField.focus();
  });
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sendButton.disabled) return;
  const text = messageField.value;
  const restoreFocus = [sendButton, messageField].includes(document.activeElement);
  const pending = makeEntry({ role: "user", text: text.trim(), created_at: new Date().toISOString() });
  showError(messageError);
  sending = true;
  historyList.append(pending);
  messageField.value = "";
  syncComposer();
  scrollToLatest();
  try {
    const turn = await api("messages", { method: "POST", body: { text } });
    pending.replaceWith(makeEntry(turn.user), makeEntry(turn.assistant));
  } catch (error) {
    pending.remove();
    messageField.value = text;
    if (error.status === 401) openLogin("Время входа истекло. Введите ключ ещё раз.", true);
    else showError(messageError, errorText(error));
  } finally {
    sending = false;
    syncComposer();
    scrollToLatest();
    if (restoreFocus && !chatView.hidden && document.activeElement === document.body) {
      messageField.focus({ preventScroll: true });
    }
  }
});

get("reload").addEventListener("click", () => window.location.reload());

openChat().catch((error) => {
  if (error.status === 401) openLogin();
  else showStartupError(error);
});
