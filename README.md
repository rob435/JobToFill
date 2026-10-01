# JobToFill

A browser extension for **Chrome, Edge, Brave and Firefox** that fills out job applications for you, and works as a general autofill for sign-ups and checkouts too.

Save your details once: name, contact info, address, links, education, work history, resume, answers to common screening questions, plus (optionally) passwords and payment cards in an encrypted vault. Then press **Alt+Shift+F** (or click the toolbar button) on any application page and JobToFill fills in everything it recognizes. It never submits anything; you review the form and press Submit yourself.

## Features

**Job applications**

- **Smart field detection.** Each field is scored using its `autocomplete` attribute, `<label>`, `aria-label`, placeholder, `name`/`id`, the legend of the group it sits in, ATS attributes (Workday `data-automation-id`, Lever `urls[LinkedIn]`, Greenhouse `job_application[...]`) and nearby text. Tested against Greenhouse (classic and the new job boards, with the real react-select), Ashby, Lever and Workday-style pages.
- **Screening questions.** Answers "Are you legally authorized to work…?", "Will you require sponsorship…?", relocation, over-18, salary, notice period, non-competes, "Do you have offers from other firms or deadlines?", start date and "How did you hear about us?". It knows the trap where _"authorized to work… without sponsorship?"_ needs a **Yes**, and leaves "If you said yes above…" boxes empty when your answer was No.
- **Dropdowns, radios and checkboxes.** "USA" matches "United States of America" or an option with value `US`, and "CA" matches "California". "No" matches "I am not a protected veteran", "BSc" matches "Bachelor’s", and 6 years matches the "5–10" range.
- **Dates against terms.** A May 2027 graduation picks "Spring/Summer 2027", "Spring 2027", "Q2 2027" or "Class of 2027", whichever the list offers; December picks "Fall". A year on its own counts as a June graduation.
- **Lists.** Your preferred locations tick every matching office checkbox ("Which other locations would you relocate to?"), and a single "Preferred location" dropdown gets the first one it offers. Skills checklists ("Which programming languages do you use?") work the same way.
- **Custom dropdowns.** Opens react-select (single and multi), Workday listboxes and async search boxes (school pickers), reads every option, picks the best match and checks the site registered it. If nothing fits it leaves the box empty instead of half-typed.
- **Custom buttons and toggles.** Yes/No toggle buttons (Ashby), `role="radio"` / `role="checkbox"` widgets (Radix, Headless UI) and switches, not just native inputs.
- **Multiple education and job entries.** When a form repeats its _School_ or _Job title_ section, each copy gets the next entry from your profile. "From", "To" and "Location" boxes take their meaning from the section they sit in, and split month/year boxes are handled.
- **Resume and cover letter upload.** Your files are attached to the right upload fields, even when every button just says "Attach". A cover-letter upload never gets your resume.
- **Custom answers.** Rules like "_why do you want to work_" → your answer. You can match with plain phrases, `a | b` alternatives or `/regex/`.
- **Learn from this page.** After you type answers into an unusual form, one click saves them, either as profile values or as custom answers for next time.
- **Acknowledgement boxes** ("I have read the privacy notice", "Acknowledge/Confirm"). Left for you by default, with a one-click _Always tick these_ in the popup. Marketing and talent-pool opt-ins are never ticked.
- **Voluntary EEO questions** (gender, race, veteran, disability). These are opt-in, and "— don't fill —" is the default.
- **Application log.** Every job application you fill is recorded, and the log can be exported as CSV.
- **Multiple profiles.** For example "Software engineer", "Data analyst" and "Personal shopping", each with its own resume.

**Cover letters and tailored CVs (AI)**

- **Write cover letter** in the popup, on any application. JobToFill finds the job's real description, writes a one-page letter in your voice from your CV, checks every fact, and attaches the PDF to the form (and pastes the text into "cover letter" boxes). The next steps of the same application get it too.
- **Finds the actual job.** It checks the application page itself, the job site's public listing APIs (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Oracle…), "View job" links, the page you came from and, if you allow it, your browsing history. Pages that only render with scripts are read in a background tab. Then it **proves it's the same job** (same job ID, company and title) before writing; if it's unsure, the AI double-checks, and you can always paste the job instead.
- **Your style.** Add letters you've written before (PDF, Word or text). New letters copy their voice, structure and length, and reuse what they say about you. They never reuse the company they were written for.
- **Bulletproof facts.** Every draft is checked before you see it, and failures go back to the model to fix:
  - every number must appear in your CV, notes or the posting;
  - tools and skills it claims must be yours;
  - names must be real;
  - it must name the right company, with no other company's name leaking in from an example letter;
  - no placeholders, markdown, clichés or em dashes, and a sensible length.

  A second AI pass reads the letter against your CV and flags any claim about you that isn't backed up. Whatever is still doubtful is listed for you to check.

