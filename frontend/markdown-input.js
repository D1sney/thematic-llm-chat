import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/dompurify.js';

// The wire/draft format stays Markdown. DOM is a safe, editable inline view.
export function markdownFragment(value) {
  const fragment = document.createDocumentFragment();
  function append(parent, tokens) {
    for (const token of tokens) {
      const tag = { strong: 'strong', em: 'em', codespan: 'code', del: 's' }[token.type];
      if (tag) {
        const node = document.createElement(tag);
        node.dataset.md = token.type === 'strong' ? token.raw.slice(0, 2) : token.type === 'em' ? token.raw[0] : token.type === 'del' ? '~~' : token.raw.match(/^`+/)[0];
        if (token.tokens) append(node, token.tokens); else node.textContent = token.raw.slice(node.dataset.md.length, -node.dataset.md.length);
        parent.append(node);
      } else if (token.type === 'escape') {
        const span = document.createElement('span'); span.dataset.mdEscape = token.raw; span.textContent = token.text; parent.append(span);
      } else {
        // Raw HTML, images and links are never activated in a composer/chip.
        parent.append(document.createTextNode(token.type === 'escape' ? token.text : token.raw));
      }
    }
  }
  append(fragment, marked.Lexer.lexInline(value));
  return fragment;
}

function editorFragment(value) {
  const fragment = markdownFragment(value);
  if (fragment.lastChild?.nodeType === Node.ELEMENT_NODE) {
    const anchor = document.createElement('span'); anchor.dataset.mdCaret = '';
    anchor.style.fontWeight = '400'; anchor.style.fontStyle = 'normal';
    anchor.textContent = '\u200b'; fragment.append(anchor);
  }
  return fragment;
}

function serialize(root) {
  let value = '';
  const points = [], offsets = new Map();
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = value.length, map = [start];
      const escaped = node.parentNode.dataset?.mdEscape;
      const escapedAt = escaped ? node.data.indexOf(escaped.slice(1)) : -1;
      const caret = node.parentNode.dataset?.mdCaret !== undefined;
      for (let index = 0; index < node.data.length; index++) {
        const char = node.data[index];
        if (!(caret && char === '\u200b')) {
          if (index === escapedAt) value += '\\';
          value += char === '\u00a0' ? ' ' : char;
        }
        map.push(value.length);
      }
      offsets.set(node, { start, map });
      points.push({ node, start, end: value.length, map });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node !== root) return;
    const block = node !== root && /^(DIV|P)$/.test(node.nodeName);
    if (block && node.previousSibling) value += '\n';
    if (node.nodeName === 'BR') { if (!(node.parentNode.childNodes.length === 1) && !(node.nextSibling === null && node.previousSibling?.nodeName === 'BR')) value += '\n'; return; }
    const marker = node.dataset?.md || ({ STRONG: '**', B: '**', EM: '*', I: '*', CODE: '`', S: '~~', DEL: '~~' }[node.nodeName] || '');
    const before = value.length;
    value += marker;
    const boundaries = [value.length];
    for (const child of node.childNodes) { visit(child); boundaries.push(value.length); }
    offsets.set(node, { boundaries });
    value += marker;
    if (node !== root) {
      const index = [...node.parentNode.childNodes].indexOf(node);
      points.push({ node: node.parentNode, offset: index, start: before, end: before });
      points.push({ node: node.parentNode, offset: index + 1, start: value.length, end: value.length });
    }
  }
  visit(root);
  return { value, points, offsets };
}

export function createMarkdownInput(input) {
  const editor = document.createElement('div'); editor.id = 'message-editor'; editor.className = 'composer-editor';
  editor.contentEditable = 'true'; editor.role = 'textbox'; editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', 'Сообщение'); editor.setAttribute('aria-describedby', input.getAttribute('aria-describedby') || 'input-status'); editor.spellcheck = true; editor.setAttribute('aria-placeholder', input.placeholder);
  input.after(editor); input.hidden = true; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const nativeRange = input.setSelectionRange.bind(input);
  let composing = false, undo = [], redo = [], before = null, lastValue = '', lastSelection = [0, 0], highlight = null;
  let rendering = false;

  function snapshot() { return { value: descriptor.get.call(input), selection: selection() }; }
  function selection() {
    const sel = getSelection();
    if (!sel?.rangeCount || !editor.contains(sel.anchorNode) || !editor.contains(sel.focusNode)) return lastSelection;
    const doc = serialize(editor);
    const at = (node, offset) => {
      const record = doc.offsets.get(node);
      return node.nodeType === Node.TEXT_NODE ? record?.map?.[offset] ?? (record?.start || 0) + offset : record?.boundaries?.[offset] ?? doc.value.length;
    };
    const a = at(sel.anchorNode, sel.anchorOffset), b = at(sel.focusNode, sel.focusOffset);
    return lastSelection = [Math.min(a, b), Math.max(a, b)];
  }
  function pointAt(offset) {
    const doc = serialize(editor);
    const exact = doc.points.find(point => point.node.nodeType === Node.TEXT_NODE && offset >= point.start && offset <= point.end);
    if (exact) { const index = exact.map.lastIndexOf(offset); return [exact.node, index >= 0 ? index : Math.max(0, exact.map.findIndex(value => value > offset) - 1)]; }
    const nearest = doc.points.reduce((best, point) => !best || Math.abs(point.start - offset) < Math.abs(best.start - offset) ? point : best, null);
    return nearest ? [nearest.node, nearest.offset ?? 0] : [editor, 0];
  }
  function domRange(start, end) {
    const range = document.createRange();
    const a = pointAt(start), b = pointAt(end);
    range.setStart(...a); range.setEnd(...b); return range;
  }
  function setSelection(start, end = start) {
    const length = descriptor.get.call(input).length;
    start = Math.max(0, Math.min(length, start)); end = Math.max(start, Math.min(length, end));
    nativeRange(start, end); lastSelection = [start, end];
    const sel = getSelection(); const range = domRange(start, end);
    sel.removeAllRanges(); sel.addRange(range);
  }
  function paintHighlight() {
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      CSS.highlights.delete('answer-insertion');
      if (highlight) CSS.highlights.set('answer-insertion', new Highlight(domRange(highlight.start, highlight.end)));
    }
  }
  function layout() {
    editor.dataset.empty = String(!descriptor.get.call(input));
    editor.parentElement.dataset.empty = editor.dataset.empty;
    editor.style.height = 'auto'; editor.style.height = `${Math.min(editor.scrollHeight, 180)}px`;
    editor.style.overflowY = editor.scrollHeight > 180 ? 'auto' : 'hidden';
  }
  function render(value, selected = null) {
    rendering = true;
    const scroll = editor.scrollTop;
    editor.replaceChildren(editorFragment(value));
    descriptor.set.call(input, serialize(editor).value);
    lastValue = descriptor.get.call(input);
    if (!selected) { lastSelection = [lastValue.length, lastValue.length]; nativeRange(...lastSelection); }
    layout();
    if (selected) setSelection(...selected);
    editor.scrollTop = scroll; paintHighlight(); rendering = false;
  }
  function publish() {
    lastValue = descriptor.get.call(input); layout(); paintHighlight();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function remember(state) { if (undo.at(-1)?.value !== state.value) undo.push(state); if (undo.length > 100) undo.shift(); redo = []; }
  function restore(state) { render(state.value, state.selection); publish(); editor.focus({ preventScroll: true }); }
  function history(direction) {
    const from = direction < 0 ? undo : redo, to = direction < 0 ? redo : undo;
    const state = from.pop(); if (!state) return;
    to.push(snapshot()); restore(state);
  }
  function commitDOM() {
    const selected = selection(), value = serialize(editor).value;
    if (Array.from(value).length > input.maxLength && value.length >= lastValue.length) {
      render(lastValue, before?.selection || lastSelection);
      input.dispatchEvent(new Event('draft-limit')); return;
    }
    if (value !== lastValue) remember(before || { value: lastValue, selection: lastSelection });
    descriptor.set.call(input, value);
    // Conversion only after complete inline Markdown; ordinary keystrokes keep DOM.
    const parsed = editorFragment(value), probe = document.createElement('div'); probe.append(parsed);
    if (serialize(probe).value === value && editor.innerHTML !== probe.innerHTML) render(value, selected);
    publish(); before = null;
  }
  function replace(text, start, end, record = true) {
    if (input.disabled || input.readOnly) return;
    const state = snapshot(), next = state.value.slice(0, start) + text + state.value.slice(end);
    if (Array.from(next).length > input.maxLength) { input.dispatchEvent(new Event('draft-limit')); return; }
    if (record) remember(state);
    render(next, [start + text.length, start + text.length]);
  }
  Object.defineProperty(input, 'value', { configurable: true, get: () => descriptor.get.call(input), set(value) { undo = []; redo = []; render(String(value ?? '')); } });
  input.focus = options => editor.focus(options);
  input.setSelectionRange = setSelection;
  input.setRangeText = (text, start = input.selectionStart, end = input.selectionEnd) => replace(text, start, end);
  input.setRichHighlight = range => { highlight = range; paintHighlight(); };
  input.resizeRichInput = layout;
  function disabled() {
    const editable = String(!input.disabled && !input.readOnly);
    // Reassigning contentEditable even to the same value resets the native
    // editing surface in Chromium. Mode persistence must not blink the draft.
    if (editor.contentEditable !== editable) editor.contentEditable = editable;
    if (editor.getAttribute('aria-disabled') !== String(input.disabled)) editor.setAttribute('aria-disabled', String(input.disabled));
    if (editor.getAttribute('aria-readonly') !== String(input.readOnly)) editor.setAttribute('aria-readonly', String(input.readOnly));
    const tabIndex = input.disabled ? -1 : 0; if (editor.tabIndex !== tabIndex) editor.tabIndex = tabIndex;
  }
  new MutationObserver(() => { disabled(); editor.setAttribute('aria-placeholder', input.placeholder); }).observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly', 'placeholder'] }); disabled();
  document.addEventListener('selectionchange', () => { if (!rendering && editor.contains(getSelection()?.anchorNode)) { const [start, end] = selection(); nativeRange(start, end); } });
  editor.addEventListener('beforeinput', event => {
    if (input.disabled || input.readOnly) { event.preventDefault(); return; }
    before = snapshot();
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); history(event.inputType === 'historyUndo' ? -1 : 1); }
  });
  editor.addEventListener('input', () => { if (!composing && !input.disabled && !input.readOnly) commitDOM(); });
  for (const type of ['compositionstart', 'compositionend']) editor.addEventListener(type, event => {
    composing = type === 'compositionstart';
    input.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: event.data }));
    if (!composing) commitDOM();
  });
  editor.addEventListener('keydown', event => {
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); if (input.readOnly || input.disabled) return; history(event.shiftKey ? 1 : -1); return; }
    const forwarded = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: event.key, code: event.code, keyCode: event.keyCode, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, isComposing: event.isComposing });
    if (!input.dispatchEvent(forwarded)) event.preventDefault();
  });
  editor.addEventListener('paste', event => {
    event.preventDefault(); if (input.disabled || input.readOnly) return; const clipboard = event.clipboardData; if (!clipboard) return;
    const [start, end] = selection(); let text = clipboard.getData('text/plain');
    const html = clipboard.getData('text/html');
    if (html) {
      const fragment = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['strong', 'b', 'em', 'i', 's', 'del', 'code', 'br', 'p', 'div', 'span'], ALLOWED_ATTR: [], RETURN_DOM_FRAGMENT: true });
      const root = document.createElement('div'); root.append(fragment); const rich = serialize(root).value;
      if (rich) text = rich;
    }
    replace(text.replace(/\r\n?/g, '\n').replace(/\u200b/g, ''), start, end); publish();
  });
  render(descriptor.get.call(input));
  return { editor };
}
