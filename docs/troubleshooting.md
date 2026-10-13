# Troubleshooting

What to do when something doesn’t work, and what JobToFill can’t do yet.

## Nothing happens when I press Alt+Shift+F

- Open the toolbar popup and click _Fill this page_ instead: it says what’s wrong.
- **“Allow JobToFill on websites”** in the popup or on the settings page: click **Allow**. Firefox asks for site access separately from the install, and Chromium browsers ask again if you limited JobToFill’s site access in its details.
- **“JobToFill can’t run on this page”**: browser pages (`chrome://`, `about:`) and the extension stores are off-limits to every extension.
- **The shortcut is taken.** If another extension or the browser already uses Alt+Shift+F, Settings › _Settings_ › _Keyboard shortcut_ may show “not set”. Pick another one: _change shortcut_ opens the browser’s shortcut settings. The toolbar button and right-click › _Fill this page_ work whatever the shortcut.

## A field is wrong or left empty

- Toolbar → _Show detected fields_ labels every field: green means ready, amber means your profile lacks it, grey means JobToFill doesn’t know the question. Toolbar → _Page map_ lists every field with what it was taken for: “✗ no value” means your profile has no answer, “(none: for AI)” that no rule knows the question.
- A field that already had a value is left alone unless _Overwrite fields that already have a value_ is on.
- Fill the gap once: right-click the box › _Insert from profile_, or type the answer and click _Learn from this page_ to keep it. For a question that differs on every site, add a rule under Settings › _Custom answers_ (“why do you want to work” → your answer).
- Still wrong? Click _Save a snapshot for a bug report_ at the bottom of the popup and attach the file to a [“A form fills wrongly” issue](https://github.com/rob435/JobToFill/issues/new?template=form-fills-wrongly.yml). It holds the form with your details taken out, and what JobToFill did with each field, so the form can be rebuilt as a test.

## AI answers don’t appear

- Add a key under Settings › _Cover letters & AI_ and click **Test connection**: it says whether the key works, and why not (no credit, a wrong key, a model the provider doesn’t offer). With keys for two providers, the other one takes over when one is out of credit.
- Check “Answer new questions with AI when I fill a page” is on, or use _Answer them with AI_ in the popup for one page.
- AI answers run only on job applications, never on checkout or sign-up pages.
- The popup’s AI card lists the questions it left for you, and why. Diversity questions, declarations, ID numbers and your date of birth are held back, and legal and health questions until you’ve written _Answer guidance_; switch any of them on under Settings › _Cover letters & AI_ › _Questions the AI may also answer_ (the popup says which). Passwords, card details and marketing opt-ins never go. A fact your CV, profile and guidance don’t give (a referrer’s name, a test score) is left for you rather than guessed.

## Firefox removed JobToFill when it restarted

That was a temporary install from `about:debugging`. Install the signed `jobtofill.xpi` from the [latest release](https://github.com/rob435/JobToFill/releases/latest) instead: it stays installed and updates itself. Your details come back from the backup file (see below).

## My details are gone after reinstalling

The settings page and the popup offer to restore the backup file JobToFill keeps in **Downloads › JobToFill › jobtofill-backup.json**. If they don’t, open Settings › _Backup & restore_ › _Choose backup file…_ and pick it. A Chromium install from source keeps its details when you move the folder, since the manifest pins its ID.

## Emailed codes aren’t filled in

- Connect your inbox under Settings › _Email codes_ and click **Test**: it reads your newest email. The inbox must be the one you apply with.
- Codes are only filled on secure (`https://`) pages, and only from an email that comes from the site asking: the same domain, the same job portal (a Workday page and a Workday email, naming the same employer when the page names one: Acme’s code isn’t typed into another employer’s page on that portal), or an email that links back to the page. A code from anyone else is offered with a _Use it_ button instead.
- With _Fill codes by themselves_ off, codes only go in when you fill the page. Right-click the box › _Insert verification code from email_ takes the newest code, whoever sent it.

## The cover letter can’t find the job

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
