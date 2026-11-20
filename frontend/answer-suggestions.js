import { uiIcon } from './message-actions.js';
import { markdownFragment } from './markdown-input.js';

// Plain-text drafts stay authoritative. Only the owned insertion is replaced.
export function createAnswerSuggestions({ host, input, onChange, announce, read, write }) {
  const viewport = document.createElement('div'); viewport.className = 'answer-suggestions-viewport';
  viewport.id = `${host.id}-viewport`;
  const rail = document.createElement('div'); rail.className = 'answer-suggestions-rail';
  viewport.append(rail);
  const navigation = [-1, 1].map(direction => {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `answer-suggestions-nav answer-suggestions-${direction < 0 ? 'previous' : 'next'}`;
    button.setAttribute('aria-label', direction < 0 ? 'Предыдущие варианты ответа' : 'Следующие варианты ответа');
    button.setAttribute('aria-controls', viewport.id); button.append(uiIcon(direction < 0 ? 'arrow-left' : 'arrow-right'));
    button.addEventListener('click', event => {
      if (blocked || button.getAttribute('aria-disabled') === 'true') return;
      const max = viewport.scrollWidth - viewport.clientWidth;
      const left = Math.max(0, Math.min(max, viewport.scrollLeft + direction * viewport.clientWidth * .8));
      navigating = event.detail !== 0 && !reduced.matches;
      viewport.scrollTo({ left, behavior: navigating ? 'smooth' : 'instant' });
    });
    // Mouse navigation keeps the draft caret; keyboard navigation retains native focus.
    button.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse') event.preventDefault(); });
    button.addEventListener('focusout', () => queueMicrotask(edges));
    return button;
  });
  host.append(viewport, ...navigation);
  const mirror = document.createElement('div'); mirror.className = 'answer-draft-mirror';
  mirror.setAttribute('aria-hidden', 'true'); mirror.hidden = true;
  const ink = document.createElement('div'); mirror.append(ink); input.before(mirror);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  let key = null, storage = null, range = null, previous = input.value, options = [];
  let composing = false, blocked = true, suspended = false, navigating = false;

  function persist() { if (storage) write(storage, range ? JSON.stringify({ message: key, ...range }) : null); }
  function valid() { return range && input.value.slice(range.start, range.end) === range.text; }
  function syncRange() {
    const value = input.value;
    if (range && previous !== value) {
      let start = 0, end = previous.length, nextEnd = value.length;
      while (start < end && start < nextEnd && previous[start] === value[start]) start++;
      while (end > start && nextEnd > start && previous[end - 1] === value[nextEnd - 1]) { end--; nextEnd--; }
      if (end <= range.start) { const delta = nextEnd - end; range.start += delta; range.end += delta; }
      else if (start < range.end) range = null;
    }
    previous = value;
    if (range && !valid()) range = null;
    persist(); paint();
  }
  function paint() {
    const show = Boolean(valid() && !composing);
    input.setRichHighlight?.(show ? range : null);
    mirror.hidden = Boolean(input.setRichHighlight) || !show; input.classList.toggle('has-answer-insertion', show);
    for (const button of rail.children) button.setAttribute('aria-pressed', String(show && button.dataset.suggestion === range.text));
    if (!show) return;
    const mark = document.createElement('mark'); mark.textContent = range.text;
    ink.replaceChildren(document.createTextNode(input.value.slice(0, range.start)), mark, document.createTextNode(input.value.slice(range.end) + '\u200b'));
    mirror.style.width = `${input.clientWidth}px`;
    ink.style.transform = `translateY(-${input.scrollTop}px)`;
  }
  function edges() {
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const boundaries = [viewport.scrollLeft < 1, viewport.scrollLeft >= max - 1];
    host.dataset.start = String(boundaries[0]); host.dataset.end = String(boundaries[1]);
    navigation.forEach((button, index) => {
      button.setAttribute('aria-disabled', String(boundaries[index]));
      // Keep an exhausted keyboard control until focus leaves, rather than dropping focus.
      button.hidden = max < 1 || (boundaries[index] && document.activeElement !== button);
      button.disabled = blocked;
    });
  }
  function cancelScroll() {
    if (!navigating) return;
    navigating = false;
    viewport.scrollTo({ left: viewport.scrollLeft, behavior: 'instant' });
  }
  function choose(text, event) {
    if (blocked || composing) return;
    cancelScroll(); syncRange();
    if (valid() && range.text === text) return;
    const value = input.value;
    let start = valid() ? range.start : value.length, end = valid() ? range.end : value.length;
    const gap = start === value.length && value && !/\s$/.test(value) ? ' ' : '';
    const next = value.slice(0, start) + gap + text + value.slice(end);
    if (Array.from(next).length > input.maxLength) { announce('В сообщении больше 500 символов. Сократите текст перед добавлением варианта.'); return; }
    input.setRangeText(gap + text, start, end); start += gap.length;
    range = { start, end: start + text.length, text }; previous = next;
    input.setSelectionRange(range.end, range.end); persist(); onChange(); paint();
    // Touch can pick another option without repeatedly opening the keyboard.
    if (event.detail === 0 || fine.matches) input.focus({ preventScroll: true });
    announce('Вариант в черновике. Можно дополнить и отправить.');
  }
  for (const event of ['pointerdown', 'wheel', 'keydown']) viewport.addEventListener(event, cancelScroll, { passive: true });
  viewport.addEventListener('scroll', edges, { passive: true });
  viewport.addEventListener('scrollend', () => { navigating = false; });
  input.addEventListener('input', () => { if (!suspended) syncRange(); });
  input.addEventListener('scroll', paint, { passive: true });
  input.addEventListener('compositionstart', () => { composing = true; paint(); });
  input.addEventListener('compositionend', () => { composing = false; syncRange(); });
  reduced.addEventListener('change', cancelScroll);
  new ResizeObserver(() => { edges(); paint(); }).observe(host);
  new ResizeObserver(edges).observe(rail);
  new ResizeObserver(paint).observe(input);
  return {
    update({ chatId, message, disabled, hidden, pending }) {
      const nextKey = message ? `${chatId}:${message.id}` : null;
      suspended = pending; blocked = disabled;
      if (key !== nextKey) {
        cancelScroll(); key = nextKey; storage = chatId ? `interview-ai:answer-insertion:${chatId}` : null;
        options = Array.isArray(message?.answer_suggestions) ? message.answer_suggestions.filter(x => typeof x === 'string' && x.trim()).slice(0, 5) : [];
        range = null; previous = input.value; rail.replaceChildren(); viewport.scrollLeft = 0;
        if (storage) {
          try {
            const saved = JSON.parse(read(storage));
            if (saved?.message === key && Number.isInteger(saved.start) && saved.start >= 0 && Number.isInteger(saved.end) && saved.end <= input.value.length && saved.end > saved.start && options.includes(saved.text)) range = saved;
          } catch { /* An unavailable or old draft remains plain text. */ }
        }
        for (const text of options) {
          const button = document.createElement('button'); button.type = 'button'; button.dataset.suggestion = text; button.append(markdownFragment(text));
          button.addEventListener('click', event => choose(text, event));
          button.addEventListener('focus', () => { cancelScroll(); button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); });
          rail.append(button);
        }
      }
      host.hidden = hidden || !options.length;
      for (const button of rail.children) button.disabled = disabled;
      if (host.hidden || disabled) cancelScroll();
      if (!pending) syncRange(); else paint();
      edges();
    },
  };
}
