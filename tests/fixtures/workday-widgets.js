// Workday's own widgets as its application pages run them, read from its candidate-experience bundles
// (candidate-experience-apply-flow.min.js), for the Workday fixture pages:
// - Select ("Select One", Canvas Kit's): its button opens a menu that fades in for 200 ms ("opening", then "opened")
//   and out for 200 ms ("closing"), with aria-expanded="true" until it has gone. A click on the button while the menu
//   is closing opens it again; Escape, or a mousedown anywhere outside the menu (the button included), closes it. A
//   row takes a click, or Enter or Space on the highlighted row; the button then shows the choice, and its value is
//   the choice's ID, never its text. Letters typed on the closed button pick the first choice they start.
// - Search prompts ("selectinput"): a search box, a chip for each pick, and a list of results whose rows only take a
//   click that lands inside them: menuItem (role="option", aria-selected while highlighted, not when picked) >
//   promptLeafNode (the click handler; data-automation-checked) > the radio or checkbox and the label (promptOption).
//   A multi-select prompt (Skills) keeps its list open and ticks the row; a click on a ticked row unticks it.
// - Year spin buttons ("YYYY"): a 1px input scaled to nothing, behind the aria-hidden "…-display" that shows the year.
//   It takes what is typed from its input events (React's onChange), digits only, between 1 and 9999.
window.WD = (function () {
  'use strict';

  const FADE = 200;
  const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hex = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

  const css = document.createElement('style');
  css.textContent = `
    .wd-menu { position: absolute; z-index: 20; background: #fff; border: 1px solid #888; transition: opacity ${FADE}ms; }
    .wd-menu ul { list-style: none; margin: 0; padding: 0; max-height: 200px; overflow-y: auto; outline: none; }
    .wd-menu li { padding: 6px; cursor: default; }
    .wd-menu li[aria-disabled="true"] { color: #999; }
    .wd-menu li.focused { background: #0875e1; color: #fff; }
    [data-automation-id="activeListContainer"] { position: absolute; z-index: 20; background: #fff; border: 1px solid #888; min-width: 260px; outline: none; }
    [data-automation-id="menuItem"] { display: flex; }
    [data-automation-id="menuItem"][aria-selected="true"] { background: #0875e1; color: #fff; }
    [data-automation-id="promptLeafNode"] { display: flex; width: 100%; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; }
    [data-automation-id="selectedItemList"] { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
    [data-automation-id="selectedItem"] { display: inline-flex; gap: 4px; background: #eef; }
    .wd-year { display: inline-block; position: relative; width: 34px; height: 24px; cursor: pointer; border: 1px solid #888; }
    .wd-year [data-automation-id$="-display"] { position: absolute; z-index: 1; width: 100%; height: 24px; display: flex; align-items: center; justify-content: center; }
    .wd-year input { position: absolute; color: rgba(255, 255, 255, 0.01); left: 0; overflow: hidden; top: 0; transform: scale(0.01); width: 1px; z-index: -1000; }
  `;
  document.head.appendChild(css);

  // What is open over the page: each closes on Escape and on a mousedown outside what it counts as its own.
  const popups = new Set();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') for (const p of [...popups]) p.hide();
  });
  document.addEventListener('mousedown', (e) => {
    for (const p of [...popups]) if (!p.owns(e.target)) p.hide();
  });

  /** Put a popup under what opened it, in a layer of its own at the end of <body> (as Canvas Kit's Popper does). */
  function place(popup, anchor) {
    const r = anchor.getBoundingClientRect();
    popup.style.left = r.left + scrollX + 'px';
    popup.style.top = r.bottom + scrollY + 'px';
    document.body.appendChild(popup);
  }

  /* ------------------------------------------------------------------ Select */

  /**
   * Canvas Kit's Select on a <button aria-haspopup="listbox" data-options="A|B|C">: "Select One" first (no choice when
   * the field is required), then the options. `onPick(label)` hears each choice.
   */
  function select(btn, onPick) {
    const field = btn.closest('[data-automation-id^="formField"]');
    const options = [
      { label: 'Select One', value: '', id: 'select-one', disabled: !!(field && field.querySelector('abbr')) },
    ].concat(btn.dataset.options.split('|').map((label) => ({ label, value: hex(), id: hex() })));
    let selected = Math.max(
      0,
      options.findIndex((o) => o.label === btn.textContent.trim()),
    );
    let focused = selected;
    let vis = 'closed';
    let timer = null;
    let keys = '';
    let keysTimer = null;
    const menuId = hex();
    // The value lives in a hidden input, changed by the picked option and heard by the form (Workday's "dte").
    const store = document.createElement('input');
    store.type = 'text';
    store.style.display = 'none';
    btn.after(store);
    store.addEventListener('change', () => {
      selected = Math.max(
        0,
        options.findIndex((o) => o.value === store.value),
      );
      focused = selected;
      render();
      if (onPick) onPick(options[selected].label);
    });
    const popup = { owns: (t) => !!menu && menu.contains(t), hide: () => toggle(false) };
    let menu = null;

    function render() {
      btn.textContent = options[selected].label;
      btn.value = options[selected].value;
      if (vis === 'closed') {
        btn.removeAttribute('aria-expanded');
        btn.removeAttribute('aria-controls');
        if (menu) menu.remove();
        menu = null;
        popups.delete(popup);
        return;
      }
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', menuId);
      if (!menu) {
        menu = document.createElement('div');
        menu.className = 'wd-menu';
        menu.style.opacity = '0';
        menu.innerHTML = `<ul role="listbox" tabindex="-1" id="${menuId}"></ul>`;
        const list = menu.firstChild;
        list.addEventListener('keydown', onKeyDown);
        for (const [i, o] of options.entries()) {
          const li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.id = o.id;
          li.dataset.value = o.value;
          if (o.disabled) li.setAttribute('aria-disabled', 'true');
          li.innerHTML = '<div></div>';
          li.firstChild.textContent = o.label;
          li.addEventListener('click', (e) => {
            e.preventDefault();
            pick(i);
          });
          list.appendChild(li);
        }
        place(menu, btn);
        popups.add(popup);
        // The menu takes the focus once it is placed (shouldMenuAutoFocus).
        requestAnimationFrame(() => menu && menu.firstChild.focus());
      }
      menu.style.opacity = vis === 'opening' || vis === 'opened' || vis === 'close' ? '1' : '0';
      const list = menu.firstChild;
      list.setAttribute('aria-activedescendant', options[focused].id);
      for (const [i, li] of Array.from(list.children).entries()) {
        li.classList.toggle('focused', i === focused);
        if (i === selected) li.setAttribute('aria-selected', 'true');
        else li.removeAttribute('aria-selected');
      }
    }
    const set = (v) => {
      vis = v;
      render();
    };
    const after = (fn) => {
      clearTimeout(timer);
      timer = setTimeout(fn, FADE);
    };
    const openMenu = () => {
      // For the tests: how many times the menu was opened (or opened again while it closed).
      btn.dataset.opened = String(+(btn.dataset.opened || 0) + 1);
      set('opening');
      after(() => set('opened'));
    };
    const closeMenu = () => {
      set('closing');
      after(() => {
        focused = selected;
        set('closed');
      });
    };
    function toggle(open) {
      if (open) {
        if (vis === 'closed') {
          set('open');
          openMenu();
        } else if (vis === 'close' || vis === 'closing') openMenu();
      } else if (vis === 'opened') {
        set('close');
        closeMenu();
      } else if (vis === 'open' || vis === 'opening') closeMenu();
    }
    function pick(i) {
      if (options[i].disabled) return;
      toggle(false);
      btn.focus();
      // fireChangeEvent: the option's value, set as React would see it, then "change".
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(store, options[i].value);
      store.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function typeAhead(ch) {
      if (vis === 'closing') return;
      let from = keys.length === 0 ? focused + 1 : focused;
      from = from === options.length ? 0 : from;
      keys += ch;
      clearTimeout(keysTimer);
      keysTimer = setTimeout(() => (keys = ''), 500);
      const starts = (a, b) => {
        for (let i = a; i < b; i++)
          if (options[i].label.toLowerCase().startsWith(keys.toLowerCase()) && !options[i].disabled) return i;
        return -1;
      };
      let at = starts(from, options.length);
      if (at < 0) at = starts(0, from);
      if (at < 0) return;
      if (vis === 'closed') pick(at);
      else {
        focused = at;
        render();
      }
    }
    const move = (at, step) => {
      while (at >= 0 && at < options.length && options[at].disabled) at += step;
      if (at >= 0 && at < options.length) {
        focused = at;
        render();
      }
    };
    function onKeyDown(e) {
      let handled = true;
      if (e.key.length === 1 && /\S/.test(e.key)) typeAhead(e.key);
      else if (/^(Arrow)?(Up|Down)$/.test(e.key)) {
        if (vis === 'closed' || vis === 'closing') toggle(true);
        else move(focused + (/Up/.test(e.key) ? -1 : 1), /Up/.test(e.key) ? -1 : 1);
      } else if (e.key === 'Home' || e.key === 'End')
        move(e.key === 'Home' ? 0 : options.length - 1, e.key === 'Home' ? 1 : -1);
      else if (e.key === 'Tab') {
        if (vis !== 'closed') {
          toggle(false);
          btn.focus();
        } else handled = false;
      } else if (e.key === ' ' || e.key === 'Spacebar') {
        if (keys) typeAhead(' ');
        else if (vis === 'closed' || vis === 'closing') toggle(true);
        else pick(focused);
      } else if (e.key === 'Enter') {
        if (vis === 'closed' || vis === 'closing') handled = false;
        else pick(focused);
      } else handled = false;
      if (handled) {
        e.stopPropagation();
        e.preventDefault();
      }
    }
    btn.addEventListener('click', () => {
      if (vis === 'close' || vis === 'closing') {
        if (menu) menu.firstChild.focus();
        toggle(true);
      } else if (vis === 'closed') toggle(true);
      else toggle(false);
    });
    btn.addEventListener('keydown', onKeyDown);
    btn.addEventListener('keyup', (e) => e.preventDefault());
    render();
  }

  /* ----------------------------------------------------------- search prompts */

  /**
   * A search prompt in `field` (its <label for> names the box's id): `options` to search, found on Enter
   * (`search: 'enter'`) or as `min` letters are typed (`'type'`); `chips` already picked; `multi` for a list that
   * takes several (Skills).
   */
  function prompt(field, { options, search = 'enter', min = 1, chips: initial = [], multi = false }) {
    const label = field.querySelector('label');
    const container = document.createElement('div');
    container.dataset.automationId = 'multiSelectContainer';
    container.innerHTML =
      '<ul role="listbox" data-automation-id="selectedItemList" aria-orientation="horizontal"></ul>' +
      '<input type="text" enterkeyhint="search" data-uxi-widget-type="selectinput" data-automation-id="searchBox" placeholder="Search" autocomplete="off" aria-required="true">' +
      '<span data-automation-id="promptIcon" aria-hidden="true">≡</span>';
    field.appendChild(container);
    const input = container.querySelector('input');
    input.id = label.getAttribute('for');
    if (label.id) input.setAttribute('aria-labelledby', label.id);
    const chipList = container.querySelector('ul');
    const picked = new Set(initial);
    let list = null;
    let rows = [];
    let highlighted = -1;
    const popup = { owns: (t) => container.contains(t) || (!!list && list.contains(t)), hide: () => hide() };

    function drawChips() {
      chipList.replaceChildren();
      for (const text of picked) {
        const li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        li.innerHTML =
          '<div role="option" aria-selected="true" tabindex="0" data-automation-id="selectedItem"><div data-automation-id="DELETE_charm" aria-hidden="true">×</div><p data-automation-id="promptOption"></p></div>';
        li.querySelector('p').textContent = text;
        li.querySelector('p').dataset.automationLabel = text;
        li.querySelector('[data-automation-id="selectedItem"]').title = text;
        li.querySelector('[data-automation-id="DELETE_charm"]').addEventListener('click', () => {
          picked.delete(text);
          drawChips();
          drawRows();
        });
        chipList.appendChild(li);
      }
      field.dataset.value = [...picked].join('|');
    }
    function hide() {
      if (list) list.remove();
      list = null;
      popups.delete(popup);
    }
    function drawRows() {
      if (!list) return;
      for (const [i, { row, leaf, box, text }] of rows.entries()) {
        const on = picked.has(text);
        row.setAttribute('aria-selected', String(i === highlighted));
        row.dataset.automationSelected = String(i === highlighted);
        leaf.dataset.automationChecked = on ? 'Checked' : 'Not Checked';
        leaf.dataset.uxiMultiselectlistitemIsselected = String(on);
        box.checked = on;
        if (box.parentElement.dataset.automationId === 'checkbox')
          box.parentElement.dataset.automationcheckboxchecked = String(on);
      }
    }
    function choose(i) {
      const { text } = rows[i];
      highlighted = i;
      if (multi) {
        if (picked.has(text)) picked.delete(text);
        else picked.add(text);
        drawChips();
        drawRows();
        list.focus();
        return;
      }
      picked.clear();
      picked.add(text);
      drawChips();
      input.value = '';
      hide();
    }
    async function results(query) {
      await later(200); // the search goes to the server
      const q = query.trim().toLowerCase();
      if (q.length < min || input.value.trim().toLowerCase() !== q) return;
      const hits = options.filter((o) => q.split(/\s+/).every((w) => o.toLowerCase().includes(w)));
      hide();
      list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      list.setAttribute('tabindex', '-1');
      list.dataset.automationId = 'activeListContainer';
      list.id = 'prompt-results-' + hex().slice(0, 8);
      if (!hits.length) list.innerHTML = '<div data-automation-id="multiSelectMessageContainer">No Items.</div>';
      highlighted = -1;
      rows = hits.map((text, i) => {
        const id = hex().slice(0, 12);
        const row = document.createElement('div');
        row.id = 'menuItem-' + id;
        row.dataset.automationId = 'menuItem';
        row.setAttribute('role', 'option');
        row.setAttribute('tabindex', '-1');
        row.setAttribute('aria-posinset', String(i + 1));
        row.setAttribute('aria-label', text);
        const leaf = document.createElement('div');
        leaf.dataset.automationId = 'promptLeafNode';
        leaf.setAttribute('tabindex', '-1');
        leaf.dataset.uxiWidgetType = 'multiselectlistitem';
        leaf.dataset.uxiMultiselectlistitemType = multi ? 'checkbox' : 'radio';
        leaf.innerHTML = multi
          ? '<div data-automation-id="checkbox"><input type="checkbox" data-automation-id="checkboxPanel" tabindex="-1"></div>'
          : '<div><input type="radio" data-automation-id="radioBtn" tabindex="-1"></div>';
        const name = document.createElement('div');
        name.id = 'promptOption-' + id;
        name.dataset.automationId = 'promptOption';
        name.dataset.automationLabel = text;
        name.textContent = text;
        leaf.appendChild(name);
        row.appendChild(leaf);
        // Only a click inside the row picks it: the row itself only hears the mouse go over it.
        leaf.addEventListener('click', (e) => {
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          choose(i);
        });
        row.addEventListener('mouseover', () => row.classList.add('hovered'));
        row.addEventListener('mouseleave', () => row.classList.remove('hovered'));
        list.appendChild(row);
        return { row, leaf, box: leaf.querySelector('input'), text };
      });
      drawRows();
      place(list, container);
      popups.add(popup);
    }
    if (search === 'type') input.addEventListener('input', () => results(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        results(input.value);
      }
    });
    // Text that wasn't picked doesn't stay once the box loses focus.
    input.addEventListener('blur', () =>
      setTimeout(() => {
        if (!list) input.value = '';
      }, 150),
    );
    drawChips();
  }

  /* -------------------------------------------------------------- year boxes */

  /** A year spin button in a dateInputWrapper whose data-id names it ("education-1--firstYearAttended"). */
  function year(wrapper) {
    const base = wrapper.dataset.id + '-dateSectionYear';
    wrapper.insertAdjacentHTML(
      'beforeend',
      `<div class="wd-year" id="${base}"><div aria-hidden="true" id="${base}-display" data-automation-id="dateSectionYear-display">YYYY</div>` +
        `<input type="text" role="spinbutton" aria-label="Year" aria-valuemax="9999" aria-valuemin="1" aria-valuetext="YYYY" aria-required="true" id="${base}-input" data-automation-id="dateSectionYear-input" value=""></div>`,
    );
    const box = wrapper.lastElementChild;
    const display = box.firstElementChild;
    const input = box.lastElementChild;
    let current = null;
    // React's controlled input: what the state holds is what the box and its display show.
    function render() {
      const shown = current == null ? 'YYYY' : String(current).padStart(4, '0');
      const text = /^\d+$/.test(shown) ? String(parseInt(shown, 10)) : '';
      display.textContent = shown;
      input.value = text;
      input.setAttribute('aria-valuetext', text || 'YYYY');
      if (text) input.setAttribute('aria-valuenow', text);
      else input.removeAttribute('aria-valuenow');
      wrapper.dataset.value = text;
    }
    function update(value) {
      const n = parseInt(value.slice(0, 4), 10);
      current = isNaN(n) ? null : Math.min(n, 9999);
      render();
    }
    input.addEventListener('focus', () => input.setSelectionRange(0, input.value.length));
    input.addEventListener('keydown', (e) => {
      if (/^(Arrow)?(Up|Down)$/.test(e.key)) {
        e.preventDefault();
        const n = current == null ? (/Up/.test(e.key) ? 1 : 9999) : current + (/Up/.test(e.key) ? 1 : -1);
        update(String(n < 1 ? 9999 : n > 9999 ? 1 : n));
        return;
      }
      const allowed = [/^\d+$/, /Backspace/, /Delete/, /Del/, /Tab/, /Unidentified/].some((re) => re.test(e.key));
      if (!allowed && !e.metaKey && !e.ctrlKey) e.preventDefault();
      // The digit already selected, typed again: kept as it is, the caret after it.
      else if (document.getSelection().toString() === e.key) {
        update(input.value);
        input.setSelectionRange(1, 1);
        e.preventDefault();
      }
    });
    input.addEventListener('input', () => update(input.value));
    // A value set from script, never heard as typing, is put back on the next render.
    input.addEventListener('blur', render);
    box.addEventListener('click', () => input.focus());
    render();
  }

  return { select, prompt, year, later };
})();
