# Settings

Every setting on the settings page, what it does and what it starts as. Open it from the toolbar button › _Edit profile & settings_.

Open the settings from the popup’s _Edit profile & settings_. Everything is saved as you type, also when you close the tab straight after, and only what you change there: what _Learn from this page_ or another settings tab saves while the page is open stays, and shows. The bar at the top switches between profiles (“Software engineer”, “Data analyst”…), each with its own details and files: _New_, _Duplicate_, _Rename_, _Delete_.

## Your profile

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

## Settings › _Settings_

| Setting                                       | Default     | What it does                                                                                                                                                                       |
| --------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overwrite fields that already have a value    | Off         | Off: only empty fields are filled, so nothing you typed gets replaced                                                                                                              |
| Highlight filled fields                       | On          | Outlines each field JobToFill filled until you click into it                                                                                                                       |
| Show a summary on the page                    | On          | The toast after filling with the keyboard shortcut or right-click menu; × closes it, and it stays while you point at it                                                            |
| Operate custom dropdowns                      | On          | Opens searchable dropdowns (Workday, Greenhouse, react-select…) and picks the matching option                                                                                      |
| Tick acknowledgement boxes                    | On          | Privacy-notice, “I confirm” and “I agree with the terms and conditions” boxes; never marketing or talent-pool opt-ins. Off: they’re left for you                                   |
| Keep an application log                       | On          | Remembers each job application page you filled, under Settings › _Application log_ (_Export CSV_ there)                                                                            |
| Sign in and create job-portal accounts for me | On          | On a sign-in or sign-up page you fill, clicks the page’s own _Sign in_ or _Create account_, and fills the emailed code once your inbox is connected. Never an application’s submit |
| Move through multi-step applications for me   | Off         | Clicks a step’s own _Next_ or _Save and Continue_ once it’s filled, then fills the next step. Stops at anything left for you, and before the step that submits                     |
| Keyboard shortcut                             | Alt+Shift+F | _change shortcut_ opens the browser’s shortcut settings                                                                                                                            |

## Settings › _Cover letters & AI_

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
| Diversity and equal opportunity        | Answered from _Voluntary disclosures_; ones you haven’t answered there get “Prefer not to say” (never a guess from your name, nationality or school). Your answers go to your AI provider                                                                                                                                                               |
| Declarations and consents              | “The information I have provided is accurate”, privacy notices, a typed signature (your full legal name) and AI-use disclosures, answered truthfully (AI helped draft your answers). Acknowledgement boxes JobToFill recognises still follow _Tick acknowledgement boxes_. Marketing and talent-pool opt-ins are never ticked                           |
| Government, legal and security vetting | Public officials and politically exposed persons, criminal and regulatory history, clearance, background checks, where you’ve lived: answered from your profile and answer guidance and, where they say nothing, as someone with nothing to declare. Only switch it on if that’s true of you. It never claims a clearance or citizenship you don’t list |
| Health and adjustments                 | Where your profile says nothing: no adjustments needed                                                                                                                                                                                                                                                                                                  |
| ID numbers and date of birth           | Only a number or date your profile, CV or answer guidance gives, as written there; never made up. Passwords, card and bank details are never sent                                                                                                                                                                                                       |

## Settings › _Email codes_

Connect once: sign up at [dashboard-v3.nylas.com](https://dashboard-v3.nylas.com) (free) and create an app; under _Grants › Add test grant_, sign in to the email you apply with; under _API Keys › Generate new key_, make a key and paste it into _Nylas API key_; click **Connect**, then **Test**.

| Setting                        | Default       | What it does                                                                                                          |
| ------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Nylas API key                  | None          | Read-only access to your newest emails, through Nylas, for the codes                                                  |
| Data region                    | United States | Or Europe, wherever your Nylas app lives (a key from the other region is tried there too)                             |
| Inbox                          | The only one  | Shown when your Nylas app has more than one inbox connected                                                           |
| Fill codes by themselves       | On            | A page asking for “the code we emailed you” gets it typed in. Off: only when you fill the page or right-click the box |
| Open “verify your email” links | On            | When a page says it sent you a link, the link from that site’s email opens in a new tab                               |

## Settings › _Passwords & cards_

| Setting          | Default                                                                  | What it does                                                                                                        |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Sign-up forms    | Generate a unique password for every site and save it here (recommended) | Or “Use my default password everywhere”                                                                             |
| Default password | None                                                                     | Only used when “Use my default password everywhere” is chosen; _Generate_ makes one                                 |
| Saved logins     | None                                                                     | Filled on login pages for the matching site (a saved “example.com” also matches “careers.example.com”); _Add login_ |
| Payment cards    | None                                                                     | The selected card fills checkout forms, including payment providers’ secure frames (Stripe, Adyen, Braintree…)      |

## Settings › _Application log_

Every job application page you filled, with the date, the page, the site, how many fields and which profile. _Export CSV_ downloads it; _Clear log_ empties it.

## Settings › _Backup & restore_

| Setting                               | Default | What it does                                                                                                                                             |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep a backup file up to date         | On      | Downloads › JobToFill › jobtofill-backup.json, saved half a minute after a change, passwords and cards included, unencrypted. _Back up now_, _Show file_ |
| Include resume and cover-letter files | Ticked  | For _Download backup_, a backup you make by hand                                                                                                         |
| Include passwords and cards           | Ticked  | For _Download backup_                                                                                                                                    |
| Include the application log           | Ticked  | For _Download backup_                                                                                                                                    |
| Choose backup file…                   |         | Restores a backup: replaces all profiles and settings in this browser                                                                                    |