- **Eligibility check.** If the posting has hard requirements (graduation year, right to work, clearance, degree), it tells you when your profile doesn't seem to meet them.
- **Looks like a LaTeX letter.** The PDF is typeset like the classic LaTeX letter: Latin Modern (Computer Modern) fonts, TeX-style justified paragraphs with hyphenation, your name and a contact line with clickable links, and it always fits on one page. The text stays selectable, so applicant tracking systems can read it.
- **Tailor my CV.** Rewords and reorders your CV around the job's keywords, using only facts already in it. It shows keyword coverage before → after and a list of every change. If you choose to, it uploads the tailored PDF instead of your usual CV for that application.
- **Edit freely.** The letter is editable, the PDF preview updates as you type, and the checks re-run on your edits. Use "Rewrite" with an instruction such as "mention my chess" or "shorter".
- **Bring your own model.** DeepSeek V4.1 Flash through [OpenRouter](https://openrouter.ai) by default (about a tenth of a cent per letter, ~10 seconds), DeepSeek's own API, or any OpenAI-compatible provider. Settings › _Cover letters_.

**General autofill**

- Checkout and shipping forms, including country/state codes, phone numbers and split names. A "Company (optional)" box on a shipping form is _not_ filled with your employer.
- **Encrypted vault** for passwords and cards (AES-256-GCM with a PBKDF2 key from your master password, auto-lock).
  - Sign-up pages: a unique strong password is generated for "Create password" + "Confirm password" and saved for that site, so a Workday account for every employer is no longer painful. Choosing a single default password instead is also an option.
  - Login pages: the saved password for that site is filled.
  - Checkout pages: the selected card is filled, including inside payment-provider iframes such as Stripe.
- **Right-click menu.** _Fill this page_, _Insert from profile → Email / LinkedIn / …_ into any box, and _Generate strong password_.

**Also**

- Works inside cross-origin iframes (embedded Greenhouse boards) and open shadow DOM (web components).
- **Show detected fields** labels every field with what JobToFill thinks it is: green means ready, amber means your profile lacks it, grey means unknown.
- **Undo** puts back whatever was on the page before the fill.
- Only empty fields are filled unless you turn on _Overwrite_, and filled fields are outlined.
- Light and dark mode, an automatic backup file, and import/export.

## Install

JobToFill isn't in the extension stores yet. One `extension/` folder works unpacked in every supported browser.

**Chrome, Edge, Brave, Opera, Vivaldi, Arc**

1. Download this repository (or `git clone` it).
2. Open `chrome://extensions` (`edge://extensions` in Edge).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the **`extension/`** folder.

To update after `git pull`, click the reload arrow on JobToFill's card; there's no need to remove it. The manifest pins the extension ID, so moving the folder and loading it from the new place keeps your details too.

**Firefox 142 or newer: permanent install** (recommended)

Regular Firefox only keeps add-ons that Mozilla has signed. Mozilla signs self-distributed add-ons for free without listing them anywhere, and this repository's _Firefox release_ workflow does that for you and publishes the result as a GitHub release, which Firefox then updates itself from.

1. **Get Mozilla API credentials (once).** Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/), accept the developer agreement, open [Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/) and click **Generate new credentials**. Keep the page open.
2. **Give them to GitHub (once).** In this repository on GitHub: **Settings › Secrets and variables › Actions › New repository secret**. Add `AMO_API_KEY` with the _JWT issuer_ (looks like `user:12345678:123`), then `AMO_API_SECRET` with the _JWT secret_.
3. **Sign it.** **Actions › Firefox release › Run workflow**. After a few minutes a release appears under **Releases**.
4. **Install it.** Download `jobtofill.xpi` from the latest release, open `about:addons` in Firefox, click ⚙ › **Install Add-on From File…**, choose the file and click **Add**. If you had loaded it temporarily before, remove that copy in `about:debugging` first.
5. If the toolbar popup shows **Allow JobToFill on websites**, click **Allow**. Firefox asks for site access separately.

Firefox checks the release for updates daily (or right away with ⚙ › **Check for Updates** in `about:addons`). To ship your latest changes, run the workflow again.

The same signing works from your own computer: `RELEASE_NUMBER=<higher than the last> WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npm run sign:firefox` leaves `jobtofill.xpi` in `dist/release/`.

**Firefox: temporary install** (for development)

1. Download this repository (or `git clone` it).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose **`extension/manifest.json`**.

