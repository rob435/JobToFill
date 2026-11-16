// Workday's own widgets as its application pages run them, read from its candidate-experience bundles
// (candidate-experience-apply-flow.min.js), for the Workday fixture pages:
// - Select ("Select One", Canvas Kit's): its button opens a menu that fades in for 200 ms ("opening", then "opened")
//   and out for 200 ms ("closing"), with aria-expanded="true" until it has gone. A click on the button while the menu
//   is closing opens it again; Escape, or a mousedown anywhere outside the menu (the button included), closes it. A
//   row takes a click, or Enter or Space on the highlighted row; the button then shows the choice, and its value is
//   the choice's ID, never its text. Letters typed on the closed button pick the first choice they start.
// - Search prompts ("selectinput"), as measured on lbg.wd3.myworkdayjobs.com in November 2026: a search goes to the
//   server on Enter and takes 0.4 to 2.2 s (`data-delay` on the field, 200 ms here unless set); meanwhile a popup at
//   the end of <body> holds <div data-automation-id="responsiveMonikerPrompt" aria-busy="true"> and there is no list
//   at all. A search with exactly one match is picked by the prompt itself, and no list is shown (not in a prompt
//   that takes several). Escape does not close the results; a mousedown anywhere else does.
// - Search prompts ("selectinput"): a search box, a chip for each pick, and a list of results whose rows only take a
//   click that lands inside them: menuItem (role="option", aria-selected while highlighted, not when picked) >
//   promptLeafNode (the click handler; data-automation-checked) > the radio or checkbox and the label (promptOption).
//   A multi-select prompt (Skills) keeps its list open and ticks the row; a click on a ticked row unticks it.
// - Dates (DateField, read from candidate-experience-apply-flow 2026.45.12): a fieldset whose <legend> holds the label
//   ("From", "To (Actual or Expected)"), and a date box, a role="group" named only by the aria-hidden readout beside it
//   ("current value is YYYY", id "hiddenDateValueId-…"). In the box, a spin button per part ("YYYY" alone in
//   Education, "MM" "/" "YYYY" in Work Experience): a 1px input scaled to nothing, behind the aria-hidden "…-display"
//   that draws its digits. A part takes what is typed from its input events (React's onChange), digits only, and a
//   finished month moves the focus on to the year. The date is kept only when the focus leaves the box: a year under
//   1900 becomes 1900, a two-digit one this century's, and a month without its year is an invalid date.
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
    .wd-fieldset { display: inline-block; padding: 0; border: 0; margin: 0; }
    .wd-fieldset legend { width: 100%; padding: 0; }
    .wd-sr { clip: rect(1px, 1px, 1px, 1px); clip-path: polygon(0px 0px, 0px 0px, 0px 0px, 0px 0px); position: absolute; overflow: hidden; white-space: nowrap; height: 1px; width: 1px; margin: -1px; padding: 0; border: 0; }
    .wd-date { display: inline-flex; align-items: center; height: 40px; padding: 0 4px; border: 1px solid #888; border-radius: 4px; box-sizing: border-box; }
    .wd-date > div { display: inline-flex; align-items: center; height: 100%; cursor: pointer; }
    .wd-spin { display: inline-block; position: relative; height: 24px; text-align: center; cursor: pointer; user-select: none; }
    .wd-spin [data-automation-id$="-display"] { position: absolute; z-index: 1; width: 100%; min-width: 100%; height: 24px; display: flex; align-items: center; justify-content: center; }
    .wd-spin input { position: absolute; color: rgba(255, 255, 255, 0.01); left: 0; overflow: hidden; top: 0; transform: scale(0.01); width: 1px; z-index: -1000; }
    .css-77hcv { display: none; }
  `;
  document.head.appendChild(css);

  // What is open over the page: each closes on Escape and on a mousedown outside what it counts as its own.
  const popups = new Set();
  document.addEventListener('keydown', (e) => {
    // A Select's menu closes on Escape; a prompt's results don't.
    if (e.key === 'Escape' || e.key === 'Esc') for (const p of [...popups]) if (!p.staysOnEscape) p.hide();
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
    const popup = {
      owns: (t) => container.contains(t) || (!!list && list.contains(t)),
      hide: () => hide(),
      staysOnEscape: true,
    };
    const delay = Number(field.dataset.delay) || 200;
    let busy = null;

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
      // The search goes to the server: until it answers, a busy popup and no list.
      if (busy) busy.remove();
      busy = document.createElement('div');
      busy.innerHTML =
        '<div data-automation-id="responsiveMonikerPrompt" aria-busy="true" style="height: 200px; width: 280px"></div>';
      place(busy, container);
      field.dataset.searches = String(+(field.dataset.searches || 0) + 1);
      await later(delay);
      if (busy) busy.remove();
      busy = null;
      const q = query.trim().toLowerCase();
      if (q.length < min || input.value.trim().toLowerCase() !== q) return;
      const hits = options.filter((o) => q.split(/\s+/).every((w) => o.toLowerCase().includes(w)));
      hide();
      // Its only match is picked by the prompt itself, and nothing is listed.
      if (hits.length === 1 && !multi) {
        picked.clear();
        picked.add(hits[0]);
        drawChips();
        input.value = '';
        return;
      }
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

  /* ------------------------------------------------------------------- dates */

  const PARTS = {
    mm: { label: 'Month', automation: 'dateSectionMonth', min: 1, max: 12, placeholder: 'MM' },
    yyyy: { label: 'Year', automation: 'dateSectionYear', min: 1, max: 9999, placeholder: 'YYYY' },
  };
  const clamp = (n, lo, hi) => (isNaN(n) ? null : n === 0 ? 0 : n < lo ? lo : n > hi ? hi : n);

  /**
   * What the date box keeps when the focus leaves it (its hc()): a month from 1 to 12, a year from 1900 to 9999, and a
   * year under 100 this century's (within ten years from now) or the last.
   */
  function settle(entered) {
    const y = parseInt(entered.yyyy, 10);
    const now = new Date().getFullYear();
    const year = y >= 0 && y < 100 ? y + (now - (now % 100) - (y <= (now % 100) + 10 ? 0 : 100)) : clamp(y, 1900, 9999);
    const month = clamp(parseInt(entered.mm, 10), 1, 12);
    return { mm: month == null ? '' : String(month), yyyy: year == null ? '' : String(year) };
  }

  /**
   * A DateField on its formField-… div: data-id ("education-1--firstYearAttended"), data-label ("From"), data-format
   * ("yyyy", or "mm/yyyy"), data-required. What it keeps is on the div as data-value ("2023", "2020-06"), an invalid
   * date as data-error.
   */
  function date(field) {
    const id = field.dataset.id;
    const order = (field.dataset.format || 'yyyy').split('/');
    const required = 'required' in field.dataset;
    field.innerHTML =
      `<fieldset class="wd-fieldset"><legend><label id="label-${hex().slice(0, 8)}"><span></span></label></legend>` +
      `<div><div><div aria-hidden="true" class="wd-sr" id="hiddenDateValueId-${id}"></div>` +
      `<div role="group" aria-labelledby="hiddenDateValueId-${id}" id="${id}" data-automation-id="dateInputWrapper" class="wd-date"><div tabindex="-1"></div></div>` +
      `<div hidden id="helpText-${id}">use right and left arrows to navigate spin buttons</div></div></div></fieldset>`;
    const span = field.querySelector('legend span');
    span.textContent = field.dataset.label;
    if (required) span.insertAdjacentHTML('beforeend', '<abbr aria-hidden="true">*</abbr>');
    const readout = field.querySelector('.wd-sr');
    const group = field.querySelector('[role="group"]');
    const row = group.firstElementChild;

    // The DateInput's state, then the DateField's: what was typed, which part is selected, what the form keeps.
    let entered = { mm: '', yyyy: '' };
    let selected = null;
    let kept = '';

    const spins = order.map((key, i) => {
      const part = PARTS[key];
      const base = `${id}-${part.automation}`;
      if (i) row.insertAdjacentHTML('beforeend', '<div aria-hidden="true">/</div>');
      row.insertAdjacentHTML(
        'beforeend',
        `<div class="wd-spin" id="${base}" style="width: ${8.5 * part.placeholder.length}px"><div aria-hidden="true" id="${base}-display" data-automation-id="${part.automation}-display">${part.placeholder}</div>` +
          `<input role="spinbutton" aria-label="${part.label}" aria-valuemax="${part.max}" aria-valuemin="${part.min}" aria-valuetext="${part.placeholder}" aria-required="${required}" id="${base}-input" value="" data-automation-id="${part.automation}-input"></div>`,
      );
      const box = row.lastElementChild;
      return {
        key,
        part,
        size: String(part.max).length,
        box,
        display: box.firstElementChild,
        input: box.lastElementChild,
        current: null,
        dirty: false,
        prop: null,
      };
    });
    if (spins[0]) spins[0].input.setAttribute('aria-describedby', `helpText-${id}`);

    /** React's render: each spin button shows its state, follows the box's, and takes the focus once selected. */
    function render() {
      readout.textContent = 'current value is ' + order.map((k) => entered[k] || PARTS[k].placeholder).join('/');
      spins.forEach((s, i) => {
        const prop = entered[s.key] === '' ? null : parseInt(entered[s.key], 10);
        if (prop !== s.prop || (s.current != null && prop != null && s.current !== prop)) s.current = prop;
        s.prop = prop;
        const shown = s.current == null ? s.part.placeholder : String(s.current).padStart(s.size, '0');
        const digits = /^\d+$/.test(shown) ? String(parseInt(shown, 10)) : '';
        s.display.textContent = shown;
        if (s.input.value !== digits) s.input.value = digits;
        s.input.setAttribute('aria-valuetext', digits || s.part.placeholder);
        if (digits) s.input.setAttribute('aria-valuenow', digits);
        else s.input.removeAttribute('aria-valuenow');
        if (selected === i && document.activeElement !== s.input) s.input.focus();
      });
      field.dataset.value = kept;
    }

    /** A part's new value (its onChange): a month typed in full ("06", or "4" that can only be April) moves on. */
    function changed(i, value, raw, typed) {
      const s = spins[i];
      let v = value;
      if (s.key === 'yyyy' && v != null && !typed && !raw) v = new Date().getFullYear();
      entered = Object.assign({}, entered, { [s.key]: v == null ? '' : String(v) });
      const done =
        s.key === 'mm'
          ? v != null && (v !== 0 || raw.length === 2) && (10 * v > 12 || raw.length === 2) && typed
          : v != null && String(v).length === 4 && typed;
      if (selected !== null && i < spins.length - 1 && done) selected = i + 1;
    }

    /** The spin button's validateAndUpdate: the first digits it holds, kept within its range. */
    function update(i, text, typed) {
      const s = spins[i];
      const n = parseInt(text.length > s.size ? text.slice(0, s.size) : text, 10);
      s.current = isNaN(n) ? null : n > 0 && n < s.part.min ? s.part.min : n > s.part.max ? s.part.max : n;
      changed(i, s.current, s.input.value, typed);
      render();
      if (!typed) s.input.setSelectionRange(0, s.input.value.length);
    }

    /** The focus leaves the box: the date is settled and kept, or refused when only part of it is there. */
    function blurred() {
      entered = settle(entered);
      selected = null;
      const parts = order.map((k) => entered[k]);
      delete field.dataset.error;
      if (parts.some(Boolean) && (!parts.every(Boolean) || parts.some((p) => Number(p) === 0))) {
        kept = '';
        field.dataset.error = 'Invalid date: ' + order.map((k) => entered[k] || PARTS[k].placeholder).join('/');
      } else {
        kept = [entered.yyyy, entered.mm && entered.mm.padStart(2, '0')].filter(Boolean).join('-');
      }
      render();
    }

    spins.forEach((s, i) => {
      s.input.addEventListener('focus', () => {
        s.dirty = false;
        s.input.setSelectionRange(0, s.input.value.length);
      });
      s.input.addEventListener('keydown', (e) => {
        if (/^(Arrow)?(Up|Down)$/.test(e.key)) {
          e.preventDefault();
          const up = /Up/.test(e.key);
          const n = s.current == null ? (up ? s.part.min : s.part.max) : s.current + (up ? 1 : -1);
          update(i, String(n > s.part.max ? s.part.min : n < s.part.min ? s.part.max : n), false);
          s.dirty = true;
          return;
        }
        const allowed = [/^\d+$/, /Backspace/, /Delete/, /Del/, /Tab/, /Unidentified/].some((re) => re.test(e.key));
        if (!allowed && !e.metaKey && !e.ctrlKey) return e.preventDefault();
        // The digit already selected, typed again: kept as it is, the caret after it.
        if (document.getSelection().toString() === e.key) {
          update(i, s.input.value, true);
          s.input.setSelectionRange(1, 1);
          e.preventDefault();
        }
        s.dirty = true;
      });
      s.input.addEventListener('input', () => update(i, s.input.value, true));
      s.box.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selected = i;
        render();
      });
    });
    row.addEventListener('click', () => {
      selected = 0;
      render();
    });
    // The box's own focus and blur (React's onFocus and onBlur, which hear focusin and focusout).
    group.addEventListener('focusin', (e) => {
      if (selected == null && e.target instanceof HTMLInputElement) selected = 0;
      render();
    });
    group.addEventListener('focusout', (e) => {
      const to = e.relatedTarget || document.activeElement;
      if (to && group.contains(to)) return;
      blurred();
    });
    render();
  }

  return { select, prompt, date, later };
})();
