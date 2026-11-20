// An inline editor leaves the surrounding conversation in place until Send.
export function createMessageEditor({ content, original, onChange, onCancel, onSend }) {
  const form = document.createElement('form');
  form.className = 'message-edit';
  const input = document.createElement('textarea');
  input.className = 'message-edit-input';
  input.setAttribute('aria-label', 'Изменить сообщение');
  input.rows = 2; input.value = content;
  const footer = document.createElement('div'); footer.className = 'message-edit-footer';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'message-edit-cancel'; cancel.textContent = 'Отмена';
  const send = document.createElement('button');
  send.type = 'submit'; send.className = 'message-edit-send'; send.textContent = 'Отправить';
  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 320)}px`;
    input.style.overflowY = input.scrollHeight > 320 ? 'auto' : 'hidden';
    send.disabled = !input.value.trim() || input.value.trim() === original.trim() || Array.from(input.value).length > 500;
  };
  input.addEventListener('input', () => { resize(); onChange(input.value); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !send.disabled) {
      event.preventDefault(); form.requestSubmit();
    }
  });
  cancel.addEventListener('click', onCancel);
  form.addEventListener('submit', event => { event.preventDefault(); if (!send.disabled) onSend(input.value); });
  footer.append(cancel, send); form.append(input, footer);
  requestAnimationFrame(() => { if (form.isConnected) { resize(); input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); } });
  return form;
}
