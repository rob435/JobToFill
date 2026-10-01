# JobToFill

A browser extension that fills out job applications for you, and works as a general autofill for sign-ups and checkouts too.

Save your details once: name, contact info, address, links, education, work history, resume, answers to common screening questions, plus (optionally) passwords and payment cards in an encrypted vault. Then press **Alt+Shift+F** (or click the toolbar button) on any application page and JobToFill fills in everything it recognizes. It never submits anything; you review the form and press Submit yourself.

## Features

**Job applications**
- **Smart field detection.** Each field is scored using its `autocomplete` attribute, `<label>`, `aria-label`, placeholder, `name`/`id`, ATS attributes (Workday `data-automation-id`, Lever `urls[LinkedIn]`, Greenhouse `job_application[...]`) and nearby text. Tested against Greenhouse-, Lever- and Workday-style pages.
- **Screening questions.** Answers "Are you legally authorized to work…?", "Will you require sponsorship…?", relocation, over-18, salary, notice period, start date and "How did you hear about us?". It knows the trap where *"authorized to work… without sponsorship?"* needs a **Yes**.
- **Dropdowns, radios and checkboxes.** "USA" matches "United States of America" or an option with value `US`, and "CA" matches "California". "No" matches "I am not a protected veteran", "BSc" matches "Bachelor's Degree", and 6 years matches the "5–10" range.
- **Custom dropdowns.** Opens and picks options in react-select, Workday listboxes and async search boxes (school pickers).
- **Multiple education and job entries.** When a form repeats its *School* or *Job title* section, each copy gets the next entry from your profile. "From", "To" and "Location" boxes take their meaning from the section they sit in, and split month/year boxes are handled.
- **Resume and cover letter upload.** Your files are attached to the upload fields automatically.
- **Custom answers.** Rules like "*why do you want to work*" → your answer. You can match with plain phrases, `a | b` alternatives or `/regex/`.
- **Learn from this page.** After you type answers into an unusual form, one click saves them, either as profile values or as custom answers for next time.
- **Voluntary EEO questions** (gender, race, veteran, disability). These are opt-in, and "— don't fill —" is the default.
- **Application log.** Every job application you fill is recorded, and the log can be exported as CSV.
- **Multiple profiles.** For example "Software engineer", "Data analyst" and "Personal shopping", each with its own resume.

**General autofill**
- Checkout and shipping forms, including country/state codes, phone numbers and split names. A "Company (optional)" box on a shipping form is *not* filled with your employer.
- **Encrypted vault** for passwords and cards (AES-256-GCM with a PBKDF2 key from your master password, auto-lock).
  - Sign-up pages: a unique strong password is generated for "Create password" + "Confirm password" and saved for that site, so a Workday account for every employer is no longer painful. Choosing a single default password instead is also an option.
  - Login pages: the saved password for that site is filled.
  - Checkout pages: the selected card is filled, including inside payment-provider iframes such as Stripe.
- **Right-click menu.** *Fill this page*, *Insert from profile → Email / LinkedIn / …* into any box, and *Generate strong password*.

**Also**
- Works inside cross-origin iframes (embedded Greenhouse boards) and open shadow DOM (web components).
- **Show detected fields** labels every field with what JobToFill thinks it is: green means ready, amber means your profile lacks it, grey means unknown.
- **Undo** puts back whatever was on the page before the fill.
- Only empty fields are filled unless you turn on *Overwrite*, and filled fields are outlined.
- Light and dark mode, plus import/export backups.

## Install

JobToFill isn't on the Chrome Web Store yet, so load it unpacked:

1. Download this repository (or `git clone` it).
2. Open `chrome://extensions` (in Edge, `edge://extensions`; Brave, Opera, Arc and Vivaldi work the same way).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the **`extension/`** folder.
5. The settings page opens. Fill in your profile, and pin the toolbar icon.

`npm run build` writes ready-to-upload zips to `dist/` for Chrome and Firefox.

> **Firefox (experimental):** after `npm run build`, open `about:debugging` → *This Firefox* → *Load Temporary Add-on* and pick `dist/firefox/manifest.json`. The Firefox build uses the same code with a background page instead of a service worker. It has not been tested as thoroughly as Chrome.

## Using it

| Do this | How |
| --- | --- |
| Fill the page | **Alt+Shift+F**, the toolbar button → *Fill this page*, or right-click → *Fill this page* |
| See what was detected | Toolbar → *Show detected fields* |
| Save answers you typed | Toolbar → *Learn from this page* |
| Insert one value | Right-click a box → *Insert from profile* |
| New password on a sign-up form | Right-click the password box → *Generate strong password* (or just fill the page) |
| Undo a fill | *Undo* in the popup or in the on-page toast |

You can change the shortcut at `chrome://extensions/shortcuts`.

### Try it on the demo forms

```bash
npm install
npm run demo        # serves the test forms at http://localhost:8080/
```

The demo includes Greenhouse-, Workday- and Lever-style applications, searchable dropdowns, a checkout, sign-up/login pages, a cross-origin embed and a page of deliberately tricky fields.

