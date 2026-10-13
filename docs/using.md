# Using JobToFill

The buttons and shortcuts, a typical application from start to finish, and setting up the AI. The [README](../README.md) has the short version.

## Buttons and shortcuts

| Do this                                                    | How                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Fill the page                                              | **Alt+Shift+F**, the toolbar button → _Fill this page_, or right-click → _Fill this page_           |
| Open the popup                                             | **Alt+Shift+J**, or click the toolbar button                                                        |
| See what was detected                                      | Toolbar → _Show detected fields_                                                                    |
| See the page as JobToFill does                             | Toolbar → _Page map_: every field, what it’s taken for and what’s missing; click a line to go to it |
| Save answers you typed                                     | Toolbar → _Learn from this page_                                                                    |
| Insert one value                                           | Right-click a box → _Insert from profile_                                                           |
| New password on a sign-up form                             | Right-click the password box → _Generate strong password_ (or just fill the page)                   |
| Undo a fill                                                | _Undo_ in the popup or in the on-page toast: every fill since the last Undo, the AI’s answers too   |
| Letter, CV and form in one go                              | Toolbar → _Quick apply_ (see the result later under _Last quick apply_)                             |
| Write a cover letter                                       | Toolbar → _Write cover letter_ on the application page (set up a key under _Cover letters & AI_)    |
| Answer the questions left                                  | Automatic with an AI key; or the popup’s _Answer them with AI_                                      |
| Let the AI answer diversity, legal, health or ID questions | Settings › _Cover letters & AI_ › _Questions the AI may also answer_ (all off by default)           |
| Emailed sign-in codes                                      | Automatic once your inbox is connected under _Email codes_; or right-click the box                  |
| Sign in / create an account                                | Fill the portal’s sign-in or sign-up page: it clicks _Sign in_ / _Create account_ for you           |

To change the shortcut, open `chrome://extensions/shortcuts` in Chromium browsers, or in Firefox go to `about:addons`, click ⚙, then **Manage Extension Shortcuts**. The settings page links there too.

## A typical application

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

**What the AI is used for.** Answers to the questions a fill leaves empty, cover letters, tailored CVs, a second look when JobToFill isn’t sure it found the right job, and _Ask the AI for more ideas_ in Discover. What each of these sends is listed under [Privacy and security](privacy.md).

**Help it answer.** Settings › _Cover letters & AI_ › _Answer guidance_ holds facts and rules the AI may rely on for questions your CV doesn’t settle (“I have no criminal convictions and no regulatory history.”), and Settings › _Skills & writing_ › _Extra details_ anything else an application might ask. Diversity questions, declarations and ID numbers are held back from the AI, and legal and health questions until you’ve written answer guidance, unless you switch them on under _Questions the AI may also answer_ (see the [settings reference](settings.md)).

**More than one provider.** Each provider keeps its own key and model, so you can switch back and forth. With keys for more than one, another takes over when the one you chose is out of credit, rate-limited or down (Claude first; you can switch that off).

**Fast mode.** Opus 5.5 has a **fast mode** (Settings › _Cover letters & AI_ › _Fast mode_, a research preview on Anthropic’s own API): it writes up to 2.5× as fast for twice the price (about 20¢ a letter); if your key can’t use it yet, Claude writes at its usual speed and _Test connection_ says so. Steps that don’t need reasoning (reading the job, the letter, the fact check, the CV) run without Claude thinking first, as they already do through OpenRouter, so Sonnet and Haiku start writing straight away. JobToFill keeps its instructions and your material in Claude’s prompt cache between the steps of a letter or a page of answers, so the repeated part costs a tenth as much.
