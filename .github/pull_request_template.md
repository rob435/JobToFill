<!-- What changed, in the product’s terms (“Jane Street: dropdowns without ARIA…”), a bullet per behaviour, and why. -->

## Done means

- [ ] `npm run lint` is clean and `npm run test:unit` passes
- [ ] The e2e files for every area touched pass (all of them for `dom.js`, `fill.js`, `matcher.js` or `fields*.js`)
- [ ] A site that filled wrongly has a fixture that mimics its markup, and an e2e test
- [ ] Rules or `dom.js` changed: `npm run bench` saved before, compared after, and every field that got worse looked
      at (the corpus is private: say so if you couldn’t run it)
- [ ] The README says what a person would notice: Features, and Privacy and security for any new data flow
- [ ] The invariants in [CLAUDE.md](https://github.com/rob435/JobToFill/blob/main/CLAUDE.md) hold: it never
      submits, nothing leaves the browser but for the person’s AI provider and Nylas, the AI never sees what
      `withheld()` keeps back, snapshots and redacted page maps carry no personal data, and fills stay with the rules
