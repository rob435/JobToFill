# JobToFill — notes for Claude Code

A Manifest V3 browser extension (Chromium and Firefox, one codebase) that fills job applications and everyday
forms from a saved profile, answers what the rules can't with the person's own AI key, writes cover letters and
tailors CVs. Plain JavaScript, no bundler, no runtime dependencies. `docs/features.md` is the product spec: read
its section before changing behaviour. `docs/development.md` has the file tree and the measuring tools. `README.md`
is a short user guide; `docs/install.md`, `using.md`, `settings.md`, `privacy.md` and `troubleshooting.md` have the
detail. Keep the README short: only what everyone needs.

## Invariants (never break these)

- **It never submits an application.** Every click on a page's own buttons goes through `JTF.flow`
  (`content/account.js`), which re-checks the wording against `lib/account.js`: `intent()` for sign-in and sign-up
  pages, `stepIntent()` on an application (a section's "Add" for another entry; with the opt-in setting, a step's
  "Next" / "Save and Continue", never anything `submits()` names). Other code only drives a field's own widget
  (a dropdown, a calendar's arrows, a chip's ×, an upload tile's "From Device", a dialog's Close) and never presses
  anything that would submit a form (`fill.js`'s submit check).
- **Nothing leaves the browser** except to the AI provider the person chose (with their key) and Nylas for codes.
  `docs/privacy.md` is a promise: a new data flow needs an opt-in and a line there.
- **What the AI never sees** (`lib/answers.js` `withheld()`): passwords, card and bank details, and marketing /
  talent-pool / SMS opt-ins, whatever the settings. Unless the person switches that kind on (Settings › _Cover
  letters & AI_ › _Questions the AI may also answer_, `settings.aiSensitive`, all off by default): diversity /
  equal-opportunity questions (any language), declarations and consents, ID numbers and the date of birth; legal,
  health and vetting questions (and the adjustments answer) only when the person wrote answer guidance or switched
  those on. A kind switched on brings its own rules: an EEO question the person left unanswered gets the declining
  option, never an inference; legal and health questions are answered, where the material says nothing, as someone
  with nothing to declare; an ID is used only as the material writes it (`inMaterial()`). With nothing switched on
  the prompts are byte for byte the ones the eval measured (`tests/unit/answers.test.js` hashes them). A withheld
  question's answer never rides along as the question before another (`decide.hidesAnswer`, `questionJson`). Facts
  the material doesn't give are skipped, never guessed. Grades are never converted (a 2:1 never becomes a GPA).
- **Snapshots and page maps in redacted mode carry no personal data.** `tests/e2e/snapshot.test.mjs` asserts it;
  keep it passing and extend it when you add a field to what they carry. A page map that leaves the browser (to
  the AI, in a file) is made with `values: 'redacted'`: the default `'state'` hides typed values but not the
  page's own text ("Welcome back, Ada").
- **Fills stay deterministic.** The rules (`lib/fields*.js`, `lib/matcher.js`) do the filling: fast, free,
  private. AI handles the leftovers; don't route fills through a model.
- Fills must not regress on any fixture: a change for one site runs against all of them in the e2e suite.

## How it fits together

- `lib/` — classic scripts shared by the background, content scripts, extension pages and the Node unit tests.
  Each attaches to the `JTF` namespace and ends with `module.exports` when pure. No `import`/`require` between
  them; load order is the list in `background.js` (`importScripts`, Chromium) which must equal manifest
  `background.scripts` (Firefox) — `scripts/check.mjs` enforces it. `lib/fields.js` is put together from its parts
  (`lib/fields-*.js`, by topic), which load just before it, in the same order wherever it loads (check.mjs again);
  a part shares what the others use on `JTF.fieldParts`.
- `content/` — injected on demand into every frame (`CONTENT_FILES` in `background.js`); `main.js` exposes
  `globalThis.__jtf`, which the background calls per frame through `callFrames(tabId, method, args)`. In Firefox a
  content script sees the page's objects through Xrays: a URL's `searchParams` can't be iterated there (get and has
  work), so `lib/jobpage.js`, which runs in pages too, reads a query with `queryPairs()`
  (`tests/unit/jobpage-xray.test.js` checks).
- **Fill:** `fillTab` → `callFrames('fill')` → `main.js scan()` = `dom.collect()` (controls, labels, groups,
  shadow DOM) → `matcher.plan()` (classification) → `decide.field()` (fill, leave for you or missing, with the value
  from `fields.resolve()`) → `fill.apply()` (sets values the way frameworks notice, drives custom dropdowns) →
  read-back and retry. What goes to the AI is `decide.forAi()`. `lib/decide.js` is DOM-free, so the benchmark scores
  exactly what the fill does.
