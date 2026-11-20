import { createMessageActionHint, node, uiIcon } from './message-actions.js';

const labels = {good: 'Хороший ответ', bad: 'Плохой ответ'};
const icons = {good: 'thumb-up', bad: 'thumb-down'};

export function createMessageFeedback(rating, {save, onError, announce}) {
  let selected = rating;
  let saving = false;
  const wrapper = node('div', 'feedback-control');
  const trigger = node('button', 'icon-button feedback-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const hint = createMessageActionHint(trigger, () => labels[selected] ?? 'Оценить ответ');
  const panel = node('div', 'feedback-menu');
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', 'Оценка ответа');

  const button = (value, label, icon) => {
    const option = node('button', 'feedback-option');
    option.type = 'button';
    option.setAttribute('role', value ? 'menuitemradio' : 'menuitem');
    if (value) option.setAttribute('aria-checked', String(value === selected));
    option.append(uiIcon(icon), node('span', '', label));
    option.addEventListener('click', async event => {
      if (saving) return;
      const keyboard = event.detail === 0;
      panel.hidePopover();
      if (keyboard) trigger.focus({preventScroll: true});
      else if (document.activeElement === trigger) trigger.blur();
      if (value === selected) return;
      saving = true;
      trigger.setAttribute('aria-busy', 'true');
      try {
        await save(value);
        selected = value;
        update();
        announce(value ? 'Оценка сохранена' : 'Оценка удалена');
      } catch (error) {
        onError(error);
      } finally {
        saving = false;
        trigger.removeAttribute('aria-busy');
      }
    });
    return option;
  };

  function update() {
    trigger.replaceChildren(uiIcon(icons[selected] ?? 'feedback'), hint);
    trigger.classList.toggle('has-feedback', Boolean(selected));
    trigger.setAttribute('aria-label', selected ? 'Изменить оценку ответа' : 'Оценить ответ');
    const options = Object.keys(labels).map(value => button(value, labels[value], icons[value]));
    if (selected) options.push(button(null, 'Убрать оценку', 'close'));
    panel.replaceChildren(...options);
  }

  trigger.addEventListener('click', event => {
    if (saving) return;
    if (panel.matches(':popover-open')) {
      panel.hidePopover();
      return;
    }
    panel.showPopover();
    const rect = trigger.getBoundingClientRect();
    const left = Math.min(rect.left, innerWidth - panel.offsetWidth - 8);
    const top = rect.top - panel.offsetHeight - 6;
    panel.style.left = `${Math.max(8, left)}px`;
    const preferred = top >= 8 ? top : rect.bottom + 6;
    panel.style.top = `${Math.max(8, Math.min(preferred, innerHeight - panel.offsetHeight - 8))}px`;
    if (event.detail === 0) panel.firstElementChild.focus({preventScroll: true});
  });
  panel.addEventListener('toggle', () => {
    trigger.setAttribute('aria-expanded', String(panel.matches(':popover-open')));
  });
  panel.addEventListener('keydown', event => {
    const items = [...panel.children];
    const current = items.indexOf(document.activeElement);
    const target = {
      ArrowUp: (current + items.length - 1) % items.length,
      ArrowDown: (current + 1) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    items[target].focus({preventScroll: true});
  });

  wrapper.append(trigger, panel);
  update();
  return wrapper;
}
