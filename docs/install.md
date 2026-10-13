# Installing JobToFill

Every way to install JobToFill, how to update it, and how to publish your own signed release. The [README](../README.md#install) has the quick version.

JobToFill isn’t in the extension stores yet. One `extension/` folder works unpacked in every supported browser. Each [release](https://github.com/rob435/JobToFill/releases/latest) also carries a copy ready to install: a zip for Chromium browsers and a signed add-on for Firefox.

## Chrome, Edge, Brave, Opera, Vivaldi, Arc

**From a release** (easiest)

1. Download `jobtofill-chrome.zip` from the [latest release](https://github.com/rob435/JobToFill/releases/latest) and unzip it somewhere you’ll keep it: the browser loads JobToFill from that folder every time it starts.
2. Open `chrome://extensions` (`edge://extensions` in Edge).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the unzipped folder (the one with `manifest.json` in it).

To update, unzip the new release over the same folder and click the reload arrow on JobToFill’s card (unpacked extensions don’t update themselves). The zip keeps the extension’s pinned ID, as a clone’s `extension/` folder does, so moving the folder or switching between the zip and a clone keeps your details.

**From source**

1. Download this repository (or `git clone` it).
2. Open `chrome://extensions` (`edge://extensions` in Edge).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the **`extension/`** folder.

To update after `git pull`, click the reload arrow on JobToFill’s card; there’s no need to remove it. The manifest pins the extension ID, so moving the folder and loading it from the new place keeps your details too.

## Firefox

**Firefox 142 or newer: permanent install** (recommended)

Regular Firefox only keeps add-ons that Mozilla has signed. Mozilla signs self-distributed add-ons for free without listing them anywhere, and this repository’s _Release_ workflow does that for you and publishes the result as a GitHub release, which Firefox then updates itself from.

1. **Install it.** Download `jobtofill.xpi` from the [latest release](https://github.com/rob435/JobToFill/releases/latest), open `about:addons` in Firefox, click ⚙ › **Install Add-on From File…**, choose the file and click **Add**. If you had loaded it temporarily before, remove that copy in `about:debugging` first.
2. If the toolbar popup shows **Allow JobToFill on websites**, click **Allow**. Firefox asks for site access separately.

Firefox checks the release for updates daily (or right away with ⚙ › **Check for Updates** in `about:addons`).

**Signing your own release** (for the owner of this repository, or a fork)

Each release carries `jobtofill.xpi` (the signed Firefox add-on, which installs permanently and updates itself), `updates.json` (where Firefox looks for updates) and `jobtofill-chrome.zip`. To make one:

1. **Get Mozilla API credentials (once).** Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/), accept the developer agreement, open [Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/) and click **Generate new credentials**. Keep the page open.
2. **Give them to GitHub (once).** In this repository on GitHub: **Settings › Secrets and variables › Actions › New repository secret**. Add `AMO_API_KEY` with the _JWT issuer_ (looks like `user:12345678:123`), then `AMO_API_SECRET` with the _JWT secret_.
3. **Sign it.** **Actions › Release › Run workflow**. After a few minutes a release appears under **Releases**.
4. **Install it** from that release, as above.

To ship your latest changes, run the workflow again. A fork signs with its own Mozilla account, so it needs an add-on ID of its own first (`browser_specific_settings.gecko.id` in `extension/manifest.json`): Mozilla ties each ID to the account that signed it first.

Leave the workflow’s “Release number” box empty: each release is numbered one past the last (the manifest’s version plus that number, 1.2.0.18 after 1.2.0.17), since Firefox only updates to a higher version. The same release works from your own computer: `WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npm run release` leaves `jobtofill.xpi`, `jobtofill-chrome.zip` and `updates.json` in `dist/release/` (add `-- --publish` to create the GitHub release with the `gh` CLI, or `-- --dry-run` to see what it would do without any keys).

**Firefox: temporary install** (for development)

1. Download this repository (or `git clone` it).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose **`extension/manifest.json`**.

Firefox removes temporary add-ons when it restarts.

## After installing

In both browsers the settings page opens on install. Fill in your profile and pin the toolbar icon. The “Get started” checklist at the top of the settings page shows what’s still to do: each step links to where it’s done and is ticked off as you go. Hide it once you’re set, or bring it back from Settings › _Settings_.

**Your details survive re-installs.** Removing an extension deletes everything it stored (and so does Firefox’s restart for temporary add-ons). JobToFill therefore keeps a copy in **Downloads › JobToFill › jobtofill-backup.json**, rewritten half a minute after each change. When it is added again and starts out empty, the settings page and the popup offer to restore that file in one click. Automatic backups can be switched off under _Backup & restore_.
