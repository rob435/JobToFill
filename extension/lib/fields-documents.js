/*
 * JobToFill — field rules, documents: which upload takes your CV, cover letter or transcript, and which takes several.
 * One of the parts lib/fields.js puts together (loaded before it, in the order background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const { entryLevels, levelsOf, simple } = P;

  // The documents an upload names: your CV, a cover letter, a transcript.
  const CV_NAMED = /\b(resumes?|cvs?|curriculum|lebenslauf)\b/;
  // Dayforce's "Click Import Resume to add this information from your resume" reads the CV into the form.
  const AUTOFILL_UPLOAD =
    /\bauto ?fill|automatically fill|apply with (your )?(resume|cv)|\bpre ?fill|\bparse|save time by uploading|\bimport (your |a )?(resume|cv)\b|\b(information|details) from your (resume|cv)\b/;
  const LETTER_NAMED = /cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation/;
  const TRANSCRIPT_NAMED =
    /transcript|academic record|grade (report|sheet)|mark ?sheet|record of (marks|grades)|notenspiegel|releve de notes/;

  // Uploads that belong to one level of study: the transcript of your graduate studies is not your undergraduate one.
  const LEVEL_UPLOADS = new Set(['file.transcript']);

  /**
   * Does upload `type` take your file? "If applicable, please provide a recent transcript of your graduate studies."
   * (or "Master's transcript", "High school transcript") only when your education has an entry at that level;
   * "University transcript", "Transcript of your most recent degree" or "Academic transcripts (undergraduate and
   * postgraduate)" when you have any. An entry whose degree says no level ("Computer Science") can't rule one out.
   */
  function uploadApplies(type, profile, question) {
    if (!LEVEL_UPLOADS.has(type)) return true;
    const asked = levelsOf(question);
    if (!asked.length) return true;
    const entries = ((profile && profile.education) || []).filter((e) => !U.isBlank(e.school) || !U.isBlank(e.degree));
    const levels = entries.map(entryLevels);
    if (!levels.length || levels.some((l) => !l.length)) return true;
    return asked.some((level) => levels.some((l) => l.includes(level)));
  }

  /**
   * The other documents your CV's upload takes with it, in this order after the CV, when its box takes several files
   * (`multiple`): your cover letter when the form has no upload of its own for one (`separate`: the upload types the
   * form has), and your transcript when the upload or its heading names transcripts ("Resume/CV/Transcripts") and it
   * applies to your studies (uploadApplies). `text`: the upload's label, question and heading, normalised. A box that
   * takes one file takes just the CV.
   */
  function uploadAlso(text, { multiple, profile, separate }) {
    if (!multiple) return [];
    const out = [];
    if (!(separate && separate.has('file.coverLetter'))) out.push('file.coverLetter');
    if (TRANSCRIPT_NAMED.test(text) && uploadApplies('file.transcript', profile, text)) out.push('file.transcript');
    return out;
  }

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
    coverLetter: simple('Cover letter', 'coverLetter'),

    'file.resume': { label: 'Resume file', file: 'resume', get: () => null },
    'file.coverLetter': { label: 'Cover letter file', file: 'coverLetter', get: () => null },
    // Only for a level of study you have an entry at (uploadApplies): not "…of your graduate studies" for a BSc.
    'file.transcript': { label: 'Transcript file', file: 'transcript', get: () => null },
  });

  Object.assign(P, { AUTOFILL_UPLOAD, CV_NAMED, LETTER_NAMED, TRANSCRIPT_NAMED, uploadAlso, uploadApplies });
})(typeof globalThis !== 'undefined' ? globalThis : this);
