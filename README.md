# JobToFill

A browser extension for **Chrome, Edge, Brave and Firefox** that fills out job applications for you, and works as a general autofill for sign-ups and checkouts too.

Save your details once: name, contact info, address, links, education, work history, resume, answers to common screening questions, plus (optionally) passwords and payment cards. Then press **Alt+Shift+F** (or click the toolbar button) on any application page and JobToFill fills in everything it recognizes. It never submits an application; you review the form and press Submit yourself. On a job portal's own sign-in and sign-up pages it can sign you in and create the account for you (a setting, on by default; see [Job-portal accounts](#job-portal-accounts)).

## Features

**Job applications**

- **Smart field detection.** Each field is scored using its `autocomplete` attribute, `<label>`, `aria-label`, placeholder, `name`/`id`, the legend of the group it sits in, ATS attributes (Workday `data-automation-id`, Lever `urls[LinkedIn]`, Greenhouse `job_application[...]`) and nearby text. Tested against Greenhouse (classic and the new job boards, with the real react-select), Ashby, Lever, Workday-style pages, and dozens of live graduate and internship forms listed on Trackr.
- **Screening questions.** Answers "Are you legally authorized to work…?", "Will you require sponsorship…?", relocation, over-18, salary, notice period, non-competes, "Do you have offers from other firms or deadlines?", start date, "What is your communication preference?" (Email by default), "Are you willing to work in the office 5 days a week?", "Do you need adjustments for the recruitment process?", "Have you applied to us before?" and "How did you hear about us?". UK forms too: right to work, your degree classification from Settings › _Education_, expected or achieved (a 2:1 picks "Upper Second Class Honours (2:1)", "2(i)" or "60-69% - Second class honours: Grade 1", never a GPA band, and a GPA box never gets "2:1" when it wants a number, nor a "GPA Scale" list anything but its UK option), "Do you have a 2:1 or above?" and "Do you expect to graduate with honours?" answered from that class (a US GPA is never converted), "Will you graduate between December 2026 and July 2027?" answered from your dates, year-of-study lists, and "Are you a final year student?" or "Are you currently an undergraduate student?". It knows the trap where _"authorized to work… without sponsorship?"_ needs a **Yes**, and leaves "If you said yes above…" boxes empty when your answer was No.
- **Right to work, country by country.** A question about a country you can't work in (_"Are you authorized to work in the United States?"_ for a British student) is answered **No, sponsorship needed**, while UK questions still get Yes. The country is the one the question names, or its visa words name (_"e.g., H-1B"_ is the US, _"Tier 4"_ the UK), or its options do; a question that names none (_"…in the country where this role is based?"_) is about where the job is: the job already found for the tab (Quick apply, a cover letter) or the location line on the application page, else the one country the form's other questions name. It goes by the countries you list, or else your nationality: EU citizens count for the whole EU/EEA, and British and Irish citizens for both countries. _"Do you hold a valid UK visa?"_ gets _"Not applicable – British/Irish citizen"_ (or No) for a British citizen, and _"Are you located in London?"_, _"Are you able to commute into our London office?"_ and _"Would you be willing to be based in our London office?"_ are answered from your address and relocation answer.
- **Where you found the job.** Left blank, it's LinkedIn, however the form spells it: "Linkedin", "LinkedIn Jobs", "Social Media (LinkedIn, Instagram…)", "Job Board / LinkedIn", Workday's two-level "Social Media › LinkedIn", or just LinkedIn ticked in a "select all that apply" list. A job site the form doesn't list (Trackr, Bright Network…) picks the matching kind of option ("Online job board", "Job Board (Indeed, LinkedIn…)"), never a campus board or the employer's own website, and otherwise "Other".
- **US sanctions and export controls.** "Please confirm whether any of the below applies to you… U.S. sanctions and export controls" ticks exactly the statements that are true of you, from your nationality (two work: "British, Irish"), the country and region you live in and whether you'd relocate, or else "None of the above", and its follow-up gets "Not applicable". Yes/No versions ("Are you a citizen or resident of Cuba, Iran, North Korea, Syria, or the Crimea region…?", "…a national of any country subject to US embargo?") too. When your profile can't tell (no nationality, a region of Ukraine, Russia with relocation unknown), it's left for you, and never sent to the AI.
- **Interview slots.** "Please select ALL dates/times for which you are available" ticks every slot (in a checklist, a multi-select or Teamtailor's menu of ticks) that fits the days, hours and dates you can't do (exams) set under _Interview availability_, weekdays 8am–8pm by default: "Monday 13th October – 10:00-11:00", "Tue 14/10 AM", "w/c 20th October", "Morning (9am-12pm)", UK or US dates, years left out. One choice gets the earliest, "None of these dates work for me" only what's left when nothing fits, and a box asking in words gets "Weekdays, 8am–8pm".
- **Dropdowns, radios and checkboxes.** "USA" matches "United States of America" or an option with value `US`, and "CA" matches "California". "No" matches "I am not a protected veteran", "BSc" matches "Bachelor’s", and 6 years matches the "5–10" range. "University of Glasgow" matches "Glasgow, University of", "The University of Glasgow (UofG)" or "UofG", never "Glasgow Caledonian University" or "University of Strathclyde (Glasgow)"; "UCL", "LSE", "KCL", "UC Berkeley", "MIT" and "NYU" match their full names and back. "Computing Science" picks "Computer Science" (or "STEM (Science, Technology/Computer Science, …)"), "Maths" "Mathematics" and "LLB" "Law", and a catch-all like "Science" only when nothing more telling is offered.
- **Dates against terms.** A May 2027 graduation picks "Spring/Summer 2027", "Spring 2027", "Q2 2027" or "Class of 2027", whichever the list offers; December picks "Fall". A year on its own counts as a June graduation. Your start date picks the first option you can make, to the day: "Start 30th June, finish 17th September 2027" rather than "Start 1st June…" for a 28 June start, and "Summer 2027 (May 10th - August 20th, 2027)" rather than "Spring 2027 (January 11th - April 30th, 2027)". "I confirm that the listed dates are suitable for me; 14th June – 22nd August" is answered from it too (No for a 28 June start, and never ticked as an acknowledgement).
- **Phone numbers.** A box for the whole number ("Mobile number (inc. country code)", "Telephone number (with international dialling code)", "Mobile phone number (country code + number)", "Mobile Number (+CountryCode)") gets "+44 7700 900123", written like its example ("+447700900000" or E.164: no spaces); a separate "Country code" list gets "+44" and the box beside it the rest. "Alternative phone number", "Secondary phone" and "Landline" boxes are left empty: your number is already in the main one.
- **Lists.** Your preferred locations tick every matching office checkbox ("Which other locations would you relocate to?"), and a single "Preferred location" dropdown gets the first one it offers. A text box that names its own places ("Please rank your location preference: Austin, Chicago, Greenwich, Houston, New York") gets only the ones you prefer, or nothing. Skills checklists ("Which programming languages do you use?") work the same way.
- **Custom dropdowns.** Opens react-select (single and multi), Workday listboxes, Teamtailor's "Select an option" menus and async search boxes (school pickers), reads every option, picks the best match and checks the site registered it. If nothing fits it leaves the box empty instead of half-typed.
- **Custom buttons and toggles.** Yes/No toggle buttons (Ashby), `role="radio"` / `role="checkbox"` widgets (Radix, Headless UI) and switches, not just native inputs.
- **Multiple education and job entries.** When a form repeats its _School_ or _Job title_ section, each copy gets the next entry from your profile. "From", "To" and "Location" boxes take their meaning from the section they sit in (a block that starts with its dates, as on SuccessFactors, included), and split month/year boxes are handled (Workday's "From (Actual)" and "To (Actual or Expected)" too). A box after a list asking the same thing ("If your year of graduation is not listed, please specify.") is left for an answer the list lacks, never taken for a second entry. "University Course" is your subject, never the university, and "Country of School" or "Country of Employer" comes from that entry's location ("Glasgow, Scotland"; "Perth, WA" is Western Australia, "Seattle, WA" Washington). Secondary-school questions ("Name of secondary school", "Scottish Highers grades", "What year did you graduate from high school?") are answered from your school entry (A-levels, Highers, IB, BTEC…), never from your degree, and GCSE grades never get your A-levels.
- **Resume, cover letter and transcript upload.** Your files are attached to the right upload fields, even when every button just says "Attach" (Jobvite, Gem and Ashby's "autofill from resume" included). A cover-letter or code-sample upload never gets your resume, and a transcript upload for studies you don't have ("…of your graduate studies" for an undergraduate) is left empty. Files go in first, and if the site reads your CV and clears the form (Breezy, Lever), the answers are put back. Upload tiles that first ask where the file comes from (SuccessFactors' "Upload a Resume" → _Upload from Device / Upload from Dropbox / Sign in with Google_) get it through _Upload from Device_, without a file dialog; Dropbox, Google and other services are never chosen, and an "Additional Documents" tile never gets your resume.
- **Custom answers.** Rules like "_why do you want to work_" → your answer. You can match with plain phrases, `a | b` alternatives or `/regex/`.
- **Learn from this page.** After you type answers into an unusual form, one click saves them, either as profile values or as custom answers for next time.
- **Acknowledgement boxes** ("I have read the privacy notice", "Acknowledge/Confirm"). Left for you by default, with a one-click _Always tick these_ in the popup; Quick apply always ticks them and says how many. Marketing and talent-pool opt-ins are never ticked.
- **Voluntary EEO and UK social-mobility questions.** Gender, detailed ethnicity, veteran, disability, sexual orientation, gender identity, religion, neurodivergence; school type, free school meals, a parent's degree (a "highest level of education" list only gets an option your answer settles), household earner's job (which also answers "Which socio-economic background do you identify with?"), postcode at 14, care, caring, refugee background, bursaries. Pick one detailed ethnicity (e.g. _Asian – Chinese_) and each form gets its closest option: "Chinese - Chinese" on a 2011-style UK list, the subgroup on two-step forms, "East Asian" or "Asian" where that's all there is. These are opt-in, and "— don't fill —" is the default.
- **Conflicts of interest** that banks and law firms ask: worked there before, relatives or a "Personal Relationship" with an employee, and whether you or a close family member is a government or public official (including "politically exposed person" and state-owned companies). "If yes, please give details" boxes get your details only when you answered Yes, and "…Otherwise, enter N/A" gets "N/A" after a No.
- **Questions that appear as you answer** (the ethnic background once the group is picked, "if yes" boxes, follow-ups) are filled in the same go.
- **Application log.** Every job application you fill is recorded, and the log can be exported as CSV.
- **Multiple profiles.** For example "Software engineer", "Data analyst" and "Personal shopping", each with its own resume.

**Answers to questions it has never seen (AI)**

- **Every question the rules leave empty is answered by AI as part of the same fill:** open questions (_"Why do you want to join Figma?"_, _"Describe how Belvedere Trading makes money"_, _"In 150 words, why Real Estate Asset Management?"_), firm-specific choices (_"Which desk interests you most?"_, _"Rank your top areas of finance"_, _"Which engineering work at Figma? First choice"_) and yes/no questions your material settles (_"Do you have practical Python experience?"_, _"Did you take the SAT?"_, _"Are you a member of a university society?"_).
- **Written for this job.** It uses the job's real description, found the same way as for cover letters: the page, the job site's listing, the letter you wrote for this application, or Trackr's company note. It also uses your CV, profile and notes, plus your answer guidance. The earlier answers you gave for other employers are reused as your own words, never with the other firm's name.
- **Checked like the letters.**
  - A choice must be one of the options.
  - Written answers keep to the limit the question states (words, characters, sentences or the box's own limit).
  - Every number, tool and employer must come from your material or the posting, with no placeholders or stock phrases.
  - A second pass fact-checks written answers against your CV.
  - Anything that fails goes back to the model once; anything that still fails is left for you.
- **What it never does.** Diversity questions, declarations and consent boxes, and ID numbers never leave the page. Criminal, regulatory and health questions are only answered from what you wrote in _Answer guidance_ (e.g. "I have no convictions"). Facts it can't find (a referrer's name, a past application, a test score) are skipped, not guessed.
- **You stay in charge.** AI answers are outlined in dashed orange; the popup lists each one, plus what it left and why. Undo takes them back with the rest of the fill. They're remembered per application, so the next page or a refill doesn't ask again. Switch it off under Settings › _Cover letters & AI_, or use _Answer them with AI_ in the popup for one page.

**Cover letters and tailored CVs (AI)**

- **Write cover letter** in the popup, on any application. JobToFill finds the job's real description, writes a one-page letter in your voice from your CV, checks every fact, and attaches the PDF to the form (and pastes the text into "cover letter" boxes). The next steps of the same application get it too.
- **Finds the actual job.** It checks the application page itself, the job site's public listing APIs (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Oracle…), "View job" links, the job a sign-in or application step names only in its form (SuccessFactors keeps every step at one session address), the page you came from, the job pages you opened in that tab just before (so sites that send _Apply_ to a bare sign-in address still work) and, if you allow it, your browsing history. Pages that only render with scripts, or that block plain lookups, are read in a background tab. Then it **proves it's the same job** (same job ID, company and title) before writing; if it's unsure, the AI double-checks, and you can always paste the job instead.
- **Your style.** Add letters you've written before (PDF, Word or text). New letters copy their voice, structure and length, and reuse what they say about you. They never reuse the company they were written for.
- **Bulletproof facts.** Every draft is checked before you see it, and failures go back to the model to fix:
  - every number must appear in your CV, notes or the posting;
  - tools and skills it claims must be yours;
  - names must be real;
  - it must name the right company, with no other company's name leaking in from an example letter;
  - no placeholders, markdown, clichés or em dashes, and a sensible length.

  A second AI pass reads the letter against your CV and flags any claim about you that isn't backed up. Whatever is still doubtful is listed for you to check.

- **Quick apply.** The small **Quick apply** button next to _Write cover letter_ does all of it without asking. Your details go into the form at once (acknowledgement and privacy-notice boxes ticked too, whatever the setting says; marketing opt-ins never), along with AI answers to the leftover questions. Meanwhile it finds the job, writes and fits the letter and tailors your CV, then puts the letter and the tailored CV in, in place of anything already in those fields, and says what it did in a toast on the page (including how many boxes it ticked, so you can untick any you disagree with). There's no need to press _Fill_ while it works: if you do, the CV and letter uploads are left for Quick apply. If it stops (no AI credit, say), your usual CV goes in instead. It works in a background tab beside the application and closes it when done; if the job's description can't be found it reads the application page itself. It never submits. A small **Last quick apply** tab then appears in the popup: it opens a page with the letter and CV (PDFs, plus the CV as `.tex`) for a look afterwards. Only the latest one is kept, in the browser's memory: it goes when you run another, press _Clear_ or close the browser, and it is never in the backup file. If the AI key, its permission or site access isn't set up yet, the normal studio opens to ask for it.
- **Eligibility check.** If the posting has hard requirements (graduation year, right to work, clearance, degree), it tells you when your profile doesn't seem to meet them.
- **Looks like a LaTeX letter.** The PDF is typeset like the classic LaTeX letter: Latin Modern (Computer Modern) fonts, TeX-style justified paragraphs with hyphenation, your name and a contact line with clickable links, and it always fits on one page. The text stays selectable, so applicant tracking systems can read it.
- **Tailor my CV.** Rewords and reorders your CV around the job's keywords, using only facts already in it. It shows keyword coverage before → after and a list of every change. If you choose to, it uploads the tailored PDF instead of your usual CV for that application. Rebuilt from your CV file, a project is just its name and what it is (its technologies are in its bullets and your Skills, not listed under the name), and achievements, skills and languages are rows with a bold label and plain text.
- **Edit freely.** The letter is editable, the PDF preview updates as you type, and the checks re-run on your edits. Use "Rewrite" with an instruction such as "mention my chess" or "shorter".
- **Pick up where you left off.** Coming back to a job you already wrote for offers that letter, with your edits, instead of writing a new one.
- **Bring your own model.** DeepSeek V4.1 Flash through [OpenRouter](https://openrouter.ai) by default (about a tenth of a cent per letter, ~10 seconds), [DeepSeek's own API](https://platform.deepseek.com/api_keys) (`deepseek-chat`), or any OpenAI-compatible provider. Settings › _Cover letters_. Each provider keeps its own key and model, so you can switch back and forth. With keys for both OpenRouter and DeepSeek, the other one takes over when the one you chose is out of credit, rate-limited or down (you can switch that off).

**Extra answers, from you and the AI**

- **Extra details for the AI.** Settings › _Skills & writing_: anything an application might ask that isn't in the boxes, in your own words ("no relatives in public office, no convictions, happy to relocate"). The AI reads it when it answers leftover questions and when it writes your cover letter; it never leaves your browser except to your chosen AI provider.
- **Your CV as LaTeX.** Paste your CV's LaTeX in Settings › _Cover letters_. JobToFill reads its structure and tailors only the wording of bullets and the order of what it may touch; names, dates, places, titles and grades are always kept exactly. The tailored CV is drawn like your template as a PDF, and **Download .tex** gives LaTeX you can compile in Overleaf.

**Discover internships (beyond Trackr)**

- **Firms nobody advertises.** Toolbar → _Discover internships_ searches a bundled registry of 2,100+ reputable finance firms: SEC-registered advisers (from the SEC's Form ADV data: headcount, assets, private funds) plus the firms in Wikipedia's hedge fund, investment bank, private equity and Tiger Cub categories. Filter by kind (hedge funds, quant, prop trading, asset managers, credit, private equity, boutique advisory, family offices, VC), place and size. Small, well-regarded firms rank first.
- **Leaves out what Trackr already lists.** It reads Trackr's own finance and tech trackers (this season and next) and hides those companies, so what's left are the HBKs and Lansdownes.
- **Firms like the ones you name.** "HBK, Lansdowne Partners" finds firms in the same niche, city and size, and firms that share their Wikipedia categories.
- **Checked live, not guessed.** _Check careers_ reads the firm's own website: its careers pages, the job board they embed or link to (Greenhouse, Lever, Ashby, Workable, Workday, SmartRecruiters, Recruitee, Phenom, Oleeo), and lists only student roles (internships, summer analyst, off-cycle, insight and spring weeks, graduate). Firms without a job board get the programme sentences from their careers page with the deadline and the application email (Cloudflare-hidden addresses decoded). A board is only guessed when the site doesn't name one, and a guessed board counts only if it carries the firm's name.
- **AI ideas, verified.** With an AI key, _Ask the AI for more ideas_ adds firms the registry doesn't know, but only those whose website loads and names them **and** which the SEC adviser register or Wikipedia confirms. The rest are listed as left out, with the reason.
- **Watchlist.** _Watch_ a firm and JobToFill re-checks its board and careers pages every six hours. New roles and programme pages show as a number on the toolbar button and in the popup. Small firms post once a year, often quietly.
- `npm run firms` rebuilds the registry from the latest SEC file and Wikipedia (`FIRMS_CONTACT=you@example.org`, which the SEC requires).

**General autofill**

- Checkout and shipping forms, including country/state codes, phone numbers and split names. A "Company (optional)" box on a shipping form is _not_ filled with your employer.
- **Passwords and cards** (Settings › _Passwords & cards_), filled straight away on every fill, Quick apply and sign-in step.
  - Sign-up pages: a unique strong password is generated for "Create password" + "Confirm password" ("Choose Password" / "Retype Password", "Verify New Password"…) and saved for that site, so a Workday account for every employer is no longer painful. Choosing a single default password instead is also an option.
  - **Passwords that fit the page.** The rules a sign-up page states ("at least 8 characters", "not longer than 18", "one upper case and one lower case letter", "a number or punctuation character", "no spaces", the special characters it lists or bans, and the box's own `minlength` / `maxlength` / `pattern`) are read, and a generated password always meets them. When your default password wouldn't, it isn't submitted to be refused: a fitting one is made, saved for that site, and the fill says so.
  - Login pages: the saved password for that site is filled, or your default password when you chose it and nothing is saved for the site. Employers that share one host (every SuccessFactors company on `career8.successfactors.com`) each get their own login.
  - Checkout pages: the selected card is filled, including inside payment-provider iframes such as Stripe.
- **Right-click menu.** _Fill this page_, _Insert from profile → Email / LinkedIn / …_ into any box, _Generate strong password_ and _Insert verification code from email_.

**Job-portal accounts**

- **Signs in and creates portal accounts for you** (Settings › _Sign in and create job-portal accounts for me_, on by default). When you fill (button, shortcut, right-click or Quick apply) a secure page that is only a sign-in or sign-up form, with no job questions or uploads on it:
  - a sign-in page for a site with a saved login gets it, and its _Sign in_ button is clicked;
  - a sign-in page for a site with no known account gets its _Create account_ / _Register_ / _New user?_ link clicked, and the sign-up page that opens in the tab is filled by itself;
  - a sign-up page is filled (your default or a fitting new password, the sign-up form's own terms box ticked, never marketing) and its _Create account_ button clicked;
  - the code the site then emails is typed in from your inbox (with Nylas connected), and that step's _Continue_ / _Verify_ clicked;
  - "An account with this email already exists" goes back to sign in with the saved or default password;
  - the application page it lands on is filled as usual, and the toast lists every button it clicked.
- **CAPTCHAs are yours.** A plain "I'm not a robot" checkbox is ticked like any other box. A real CAPTCHA (reCAPTCHA, hCaptcha, Turnstile, Arkose, an image CAPTCHA) is never clicked, solved or bypassed: the toast asks you to complete it (and to accept a "Terms of Use" statement that opens in a dialog), and JobToFill carries on as soon as you have, for up to five minutes.
- **Strict about what it clicks.** Only buttons and links whose wording says sign in, log in, create account, register, sign up, "New user?", "Already have an account? Sign in", or _Continue_ / _Verify_ on an emailed-code step; a bare _Submit_ / _Next_ only when it is the one submit of a pure sign-in or sign-up form. Never anything that says apply, application, submit application, send, withdraw, delete, pay, review and submit, forgot or reset password, upload, cancel, or signs in with another service (Google, LinkedIn, Microsoft, Indeed…). Never on a page with job-application questions, never while a required box is empty or an error is showing, never on `http://` pages, and only what is on top at the button's spot (nothing hidden under a banner). Each tab's run lasts ten minutes at most, takes at most six clicks, stays on the same site (and employer), and stops when you go elsewhere.
- **Dropdowns on account pages.** SuccessFactors' "Country/Region Code" gets "UNITED KINGDOM (+44)" (not the Isle of Man or Jersey, and "+1" is the United States unless you live in Canada), the phone number then goes in without its code, and "Country/Region of Residence" gets your country, not your state.

**Verification codes from email**

- **Codes fill themselves.** Job portals want an account, then "the 6-digit code we just emailed you", again and again. Connect your inbox once through [Nylas](https://www.nylas.com) (Settings › _Email codes_: paste one API key) and JobToFill watches for code boxes, waits for that email, and types the code in: one box or a row of single-digit boxes, React widgets included. "Check your inbox to verify your email" pages get the link from that email opened in a new tab.
- **Reads emails like a person.** It finds the code beside "verification code", "one-time passcode", "Bestätigungscode" and friends, and ignores order numbers, phone numbers, prices, years, dates, tracking links and the hidden preview text. The box decides the shape: six boxes take a six-digit code, a numeric box no letters.
- **Only from the site that asked.** A code is filled by itself only when the email comes from that site: the same domain, the same portal (a Workday page and a Workday email; Oracle, SuccessFactors, iCIMS, Greenhouse and two dozen more), the company's own domain behind its portal, or an email that links back to the page. A code from anyone else is only offered with a _Use it_ button, so a look-alike page can't collect your bank's sign-in code. Secure pages only; each code is used once. The code watcher itself submits nothing: only _Sign in and create job-portal accounts for me_, during a sign-in or sign-up it is running, presses the code step's _Continue_.
- Right-click any box › _Insert verification code from email_ takes the newest code whoever sent it.

**Also**

- Works inside cross-origin iframes (embedded Greenhouse boards) and open shadow DOM (web components).
- **Show detected fields** labels every field with what JobToFill thinks it is: green means ready, amber means your profile lacks it, grey means unknown.
- **Undo** puts back whatever was on the page before the fill.
- Only empty fields are filled unless you turn on _Overwrite_, and filled fields are outlined. One exception: a country the site chose for you is put right. Workday picks the _Country / Territory_ and the phone code's country from where your connection seems to be (Italy on a VPS there); when that isn't your country it becomes yours, the chip "Italy (+39)" becomes "United Kingdom (+44)", and the address fields are filled once the page has switched to that country's (_County_ and _City_ instead of _Province_ and _City (Comune)_).
- Light and dark mode, an automatic backup file, and import/export.

## Install

JobToFill isn't in the extension stores yet. One `extension/` folder works unpacked in every supported browser.

**Chrome, Edge, Brave, Opera, Vivaldi, Arc**

1. Download this repository (or `git clone` it).
2. Open `chrome://extensions` (`edge://extensions` in Edge).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the **`extension/`** folder.

To update after `git pull`, click the reload arrow on JobToFill's card; there's no need to remove it. The manifest pins the extension ID, so moving the folder and loading it from the new place keeps your details too.

**Firefox 142 or newer: permanent install** (recommended)

Regular Firefox only keeps add-ons that Mozilla has signed. Mozilla signs self-distributed add-ons for free without listing them anywhere, and this repository's _Firefox release_ workflow does that for you and publishes the result as a GitHub release, which Firefox then updates itself from.

1. **Get Mozilla API credentials (once).** Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/), accept the developer agreement, open [Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/) and click **Generate new credentials**. Keep the page open.
2. **Give them to GitHub (once).** In this repository on GitHub: **Settings › Secrets and variables › Actions › New repository secret**. Add `AMO_API_KEY` with the _JWT issuer_ (looks like `user:12345678:123`), then `AMO_API_SECRET` with the _JWT secret_.
3. **Sign it.** **Actions › Firefox release › Run workflow**. After a few minutes a release appears under **Releases**.
4. **Install it.** Download `jobtofill.xpi` from the latest release, open `about:addons` in Firefox, click ⚙ › **Install Add-on From File…**, choose the file and click **Add**. If you had loaded it temporarily before, remove that copy in `about:debugging` first.
5. If the toolbar popup shows **Allow JobToFill on websites**, click **Allow**. Firefox asks for site access separately.

Firefox checks the release for updates daily (or right away with ⚙ › **Check for Updates** in `about:addons`). To ship your latest changes, run the workflow again.

The same signing works from your own computer: `RELEASE_NUMBER=<higher than the last> WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npm run sign:firefox` leaves `jobtofill.xpi` in `dist/release/`.

**Firefox: temporary install** (for development)

1. Download this repository (or `git clone` it).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose **`extension/manifest.json`**.

Firefox removes temporary add-ons when it restarts.

In both browsers the settings page opens on install. Fill in your profile and pin the toolbar icon. `npm run build` writes store-ready zips for both browsers to `dist/`.

**Your details survive re-installs.** Removing an extension deletes everything it stored (and so does Firefox's restart for temporary add-ons). JobToFill therefore keeps a copy in **Downloads › JobToFill › jobtofill-backup.json**, rewritten half a minute after each change. When it is added again and starts out empty, the settings page and the popup offer to restore that file in one click. Automatic backups can be switched off under _Backup & restore_.

## Using it

| Do this                        | How                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Fill the page                  | **Alt+Shift+F**, the toolbar button → _Fill this page_, or right-click → _Fill this page_   |
| See what was detected          | Toolbar → _Show detected fields_                                                            |
| Save answers you typed         | Toolbar → _Learn from this page_                                                            |
| Insert one value               | Right-click a box → _Insert from profile_                                                   |
| New password on a sign-up form | Right-click the password box → _Generate strong password_ (or just fill the page)           |
| Undo a fill                    | _Undo_ in the popup or in the on-page toast                                                 |
| Letter, CV and form in one go  | Toolbar → _Quick apply_ (see the result later under _Last quick apply_)                     |
| Write a cover letter           | Toolbar → _Write cover letter_ on the application page (set up a key under _Cover letters_) |
| Answer the questions left      | Automatic with an AI key; or the popup's _Answer them with AI_                              |
| Emailed sign-in codes          | Automatic once your inbox is connected under _Email codes_; or right-click the box          |
| Sign in / create an account    | Fill the portal's sign-in or sign-up page: it clicks _Sign in_ / _Create account_ for you   |

To change the shortcut, open `chrome://extensions/shortcuts` in Chromium browsers, or in Firefox go to `about:addons`, click ⚙, then **Manage Extension Shortcuts**. The settings page links there too.

### Try it on the demo forms

```bash
npm install
npm run demo        # serves the test forms at http://localhost:8080/
```

The demo includes Greenhouse-, Workday- and Lever-style applications, searchable dropdowns, a checkout, sign-up/login pages, a cross-origin embed and a page of deliberately tricky fields.

## Privacy and security

- **Nothing leaves your browser** unless you use the AI features (cover letters, and answers to the questions a fill leaves empty) or connect your inbox for codes. Discover only fetches public pages (firms' websites and job boards, Trackr's public lists, Wikipedia and the SEC adviser search) and sends no personal details; with _Ask the AI_ ticked, your search (not your profile) goes to your AI provider. There are no servers or analytics. The profile lives in the extension's local storage, plus the backup file in your own Downloads folder.
- **The cover letter writer** sends the job description, your CV's text, your profile, notes and example letters to the AI provider you chose, with your own API key, and only when you ask for a letter.
- **AI answers** run only once you've added an API key, and only on job applications (never on checkout or sign-up pages). They send the empty questions (with their options), the job description, your CV's text, your profile, notes, answer guidance and your earlier written answers to the same provider. Diversity questions, declarations and ID numbers are never sent. Switch it off under Settings › _Cover letters & AI_. In Firefox it asks for your permission first. Your API keys stay in this browser and in your own backup file, so they come back if JobToFill is reinstalled; switch off _Keep my API keys in the backup file_ to leave them out (they are never sent anywhere but to the provider). Job descriptions are fetched from the job sites directly, without your cookies. Browsing history is only searched if you switch that on; it is searched locally, and only the matching job pages are opened. To find the job behind an application, JobToFill remembers the last few job-related pages each tab showed (at most 12, for 3 hours) in the browser's session memory; they are never written to disk or sent anywhere, and are gone when the browser closes. If you came from a Trackr list, its public programme list is fetched to confirm which job it is.
- **Email codes** are read through Nylas with your own API key: JobToFill asks Nylas for the last few messages of the inbox you connected, received in the last minutes, and picks the code in your browser. It never sends, deletes or marks mail, and no page content goes to Nylas. The key is kept like the AI keys (this browser and your backup file).
- **Nothing runs until you ask.** The fill code is injected into a page only when you press the shortcut or a button. It is not loaded on every site you visit. The one exception is opt-in: once you connect your inbox, a small watcher that only looks for verification-code boxes goes into each secure page as it loads (switch _Fill codes by themselves_ off to stop that).
- **The backup file is yours.** It is written only to your Downloads folder and contains your profile as plain JSON, passwords and cards included. Turn it off under _Backup & restore_ if you'd rather not keep one, or untick _Include passwords and cards_ when you export one by hand.
- **Passwords and cards are kept as they are**, like the API keys: in this browser's extension storage and in your backup file, unencrypted, so a fill puts them in straight away. Anyone who can open your browser profile or the backup file can read them; web pages can't.
- **Secrets are guarded:**
  - Passwords and cards are only handed out during a fill you started.
  - They are only filled on HTTPS pages (or `localhost`).
  - They only go into visible fields: off-screen "honeypot" and hidden fields are skipped.
  - Saved passwords only go to the site they belong to.
  - Cards only go to the top page, the same site, or known payment processors' frames, never to an arbitrary third-party iframe.
- **Never submits an application.** Acknowledgement and terms checkboxes are left for you unless you turn on _Tick acknowledgement boxes_ or use Quick apply (which ticks them and tells you); marketing, newsletter and talent-pool opt-ins are never ticked. Beyond filling (which opens dropdowns, menus and upload tiles, never Dropbox or Google sign-ins), the one thing it clicks for you, with _Sign in and create job-portal accounts for me_ on, is a job portal's own sign-in or create-account button (and the _Continue_ after an emailed code) on a pure sign-in or sign-up page, as listed under [Job-portal accounts](#job-portal-accounts); on such a sign-up page it also ticks the form's own terms box, since creating the account means accepting them. Switch the setting off and it only fills.
- **CAPTCHAs are never touched.** Nothing is filled or clicked inside a CAPTCHA, and its frames (Google reCAPTCHA, hCaptcha, Cloudflare, Arkose) are skipped entirely.
- **Works under strict Content-Security-Policies.** The on-page toast and labels are styled through the DOM, so a site's CSP can't block them, and no page script ever sees the extension's code.
- The extension needs access to all sites so it can fill application forms embedded from other domains (iframes). It only touches a page when you trigger it.

A dedicated password manager is still the stronger choice for your important accounts. JobToFill's passwords are aimed at the dozens of throwaway job-portal accounts.

## Brainstorm: what an application autofiller should do

Implemented ✅ · Ideas for later 💡

- ✅ Standard contact/address fields with `autocomplete` support, so it also works as a general autofill
- ✅ ATS-aware detection (Workday, Greenhouse, Lever patterns) with a scoring engine rather than one regex per site
- ✅ Screening questions with tricky-wording handling; EEO answers opt-in
- ✅ Repeated education/experience sections, split month/year dates, ranges, country/state codes
- ✅ React/Vue/Angular-safe value setting; custom dropdown automation; iframes and shadow DOM
- ✅ Resume/cover letter auto-attach; per-profile documents
- ✅ Custom Q&A rules and _Learn from this page_
- ✅ Passwords and cards: per-site generated passwords for ATS sign-ups, cards for checkout
- ✅ Inspect overlay, undo, application log, multiple profiles, backup/restore
- ✅ One codebase for Chromium browsers and Firefox, tested end-to-end in both
- ✅ **AI answers** for every question the rules can't answer ("Why us?", firm-specific choices, yes/no questions your CV settles), checked against your material and the posting
- 💡 **Cover-letter templates** with `{company}` / `{role}` filled from the job posting
- 💡 **Workday "Add another"**: click _Add_ for each extra education/job entry automatically
- 💡 **Auto-advance** multi-step applications (fill, then _Next_, then fill again), always stopping before _Submit_
- 💡 **Resume import** to parse a PDF/DOCX or LinkedIn export into the profile
- 💡 **Application tracker** with status (applied → interview → offer) and follow-up reminders, built on the existing log
- 💡 Optional encrypted **sync** between browsers, and Chrome Web Store / Firefox Add-ons listings
- 💡 More languages for label detection (rules already cover some German, French and Spanish)

## Known limitations

- Detection is heuristic. Unusual forms may need a custom answer, or one right-click _Insert from profile_. _Show detected fields_ shows what was recognized.
- Workday-style date "spinners" and some heavily customized widgets may ignore programmatic input. JobToFill reports those as "No matching option" so you know to check them.
- Undo can't clear a dropdown that has no clear (×) button, or remove a file once the site has replaced its upload box.
- "Enter manually" cover-letter boxes that only appear after a click aren't opened for you.
- Sections that only appear after clicking _Add another_ aren't added automatically yet.
- It never solves CAPTCHAs (it waits for you), can't fill closed shadow roots, and won't run on browser pages or extension stores.
- Signing in for you covers sign-in and sign-up forms with a password box. Email-first sign-ins (Oracle Recruiting Cloud's "Email address → Next → PIN", iCIMS's "Next", Eightfold's "Continue with email") are filled but their _Next_ is left for you; the PIN or code that follows is still typed in from your inbox. Sign-up forms with security questions (some Taleo sites) stop and say what's left to fill. SuccessFactors' older "Choose File → Upload" document dialog isn't driven; attach the file there by hand.
- The cover letter writer and AI answers need an AI provider account (OpenRouter, DeepSeek or similar). Their checks catch invented numbers, skills, names and claims, but read the letter and every orange-outlined answer before you submit: the AI can still describe something more strongly than you would, or pick a preference you wouldn't.
- AI answers read a custom dropdown's options by opening it. Searchable lists (schools, cities) are answered by typing, so an unusual option may not be found.
- The job description is found and checked for 97% of the live postings tested (236 graduate and internship roles from Trackr's UK, US, Hong Kong, French and German trackers, across 25+ job sites) when you open the application from the job's page, and for 86% when you land on the application directly. No posting for another job was ever accepted as the same job. Some employers (Amazon, law firm portals, SuccessFactors' newer career sites such as apply.careers.hsbc.com) send _Apply_ to a sign-in page that drops the job's ID: start from the job's page, switch on the browsing-history search, or paste the description.
- CV text is read from text-based PDFs and Word files. Scanned (image-only) PDFs have no text to read.

## Development

```
extension/
  manifest.json        Manifest V3, shared by Chromium (service worker) and Firefox (background scripts)
  background.js        injection, fill orchestration, passwords and cards for the page, menus, shortcut
  lib/                 classic scripts shared by every context (and the Node unit tests)
    fields.js          profile schema, field types, detection rules, value resolution
    matcher.js         classification, section/entry planning, option matching, formatting
    account.js         job-portal accounts: the click allow/deny-list, "already exists" messages, shared-host employers
    geo.js             countries (ISO codes + aliases) and US/CA/AU regions
    passwords.js       saved logins and cards, password generator and page password rules
    store.js           profiles, settings, documents, history, backups, cover letter material and letters
    util.js            text normalization, dates, and JTF.api (browser.* in Firefox, chrome.* elsewhere)
    discover.js        Discover: registry search, Trackr dedupe, careers crawl, job boards, verification, watchlist checks
    ai.js              OpenAI-compatible chat client (OpenRouter, DeepSeek, custom): JSON mode, retries, errors
    letter.js          cover letter and CV prompts, and the checks every draft must pass
    answers.js         AI answers to the questions a fill leaves empty: what may be sent, limits, prompt, checks
    jobpage.js         job postings: extraction, ATS APIs, finding the description, same-job validation
    doctext.js         text from PDF and Word files (your CV, example letters), no dependencies
    pdfdoc.js          PDF writer: TeX-style line breaking, embedded fonts, the letter and CV layouts
  fonts/               Latin Modern (GUST font licence) as TrueType subsets, and English hyphenation patterns
  offscreen/           Chromium only: reads job pages' HTML for the background (its service worker has no DOMParser)
  content/             injected on demand into every frame
    dom.js             finds controls (incl. shadow DOM), labels, radio groups
    fill.js            sets values the way frameworks notice, custom dropdowns, files and upload tiles, undo
    account.js         sign-in / sign-up / code pages: what blocks the submit, CAPTCHAs, the allowed clicks
    main.js            in-page API: fill / learn / inspect / undo / toast
  ui/                  shared styles and helpers for the popup and settings page (ES modules)
  popup/               toolbar popup
  studio/              the cover letter page: find the job, write, check, preview, attach, tailor the CV
  discover/            Discover internships page: search, careers checks, watchlist
  data/firms.json      the registry Discover searches (built by scripts/firms.mjs)
  options/             settings page: main.js (shell), profile.js, passwords.js, app.js, controls.js
tests/
  unit/                node:test, no browser
  e2e/                 the real extension in Chromium (Playwright) or Firefox (Puppeteer + remote debugging)
  live/                surveys of live application forms listed on Trackr (not run by npm test, see below)
  fixtures/            the demo/test forms; src/*.jsx are pages built with real React widgets
                       (react-select), bundled on request by serve.mjs; docs/ CVs in many PDF/Word
                       flavours (make.mjs rebuilds them), jobs/ trimmed real job pages and ATS API
                       replies, letters/ an application and its job posting
scripts/               build, static checks, icon rendering
```

There is no build step for development. Edit the files, then reload: **Reload** on `chrome://extensions`, or **Reload** on `about:debugging` in Firefox. `npm run chrome` / `npm run firefox` start a fresh browser with the extension loaded that reloads it automatically when files change (via [web-ext](https://github.com/mozilla/web-ext)).

```bash
npm install
npm run lint          # ESLint, Prettier, file checks, and Mozilla's add-on linter on the Firefox build
npm run format        # Prettier + ESLint fixes
npm run test:unit     # fast, no browser
npm run test:e2e      # the extension in headless Chromium (HEADED=1 to watch)
npm run test:firefox  # the same fill and page tests in Firefox (FIREFOX_BIN=/path/to/firefox if it isn't on PATH)
npm run build         # dist/ zips for the Chrome Web Store and Firefox Add-ons
npm run sign:firefox  # a signed .xpi for a permanent Firefox install (needs AMO API keys, see Install)
                      # .github/workflows/firefox.yml runs it and publishes the GitHub release
```

Adding support for a new kind of field usually means adding a rule to `RULES` and a definition to `DEFS` in `extension/lib/fields.js`, plus a case in `tests/unit/classify.test.js`.

### Surveying live application forms

`tests/live/` measures JobToFill against the forms people actually apply through. It reads the programmes that are open now from Trackr's public tracker lists, then reads each form's questions through its job board's public API: Greenhouse, Ashby, and Lever's server-rendered form. No browser is needed, and nothing is ever submitted. Every question goes through the same classification, value resolution and option matching as a real fill, and the questions left unanswered are printed, most common first.

```bash
node tests/live/survey-api.mjs --limit 150                 # fetch and report (writes tests/live/survey-api-report.json)
node tests/live/survey-api.mjs --from report.json          # re-run the rules on forms fetched before
OPENROUTER_API_KEY=sk-or-… node tests/live/survey-api.mjs --from report.json --ai --forms 10
                                                           # also answer what's left with the AI, and print it
node tests/live/survey.mjs --limit 20                      # the real extension in Chromium on live forms (HEADED=1 to watch)
```

The first survey (117 live forms, 2,408 questions on Trackr's UK and US finance and tech trackers) is what the country-by-country right to work, job-site mapping, on-site and adjustments answers, and AI answers were built from. The rules now fill 1,546 of those questions (64%, up from 60%; about a third of the gain is the new profile answers, the rest is new and corrected rules), and about 30 right-to-work answers that were wrong for a British applicant on US forms are now right. Most of the 461 questions they still don't recognise are firm-specific, and those go to the AI.
