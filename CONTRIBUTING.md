# Contributing to JobToFill

The most useful contribution is a form that fills wrongly, reported with its snapshot: open an issue with **A form fills wrongly** and follow it. The rest of this page is for changing the code.

[CLAUDE.md](CLAUDE.md) is the project’s working notes, for people as much as for Claude Code: what the extension must never do, how a fill fits together, and where each common change goes. Read it before your first change; this page doesn’t repeat it.

## Setting up

You need Node.js 22.13 or newer and git.

```bash
git clone https://github.com/rob435/JobToFill.git
cd JobToFill
npm ci                               # the exact versions in package-lock.json
npx playwright install chromium      # for the end-to-end tests (on Linux: --with-deps chromium)
```

There is no build step. Load the `extension/` folder itself and reload it after each edit:

- **Chrome, Edge, Brave:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `extension/`. After an edit, click the reload arrow on JobToFill’s card.
- **Firefox 142 or newer:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and choose `extension/manifest.json`. After an edit, click **Reload**.

`npm run demo` serves the test forms at http://localhost:8080/: Greenhouse-, Workday- and Lever-style applications, real widget libraries, sign-up pages, a checkout and some deliberately tricky fields. Fill them with a made-up profile.

Or let [web-ext](https://github.com/mozilla/web-ext) do the loading: with `npm run demo` running, `npm run chrome` or `npm run firefox` starts a fresh browser on the demo forms with the extension loaded, and reloads it whenever a file changes.

To see a page the way JobToFill does, every field with what the rules take it for, run `node scripts/pagemap.mjs <address or fixture name>`; `--screenshot page.png` draws each field’s ref on the page.

## Tests

```bash
npm run lint          # ESLint, Prettier, the manifest and file checks, the build, Mozilla's add-on linter
npm run format        # Prettier and ESLint fixes
npm run test:unit     # no browser, seconds
node --test --test-concurrency=1 tests/e2e/<area>.test.mjs   # one area in headless Chromium (HEADED=1 to watch)
npm run test:e2e      # every end-to-end file, a few minutes
npm run test:firefox  # the Firefox list (Firefox 142+ on PATH, or FIREFOX_BIN=/path/to/firefox)
npm run bench         # the rules on 55 real forms, field by field: needs the private corpus beside this repository
```

CI runs lint, the unit tests and both browsers’ end-to-end tests on every push, and on pull requests from forks.

## Done means

- `npm run lint` clean and `npm run test:unit` green.
- The end-to-end files for every area you touched green; all of them for changes to `dom.js`, `fill.js`, `matcher.js` or `fields*.js`. A fix for one site must not break another.
- A change to the rules or to `dom.js`: `npm run bench -- --save /tmp/before.json` before, `npm run bench -- --baseline /tmp/before.json` after (`--pages` too for `dom.js`), and every field that got worse looked at. The corpus is private: if you can’t run it, say so in the pull request.
- The README updated for anything a person would notice: a Features bullet with the real question wording, and a line in _Privacy and security_ for any new data flow (which also needs an opt-in).
- The invariants in [CLAUDE.md](CLAUDE.md) still hold. Above all: it never submits an application, and nothing leaves the browser except to the AI provider the person chose and to Nylas.

Tests stay to what both browser drivers share (`tests/e2e/harness.mjs`), since CI runs many of them in Firefox too.

## From a bug-report snapshot to a test

A snapshot (`jobtofill-snapshot-<site>-<date>.html`, from the popup’s **Save a snapshot for a bug report**) is the form with the person taken out: typed values left out, personal details replaced by placeholders, scripts removed. It is most of a fixture already.

1. **Read it.** Open it in a browser. At the end, the `jtf-trace` JSON holds every field, what the fill did with each, and the page map (`pageMap`); the page’s other frames follow the page in `<template data-frame-url="…">` blocks.
2. **Make it a fixture.** Save it as `tests/fixtures/<site>.html` (`bamboohr.html`, `janestreet.html`). `npm run demo` serves it, and `node scripts/pagemap.mjs <site>.html` maps it. Cut what isn’t the form, but keep the markup as the site wrote it: fixtures are exempt from Prettier, so don’t tidy them.
3. **Give it the site’s behaviour.** The snapshot keeps the markup but not the scripts, so a custom dropdown, upload tile or date picker needs a small script that does what the site’s does (`janestreet.html` re-creates Jane Street’s dropdowns), or, for a known library, a page built with the real library in `tests/fixtures/src/<name>.jsx`. Remove the Content-Security-Policy `<meta>` at the top once the page has a script. A frame becomes a page of its own, loaded in an `<iframe>` (`embed.html` loads one from the other origin).
4. **Write the test** in `tests/e2e/<site>.test.mjs` (`janestreet.test.mjs` is a good model): fill the page, then check each field’s value and what the widget itself registered, not just what the page shows, and that menus closed again.
5. **Fix it** in `content/dom.js`, `content/fill.js`, `lib/matcher.js` or the rules (`lib/fields-rules.js`), then run every end-to-end file and the benchmark.

## Commits

The subject says what changed, in the product’s terms: “Jane Street: dropdowns without ARIA, chosen selects’ hidden labels, and the student questions”. The body has a bullet per behaviour, wrapped near 110 columns. No `fix:` or `feat:` prefixes.

In code: Prettier’s 120 columns, single quotes and trailing commas; small functions with a one-line doc comment; comments that say why, quoting the real case (Workday’s “…”). No runtime dependencies: everything in `package.json` is a development tool. Words people read (the interface, the README, messages) are plain British English with curly quotes.