Firefox removes temporary add-ons when it restarts.

In both browsers the settings page opens on install. Fill in your profile and pin the toolbar icon. `npm run build` writes store-ready zips for both browsers to `dist/`.

**Your details survive re-installs.** Removing an extension deletes everything it stored (and so does Firefox's restart for temporary add-ons). JobToFill therefore keeps a copy in **Downloads › JobToFill › jobtofill-backup.json**, rewritten half a minute after each change. When it is added again and starts out empty, the settings page and the popup offer to restore that file in one click. Automatic backups can be switched off under _Backup & restore_.

## Using it

| Do this                        | How                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Fill the page                  | **Alt+Shift+F**, the toolbar button → _Fill this page_, or right-click → _Fill this page_   |
| See what was detected          | Toolbar → _Show detected fields_                                                            |
| Save answers you typed         | Toolbar → _Learn from this page_                                                            |
| Insert one value               | Right-click a box → _Insert from profile_                                                   |
| New password on a sign-up form | Right-click the password box → _Generate strong password_ (or just fill the page)           |
| Undo a fill                    | _Undo_ in the popup or in the on-page toast                                                 |
| Write a cover letter           | Toolbar → _Write cover letter_ on the application page (set up a key under _Cover letters_) |

To change the shortcut, open `chrome://extensions/shortcuts` in Chromium browsers, or in Firefox go to `about:addons`, click ⚙, then **Manage Extension Shortcuts**. The settings page links there too.

### Try it on the demo forms

```bash
npm install
npm run demo        # serves the test forms at http://localhost:8080/
```

The demo includes Greenhouse-, Workday- and Lever-style applications, searchable dropdowns, a checkout, sign-up/login pages, a cross-origin embed and a page of deliberately tricky fields.

## Privacy and security

- **Nothing leaves your browser** unless you use the cover letter writer. There are no servers or analytics. The profile lives in the extension's local storage, plus the backup file in your own Downloads folder.
- **The cover letter writer** sends the job description, your CV's text, your profile, notes and example letters to the AI provider you chose, with your own API key, and only when you ask for a letter. In Firefox it asks for your permission first. The key stays in this browser and is never included in backups or exports. Job descriptions are fetched from the job sites directly, without your cookies. Browsing history is only searched if you switch that on; it is searched locally, and only the matching job pages are opened.
- **Nothing runs until you ask.** The fill code is injected into a page only when you press the shortcut or a button. It is not loaded on every site you visit.
- **The backup file is yours.** It is written only to your Downloads folder and contains your profile as plain JSON (the vault stays encrypted). Turn it off under _Backup & restore_ if you'd rather not keep one.
- **The vault is encrypted** with AES-256-GCM. The key is derived from your master password (PBKDF2-SHA256, 600,000 iterations) and is kept only in memory (`storage.session`) while unlocked. Content scripts can't read it. The vault auto-locks after inactivity (30 minutes by default) and always locks when the browser closes. Backups contain the vault still encrypted.
- **Secrets are guarded:**
  - Passwords and cards are only handed out during a fill you started.
  - They are only filled on HTTPS pages (or `localhost`).
  - They only go into visible fields: off-screen "honeypot" and hidden fields are skipped.
  - Saved passwords only go to the site they belong to.
  - Cards only go to the top page, the same site, or known payment processors' frames, never to an arbitrary third-party iframe.
- **Never submits.** Acknowledgement and terms checkboxes are left for you unless you turn on _Tick acknowledgement boxes_; marketing, newsletter and talent-pool opt-ins are never ticked.
- **Works under strict Content-Security-Policies.** The on-page toast and labels are styled through the DOM, so a site's CSP can't block them, and no page script ever sees the extension's code.
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
- ✅ Custom Q&A rules and _Learn from this page_
- ✅ Encrypted vault: per-site generated passwords for ATS sign-ups, cards for checkout
- ✅ Inspect overlay, undo, application log, multiple profiles, backup/restore
- ✅ One codebase for Chromium browsers and Firefox, tested end-to-end in both
- 💡 **AI-drafted answers** for open questions ("Why us?") using your summary, the job description on the page and a model API key you provide
- 💡 **Cover-letter templates** with `{company}` / `{role}` filled from the job posting
- 💡 **Workday "Add another"**: click _Add_ for each extra education/job entry automatically
- 💡 **Auto-advance** multi-step applications (fill, then _Next_, then fill again), always stopping before _Submit_
- 💡 **Resume import** to parse a PDF/DOCX or LinkedIn export into the profile
- 💡 **Application tracker** with status (applied → interview → offer) and follow-up reminders, built on the existing log
- 💡 Optional encrypted **sync** between browsers, and Chrome Web Store / Firefox Add-ons listings
- 💡 More languages for label detection (rules already cover some German, French and Spanish)

## Known limitations

- Detection is heuristic. Unusual forms may need a custom answer, or one right-click _Insert from profile_. _Show detected fields_ shows what was recognized.
- Workday-style date "spinners" and some heavily customized widgets may ignore programmatic input. JobToFill reports those as "No matching option" so you know to check them.
- Undo can't clear a dropdown that has no clear (×) button, or remove a file once the site has replaced its upload box.
- "Enter manually" cover-letter boxes that only appear after a click aren't opened for you.
- Sections that only appear after clicking _Add another_ aren't added automatically yet.
- It can't fill CAPTCHAs or closed shadow roots, and won't run on browser pages or extension stores.
- The cover letter writer needs an AI provider account (OpenRouter, DeepSeek or similar). Its checks catch invented numbers, skills, names and claims, but read the letter before you send it: the AI can still describe something more strongly than you would.
- Job descriptions behind a login (some Workday, Oracle or SuccessFactors sites) can't always be fetched. Open the job page and start from there, or paste the description.
- CV text is read from text-based PDFs and Word files. Scanned (image-only) PDFs have no text to read.

## Development

```
extension/
  manifest.json        Manifest V3, shared by Chromium (service worker) and Firefox (background scripts)
  background.js        injection, fill orchestration, vault access, menus, shortcut
  lib/                 classic scripts shared by every context (and the Node unit tests)
    fields.js          profile schema, field types, detection rules, value resolution
    matcher.js         classification, section/entry planning, option matching, formatting
    geo.js             countries (ISO codes + aliases) and US/CA/AU regions
    vault.js           encryption, password generator, lock/unlock
    store.js           profiles, settings, documents, history, backups, cover letter material and letters
    util.js            text normalization, dates, and JTF.api (browser.* in Firefox, chrome.* elsewhere)
    ai.js              OpenAI-compatible chat client (OpenRouter, DeepSeek, custom): JSON mode, retries, errors
    letter.js          cover letter and CV prompts, and the checks every draft must pass
    jobpage.js         job postings: extraction, ATS APIs, finding the description, same-job validation
    doctext.js         text from PDF and Word files (your CV, example letters), no dependencies
    pdfdoc.js          PDF writer: TeX-style line breaking, embedded fonts, the letter and CV layouts
  fonts/               Latin Modern (GUST font licence) as TrueType subsets, and English hyphenation patterns
  content/             injected on demand into every frame
    dom.js             finds controls (incl. shadow DOM), labels, radio groups
    fill.js            sets values the way frameworks notice, custom dropdowns, files, undo
    main.js            in-page API: fill / learn / inspect / undo / toast
  ui/                  shared styles and helpers for the popup and settings page (ES modules)
  popup/               toolbar popup
  studio/              the cover letter page: find the job, write, check, preview, attach, tailor the CV
  options/             settings page: main.js (shell), profile.js, vault.js, app.js, controls.js
tests/
  unit/                node:test, no browser
  e2e/                 the real extension in Chromium (Playwright) or Firefox (Puppeteer + remote debugging)
  fixtures/            the demo/test forms; src/*.jsx are pages built with real React widgets
                       (react-select), bundled on request by serve.mjs
scripts/               build, static checks, icon rendering
```

There is no build step for development. Edit the files, then reload: **Reload** on `chrome://extensions`, or **Reload** on `about:debugging` in Firefox. `npm run chrome` / `npm run firefox` start a fresh browser with the extension loaded that reloads it automatically when files change (via [web-ext](https://github.com/mozilla/web-ext)).

```bash
npm install
npm run lint          # ESLint, Prettier, file checks, and Mozilla's add-on linter on the Firefox build
npm run format        # Prettier + ESLint fixes
npm run test:unit     # fast, no browser
npm run test:e2e      # the extension in headless Chromium (HEADED=1 to watch)
npm run test:firefox  # the same fill and page tests in Firefox (FIREFOX_BIN=/path/to/firefox if it isn't on PATH)
npm run build         # dist/ zips for the Chrome Web Store and Firefox Add-ons
npm run sign:firefox  # a signed .xpi for a permanent Firefox install (needs AMO API keys, see Install)
                      # .github/workflows/firefox.yml runs it and publishes the GitHub release
```

Adding support for a new kind of field usually means adding a rule to `RULES` and a definition to `DEFS` in `extension/lib/fields.js`, plus a case in `tests/unit/classify.test.js`.
