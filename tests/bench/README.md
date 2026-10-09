# Detection benchmark

Scores the rules on real application forms: what a fill would leave in every field of 55 forms found in dry runs on
niche Trackr postings (1,085 fields, 9 October 2026), against the answer a careful person with the same profile would
give. It is how a change to `lib/fields*.js`, `lib/matcher.js` or `content/dom.js` shows what it does to real forms,
not only to the fixtures it was written for.

It runs exactly what ships: each field is decided by `lib/decide.js`, the code the fill itself decides with
(`content/main.js`, `content/fill.js`), as the live survey's fictional applicant (`SURVEY_PROFILE` in
`tests/live/profile.mjs`, with a CV and a cover letter, on 9 October 2026). What the fill leaves empty goes to the AI
only as far as the AI round would take it: `answers.withheld` keeps diversity questions, declarations and (without
answer guidance) legal and vetting questions back, so those count as left for the person. Nothing is re-implemented
and nothing is sent anywhere.

## The corpus

The forms are the employers' pages, so they live in a private repository (`rob435/JobToFill-bench`), not here. Clone it
beside this one (`../JobToFill-bench`), or point to it with `JTF_BENCH=/path` or `--corpus /path`. Its README says how
it is laid out and how expected answers are written: `{ "fill": "…" }`, `{ "ai": true }`, `{ "empty": true }`,
`{ "blank": true }` or `{ "skip": true }` for each field.

A form whose page is read again (`--pages`) needs its stylesheets beside it, or every control the site hid with CSS (a
widget's own `<select>` under its menu, a closed dialog) reads as a field. Save them once for a new form, as the sites
serve them now; only the rules that apply to something on that page are kept (BCG's 59 MB come to 566 KB):

```bash
node tests/bench/styles.mjs --only 95-new-form      # writes forms/95-new-form/styles.css; --force to fetch again
```

## Running it

```bash
npm run bench                                    # the rules, on the fields as captured live (under a second)
npm run bench -- --pages                         # content/dom.js too: each saved page read again in Chromium
npm run bench -- --only 58-alloyed,82-eastdil-secured --all
npm run bench -- --save /tmp/before.json         # keep a run…
npm run bench -- --baseline /tmp/before.json     # …and list what changed since (exit code 1 if anything got worse)
npm run bench -- --draft                         # write each form's expected.draft.json from what the rules do now
```

Without `--pages` the fields are those `dom.js` read on the live site, widgets and all, so only the rules are measured;
a list the capture cut at 120 options (countries) is scored only when it comes out right, and a menu whose options
weren't captured (react-select, Ant Design) only on whether something goes in. `--pages` loads each saved page
(scripts stripped, its saved `styles.css` in place of the site's stylesheets, every network request refused) into the
extension in headless Chromium and reads it again: `dom.js` changes count, but script-driven widgets are frozen as
they were saved. A menu that loads its options when opened has none in a saved page, so it gets the ones the live
capture read from it, as a fill gets them by opening it.

The two readings don't always name a field alike: a newer `dom.js` reads a label the capture missed, or leaves out a
note the capture kept ("Single line text." after each of Microsoft Forms' questions). An expected answer says so in its
entry: `"pages": "<key>"` is its key in the page read again, `"pages": false` that reading has no such field (a
reCAPTCHA frame isn't saved), and `"live": false` that the capture has none, or none that can be scored (a label it
didn't read, options that lost their "A*"). "expected but not found" counts the entries a reading couldn't place: each
is a key to update.

## What the numbers mean

Every field gets a verdict:

- **right**: as expected.
- **wrong**: a value went in that shouldn't have: another value, or one where the field should have stayed empty. The
  worst kind: it is on the application unless the person spots it.
- **missed**: nothing went in where the profile has the answer.
- **routed**: left empty either way, but sent to the AI when it was the person's to answer, or the other way round.
- **unscored**: no expectation (`skip`, or none written).

The scoreboard prints each form's counts, the total share of scored fields that came out right, then every wrong and
missed field with what the rules did and what was expected (`--all` adds the routed ones). With `--baseline`, it lists
the fields that got better, worse or changed since that run: run it before and after a change to the rules, and look at
every one that got worse.

When a field is wrong because the expectation is, fix `expected.json` in the corpus (and say why in its `note`); when the
rules are, fix them, add the case to the unit or e2e tests, and the benchmark shows the gain.
