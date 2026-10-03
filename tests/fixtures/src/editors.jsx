// Real rich-text editors for tests/fixtures/editors.html: Quill 2, TipTap 3 (ProseMirror) and Lexical, plus a bare
// contenteditable box. Each one's own idea of its text goes into #state.
import Quill from 'quill';
import quillCss from 'quill/dist/quill.snow.css';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { $getRoot, createEditor } from 'lexical';
import { HeadingNode, QuoteNode, registerRichText } from '@lexical/rich-text';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';

document.head.append(Object.assign(document.createElement('style'), { textContent: quillCss }));

const model = { name: '', coverLetter: '', why: '', summary: '', skills: '' };
const show = () => (document.getElementById('state').textContent = JSON.stringify(model));

document.getElementById('name').addEventListener('input', (e) => ((model.name = e.target.value), show()));

const quill = new Quill('#quill', {
  theme: 'snow',
  placeholder: 'Write or paste your cover letter',
  modules: { toolbar: [['bold', 'italic'], ['link']] },
});
quill.on('text-change', () => ((model.coverLetter = quill.getText().trim()), show()));

const tiptap = new Editor({
  element: document.getElementById('tiptap'),
  extensions: [StarterKit],
  content: '',
  onUpdate: ({ editor }) => ((model.why = editor.getText({ blockSeparator: '\n' }).trim()), show()),
});
window.tiptap = tiptap;

const lexical = createEditor({
  namespace: 'summary',
  nodes: [HeadingNode, QuoteNode],
  onError: (e) => console.error(e),
});
lexical.setRootElement(document.getElementById('lexical'));
registerRichText(lexical);
registerHistory(lexical, createEmptyHistoryState(), 300);
lexical.registerUpdateListener(({ editorState }) =>
  editorState.read(() => ((model.summary = $getRoot().getTextContent().trim()), show())),
);

const plain = document.getElementById('plain');
plain.addEventListener('input', () => ((model.skills = plain.innerText.trim()), show()));
show();
