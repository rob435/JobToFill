# JobToFill — notes for Claude Code

A Manifest V3 browser extension (Chromium and Firefox, one codebase) that fills job applications and everyday
forms from a saved profile, answers what the rules can't with the person's own AI key, writes cover letters and
tailors CVs. Plain JavaScript, no bundler, no runtime dependencies. `README.md` is the product spec: read its
Features list before changing behaviour, and its Development section for the file tree.

## Invariants (never break these)

- **It never submits an application.** Every click on a page's own buttons goes through `JTF.flow`
  (`content/account.js`), which re-checks the wording against `lib/account.js`: `intent()` for sign-in and sign-up
  pages, `stepIntent()` on an application (a section's "Add" for another entry; with the opt-in setting, a step's
  "Next" / "Save and Continue", never anything `submits()` names). No other code clicks a page's buttons.
- **Nothing leaves the browser** except to the AI provider the person chose (with their key) and Nylas for codes.
  README › _Privacy and security_ is a promise: a new data flow needs an opt-in and a line there.
- **What the AI never sees** (`lib/answers.js` `withheld()`): diversity/equal-opportunity questions (any
  language), declarations and consents, identity numbers; legal, health and vetting questions only when the
  person wrote answer guidance. Facts the material doesn't give are skipped, never guessed. Grades are never
  converted (a 2:1 never becomes a GPA).
- **Snapshots and page maps in redacted mode carry no personal data.** `tests/e2e/snapshot.test.mjs` asserts it;
  keep it passing and extend it when you add a field to what they carry. A page map that leaves the browser (to
  the AI, in a file) is made with `values: 'redacted'`: the default `'state'` hides typed values but not the
  page's own text ("Welcome back, Ada").
- **Fills stay deterministic.** The rules (`lib/fields.js`, `lib/matcher.js`) do the filling: fast, free,
  private. AI handles the leftovers; don't route fills through a model.
- Fills must not regress on any fixture: a change for one site runs against all of them in the e2e suite.

## How it fits together

- `lib/` — classic scripts shared by the background, content scripts, extension pages and the Node unit tests.
  Each attaches to the `JTF` namespace and ends with `module.exports` when pure. No `import`/`require` between
  them; load order is the list in `background.js` (`importScripts`, Chromium) which must equal manifest
  `background.scripts` (Firefox) — `scripts/check.mjs` enforces it.
- `content/` — injected on demand into every frame (`CONTENT_FILES` in `background.js`); `main.js` exposes
  `globalThis.__jtf`, which the background calls per frame through `callFrames(tabId, method, args)`.
- **Fill:** `fillTab` → `callFrames('fill')` → `main.js scan()` = `dom.collect()` (controls, labels, groups,
  shadow DOM) → `matcher.plan()` (classification) → `decide.field()` (fill, leave for you or missing, with the value
  from `fields.resolve()`) → `fill.apply()` (sets values the way frameworks notice, drives custom dropdowns) →
  read-back and retry. What goes to the AI is `decide.forAi()`. `lib/decide.js` is DOM-free, so the benchmark scores
  exactly what the fill does.
- **AI answers:** `answerRound` (background) → `answers.answer(chat, …)` with `ai.chat` (`lib/ai.js`,
  OpenAI-compatible: OpenRouter, DeepSeek, custom). Pipelines take `chat` injected, so they run in Node tests.
- **Letters and CVs:** `studio/studio.js` → `letter.analyse()` / `letter.write()` / `letter.tailor()`; PDFs by
  `lib/pdfdoc.js` (own TeX-style typesetter, embedded fonts in `fonts/`).
- `options/`, `popup/`, `studio/`, `discover/`, `ui/` are extension pages (ES modules for `ui/` and `options/`).
- Chromium's background is a service worker with no `DOMParser`: HTML parsing goes through `offscreen/`.
  `JTF.api` (in `lib/util.js`) is `browser.*` in Firefox and `chrome.*` elsewhere.

## Common changes

- **A new kind of field or screening question:** a rule in `RULES` and a definition in `DEFS`
  (`lib/fields.js`), a case in `tests/unit/classify.test.js` (and `screening.test.js` for answers), and a
  Features bullet in the README with the real question wording.
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
- **Coverage on real forms:** `tests/live/survey-api.mjs` (README › _Surveying live application forms_) runs the
  rules over live Greenhouse, Ashby and Lever forms and lists what they don't recognise.

## Commands and definition of done

```bash
npm run lint        # ESLint, Prettier, scripts/check.mjs, build, Mozilla's add-on linter
npm run test:unit   # node:test, no browser, seconds
node --test --test-concurrency=1 tests/e2e/<area>.test.mjs   # the real extension in headless Chromium
npm run test:e2e    # every e2e file (minutes); CI also runs the Firefox list in package.json
```

Done means: `npm run lint` clean, `npm run test:unit` green, the e2e files for every area you touched green (all of
them for changes to `dom.js`, `fill.js`, `matcher.js` or `fields.js`), and the README updated for any behaviour a
person would notice. Firefox isn't installed in cloud sessions; CI covers it, so keep tests to what both drivers
share (see `tests/e2e/harness.mjs`).

## Style

- Prettier: 120 columns, single quotes, trailing commas. Match the surrounding code: dense, small functions, a
  one-line doc comment on each, comments that say why with the real case in quotes (Workday's "…", Jane
  Street's "…"). No new runtime dependencies.
- Words people read (UI, README, toasts, errors): plain British English, curly quotes and apostrophes, settings
  paths as Settings › _Section_, concrete examples over adjectives.
- Commit subject: what changed, in the product's terms ("Jane Street: dropdowns without ARIA, chosen selects'
  hidden labels, and the student questions"); body: a bullet per behaviour, wrapped near 110 columns. No
  conventional-commit prefixes.
