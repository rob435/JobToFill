# JobToFill

[![CI](https://github.com/rob435/JobToFill/actions/workflows/ci.yml/badge.svg)](https://github.com/rob435/JobToFill/actions/workflows/ci.yml)

A browser extension for **Chrome, Edge, Brave and Firefox** that fills out job applications for you, and works as a general autofill for sign-ups and checkouts too.

- **Fills applications from your profile.** Save your details once: name, contact info, address, links, education, work history, resume, answers to common screening questions, plus (optionally) passwords and payment cards. Then press **Alt+Shift+F** (or click the toolbar button) on any application page and JobToFill fills in everything it recognises, on Workday, Greenhouse, Lever, Ashby and the rest.
- **Answers screening questions** from your profile: right to work and sponsorship, country by country; your degree class (a 2:1 is never turned into a GPA); graduation and start dates; “How did you hear about us?”; interview slots; conflicts of interest.
- **Answers what’s left with AI, using your own key.** “Why do you want to join Figma?” or “Which desk interests you most?”: whatever the rules leave empty is answered from your CV and the real job description, checked, and outlined in orange for you to read.
- **Writes cover letters and tailors your CV** for the job you’re applying to: one page in your voice, every fact checked against your CV, attached to the form as a PDF.
- **Signs you in to job portals.** On a job portal’s own sign-in and sign-up pages it can sign you in and create the account for you (a setting, on by default; see [Job-portal accounts](docs/features.md#job-portal-accounts)). It makes a strong password for each site and, once your inbox is connected, types in the codes the portals email you.
- **You stay in charge.** It never submits an application; you review the form and press Submit yourself.
- **Private.** Your details go nowhere but to the AI provider you chose, with your own key, and to Nylas for emailed codes, and only when you use those features. There are no servers or analytics.

## Quick start

1. **Install it.** Download it from the [latest release](https://github.com/rob435/JobToFill/releases/latest): `jobtofill-chrome.zip` for Chrome, Edge, Brave and other Chromium browsers, `jobtofill.xpi` for Firefox. Step by step under [Install](#install).
2. **Follow “Get started”.** The settings page opens on install. The “Get started” card at its top lists what to fill in: your name and email, your CV, your education, an AI key (optional), your inbox for emailed codes (optional), and pinning the toolbar button.
3. **Open a job application and press Alt+Shift+F.** JobToFill fills what it recognises and outlines each field it filled; a summary on the page says what it filled and what it left for you.
4. **Check it, then press Submit yourself.** Read every answer, especially those outlined in dashed orange (written by the AI). JobToFill never submits.
5. **Want a cover letter too?** Open the toolbar popup on the application and click _Write cover letter_, or _Quick apply_ for the letter, a tailored CV and the form in one go. Both need an [AI key](#setting-up-ai-optional).

## Install

JobToFill isn’t in the extension stores yet. One `extension/` folder works unpacked in every supported browser. Each [release](https://github.com/rob435/JobToFill/releases/latest) also carries a copy ready to install: a zip for Chromium browsers and a signed add-on for Firefox.

### Chrome, Edge, Brave, Opera, Vivaldi, Arc

**From a release** (easiest)

1. Download `jobtofill-chrome.zip` from the [latest release](https://github.com/rob435/JobToFill/releases/latest) and unzip it somewhere you’ll keep it: the browser loads JobToFill from that folder every time it starts.
2. Open `chrome://extensions` (`edge://extensions` in Edge).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the unzipped folder (the one with `manifest.json` in it).

To update, unzip the new release over the same folder and click the reload arrow on JobToFill’s card.

**From source**

1. Download this repository (or `git clone` it).
2. Open `chrome://extensions` (`edge://extensions` in Edge).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the **`extension/`** folder.

To update after `git pull`, click the reload arrow on JobToFill’s card; there’s no need to remove it. The manifest pins the extension ID, so moving the folder and loading it from the new place keeps your details too.

### Firefox

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

The same signing works from your own computer: `RELEASE_NUMBER=<higher than the last> WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npm run sign:firefox` leaves `jobtofill.xpi` in `dist/release/`.

**Firefox: temporary install** (for development)

1. Download this repository (or `git clone` it).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose **`extension/manifest.json`**.

Firefox removes temporary add-ons when it restarts.

### After installing

In both browsers the settings page opens on install. Fill in your profile and pin the toolbar icon. The “Get started” checklist at the top of the settings page shows what’s still to do.

**Your details survive re-installs.** Removing an extension deletes everything it stored (and so does Firefox’s restart for temporary add-ons). JobToFill therefore keeps a copy in **Downloads › JobToFill › jobtofill-backup.json**, rewritten half a minute after each change. When it is added again and starts out empty, the settings page and the popup offer to restore that file in one click. Automatic backups can be switched off under _Backup & restore_.

## Using it

| Do this                        | How                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Fill the page                  | **Alt+Shift+F**, the toolbar button → _Fill this page_, or right-click → _Fill this page_           |
| Open the popup                 | **Alt+Shift+J**, or click the toolbar button                                                        |
| See what was detected          | Toolbar → _Show detected fields_                                                                    |
| See the page as JobToFill does | Toolbar → _Page map_: every field, what it’s taken for and what’s missing; click a line to go to it |
| Save answers you typed         | Toolbar → _Learn from this page_                                                                    |
| Insert one value               | Right-click a box → _Insert from profile_                                                           |
| New password on a sign-up form | Right-click the password box → _Generate strong password_ (or just fill the page)                   |
| Undo a fill                    | _Undo_ in the popup or in the on-page toast                                                         |
| Letter, CV and form in one go  | Toolbar → _Quick apply_ (see the result later under _Last quick apply_)                             |
| Write a cover letter           | Toolbar → _Write cover letter_ on the application page (set up a key under _Cover letters & AI_)    |
| Answer the questions left      | Automatic with an AI key; or the popup’s _Answer them with AI_                                      |
| Emailed sign-in codes          | Automatic once your inbox is connected under _Email codes_; or right-click the box                  |
| Sign in / create an account    | Fill the portal’s sign-in or sign-up page: it clicks _Sign in_ / _Create account_ for you           |

To change the shortcut, open `chrome://extensions/shortcuts` in Chromium browsers, or in Firefox go to `about:addons`, click ⚙, then **Manage Extension Shortcuts**. The settings page links there too.

### A typical application

1. **Start from the job’s posting** and click its _Apply_ button. JobToFill remembers the posting, so the cover letter and the AI answers are written for the real job.
2. **Sign in or create the account.** Press **Alt+Shift+F** on the portal’s sign-in or sign-up page. JobToFill signs in with the login it saved for that site, or creates the account with a new strong password, and types in the code the site emails you. If a CAPTCHA appears, solve it: JobToFill carries on once you have.
3. **Fill the application.** Press **Alt+Shift+F** again. Your CV goes into the upload first, then your contact details, education, work history and screening answers. With an AI key, the questions left empty are answered in the same go and outlined in dashed orange. (_Quick apply_ in the popup does all this, plus the cover letter and a tailored CV.)
4. **Read what it says.** The summary on the page and the popup list what was filled, what’s _Missing from your profile_, where there was _No matching option_, and anything outlined in red to _Check_. Type those in yourself, or right-click the box › _Insert from profile_.
5. **Next step.** On an application in steps (Workday’s _My Information_, _My Experience_, _Application Questions_…), click the step’s _Next_ and press **Alt+Shift+F** again, or let JobToFill do it: Settings › _Settings_ › “Move through multi-step applications for me”. It always stops before the step that submits.
6. **Submit it yourself**, once you’ve read every answer.
7. **Teach it.** If you typed answers JobToFill didn’t know, Toolbar → _Learn from this page_ saves them for next time.

## Setting up AI (optional)

Without an AI key, JobToFill fills from your profile alone. With one, it also answers the questions the rules leave empty, writes cover letters and tailors your CV, and Discover can ask it for more firms. You pay your provider directly; JobToFill has no account or server of its own.

| Provider                                   | Models and what a letter costs                                                                                                                   | Get a key                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Claude** (Anthropic’s own API)           | Sonnet 5.5, the all-rounder (about 5¢ a letter); Haiku 5.5, the quickest and cheapest (well under 1¢); or Opus 5.5, the most capable (about 10¢) | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **OpenRouter** (the default)               | DeepSeek V4.1 Flash by default, about a tenth of a cent per letter, or the same Claude models                                                    | [openrouter.ai](https://openrouter.ai/settings/keys)                 |
| **DeepSeek** (DeepSeek’s own API)          | `deepseek-chat`                                                                                                                                  | [platform.deepseek.com](https://platform.deepseek.com/api_keys)      |
| **Other** (any OpenAI-compatible provider) | Any model it offers, at the API address you give                                                                                                 | Your provider’s site                                                 |

1. Get an API key from one of the providers above.
2. Open Settings › _Cover letters & AI_ › _AI model_. Choose the _Provider_, paste the key into _API key_ and pick a _Model_: the list shows each provider’s suggested models with what each is good for, and “Another model…” takes any id the provider offers.
3. Click **Test connection**. In Firefox, JobToFill asks your permission once before anything goes to the provider.
4. That’s it. “Answer new questions with AI when I fill a page” is on by default, so your next fill answers what the rules leave empty, and _Write cover letter_ in the popup works.

**What the AI is used for.** Answers to the questions a fill leaves empty, cover letters, tailored CVs, a second look when JobToFill isn’t sure it found the right job, and _Ask the AI for more ideas_ in Discover. What each of these sends is listed under [Privacy and security](#privacy-and-security).

**Help it answer.** Settings › _Cover letters & AI_ › _Answer guidance_ holds facts and rules the AI may rely on for questions your CV doesn’t settle (“I have no criminal convictions and no regulatory history.”), and Settings › _Skills & writing_ › _Extra details_ anything else an application might ask. Diversity questions, declarations and ID numbers are held back from the AI, and legal and health questions until you’ve written answer guidance, unless you switch them on under “Questions the AI may also answer” (see the [settings reference](#settings-reference)).

**More than one provider.** Each provider keeps its own key and model, so you can switch back and forth. With keys for more than one, another takes over when the one you chose is out of credit, rate-limited or down (Claude first; you can switch that off).

**Fast mode.** Opus 5.5 has a **fast mode** (Settings › _Cover letters & AI_ › _Fast mode_, a research preview on Anthropic’s own API): it writes up to 2.5× as fast for twice the price (about 20¢ a letter); if your key can’t use it yet, Claude writes at its usual speed and _Test connection_ says so. Steps that don’t need reasoning (reading the job, the letter, the fact check, the CV) run without Claude thinking first, as they already do through OpenRouter, so Sonnet and Haiku start writing straight away. JobToFill keeps its instructions and your material in Claude’s prompt cache between the steps of a letter or a page of answers, so the repeated part costs a tenth as much.

## Settings reference

Open the settings from the popup’s _Edit profile & settings_. Everything is saved as you type. The bar at the top switches between profiles (“Software engineer”, “Data analyst”…), each with its own details and files: _New_, _Duplicate_, _Rename_, _Delete_.

### Your profile

| Section                 | What it holds                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Personal & contact_    | Name (your preferred name signs your cover letters; forms get your legal name), email and university email, phone, address, date of birth, nationality                                                         |
| _Links_                 | LinkedIn, GitHub, portfolio, personal website, Twitter / X                                                                                                                                                     |
| _Work eligibility_      | Screening answers (right to work, sponsorship, countries you can work in, office, adjustments, relocation, clearance, offers, non-competes), _Conflicts of interest_, preferences and _Interview availability_ |
| _Education_             | One entry per school or university, most recent first: degree, subject, GPA or UK classification (“2:1”), location, dates                                                                                      |
| _Experience_            | One entry per job, most recent first                                                                                                                                                                           |
| _Skills & writing_      | _Extra details_ for the AI, skills, languages, a summary, and a cover letter for “Cover letter” text boxes                                                                                                     |
| _Resume & files_        | Your CV, a cover letter and an academic transcript, attached to upload buttons                                                                                                                                 |
| _Custom answers_        | “When the question contains…” → “Answer with”: plain phrases, `a \| b` alternatives or `/regex/`                                                                                                               |
| _Voluntary disclosures_ | Equal-opportunity and UK social-mobility answers. Each is “— don’t fill —” until you choose                                                                                                                    |

A question left on “— don’t fill —” is left for you to answer each time.

### Settings › _Settings_

| Setting                                       | Default     | What it does                                                                                                                                                                       |
| --------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overwrite fields that already have a value    | Off         | Off: only empty fields are filled, so nothing you typed gets replaced                                                                                                              |
| Highlight filled fields                       | On          | Outlines each field JobToFill filled until you click into it                                                                                                                       |
| Show a summary on the page                    | On          | The toast after filling with the keyboard shortcut or right-click menu                                                                                                             |
| Operate custom dropdowns                      | On          | Opens searchable dropdowns (Workday, Greenhouse, react-select…) and picks the matching option                                                                                      |
| Tick acknowledgement boxes                    | On          | Privacy-notice, “I confirm” and “I agree with the terms and conditions” boxes; never marketing or talent-pool opt-ins. Off: they’re left for you                                   |
| Keep an application log                       | On          | Remembers each job application page you filled, under Settings › _Application log_ (_Export CSV_ there)                                                                            |
| Sign in and create job-portal accounts for me | On          | On a sign-in or sign-up page you fill, clicks the page’s own _Sign in_ or _Create account_, and fills the emailed code once your inbox is connected. Never an application’s submit |
| Move through multi-step applications for me   | Off         | Clicks a step’s own _Next_ or _Save and Continue_ once it’s filled, then fills the next step. Stops at anything left for you, and before the step that submits                     |
| Keyboard shortcut                             | Alt+Shift+F | _change shortcut_ opens the browser’s shortcut settings                                                                                                                            |

### Settings › _Cover letters & AI_

| Setting                                                                            | Default                                                                                   | What it does                                                                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Provider                                                                           | OpenRouter                                                                                | Claude (Anthropic), OpenRouter, DeepSeek, or Other (OpenAI-compatible)                                                       |
| Model                                                                              | DeepSeek V4.1 Flash on OpenRouter, Claude Sonnet 5.5 on Claude, DeepSeek Chat on DeepSeek | Each provider keeps its own; “Another model…” takes any id the provider offers                                               |
| API key                                                                            | None                                                                                      | One per provider, kept in this browser and your backup file                                                                  |
| API address                                                                        | None                                                                                      | Only for Other (OpenAI-compatible)                                                                                           |
| Fast mode                                                                          | Off                                                                                       | Claude Opus 5.5 only: up to 2.5× as fast, at twice the price (about 20¢ a letter)                                            |
| If it’s out of credit or down, use another provider I’ve added a key for           | On                                                                                        | Another provider you have a key for takes over (Claude first)                                                                |
| Keep my API keys in the backup file, so they come back if JobToFill is reinstalled | On                                                                                        | Off: the keys are left out of the backup file                                                                                |
| Your CV as LaTeX                                                                   | Empty                                                                                     | Paste your CV’s LaTeX and _Save_: tailoring then edits it instead of reading your CV file, and _Download .tex_ gives it back |
| Notes about you                                                                    | Empty                                                                                     | Facts the AI may use besides your CV and profile: projects, results with numbers, awards                                     |
| Answer new questions with AI when I fill a page                                    | On                                                                                        | Off: the popup still offers _Answer them with AI_ for one page                                                               |
| Answer guidance                                                                    | Empty                                                                                     | Facts and rules the AI may rely on for questions your CV doesn’t settle (“I don’t need any adjustments for interviews.”)     |
| Questions the AI may also answer                                                   | All off                                                                                   | See below                                                                                                                    |
| Your example letters                                                               | None                                                                                      | Up to 5 (PDF, Word, text or pasted): new letters copy their voice, structure and length                                      |
| Contact line                                                                       | From your profile                                                                         | The line under your name on the letter; separate items with \|                                                               |
| Sign-off                                                                           | “Yours sincerely,” (“Sincerely,” in American English)                                     | How the letter ends                                                                                                          |
| Spelling                                                                           | From the job’s country                                                                    | Or British English, or American English                                                                                      |
| Paper                                                                              | A4                                                                                        | Or US Letter                                                                                                                 |
| Also look in my browsing history                                                   | Off                                                                                       | Finds the job page you read before clicking _Apply_. Searched in this browser only; asks for the history permission          |

The section also lists the AI’s answers per application and your last 25 letters, with their PDFs.

**Questions the AI may also answer.** These kinds of question are held back from the AI (legal and health ones unless you’ve written answer guidance) until you switch them on. Each is off by default; “All of them” switches every one on.

| Switch                                 | With it on                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diversity and equal opportunity        | Answered from _Voluntary disclosures_; ones you haven’t answered there get “Prefer not to say”. Your answers go to your AI provider                                                                                                                                                                                                                     |
| Declarations and consents              | “The information I have provided is accurate”, privacy notices, typed signatures and AI-use disclosures, answered truthfully. Marketing and talent-pool opt-ins are never ticked                                                                                                                                                                        |
| Government, legal and security vetting | Public officials and politically exposed persons, criminal and regulatory history, clearance, background checks, where you’ve lived: answered from your profile and answer guidance and, where they say nothing, as someone with nothing to declare. Only switch it on if that’s true of you. It never claims a clearance or citizenship you don’t list |
| Health and adjustments                 | Where your profile says nothing: no adjustments needed                                                                                                                                                                                                                                                                                                  |
| ID numbers and date of birth           | Only numbers in your profile, CV or answer guidance, never made up. Passwords and card numbers are never sent                                                                                                                                                                                                                                           |

### Settings › _Email codes_

Connect once: sign up at [dashboard-v3.nylas.com](https://dashboard-v3.nylas.com) (free) and create an app; under _Grants › Add test grant_, sign in to the email you apply with; under _API Keys › Generate new key_, make a key and paste it into _Nylas API key_; click **Connect**, then **Test**.

| Setting                        | Default       | What it does                                                                                                          |
| ------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Nylas API key                  | None          | Read-only access to your newest emails, through Nylas, for the codes                                                  |
| Data region                    | United States | Or Europe, wherever your Nylas app lives (a key from the other region is tried there too)                             |
| Inbox                          | The only one  | Shown when your Nylas app has more than one inbox connected                                                           |
| Fill codes by themselves       | On            | A page asking for “the code we emailed you” gets it typed in. Off: only when you fill the page or right-click the box |
| Open “verify your email” links | On            | When a page says it sent you a link, the link from that site’s email opens in a new tab                               |

### Settings › _Passwords & cards_

| Setting          | Default                                                                  | What it does                                                                                                        |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Sign-up forms    | Generate a unique password for every site and save it here (recommended) | Or “Use my default password everywhere”                                                                             |
| Default password | None                                                                     | Only used when “Use my default password everywhere” is chosen; _Generate_ makes one                                 |
| Saved logins     | None                                                                     | Filled on login pages for the matching site (a saved “example.com” also matches “careers.example.com”); _Add login_ |
| Payment cards    | None                                                                     | The selected card fills checkout forms, including payment providers’ secure frames (Stripe, Adyen, Braintree…)      |

### Settings › _Application log_

Every job application page you filled, with the date, the page, the site, how many fields and which profile. _Export CSV_ downloads it; _Clear log_ empties it.

### Settings › _Backup & restore_

| Setting                               | Default | What it does                                                                                                                                             |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep a backup file up to date         | On      | Downloads › JobToFill › jobtofill-backup.json, saved half a minute after a change, passwords and cards included, unencrypted. _Back up now_, _Show file_ |
| Include resume and cover-letter files | Ticked  | For _Download backup_, a backup you make by hand                                                                                                         |
| Include passwords and cards           | Ticked  | For _Download backup_                                                                                                                                    |
| Include the application log           | Ticked  | For _Download backup_                                                                                                                                    |
| Choose backup file…                   |         | Restores a backup: replaces all profiles and settings in this browser                                                                                    |

## Features

The full list, with the real wording of the questions JobToFill answers, is in [docs/features.md](docs/features.md).

- **[Job applications](docs/features.md#job-applications).** Each field is read the way a person reads it (its label, the group it sits in, the job site’s own attributes) and filled from your profile: text boxes, every kind of dropdown, radios, date pickers, rich-text editors, repeated education and job sections, and your CV, cover letter and transcript uploads. Every answer is read back, and anything the page turned down is outlined in red.
- **[Screening questions](docs/features.md#screening-questions).** Right to work and sponsorship country by country, your degree class, graduation and start dates against a form’s terms, where you heard about the job, interview slots, sanctions, conflicts of interest and criminal history. Equal-opportunity questions only when you’ve answered them.
- **[AI answers](docs/features.md#ai-answers).** With your own key, whatever the rules leave empty is answered in the same fill from your CV and the real job description, checked against both, and outlined in dashed orange.
- **[Cover letters and CVs](docs/features.md#cover-letters-and-cvs).** _Write cover letter_ finds the job, writes a one-page letter in your voice, checks every fact and attaches the PDF. _Tailor my CV_ rewords your CV around the job’s keywords, and _Quick apply_ does both and the form.
- **[Discover internships](docs/features.md#discover-internships-beyond-trackr).** Searches 2,100+ finance firms that Trackr doesn’t list, reads their own careers pages for student roles, and watches the ones you pick.
- **[General autofill](docs/features.md#general-autofill).** Checkout and shipping forms, a strong password for each sign-up, saved logins and payment cards.
- **[Job-portal accounts](docs/features.md#job-portal-accounts).** On a portal’s own sign-in or sign-up page it signs you in or creates the account, and clicks nothing but those buttons.
- **[Verification codes](docs/features.md#verification-codes-from-email).** With your inbox connected through Nylas, “the 6-digit code we just emailed you” is typed in for you, but only from the site that asked.
- **[Also](docs/features.md#also).** Works inside iframes and shadow DOM; _Show detected fields_, _Page map_ and _Undo_; a snapshot of a form, with your details taken out, for bug reports.

## Privacy and security

- **Nothing leaves your browser** unless you use the AI features (cover letters, and answers to the questions a fill leaves empty) or connect your inbox for codes. Discover only fetches public pages (firms’ websites and job boards, Trackr’s public lists, Wikipedia and the SEC adviser search) and sends no personal details; with _Ask the AI_ ticked, your search (not your profile) goes to your AI provider. There are no servers or analytics. The profile lives in the extension’s local storage, plus the backup file in your own Downloads folder.
- **The cover letter writer** sends the job description, your CV’s text, your profile, notes and example letters to the AI provider you chose, with your own API key, and only when you ask for a letter.
- **AI answers** run only once you’ve added an API key, and only on job applications (never on checkout or sign-up pages). They send the empty questions (with their options), the job description, your CV’s text, your profile, notes, answer guidance and your earlier written answers to the same provider. Diversity questions, declarations and ID numbers are never sent, and criminal, regulatory, vetting and health questions only once you’ve written answer guidance, unless you switch them on under Settings › _Cover letters & AI_ › “Questions the AI may also answer” (all off by default). Passwords and card numbers are never sent. Switch it off under Settings › _Cover letters & AI_. In Firefox it asks for your permission first. Your API keys stay in this browser and in your own backup file, so they come back if JobToFill is reinstalled; switch off _Keep my API keys in the backup file_ to leave them out (they are never sent anywhere but to the provider). Job descriptions are fetched from the job sites directly, without your cookies. Browsing history is only searched if you switch that on; it is searched locally, and only the matching job pages are opened. To find the job behind an application, JobToFill remembers the last few job-related pages each tab showed (at most 12, for 3 hours) in the browser’s session memory; they are never written to disk or sent anywhere, and are gone when the browser closes. If you came from a Trackr list, its public programme list is fetched to confirm which job it is.
- **Email codes** are read through Nylas with your own API key: JobToFill asks Nylas for the last few messages of the inbox you connected, received in the last minutes, and picks the code in your browser. It never sends, deletes or marks mail, and no page content goes to Nylas. The key is kept like the AI keys (this browser and your backup file).
- **Nothing runs until you ask.** The fill code is injected into a page only when you press the shortcut or a button. It is not loaded on every site you visit. The one exception is opt-in: once you connect your inbox, a small watcher that only looks for verification-code boxes goes into each secure page as it loads (switch _Fill codes by themselves_ off to stop that).
- **The backup file is yours.** It is written only to your Downloads folder and contains your profile as plain JSON, passwords and cards included. Turn it off under _Backup & restore_ if you’d rather not keep one, or untick _Include passwords and cards_ when you export one by hand.
- **Passwords and cards are kept as they are**, like the API keys: in this browser’s extension storage and in your backup file, unencrypted, so a fill puts them in straight away. Anyone who can open your browser profile or the backup file can read them; web pages can’t.
- **Secrets are guarded:**
  - Passwords and cards are only handed out during a fill you started.
  - They are only filled on HTTPS pages (or `localhost`).
  - They only go into visible fields: off-screen “honeypot” and hidden fields are skipped.
  - Saved passwords only go to the site they belong to.
  - Cards only go to the top page, the same site, or known payment processors’ frames, never to an arbitrary third-party iframe.
- **Never submits an application.** Acknowledgement and terms checkboxes are ticked and counted in the toast (switch _Tick acknowledgement boxes_ off to leave them for you; Quick apply always ticks them and tells you); marketing, newsletter and talent-pool opt-ins are never ticked. Beyond filling (which opens dropdowns, menus and upload tiles, never Dropbox or Google sign-ins), the one thing it clicks for you, with _Sign in and create job-portal accounts for me_ on, is a job portal’s own sign-in or create-account button (and the _Continue_ after an emailed code) on a pure sign-in or sign-up page, as listed under [Job-portal accounts](docs/features.md#job-portal-accounts); on such a sign-up page it also ticks the form’s own terms box, since creating the account means accepting them. Switch the setting off and it only fills. On an application, it clicks a section’s own _Add_ to make room for each of your education and job entries, and, only with _Move through multi-step applications for me_ on, a step’s own _Next_ or _Save and Continue_: each step is then saved with the employer’s site, as when you click it yourself. It stops before the step that submits.
- **CAPTCHAs are never touched.** Nothing is filled or clicked inside a CAPTCHA, and its frames (Google reCAPTCHA, hCaptcha, Cloudflare, Arkose) are skipped entirely.
- **Works under strict Content-Security-Policies.** The on-page toast and labels are styled through the DOM, so a site’s CSP can’t block them, and no page script ever sees the extension’s code.
- **Page maps stay where you put them.** _Page map_ reads the page in your browser and sends nothing anywhere; _Copy for an AI chat_ and _Save as text_ put the map, with your details replaced by placeholders and your saved logins taken out, on your clipboard or disk, for you to paste where you choose.
- **Bug-report snapshots stay on your disk.** _Save a snapshot for a bug report_ writes one HTML file to your computer and sends nothing anywhere. Every typed value is left out, and your names, email, phone, address, postcode, date of birth, links, employers, file names, saved logins and longer written answers become placeholders wherever they appear; so do your equal-opportunity answers. Scripts are removed, and the file blocks scripts and form submission when opened. City, country, school, degree and job titles stay, because the form’s own lists need them.
- The extension needs access to all sites so it can fill application forms embedded from other domains (iframes). It only touches a page when you trigger it.

A dedicated password manager is still the stronger choice for your important accounts. JobToFill’s passwords are aimed at the dozens of throwaway job-portal accounts.

## Troubleshooting

### Nothing happens when I press Alt+Shift+F

- Open the toolbar popup and click _Fill this page_ instead: it says what’s wrong.
- **“Allow JobToFill on websites”** in the popup or on the settings page: click **Allow**. Firefox asks for site access separately from the install, and Chromium browsers ask again if you limited JobToFill’s site access in its details.
- **“JobToFill can’t run on this page”**: browser pages (`chrome://`, `about:`) and the extension stores are off-limits to every extension.
- **The shortcut is taken.** If another extension or the browser already uses Alt+Shift+F, Settings › _Settings_ › _Keyboard shortcut_ may show “not set”. Pick another one: _change shortcut_ opens the browser’s shortcut settings. The toolbar button and right-click › _Fill this page_ work whatever the shortcut.

### A field is wrong or left empty

- Toolbar → _Show detected fields_ labels every field: green means ready, amber means your profile lacks it, grey means JobToFill doesn’t know the question. Toolbar → _Page map_ lists every field with what it was taken for: “✗ no value” means your profile has no answer, “(none: for AI)” that no rule knows the question.
- A field that already had a value is left alone unless _Overwrite fields that already have a value_ is on.
- Fill the gap once: right-click the box › _Insert from profile_, or type the answer and click _Learn from this page_ to keep it. For a question that differs on every site, add a rule under Settings › _Custom answers_ (“why do you want to work” → your answer).
- Still wrong? Click _Save a snapshot for a bug report_ at the bottom of the popup and attach the file to a [new issue](https://github.com/rob435/JobToFill/issues/new). It holds the form with your details taken out, and what JobToFill did with each field, so the form can be rebuilt as a test.

### AI answers don’t appear

- Add a key under Settings › _Cover letters & AI_ and click **Test connection**: it says whether the key works, and why not (no credit, a wrong key, a model the provider doesn’t offer). With keys for two providers, the other one takes over when one is out of credit.
- Check “Answer new questions with AI when I fill a page” is on, or use _Answer them with AI_ in the popup for one page.
- AI answers run only on job applications, never on checkout or sign-up pages.
- The popup’s AI card lists the questions it left for you, and why. Diversity questions, declarations and ID numbers are held back, and legal and health questions until you’ve written _Answer guidance_; switch any of them on under “Questions the AI may also answer”. A fact your CV, profile and guidance don’t give (a referrer’s name, a test score) is left for you rather than guessed.

### Firefox removed JobToFill when it restarted

That was a temporary install from `about:debugging`. Install the signed `jobtofill.xpi` from the [latest release](https://github.com/rob435/JobToFill/releases/latest) instead: it stays installed and updates itself. Your details come back from the backup file (see below).

### My details are gone after reinstalling

The settings page and the popup offer to restore the backup file JobToFill keeps in **Downloads › JobToFill › jobtofill-backup.json**. If they don’t, open Settings › _Backup & restore_ › _Choose backup file…_ and pick it. A Chromium install from source keeps its details when you move the folder, since the manifest pins its ID.

### Emailed codes aren’t filled in

- Connect your inbox under Settings › _Email codes_ and click **Test**: it reads your newest email. The inbox must be the one you apply with.
- Codes are only filled on secure (`https://`) pages, and only from an email that comes from the site asking: the same domain, the same job portal (a Workday page and a Workday email), or an email that links back to the page. A code from anyone else is offered with a _Use it_ button instead.
- With _Fill codes by themselves_ off, codes only go in when you fill the page. Right-click the box › _Insert verification code from email_ takes the newest code, whoever sent it.

### The cover letter can’t find the job

- Open the application from the job’s own page (its _Apply_ button), not from a bookmark or an email link: JobToFill remembers the posting you came from.
- Switch on Settings › _Cover letters & AI_ › _Also look in my browsing history_, so it can find the posting you read earlier.
- Or click _Wrong job? Paste it_ on the cover letter page and paste the job’s address or its description.

## Known limitations

- Detection is heuristic. Unusual forms may need a custom answer, or one right-click _Insert from profile_. _Show detected fields_ shows what was recognised.
- Some heavily customised widgets may ignore programmatic input. A box that doesn’t keep a value set from script is typed into key by key, then pasted into; one that still doesn’t keep it, or keeps turning it down, is outlined in red and listed under _Check_ so you know to look.
- Undo can’t clear a dropdown that has no clear (×) button, a radio choice, or a date typed in parts (MUI X), or remove a file once the site has replaced its upload box.
- “Enter manually” cover-letter boxes that only appear after a click aren’t opened for you.
- _Add another_ is clicked only in sections headed _Education_ or _Work Experience_ (and the like); other repeating sections (websites, languages, certifications) are left as they are.
- It never solves CAPTCHAs (it waits for you), can’t fill closed shadow roots, and won’t run on browser pages or extension stores.
- Signing in for you covers sign-in and sign-up forms with a password box. Email-first sign-ins (Oracle Recruiting Cloud’s “Email address → Next → PIN”, iCIMS’s “Next”, Eightfold’s “Continue with email”) are filled but their _Next_ is left for you; the PIN or code that follows is still typed in from your inbox. Sign-up forms with security questions (some Taleo sites) stop and say what’s left to fill. SuccessFactors’ older “Choose File → Upload” document dialog isn’t driven; attach the file there by hand.
- The cover letter writer and AI answers need an AI provider account (Anthropic for Claude, OpenRouter, DeepSeek or similar). Their checks catch invented numbers, skills, names and claims, but read the letter and every orange-outlined answer before you submit: the AI can still describe something more strongly than you would, or pick a preference you wouldn’t.
- AI answers read a custom dropdown’s options by opening it. Searchable lists (schools, cities) are answered by typing, so an unusual option may not be found.
- The job description is found and checked for 97% of the live postings tested (236 graduate and internship roles from Trackr’s UK, US, Hong Kong, French and German trackers, across 25+ job sites) when you open the application from the job’s page, and for 86% when you land on the application directly. No posting for another job was ever accepted as the same job. Some employers (Amazon, law firm portals, SuccessFactors’ newer career sites such as apply.careers.hsbc.com) send _Apply_ to a sign-in page that drops the job’s ID: start from the job’s page, switch on the browsing-history search, or paste the description.
- CV text is read from text-based PDFs and Word files. Scanned (image-only) PDFs have no text to read.

## Roadmap

What an application autofiller should do. Implemented ✅ · Ideas for later 💡

- ✅ Standard contact/address fields with `autocomplete` support, so it also works as a general autofill
- ✅ ATS-aware detection (Workday, Greenhouse, Lever patterns) with a scoring engine rather than one regex per site
- ✅ Screening questions with tricky-wording handling; EEO answers opt-in
- ✅ Repeated education/experience sections, split month/year dates, ranges, country/state codes
- ✅ React/Vue/Angular-safe value setting; custom dropdown automation; iframes and shadow DOM
- ✅ Every answer read back and put right: typed or pasted where setting it didn’t hold, rewritten where the page’s rules turn it down, and anything left listed
- ✅ Rich-text editors, lists that follow earlier answers, late-drawn forms, numbers over several boxes
- ✅ Resume/cover letter auto-attach; per-profile documents
- ✅ Custom Q&A rules and _Learn from this page_
- ✅ Passwords and cards: per-site generated passwords for ATS sign-ups, cards for checkout
- ✅ Inspect overlay, undo, application log, multiple profiles, backup/restore
- ✅ One codebase for Chromium browsers and Firefox, tested end-to-end in both
- ✅ **AI answers** for every question the rules can’t answer (“Why us?”, firm-specific choices, yes/no questions your CV settles), checked against your material and the posting
- ✅ **Add another**: a section’s own _Add_ clicked for each extra education/job entry (Workday’s _My Experience_)
- ✅ **Auto-advance** multi-step applications (fill, then _Next_, then fill again), always stopping before _Submit_
- 💡 **Cover-letter templates** with `{company}` / `{role}` filled from the job posting
- 💡 **Resume import** to parse a PDF/DOCX or LinkedIn export into the profile
- 💡 **Application tracker** with status (applied → interview → offer) and follow-up reminders, built on the existing log
- 💡 Optional encrypted **sync** between browsers, and Chrome Web Store / Firefox Add-ons listings
- 💡 More languages for label detection (rules already cover some German, French and Spanish)

## Contributing and development

```bash
npm install
npm run demo        # serves the test forms at http://localhost:8080/
npm run lint        # ESLint, Prettier, file checks, and Mozilla's add-on linter
npm run test:unit   # fast, no browser
npm run test:e2e    # the extension in headless Chromium (HEADED=1 to watch)
```

The demo includes Greenhouse-, Workday- and Lever-style applications, searchable dropdowns, a checkout, sign-up/login pages, a cross-origin embed and a page of deliberately tricky fields. `npm run build` writes store-ready zips for both browsers to `dist/`.

- [CONTRIBUTING.md](CONTRIBUTING.md): how to report a form that fills wrongly and how to send a change.
- [docs/development.md](docs/development.md): the code’s layout, every command, and how to measure a change on live forms, on the detection benchmark and on the AI evals.
- [docs/features.md](docs/features.md): the complete feature spec. Read its section before changing what JobToFill does.
- [CLAUDE.md](CLAUDE.md): the rules every change keeps (it never submits, nothing leaves the browser, what the AI never sees), for people and coding agents alike.
