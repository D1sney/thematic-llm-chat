// Shared detail chrome: compact catalogues can reuse the same disclosure pattern.
export const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};
export function uiIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
const ACTION_HINT_DELAY = 500, ACTION_HINT_SKIP_DELAY = 300;
let actionHintId = 0, actionHintTimer = null, activeActionHint = null;
let actionHintWarmUntil = 0, activeActionHintFromPointer = false;
function hideMessageActionHint() {
  clearTimeout(actionHintTimer); actionHintTimer = null;
  if (activeActionHint?.matches(':popover-open')) {
    if (activeActionHintFromPointer) actionHintWarmUntil = performance.now() + ACTION_HINT_SKIP_DELAY;
    activeActionHint.hidePopover();
  }
  activeActionHint = null; activeActionHintFromPointer = false;
}
function resetMessageActionHints() {
  hideMessageActionHint(); actionHintWarmUntil = 0;
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') resetMessageActionHints(); });
document.addEventListener('pointerdown', resetMessageActionHints, true);
document.addEventListener('scroll', resetMessageActionHints, true);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetMessageActionHints(); });
window.addEventListener('resize', resetMessageActionHints);
window.addEventListener('blur', resetMessageActionHints);
export function createMessageActionHint(button, label, {
  placement = 'bottom', canShow = () => true, allowDisabled = false, messageAction = true,
} = {}) {
  const hint = node('span', 'message-action-hint', typeof label === 'function' ? label() : label);
  hint.id = `message-action-hint-${++actionHintId}`; hint.setAttribute('role', 'tooltip'); hint.setAttribute('popover', 'manual');
  if (messageAction) button.classList.add('message-action');
  button.removeAttribute('title');
  button.setAttribute('aria-describedby', [...new Set([...(button.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean), hint.id])].join(' '));
  function show(delay = 0, fromPointer = false) {
    hideMessageActionHint();
    const reveal = () => {
      if (!button.isConnected || !button.getClientRects().length || getComputedStyle(button).visibility !== 'visible'
        || (!allowDisabled && button.disabled) || !canShow(button)
        || (button.getAttribute('aria-expanded') === 'true' && (messageAction || button.hasAttribute('aria-haspopup')))) return;
      hint.textContent = typeof label === 'function' ? label() : label;
      if (!hint.textContent) return;
      hint.showPopover(); activeActionHint = hint; activeActionHintFromPointer = fromPointer;
      const rect = button.getBoundingClientRect(), half = hint.offsetWidth / 2;
      const requested = typeof placement === 'function' ? placement(button) : placement;
      let x = rect.left + rect.width / 2, y;
      if (requested === 'right') {
        x = rect.right + 8 + half;
        if (x + half > innerWidth - 8) x = rect.left - 8 - half;
        y = rect.top + (rect.height - hint.offsetHeight) / 2;
      } else {
        const above = rect.top - hint.offsetHeight - 6, below = rect.bottom + 6;
        y = requested === 'top' && above >= 8 || below + hint.offsetHeight > innerHeight - 8 ? above : below;
      }
      hint.style.left = `${Math.max(8 + half, Math.min(x, innerWidth - 8 - half))}px`;
      hint.style.top = `${Math.max(8, Math.min(y, innerHeight - hint.offsetHeight - 8))}px`;

    };
    if (delay) actionHintTimer = setTimeout(reveal, delay); else reveal();
  }
  button.addEventListener('pointerenter', () => {
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      const warm = activeActionHintFromPointer || performance.now() < actionHintWarmUntil;
      show(warm ? 0 : ACTION_HINT_DELAY, true);
    }
  });
  button.addEventListener('focusin', () => { if (button.matches(':focus-visible') || button.querySelector(':focus-visible')) show(); });
  button.addEventListener('pointerleave', hideMessageActionHint);
  for (const event of ['focusout', 'click']) button.addEventListener(event, resetMessageActionHints);
  return hint;
}
