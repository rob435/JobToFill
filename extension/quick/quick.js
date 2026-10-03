/*
 * JobToFill — the last quick apply: the letter and CV it made, kept only until the next quick apply,
 * "Clear", or the browser closing (see store.saveQuickApply). Opened from the popup's "Last quick apply".
 */
import { $, api, download, el } from '../ui/common.js';

const { store } = globalThis.JTF;

const state = { record: null, showing: 'letter', urls: {} };

/** A data URL as a Blob, without fetch (so no CSP rule can get in the way). */
function dataUrlToBlob(dataUrl, fallbackType) {
  const [head, body = ''] = String(dataUrl || '').split(',');
  const type = (/^data:([^;,]+)/.exec(head) || [])[1] || fallbackType;
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function pdfUrl(which) {
  const doc = state.record && state.record[which];
  if (!doc || !doc.pdf) return '';
  if (!state.urls[which]) state.urls[which] = URL.createObjectURL(dataUrlToBlob(doc.pdf, 'application/pdf'));
  return state.urls[which];
}

function show(which) {
  const rec = state.record;
  state.showing = which;
  $('#tab-letter').setAttribute('aria-selected', String(which === 'letter'));
  $('#tab-cv').setAttribute('aria-selected', String(which === 'cv'));
  const doc = rec[which];
  $('#preview').hidden = !doc;
  $('#no-cv').hidden = !!doc;
  $('#download-pdf').hidden = !doc;
  $('#download-tex').hidden = !(which === 'cv' && doc && doc.tex);
  const changes = which === 'cv' && doc && doc.changes && doc.changes.length ? doc.changes : [];
  $('#changes').hidden = !changes.length;
  $('#changes-list').replaceChildren(...changes.map((c) => el('li', { textContent: c })));
  if (doc) $('#preview').src = pdfUrl(which) + '#toolbar=0&view=FitH';
}

async function render() {
  for (const url of Object.values(state.urls)) URL.revokeObjectURL(url);
  state.urls = {};
  state.record = await store.getQuickApply();
  const rec = state.record;
  $('#empty').hidden = !!rec;
  $('#result').hidden = !rec;
  $('#clear').hidden = !rec;
  $('#when').textContent = rec ? new Date(rec.createdAt).toLocaleString() : '';
  if (!rec) return;
  $('#job').textContent = [rec.role, rec.company].filter(Boolean).join(' at ') || 'Application';
  let host = '';
  try {
    host = new URL(rec.tabUrl).hostname;
  } catch (err) {
    /* no address */
  }
  $('#site').textContent = host ? `Applied on ${host}` : '';
  $('#note').hidden = !rec.note;
  $('#note').textContent = rec.note || '';
  show('letter');
}

$('#tab-letter').onclick = () => state.record && show('letter');
$('#tab-cv').onclick = () => state.record && show('cv');
$('#download-pdf').onclick = () => {
  const doc = state.record && state.record[state.showing];
  if (doc) download(dataUrlToBlob(doc.pdf, 'application/pdf'), doc.name || `${state.showing}.pdf`);
};
$('#download-tex').onclick = () => {
  const cv = state.record && state.record.cv;
  if (cv && cv.tex)
    download(new Blob([cv.tex], { type: 'application/x-tex' }), (cv.name || 'cv.pdf').replace(/\.pdf$/i, '') + '.tex');
};
$('#clear').onclick = async () => {
  await store.clearQuickApply();
  await render();
};
// A newer quick apply replaces this one while the page is open.
api.storage.onChanged.addListener((changes) => changes.quickApply && render());

render();