- **AI answers:** `answerRound` (background) → `answers.answer(chat, …)` with `ai.chat` (`lib/ai.js`: Claude
  through Anthropic's API, and OpenAI-compatible: OpenRouter, DeepSeek, custom). Pipelines take `chat` injected, so they run in Node tests.
- **Letters and CVs:** `studio/studio.js` → `letter.analyse()` / `letter.write()` / `letter.tailor()`; PDFs by
  `lib/pdfdoc.js` (own TeX-style typesetter, embedded fonts in `fonts/`).
- `options/`, `popup/`, `studio/`, `discover/`, `map/`, `quick/`, `ui/` are extension pages (ES modules for `ui/`
  and `options/`); `ui/theme.css` is their shared look.
- Chromium's background is a service worker with no `DOMParser`: HTML parsing goes through `offscreen/`.
  `JTF.api` (in `lib/util.js`) is `browser.*` in Firefox and `chrome.*` elsewhere.

## Common changes

- **A new kind of field or screening question:** a rule in `RULES` (`lib/fields-rules.js`: one ordered list, the
  first of equal scores wins) and a definition in `DEFS` in its topic's part (`lib/fields-education.js` for `edu.*`,
  `fields-work.js` for `job.*`, `fields-diversity.js` for `eeo.*`…), a case in `tests/unit/classify.test.js` (and
  `screening.test.js` for answers), and a bullet in `docs/features.md` with the real question wording.
- **A site or widget that fills wrongly:** reproduce it as a fixture in `tests/fixtures/` that mimics the real
  markup (fixtures are deliberately exempt from Prettier: don't tidy them), or as a page built with the real
  library in `tests/fixtures/src/*.jsx` (bundled on request by `serve.mjs`); add an e2e test; then fix
  `content/dom.js` / `content/fill.js` / `lib/matcher.js`. Test what the widget itself registered, not just what
  the page shows, and that menus close again.
- **A bug-report snapshot** (`jobtofill-snapshot-*.html`) is a ready-made fixture: the redacted page, its frames
  in `<template data-frame-url>`, and the `jtf-trace` JSON at the end with every field, what the fill did and the
  page map.
- **Seeing a live page or fixture as the extension does:** `node scripts/pagemap.mjs <url|fixture.html>` prints
  the page map (outline, every field with its ref, classification and state, actions, frames); `--screenshot`
  writes a full-page screenshot with the refs drawn on. Read both before guessing at a page's structure.
- **Prompt or model changes to the AI features:** measure with `tests/eval/` (README there) before and after;
  tune on the train split, report the test split. The deterministic checks in `answers.js` and `letter.js` stay
  whatever the model.
- **Detection on real forms:** `npm run bench` scores the rules on 55 real forms (a private corpus, cloned beside this
  repo; `tests/bench/README.md`). Run it with `--save` before and `--baseline` after any change to the rules or
  `dom.js` (`--pages` for `dom.js`), and look at every field that got worse.
- **Coverage on real forms:** `tests/live/survey-api.mjs` (`docs/development.md` › _Surveying live application
  forms_) runs the rules over live Greenhouse, Ashby and Lever forms and lists what they don't recognise.

## Commands and definition of done

```bash
npm run lint        # ESLint, Prettier, scripts/check.mjs, build, Mozilla's add-on linter
npm run test:unit   # node:test, no browser, seconds
node --test --test-concurrency=1 tests/e2e/<area>.test.mjs   # the real extension in headless Chromium
npm run test:e2e    # every e2e file (minutes); CI also runs the Firefox list in package.json
```

Done means: `npm run lint` clean, `npm run test:unit` green, the e2e files for every area you touched green (all of
them for changes to `dom.js`, `fill.js`, `matcher.js` or `fields*.js`), and the docs updated for any behaviour a
person would notice: `docs/features.md` for what it does, `docs/settings.md` for a new setting, `docs/privacy.md` for a
new data flow. Firefox isn't installed in cloud sessions; CI covers it, so keep tests to what both drivers share (see
`tests/e2e/harness.mjs`).

## Style

- Prettier: 120 columns, single quotes, trailing commas. Match the surrounding code: dense, small functions, a
  one-line doc comment on each, comments that say why with the real case in quotes (Workday's "…", Jane
  Street's "…"). No new runtime dependencies.
- Words people read (UI, README, toasts, errors): plain British English, curly quotes and apostrophes, settings
  paths as Settings › _Section_, concrete examples over adjectives.
- Commit subject: what changed, in the product's terms ("Jane Street: dropdowns without ARIA, chosen selects'
  hidden labels, and the student questions"); body: a bullet per behaviour, wrapped near 110 columns. No
  conventional-commit prefixes.
