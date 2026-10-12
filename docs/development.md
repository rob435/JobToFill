# Developing JobToFill

How the code is laid out, how to run it and its tests, and how to measure a change against real application forms. Start with [CLAUDE.md](../CLAUDE.md) for the rules every change keeps (it never submits an application, nothing leaves the browser except to the AI provider and Nylas, what the AI never sees, deterministic fills) and [CONTRIBUTING.md](../CONTRIBUTING.md) for how to send a change. The [feature spec](features.md) says what each behaviour is meant to do; read its section before changing one.

- [The code](#the-code)
- [Running it](#running-it)
- [Surveying live application forms](#surveying-live-application-forms)
- [Measuring detection](#measuring-detection)
- [Measuring the AI features](#measuring-the-ai-features)
- [Page maps](#page-maps)

## The code

```
extension/
  manifest.json        Manifest V3, shared by Chromium (service worker) and Firefox (background scripts)
  background.js        injection, fill orchestration, passwords and cards for the page, menus, shortcut
  lib/                 classic scripts shared by every context (and the Node unit tests)
    fields.js          profile schema, field types, detection rules, value resolution, put together from
    fields-*.js        its parts by topic: values, profile, personal, education, documents, availability,
                       work, diversity, compliance, and rules (RULES, one ordered list)
    matcher.js         classification, section/entry planning, option matching, formatting
    decide.js          what a fill does with each field (fill, leave for you, ask the AI), as the benchmark scores it
    account.js         job-portal accounts: the click allow/deny-list, "already exists" messages, shared-host employers
    geo.js             countries (ISO codes + aliases) and US/CA/AU regions
    passwords.js       saved logins and cards, password generator and page password rules
    redact.js          your details taken out of text, for bug-report snapshots and redacted page maps
    store.js           profiles, settings, documents, history, backups, cover letter material and letters
    util.js            text normalization, dates, and JTF.api (browser.* in Firefox, chrome.* elsewhere)
    discover.js        Discover: registry search, Trackr dedupe, careers crawl, job boards, verification, watchlist checks
    ai.js              chat client: Claude (Anthropic's Messages API, cached) and OpenAI-compatible (OpenRouter,
                       DeepSeek, custom); the providers' suggested models, JSON, retries, fallback, errors
    letter.js          cover letter and CV prompts, and the checks every draft must pass
    cvtex.js           your CV as LaTeX: read into a model the tailoring edits, and written back as .tex
    answers.js         AI answers to the questions a fill leaves empty: what may be sent, limits, prompt, checks
    jobpage.js         job postings: extraction, ATS APIs, finding the description, same-job validation
    pagemap.js         page maps: the frames' maps merged into one page, and its text outline within a budget
    doctext.js         text from PDF and Word files (your CV, example letters), no dependencies
    otp.js             verification emails: the code or link in a message, and whether it is from the site asking
    nylas.js           your recent email through Nylas (read-only), for verification codes
    pdfdoc.js          PDF writer: TeX-style line breaking, embedded fonts, the letter and CV layouts
  fonts/               Latin Modern (GUST font licence) as TrueType subsets, and English hyphenation patterns
  offscreen/           Chromium only: reads job pages' HTML for the background (its service worker has no DOMParser)
  content/             injected on demand into every frame
    dom.js             finds controls (incl. shadow DOM), labels, radio groups
    fill.js            sets values the way frameworks notice, custom dropdowns, files and upload tiles, undo
    account.js         sign-in / sign-up / code pages: what blocks the submit, CAPTCHAs, the allowed clicks
    main.js            in-page API: fill / learn / inspect / undo / toast
    pagemap.js         a frame's page map (injected only when one is asked for), and its refs drawn for screenshots
    snapshot.js        "Save a snapshot for a bug report": the frame's form with your details taken out, and a trace
    otp.js             the code-box watcher, injected on its own into secure pages once Nylas is connected
  ui/                  shared styles and helpers for the popup and settings page (ES modules)
  popup/               toolbar popup
  map/                 the page map viewer: a tab's map to read, search, copy redacted, and click through to the page
  studio/              the cover letter page: find the job, write, check, preview, attach, tailor the CV
  discover/            Discover internships page: search, careers checks, watchlist
  data/firms.json      the registry Discover searches (built by scripts/firms.mjs)
  options/             settings page: main.js (shell), profile.js, letters.js, email.js, passwords.js, app.js, controls.js,
                       setup.js (Get started), edits.js (what the page changed, put onto the profile as stored now)
tests/
  unit/                node:test, no browser
  e2e/                 the real extension in Chromium (Playwright) or Firefox (Puppeteer + remote debugging)
  live/                surveys of live application forms listed on Trackr (not run by npm test, see below)
  bench/               the detection benchmark: real forms (a private corpus) scored field by field (see below);
                       styles.mjs saves each form's stylesheets for reading its page again
  eval/                the AI answers and cover letters scored on live forms and postings, any provider (see below)
  fixtures/            the demo/test forms; src/*.jsx are pages built with real widget libraries
                       (lib-*.html: MUI, Ant Design, Headless UI, Radix, Downshift, select2, chosen,
                       choices.js, Tom Select, form libraries and masks, Element Plus; phenom.html:
                       react-datepicker's month pickers as Phenom sets them up; editors.html:
                       Quill, TipTap, Lexical), bundled on request by serve.mjs, each printing the
                       library's own state into #state for the tests; replicas of real forms
                       (bamboohr.html: BambooHR's menu-button dropdowns and A-level questions;
                       msforms.html: Microsoft Forms' question notes and date picker; eploy.html:
                       an upload in a dialog of its own; workday-steps.html: an application in four steps, its
                       sections' own "Add" and the Review step's "Submit"; dayforce-upload.html: two uploads
                       sharing an id);
                       docs/ CVs in many PDF/Word flavours (make.mjs rebuilds them), jobs/ trimmed
                       real job pages and ATS API replies, letters/ an application and its job posting
scripts/               build, release (signing for Firefox, the GitHub release), static checks, icons, the firms registry,
                       page maps
```

## Running it

There is no build step for development. Edit the files, then reload: **Reload** on `chrome://extensions`, or **Reload** on `about:debugging` in Firefox. `npm run chrome` / `npm run firefox` start a fresh browser with the extension loaded that reloads it automatically when files change (via [web-ext](https://github.com/mozilla/web-ext)).

```bash
npm install
npm run demo          # serves the demo and test forms at http://localhost:8080/
npm run lint          # ESLint, Prettier, file checks, and Mozilla's add-on linter on the Firefox build
npm run format        # Prettier + ESLint fixes
npm run test:unit     # fast, no browser
npm run test:e2e      # the extension in headless Chromium (HEADED=1 to watch)
npm run test:firefox  # the same fill and page tests in Firefox (FIREFOX_BIN=/path/to/firefox if it isn't on PATH)
npm run build         # dist/: zips for the Chrome Web Store and Firefox Add-ons, and one to load unpacked (keeps the key)
npm run release       # a release: the signed .xpi, the Chrome zip and updates.json in dist/release/ (needs AMO API keys,
                      # see README › Install; -- --dry-run needs none, -- --publish makes the GitHub release).
                      # .github/workflows/release.yml (Actions › Release) runs it with --publish
```

Adding support for a new kind of field usually means adding a rule to `RULES` (`extension/lib/fields-rules.js`) and a definition to `DEFS` in the part for its topic (`extension/lib/fields-education.js` for `edu.*`, `fields-diversity.js` for `eeo.*`…), plus a case in `tests/unit/classify.test.js`.

## Surveying live application forms

`tests/live/` measures JobToFill against the forms people actually apply through. It reads the programmes that are open now from Trackr's public tracker lists, then reads each form's questions through its job board's public API: Greenhouse, Ashby, and Lever's server-rendered form. No browser is needed, and nothing is ever submitted. Every question goes through the same classification, value resolution and option matching as a real fill, and the questions left unanswered are printed, most common first.

```bash
node tests/live/survey-api.mjs --limit 150                 # fetch and report (writes tests/live/survey-api-report.json)
node tests/live/survey-api.mjs --from report.json          # re-run the rules on forms fetched before
OPENROUTER_API_KEY=sk-or-… node tests/live/survey-api.mjs --from report.json --ai --forms 10
                                                           # also answer what's left with the AI, and print it
node tests/live/survey.mjs --limit 20                      # the real extension in Chromium on live forms (HEADED=1 to watch)
```

The first survey (117 live forms, 2,408 questions on Trackr's UK and US finance and tech trackers) is what the country-by-country right to work, job-site mapping, on-site and adjustments answers, and AI answers were built from. The rules now fill 1,546 of those questions (64%, up from 60%; about a third of the gain is the new profile answers, the rest is new and corrected rules), and about 30 right-to-work answers that were wrong for a British applicant on US forms are now right. Most of the 461 questions they still don't recognise are firm-specific, and those go to the AI.

## Measuring detection

`tests/bench/` scores the rules on 55 real application forms from the dry runs on niche Trackr postings (1,085 fields), each field with the answer a careful person with the survey applicant's profile would give. It decides every field with `lib/decide.js`, the code the fill itself decides with, and keeps from the AI what the AI round would (`answers.withheld`), so the score is what the extension does. The forms live in a private repository (they are the employers' pages); clone it beside this one. On 9 October 2026 the rules leave no wrong value and miss nothing the profile answers on them: 98.9% of the scored fields come out as expected on the fields as captured, 99.0% with each page read again; what is left is 11 questions sent to the AI that were the applicant's to answer or skip. Run it before and after a change to the rules or to `content/dom.js`, and look at every field that got worse (`tests/bench/README.md`):

```bash
npm run bench -- --save /tmp/before.json                   # the rules on the fields as captured live (under a second)
npm run bench -- --baseline /tmp/before.json               # what got better, worse or changed since
npm run bench -- --pages                                   # content/dom.js too: each saved page read again in Chromium
node tests/bench/styles.mjs --only <form>                  # a new form's stylesheets, saved beside its page
```

## Measuring the AI features

`tests/eval/` runs the AI answers and the cover letter writer, exactly as they ship, on 40 live application forms (276 questions labelled by hand) and 12 postings, for any provider and model, and scores coverage, answers that should never have been given, letters that pass their checks, cost and time; Claude can grade the writing too. Every call is recorded, so a run can be re-scored without a key. Compare models or prompt changes with it before switching (`tests/eval/README.md`):

```bash
OPENROUTER_API_KEY=sk-or-… npm run eval -- --provider openrouter --model deepseek/deepseek-v4.1-flash --split train
npm run eval:scoreboard
```

## Page maps

A page map is a page as JobToFill sees it, written out for a reader who can't see the screen: an AI model reading it as text, or you in a terminal. It is an outline in reading order, through shadow DOM and into every frame, of the page's landmarks, headings and text; every field the fill scans, with a ref (`f1`, `f2`…), its question, options, what it holds and what the rules take it for; the buttons that act on the form (`b1`…, with what they do: next, back, submit, upload, accept or reject cookies…); and the frames (`i1`…). Above the outline: the page's title and address, the job site and widget libraries it is built with, the step of a multi-step form, alerts, dialogs and cookie banners.

```
PAGE "Senior Engineer at Acme - Greenhouse-style application" http://localhost:8080/greenhouse.html  lang=en  platform=greenhouse
FIELDS 24 (4 required, 23 filled, 0 invalid)  ACTIONS 1
# Apply for Senior Engineer
[form]
  f1 text* "First Name" filled → name.first ✓ fill=filled
  f7 file "Cover Letter" no file → file.coverLetter ✗ no value fill=nothing to put
  f11 select "Are you legally authorized to work in the United States?" [Yes | No] chosen "Yes" → job.authorized ✓ fill=filled
  f21 select "Gender" [Male | Female | Decline To Self Identify] filled (answer withheld) → eeo.gender ✓ fill=filled
  b1 submit "Submit Application" (submit)
```

`→ name.first ✓` says what the rules take the field for and that your profile has the answer; `✗ no value` that it hasn't, and `(none: for AI)` that no rule knows the question, so it goes to the AI. A long page is cut to a budget (24,000 characters unless you say otherwise): page text far from the form goes first, then the tail of long option lists, then navigation links. Fields and buttons are never left out, and the last line says what was.

```bash
node scripts/pagemap.mjs greenhouse.html                   # a demo form from tests/fixtures, by its name
node scripts/pagemap.mjs https://job-boards.greenhouse.io/figma/jobs/5458801004
node scripts/pagemap.mjs greenhouse.html --fill            # fill it with the test profile first, then map it
node scripts/pagemap.mjs <page> --screenshot page.png      # and a full-page screenshot with every ref drawn on
node scripts/pagemap.mjs <page> --json map.json            # the whole map as JSON (rects, rules, validity, paths…)
node scripts/pagemap.mjs <page> --max-chars 8000 --wait 3000 --headed
```

It runs the real extension in Chromium, as the end-to-end tests do, with their test profile, and never clicks or submits anything (`--fill` fills the way the Fill button does). A map says what is picked in a field, never what is typed in it, and not which answer an equal-opportunity question has; `--values redacted` also turns your details into placeholders everywhere, as snapshots do, and `--values full` shows what is typed too (for test profiles). Passwords, file names and hidden inputs' values are never on a map. Bug-report snapshots carry the redacted map as `pageMap` in their `jtf-trace` JSON. The popup’s _Page map_ shows the same map in `map/map.html?tab=<id>` (made with `values: 'state'`, budget 60,000 characters). Clicking a line sends `jtf:pagemap-reveal` (`{ tabId, frameId, ref }`), which brings the tab forward and calls `__jtf.pageMapReveal(localRef)` in that frame to scroll the element to the middle and outline it for two seconds. _Copy for an AI chat_ and _Save as text_ use `values: 'redacted'`, whose text the background also clears of the site’s saved logins. The page map's walker (`content/pagemap.js`) goes into a page only when a map is asked for (the background's `jtf:pagemap` message), never with a fill.
