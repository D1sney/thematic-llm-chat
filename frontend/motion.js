// Keep both SVGs mounted: state changes reverse the existing CSS transition.
export function createIconSwap(first, second, initial = 'a') {
  const slot = document.createElement('span'); slot.className = 't-icon-swap';
  slot.setAttribute('aria-hidden', 'true'); slot.dataset.state = initial;
  for (const [glyph, state] of [[first, 'a'], [second, 'b']]) {
    glyph.classList.add('t-icon'); glyph.dataset.icon = state; slot.append(glyph);
  }
  return slot;
}
