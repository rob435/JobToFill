/* JobToFill settings — the "Get started" checklist: what's left to set up. Pure, so the unit tests run it. */

const filled = (value) => String(value == null ? '' : value).trim() !== '';

/**
 * The steps, from what the settings page already has: { profile, resume (the CV file is uploaded), aiKey (the
 * chosen AI provider has a key), inbox (Nylas is connected), pinned (the toolbar button is pinned: true, false, or
 * null when the browser can't tell) }. Each step: { id, text, href (the section it's done in), done, optional }.
 */
export function setupSteps({ profile, resume, aiKey, inbox, pinned } = {}) {
  const p = profile || {};
  const personal = p.personal || {};
  const contact = p.contact || {};
  return [
    {
      id: 'contact',
      text: 'Add your name and email',
      href: '#personal',
      done: filled(personal.firstName) && filled(personal.lastName) && filled(contact.email),
    },
    { id: 'cv', text: 'Upload your CV', href: '#documents', done: !!resume },
    {
      id: 'education',
      text: 'Add your education',
      href: '#education',
      done: (p.education || []).some((e) => e && filled(e.school)),
    },
    {
      id: 'ai',
      text: 'Add an AI key for cover letters and answers',
      href: '#letters',
      done: !!aiKey,
      optional: true,
    },
    { id: 'inbox', text: 'Connect your inbox for email codes', href: '#email', done: !!inbox, optional: true },
    // Where the browser can't say whether the button is pinned, the step is only a tip.
    { id: 'toolbar', text: 'Pin JobToFill to the toolbar', href: '', done: pinned === true, optional: pinned == null },
  ];
}

/** Set up enough to fill applications: every step that isn't optional is done. */
export const setupComplete = (steps) => steps.every((s) => s.done || s.optional);
