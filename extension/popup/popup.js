/* JobToFill — toolbar popup. */
(function () {
  'use strict';
  const { store, vault, util } = globalThis.JTF;
  const $ = (sel) => document.querySelector(sel);

  const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a5 5 0 0 0-5 5v3H5v12h14V10h-2V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"/></svg>';
  const OPEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2a5 5 0 0 0-5 5v3H5v12h14V10h-5V7a3 3 0 1 1 6 0v1h2V7a5 5 0 0 0-5-5Z"/></svg>';

  let tab = null;
  let suggestions = [];

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    const { dataset, ...rest } = props || {};
    Object.assign(node, rest);
    if (dataset) Object.assign(node.dataset, dataset);
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function openOptions(hash) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + (hash ? '#' + hash : '') });
    window.close();
  }

  /** Which settings section holds the data for a field type. */
  function sectionFor(type) {
    if (!type) return 'personal';
    if (type.startsWith('links.')) return 'links';
    if (type.startsWith('job.')) return 'work';
    if (type.startsWith('edu.')) return 'education';
    if (type.startsWith('exp.')) return 'experience';
    if (type.startsWith('eeo.')) return 'eeo';
    if (type.startsWith('file.')) return 'documents';
    if (['skills', 'languages', 'summary', 'coverLetter'].includes(type)) return 'writing';
    return 'personal';
  }

  /* ---------------------------------------------------------- profiles */

  async function renderProfiles() {
    const { profiles, order, settings } = await store.loadAll();
    const select = $('#profile');
    select.replaceChildren(...order.map((id) => el('option', { value: id, textContent: profiles[id].name, selected: id === settings.activeProfileId })));
    select.hidden = order.length < 2;
    return profiles[settings.activeProfileId];
  }

  /* -------------------------------------------------------------- fill */

  function renderResult(r) {
    const box = $('#result');
    box.hidden = false;
    box.replaceChildren();
    if (r.error) {
      box.append(el('div', { className: 'result-head' }, el('span', { className: 'pill bad', textContent: 'Can’t fill' })), el('p', { className: 'result-list', textContent: r.error }));
      return;
    }
    if (!r.detected) {
      box.append(el('div', { className: 'result-head' }, el('span', { textContent: 'No form fields found on this page.' })));
      return;
    }
    box.append(el('div', { className: 'result-head' },
      el('span', { className: 'count', textContent: String(r.filled) }),
      el('span', { textContent: `field${r.filled === 1 ? '' : 's'} filled` }),
      r.skipped ? el('span', { className: 'pill', textContent: `${r.skipped} already set`, title: 'Fields that already had a value were left alone. Turn on “Overwrite” in settings to replace them.' }) : null));

    const line = (label, items) => el('p', { className: 'result-list' }, el('b', { textContent: label + ' ' }), items.slice(0, 8).join(', ') + (items.length > 8 ? '…' : ''));
    if (r.missing && r.missing.length) box.append(line('Missing from your profile:', r.missing));
    if (r.unmatched && r.unmatched.length) box.append(line('No matching option:', r.unmatched));
    for (const n of r.notes || []) box.append(el('p', { className: 'result-list', textContent: n }));

    const actions = el('div', { className: 'result-actions' });
    if (r.undoable) actions.append(el('button', { className: 'small', textContent: 'Undo', onclick: undo }));
    if (r.missing && r.missing.length) actions.append(el('button', { className: 'small ghost', textContent: 'Complete profile', onclick: () => openOptions(sectionFor((r.missingTypes || [])[0])) }));
    if (actions.children.length) box.append(actions);
  }

  async function fill() {
    const btn = $('#fill');
    btn.disabled = true;
    btn.firstElementChild.textContent = 'Filling…';
    try {
      renderResult(await send({ type: 'jtf:fill', tabId: tab.id }));
    } catch (err) {
      renderResult({ error: String(err.message || err) });
    } finally {
      btn.disabled = false;
      btn.firstElementChild.textContent = 'Fill this page';
    }
  }

  async function undo() {
    const r = await send({ type: 'jtf:undo', tabId: tab.id });
    const box = $('#result');
    box.replaceChildren(el('p', { className: 'result-list', textContent: r.error || `Restored ${r.undone} field${r.undone === 1 ? '' : 's'}.` }));
  }

  async function inspect() {
    const btn = $('#inspect');
    const r = await send({ type: 'jtf:inspect', tabId: tab.id });
    if (r.error) return renderResult(r);
    btn.setAttribute('aria-pressed', String(!!r.on));
    btn.querySelector('span').textContent = r.on ? `Hide labels (${r.detected} found)` : 'Show detected fields';
  }

  /* ------------------------------------------------------------- learn */

  async function learn() {
    const panel = $('#learn-panel');
    const r = await send({ type: 'jtf:learn', tabId: tab.id });
    if (r.error) return renderResult(r);
    suggestions = r.suggestions || [];
    panel.hidden = false;
    $('#learn-empty').hidden = suggestions.length > 0;
    $('#learn-save').hidden = suggestions.length === 0;
    $('#learn-list').replaceChildren(...suggestions.map((s, i) => el('li', {},
      el('label', {},
        el('input', { type: 'checkbox', checked: true, dataset: { index: String(i) } }),
        el('span', {},
          el('div', { className: 'learn-q', textContent: s.kind === 'profile' ? s.label : s.question }),
          el('div', { className: 'learn-a', textContent: s.value }))))));
  }

  async function saveLearned() {
    const picked = [...document.querySelectorAll('#learn-list input:checked')].map((i) => suggestions[+i.dataset.index]);
    if (!picked.length) return;
    const { profile } = await store.getActive();
    for (const s of picked) {
      if (s.kind === 'profile') {
        util.setPath(profile, s.path, s.value);
      } else {
        const existing = s.replaces && profile.customAnswers.find((a) => a.id === s.replaces);
        if (existing) existing.answer = s.value;
        else profile.customAnswers.push({ id: util.uid(), question: s.question, answer: s.value });
      }
    }
    await store.saveProfile(profile);
    $('#learn-list').replaceChildren();
    $('#learn-save').hidden = true;
    $('#learn-empty').hidden = false;
    $('#learn-empty').textContent = `Saved ${picked.length} item${picked.length === 1 ? '' : 's'} to “${profile.name}”.`;
  }

  /* ------------------------------------------------------------- vault */

  async function renderVault() {
    const box = $('#vault');
    const status = await vault.status();
    box.replaceChildren();
    if (status === 'none') {
      box.append(el('span', { innerHTML: LOCK_ICON }), el('span', { className: 'grow', textContent: 'Save passwords & cards in an encrypted vault' }),
        el('button', { className: 'small', textContent: 'Set up', onclick: () => openOptions('vault') }));
    } else if (status === 'locked') {
      const input = el('input', { type: 'password', placeholder: 'Master password', autocomplete: 'current-password', ariaLabel: 'Master password' });
      const err = el('span', { className: 'err' });
      const form = el('form', {}, input, el('button', { className: 'small primary', type: 'submit', textContent: 'Unlock' }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        form.querySelector('button').disabled = true;
        try {
          await vault.unlock(input.value);
          await renderVault();
        } catch (ex) {
          err.textContent = ex.message;
          form.querySelector('button').disabled = false;
          input.select();
        }
      });
      box.append(el('span', { innerHTML: LOCK_ICON, title: 'Vault locked' }), form, err);
    } else {
      box.append(el('span', { innerHTML: OPEN_ICON }), el('span', { className: 'grow', textContent: 'Vault unlocked: passwords & cards will fill' }),
        el('button', { className: 'small', textContent: 'Lock', onclick: async () => { await vault.lock(); renderVault(); } }));
    }
  }

  /* -------------------------------------------------------------- init */

  async function init() {
    // popup.html?tab=<id> targets a specific tab (handy when the popup is opened as a page for debugging).
    const forced = new URLSearchParams(location.search).get('tab');
    if (forced) tab = await chrome.tabs.get(+forced);
    else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $('#version').textContent = 'v' + chrome.runtime.getManifest().version;
    await renderProfiles();
    await renderVault();

    try {
      const commands = await chrome.commands.getAll();
      const cmd = commands.find((c) => c.name === 'fill-page');
      if (cmd && cmd.shortcut) {
        $('#shortcut').textContent = cmd.shortcut;
        $('#shortcut').hidden = false;
      }
    } catch (err) { /* commands API unavailable */ }

    const scriptable = tab && /^(https?|file):/.test(tab.url || '');
    if (!scriptable) {
      for (const id of ['#fill', '#inspect', '#learn']) $(id).disabled = true;
      const note = $('#page-note');
      note.hidden = false;
      note.textContent = 'Open a job application or checkout page to fill it.';
    }

    $('#fill').addEventListener('click', fill);
    $('#inspect').addEventListener('click', inspect);
    $('#learn').addEventListener('click', learn);
    $('#learn-save').addEventListener('click', saveLearned);
    $('#learn-close').addEventListener('click', () => { $('#learn-panel').hidden = true; });
    $('#open-options').addEventListener('click', () => openOptions());
    $('#profile').addEventListener('change', async (e) => {
      await store.setActive(e.target.value);
      $('#result').hidden = true;
    });
  }

  init();
})();