## Privacy and security

- **Nothing leaves your browser.** There are no servers, analytics or network requests. The profile lives in `chrome.storage.local`.
- **Nothing runs until you ask.** The fill code is injected into a page only when you press the shortcut or a button. It is not loaded on every site you visit.
- **The vault is encrypted** with AES-256-GCM. The key is derived from your master password (PBKDF2-SHA256, 600,000 iterations) and is kept only in memory (`chrome.storage.session`) while unlocked. Content scripts can't read it. The vault auto-locks after inactivity (30 minutes by default) and always locks when the browser closes. Backups contain the vault still encrypted.
- **Secrets are guarded:**
  - Passwords and cards are only handed out during a fill you started.
  - They are only filled on HTTPS pages (or `localhost`).
  - They only go into visible fields: off-screen "honeypot" and hidden fields are skipped.
  - Saved passwords only go to the site they belong to.
  - Cards only go to the top page, the same site, or known payment processors' frames, never to an arbitrary third-party iframe.
- **Never submits, never ticks "I agree".** Terms and consent checkboxes are left for you.
- The extension needs access to all sites so it can fill application forms embedded from other domains (iframes). It only touches a page when you trigger it.

A dedicated password manager is still the stronger choice for your important accounts. The vault is aimed at the dozens of throwaway job-portal accounts.

## Brainstorm: what an application autofiller should do

Implemented ✅ · Ideas for later 💡

- ✅ Standard contact/address fields with `autocomplete` support, so it also works as a general autofill
- ✅ ATS-aware detection (Workday, Greenhouse, Lever patterns) with a scoring engine rather than one regex per site
- ✅ Screening questions with tricky-wording handling; EEO answers opt-in
- ✅ Repeated education/experience sections, split month/year dates, ranges, country/state codes
- ✅ React/Vue/Angular-safe value setting; custom dropdown automation; iframes and shadow DOM
- ✅ Resume/cover letter auto-attach; per-profile documents
- ✅ Custom Q&A rules and *Learn from this page*
- ✅ Encrypted vault: per-site generated passwords for ATS sign-ups, cards for checkout
- ✅ Inspect overlay, undo, application log, multiple profiles, backup/restore
- 💡 **AI-drafted answers** for open questions ("Why us?") using your summary, the job description on the page and a model API key you provide
- 💡 **Cover-letter templates** with `{company}` / `{role}` filled from the job posting
- 💡 **Workday "Add another"**: click *Add* for each extra education/job entry automatically
- 💡 **Auto-advance** multi-step applications (fill, then *Next*, then fill again), always stopping before *Submit*
- 💡 **Resume import** to parse a PDF/DOCX or LinkedIn export into the profile
- 💡 **Application tracker** with status (applied → interview → offer) and follow-up reminders, built on the existing log
- 💡 Optional encrypted **sync** between browsers, and a Chrome Web Store / Firefox Add-ons release
- 💡 More languages for label detection (rules already cover some German, French and Spanish)

## Known limitations

- Detection is heuristic. Unusual forms may need a custom answer, or one right-click *Insert from profile*. *Show detected fields* shows what was recognized.
- Workday-style date "spinners" and some heavily customized widgets may ignore programmatic input. JobToFill reports those as "No matching option" so you know to check them.
- Sections that only appear after clicking *Add another* aren't added automatically yet.
- It can't fill CAPTCHAs or closed shadow roots, and won't run on browser pages or extension stores.

## Development

```
extension/
  manifest.json        Manifest V3
  background.js        service worker: injection, fill orchestration, vault access, menus, shortcut
  lib/                 shared, DOM-free (also run by the unit tests in Node)
    fields.js          profile schema, field types, detection rules, value resolution
    matcher.js         classification, section/entry planning, option matching, formatting
    geo.js             countries (ISO codes + aliases) and US/CA/AU regions
    vault.js           encryption, password generator, lock/unlock
    store.js           profiles, settings, documents, history, backups
    util.js
  content/             injected on demand into every frame
    dom.js             finds controls (incl. shadow DOM), labels, radio groups
    fill.js            sets values the way frameworks notice, custom dropdowns, files, undo
    main.js            in-page API: fill / learn / inspect / undo / toast
  popup/  options/  ui/  icons/
tests/
  unit/                node:test, no browser
  e2e/                 Playwright with the real extension loaded in Chromium
  fixtures/            the demo/test forms
scripts/               build, static checks, icon rendering
```

There is no build step. Edit the files and click reload on `chrome://extensions`.

```bash
npm install
npm run lint        # syntax + manifest/file reference checks
npm run test:unit   # fast, no browser
npm run test:e2e    # loads the extension in headless Chromium (HEADED=1 to watch)
npm run build       # dist/*.zip for Chrome and Firefox
```

Adding support for a new kind of field usually means adding a rule to `RULES` and a definition to `DEFS` in `extension/lib/fields.js`, plus a case in `tests/unit/classify.test.js`.

