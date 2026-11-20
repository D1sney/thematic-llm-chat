(() => {
  const key = 'interview-ai:theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let reveal = null, wave = null, revision = 0;
  function stopReveal() {
    revision++;
    reveal?.skipTransition(); reveal = null;
    wave?.cancel(); wave = null;
    document.documentElement.classList.remove('theme-reveal');
  }
  const normalize = value => value === 'light' || value === 'dark' ? value : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem(key)); } catch { /* Keep the device preference. */ }

  const getTheme = () => preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
  let updateToggle;
  function apply(animateIcon = false) {
    document.documentElement.dataset.theme = getTheme();
    const background = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    document.querySelector('meta[name="theme-color"]').content = background || (getTheme() === 'dark' ? '#161616' : '#faf8f5');
    updateToggle?.(animateIcon);
  }
  function setThemePreference(value, { origin } = {}) {
    stopReveal();
    const previous = document.documentElement.dataset.theme;
    preference = normalize(value);
    try { localStorage.setItem(key, preference); } catch { /* The choice still works for this page. */ }
    // Loading, keyboard, device/storage sync and reduced motion remain instant.
    if (!origin || previous === getTheme() || reducedMotion.matches || document.hidden
        || typeof document.startViewTransition !== 'function') { apply(); return; }
    const bounds = origin.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth, bounds.left + bounds.width / 2));
    const y = Math.max(0, Math.min(innerHeight, bounds.top + bounds.height / 2));
    const radius = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
    const root = document.documentElement, current = revision;
    root.classList.add('theme-reveal');
    try {
      const transition = document.startViewTransition(() => { if (current === revision) apply(true); });
      reveal = transition;
      transition.ready.then(() => {
        if (current !== revision) return;
        const styles = getComputedStyle(root);
        wave = root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, {
          duration: parseFloat(styles.getPropertyValue('--theme-reveal-duration')) || 400,
          easing: styles.getPropertyValue('--ease-out').trim(),
          pseudoElement: '::view-transition-new(root)',
        });
      }).catch(() => { if (current === revision && root.dataset.theme !== getTheme()) apply(); });
      transition.finished.catch(() => {}).finally(() => {
        if (current !== revision) return;
        reveal = null; wave = null; root.classList.remove('theme-reveal');
      });
    } catch { stopReveal(); apply(); }
  }
  system.addEventListener('change', () => { if (preference === 'system') { stopReveal(); apply(); } });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { stopReveal(); preference = normalize(event.newValue); apply(); }
  });
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) { stopReveal(); apply(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopReveal(); apply(); } });
  apply();

  document.addEventListener('DOMContentLoaded', async () => {
    const [{createIconSwap}, {uiIcon}] = await Promise.all([
      import('./motion.js'), import('./message-actions.js'),
    ]);
    const button = document.getElementById('theme-toggle');
    const swap = createIconSwap(uiIcon('moon'), uiIcon('sun'), getTheme() === 'dark' ? 'b' : 'a');
    button.replaceChildren(swap);
    updateToggle = (animateIcon = false) => {
      const dark = getTheme() === 'dark';
      const action = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
      swap.toggleAttribute('data-instant', !animateIcon || reducedMotion.matches);
      swap.dataset.state = dark ? 'b' : 'a';
      button.setAttribute('aria-label', action);
      button.title = action;
    };
    button.addEventListener('click', event => {
      setThemePreference(getTheme() === 'dark' ? 'light' : 'dark', {origin: event.detail > 0 ? button : null});
    });
    button.disabled = false;
    apply();
  });
})();
