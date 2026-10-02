/*
 * JobToFill — offscreen document (Chromium only). The background service worker has no DOMParser, which
 * reading a job page's HTML needs, so it asks this page to find the posting behind an application.
 * It only reads public job pages: GET requests without cookies, never anything that looks like an action.
 */
(function () {
  'use strict';
  const { jobpage } = globalThis.JTF;
  const runtime = globalThis.chrome.runtime;
  const UNSAFE =
    /logout|log-out|signout|sign-out|unsubscribe|delete|remove|withdraw|cancel|confirm|verify|activate|reset|token=|password/i;

  function safeFetch(url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    const isApi = !!(init && init.headers && /json/i.test(JSON.stringify(init.headers)));
    if (UNSAFE.test(url) && !isApi) return Promise.reject(new Error('skipped: looks like an action link'));
    if (method !== 'GET' && !(method === 'POST' && isApi)) return Promise.reject(new Error('skipped: not a page load'));
    return fetch(url, { credentials: 'omit', redirect: 'follow', ...init });
  }

  runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'jtf:offscreen-find' || sender.id !== runtime.id) return false;
    jobpage.find(msg.context, { fetch: safeFetch, now: Date.now(), budget: 6, timeout: 8000 }).then(
      (found) => sendResponse({ found }),
      (err) => sendResponse({ error: String((err && err.message) || err) }),
    );
    return true;
  });
})();
