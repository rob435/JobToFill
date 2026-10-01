/* JobToFill settings — form controls and layout pieces. */
import { el } from '../ui/common.js';

const { util } = globalThis.JTF;

/**
 * A labelled control bound to a value.
 * spec: { path, label, type?, options?, placeholder?, hint?, wide?, list?, rows?, autocomplete? }
 * type: text (default) | email | tel | url | date | select | textarea | checkbox | month
 */
export function control(spec, value, onChange) {
  if (spec.type === 'checkbox') {
    const box = el('input', {
      type: 'checkbox',
      checked: !!value,
      name: spec.path,
      onchange: () => onChange(box.checked),
    });
    return el('label', { className: 'check field' + (spec.wide ? ' wide' : '') }, box, spec.label);
  }
  if (spec.type === 'month') return monthControl(spec, value, onChange);

  let input;
  if (spec.type === 'select') {
    input = el(
      'select',
      { name: spec.path },
      spec.options.map(([v, label]) => el('option', { value: v, textContent: label })),
    );
    input.value = value == null ? '' : value;
    // Keep an unknown stored value visible instead of silently showing the first option.
    if (value && input.value !== value) input.append(el('option', { value, textContent: value, selected: true }));
    input.addEventListener('change', () => onChange(input.value));
  } else if (spec.type === 'textarea') {
    input = el('textarea', { name: spec.path, rows: spec.rows || 4, value: value || '' });
    input.addEventListener('input', () => onChange(input.value));
  } else {
    input = el('input', { type: spec.type || 'text', name: spec.path, value: value || '' });
    if (spec.list) input.setAttribute('list', spec.list);
    input.addEventListener('input', () => onChange(input.value));
  }
  if (spec.placeholder) input.placeholder = spec.placeholder;
  input.autocomplete = spec.autocomplete || 'off';
  return field(spec, input);
}

function field(spec, ...controls) {
  return el(
    'label',
    { className: 'field' + (spec.wide ? ' wide' : '') },
    el('span', { textContent: spec.label }),
    ...controls,
    spec.hint ? el('small', { textContent: spec.hint }) : null,
  );
}

/**
 * Month + year picker storing "YYYY-MM" (or "YYYY"). Firefox has no <input type="month">,
 * and two plain controls are quicker to use than a calendar for dates years apart.
 */
export function monthControl(spec, value, onChange) {
  const date = util.parseDate(value) || {};
  const month = el(
    'select',
    { name: spec.path + '-month', attrs: { 'aria-label': `${spec.label}: month` } },
    el('option', { value: '', textContent: 'Month' }),
    util.MONTHS.map((m, i) => el('option', { value: String(i + 1), textContent: m[0].toUpperCase() + m.slice(1, 3) })),
  );
  const year = el('input', {
    type: 'text',
    name: spec.path + '-year',
    inputMode: 'numeric',
    maxLength: 4,
    placeholder: 'Year',
    autocomplete: 'off',
    attrs: { 'aria-label': `${spec.label}: year` },
  });
  month.value = date.month ? String(date.month) : '';
  year.value = date.year ? String(date.year) : '';
  const emit = () => {
    const y = year.value.trim();
    if (y && !/^\d{4}$/.test(y)) return; // still typing the year
    onChange(!y ? '' : month.value ? `${y}-${util.pad2(month.value)}` : y);
  };
  month.addEventListener('change', emit);
  year.addEventListener('input', emit);
  return field(spec, el('div', { className: 'month-pair' }, month, year));
}

export function sectionHead(title, intro) {
  return el(
    'div',
    { className: 'section-head' },
    el('h1', { textContent: title }),
    intro ? el('p', { textContent: intro }) : null,
  );
}

export function group(title, hint, ...children) {
  return el(
    'section',
    { className: 'group' },
    title ? el('h2', { textContent: title }) : null,
    hint ? el('p', { className: 'hint', textContent: hint }) : null,
    ...children,
  );
}

export function grid(...children) {
  return el('div', { className: 'grid' }, ...children);
}

export function table(headers, rows) {
  return el(
    'div',
    { className: 'table-wrap' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          headers.map((h) => el('th', { textContent: h })),
        ),
      ),
      el('tbody', {}, rows),
    ),
  );
}

/** Password box with Show / Copy buttons. */
export function secretInput(value, onChange, name) {
  const input = el('input', {
    type: 'password',
    value: value || '',
    name: name || '',
    autocomplete: 'off',
    spellcheck: false,
  });
  if (onChange) input.addEventListener('change', () => onChange(input.value));
  const show = el('button', {
    type: 'button',
    className: 'small',
    textContent: 'Show',
    onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      show.textContent = input.type === 'password' ? 'Show' : 'Hide';
    },
  });
  const copy = el('button', {
    type: 'button',
    className: 'small',
    textContent: 'Copy',
    onclick: async () => {
      await navigator.clipboard.writeText(input.value);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    },
  });
  return { input, row: el('div', { className: 'secret' }, input, show, copy) };
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
