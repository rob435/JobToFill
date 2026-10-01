/*
 * JobToFill — encrypted vault for passwords and payment cards.
 *
 * The vault is a JSON document encrypted with AES-256-GCM. The key is derived
 * from your master password with PBKDF2-SHA256 and is never written to disk:
 * while unlocked it lives only in chrome.storage.session (memory, extension
 * pages and the service worker only; content scripts cannot read it).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const LOCAL_KEY = 'vault';
  const SESSION_KEY = 'vaultKey';
  const USED_KEY = 'vaultLastUsed';
  const DEFAULT_ITERATIONS = 600000;

  const subtle = () => root.crypto.subtle;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function b64(bytes) {
    const arr = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    root.crypto.getRandomValues(out);
    return out;
  }

  async function deriveKey(password, salt, iterations) {
    const base = await subtle().importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  }

  async function encryptJson(key, obj) {
    const iv = randomBytes(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }

  async function decryptJson(key, blob) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return JSON.parse(decoder.decode(pt));
  }

  function emptyData() {
    return { version: 1, defaultPassword: '', credentials: [], cards: [], defaultCardId: null };
  }

  /* ---------------------------------------------------------------- passwords */

  const SETS = {
    lower: 'abcdefghijkmnopqrstuvwxyz',
    upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
    digits: '23456789',
    symbols: '!@#$%^&*-_=+?',
  };

  function randomInt(max) {
    // Rejection sampling keeps every character equally likely.
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do {
      root.crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  }

  /** A password with at least one lower, upper, digit (and symbol), as most sign-up forms demand. */
  function generatePassword(options) {
    const opts = Object.assign({ length: 20, symbols: true }, options || {});
    const sets = [SETS.lower, SETS.upper, SETS.digits];
    if (opts.symbols) sets.push(SETS.symbols);
    const length = Math.max(opts.length, sets.length);
    const all = sets.join('');
    const chars = sets.map((s) => s[randomInt(s.length)]);
    while (chars.length < length) chars.push(all[randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  /* ---------------------------------------------------------- storage-backed */

  const local = () => root.chrome.storage.local;
  const session = () => root.chrome.storage.session;

  async function getBlob() {
    const got = await local().get(LOCAL_KEY);
    return got[LOCAL_KEY] || null;
  }

  async function sessionKey() {
    const got = await session().get(SESSION_KEY);
    if (!got[SESSION_KEY]) return null;
    return subtle().importKey('raw', unb64(got[SESSION_KEY]), 'AES-GCM', true, ['encrypt', 'decrypt']);
  }

  async function rememberKey(key) {
    const raw = await subtle().exportKey('raw', key);
    await session().set({ [SESSION_KEY]: b64(raw), [USED_KEY]: Date.now() });
  }

  /** 'none' (never set up), 'locked' or 'unlocked'. */
  async function status() {
    if (!(await getBlob())) return 'none';
    const got = await session().get(SESSION_KEY);
    return got[SESSION_KEY] ? 'unlocked' : 'locked';
  }

  async function setup(password, options) {
    if (!password || password.length < 8) throw new Error('Use a master password of at least 8 characters.');
    const iterations = (options && options.iterations) || DEFAULT_ITERATIONS;
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt, iterations);
    const blob = {
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) },
      data: await encryptJson(key, emptyData()),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await local().set({ [LOCAL_KEY]: blob });
    await rememberKey(key);
  }

  async function unlock(password) {
    const blob = await getBlob();
    if (!blob) throw new Error('No vault has been set up yet.');
    const key = await deriveKey(password, unb64(blob.kdf.salt), blob.kdf.iterations);
    try {
      await decryptJson(key, blob.data);
    } catch (err) {
      throw new Error('Wrong master password.');
    }
    await rememberKey(key);
  }

  async function lock() {
    await session().remove([SESSION_KEY, USED_KEY]);
  }

  async function touch() {
    await session().set({ [USED_KEY]: Date.now() });
  }

  async function read() {
    const key = await sessionKey();
    if (!key) throw new Error('The vault is locked.');
    const blob = await getBlob();
    if (!blob) throw new Error('No vault has been set up yet.');
    const data = await decryptJson(key, blob.data);
    return JTF.util.mergeDefaults(data, emptyData());
  }

  async function write(data) {
    const key = await sessionKey();
    if (!key) throw new Error('The vault is locked.');
    const blob = await getBlob();
    blob.data = await encryptJson(key, data);
    blob.updatedAt = Date.now();
    await local().set({ [LOCAL_KEY]: blob });
    await touch();
  }

  /** Read-modify-write: `fn` may mutate the data or return a replacement. */
  async function update(fn) {
    const data = await read();
    const out = (await fn(data)) || data;
    await write(out);
    return out;
  }

  async function changePassword(newPassword) {
    if (!newPassword || newPassword.length < 8) throw new Error('Use a master password of at least 8 characters.');
    const data = await read();
    const blob = await getBlob();
    const salt = randomBytes(16);
    const iterations = Math.max(blob.kdf.iterations, DEFAULT_ITERATIONS);
    const key = await deriveKey(newPassword, salt, iterations);
    blob.kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) };
    blob.data = await encryptJson(key, data);
    blob.updatedAt = Date.now();
    await local().set({ [LOCAL_KEY]: blob });
    await rememberKey(key);
  }

  async function reset() {
    await local().remove(LOCAL_KEY);
    await lock();
  }

  /** Lock if the vault has been idle longer than `minutes` (0 = only when the browser closes). */
  async function autoLock(minutes) {
    if (!minutes || minutes <= 0) return false;
    const got = await session().get([SESSION_KEY, USED_KEY]);
    if (!got[SESSION_KEY]) return false;
    if (Date.now() - (got[USED_KEY] || 0) > minutes * 60000) {
      await lock();
      return true;
    }
    return false;
  }

  function findCredential(data, host) {
    const matches = (data.credentials || []).filter((c) => JTF.util.hostMatches(host, c.host));
    // Prefer the most specific saved host (careers.acme.com over acme.com).
    matches.sort((a, b) => b.host.length - a.host.length);
    return matches[0] || null;
  }

  function defaultCard(data) {
    const cards = data.cards || [];
    return cards.find((c) => c.id === data.defaultCardId) || cards[0] || null;
  }

  const vault = {
    LOCAL_KEY, SESSION_KEY, DEFAULT_ITERATIONS,
    deriveKey, encryptJson, decryptJson, emptyData, generatePassword, b64, unb64,
    status, setup, unlock, lock, touch, read, write, update, changePassword, reset, autoLock,
    findCredential, defaultCard,
  };
  JTF.vault = vault;
  if (typeof module === 'object' && module.exports) module.exports = vault;
})(typeof globalThis !== 'undefined' ? globalThis : this);
