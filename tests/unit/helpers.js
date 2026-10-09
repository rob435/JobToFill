// Loads the extension's classic-script libraries into this Node process and
// provides an in-memory chrome.storage so store.js / passwords.js can run.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'extension', 'lib');
// The parts lib/fields.js is put together from, in the order the extension loads them (background.js).
const FIELD_PARTS = [
  ...fs
    .readFileSync(path.join(LIB, '..', 'background.js'), 'utf8')
    .match(/importScripts\(([^)]*)\)/)[1]
    .matchAll(/'lib\/(fields-[\w-]+)\.js'/g),
].map((m) => m[1]);

function memoryArea() {
  let data = {};
  const pick = (keys) => {
    if (keys == null) return { ...data };
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
    return out;
  };
  return {
    async get(keys) {
      return pick(keys);
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    async clear() {
      data = {};
    },
    _dump: () => data,
  };
}

function installChrome() {
  globalThis.chrome = { runtime: { id: 'jobtofill-test' }, storage: { local: memoryArea(), session: memoryArea() } };
  return globalThis.chrome;
}

function load() {
  if (!globalThis.chrome) installChrome();
  for (const f of ['util', 'geo', ...FIELD_PARTS, 'fields', 'matcher', 'decide', 'account', 'passwords', 'store'])
    require(path.join(LIB, f + '.js'));
  return globalThis.JTF;
}

/** Build a matcher descriptor the way content/dom.js would. */
function desc(signals, extra) {
  return Object.assign(
    {
      kind: 'text',
      inputType: 'text',
      autocomplete: '',
      maxLength: 0,
      placeholderRaw: '',
      options: null,
      signals: typeof signals === 'string' ? { label: signals } : signals,
    },
    extra || {},
  );
}

const opts = (...texts) => texts.map((t) => (Array.isArray(t) ? { text: t[0], value: t[1] } : { text: t, value: t }));

module.exports = { load, installChrome, desc, opts };
