# JobToFill

[![CI](https://github.com/rob435/JobToFill/actions/workflows/ci.yml/badge.svg)](https://github.com/rob435/JobToFill/actions/workflows/ci.yml)

A browser extension for Chrome, Edge, Brave and Firefox that fills in job applications for you. Save your details once, open an application, press **Alt+Shift+F**, and the form is filled. You check it and press Submit yourself.

## What it does

- **Fills the form** from your profile: contact details, education, work history, your CV and the usual questions (right to work, start date, “How did you hear about us?”). It works on Workday, Greenhouse, Lever, Ashby and most other job sites.
- **Answers the rest with AI**, if you add your own API key: “Why do you want to join us?” and anything else it doesn’t know. AI answers are outlined in orange so you can check them.
- **Writes cover letters and tailors your CV** to the job.
- **Signs you in to job portals**, makes a strong password for each one, and types in the codes they email you.
- **Fills everyday forms too**: sign-ups and checkouts, with your saved passwords and cards.
- **Never submits.** You always press Submit yourself.
- **Private.** No account, no server, no tracking. Your details stay in your browser, apart from what you send to your own AI provider.

## Install

**Chrome, Edge or Brave**

1. Download `jobtofill-chrome.zip` from the [latest release](https://github.com/rob435/JobToFill/releases/latest) and unzip it into a folder you’ll keep.
2. Go to `chrome://extensions` (`edge://extensions` in Edge) and turn on **Developer mode**.
3. Click **Load unpacked** and choose that folder.

**Firefox** (version 142 or newer)

1. Download `jobtofill.xpi` from the [latest release](https://github.com/rob435/JobToFill/releases/latest).
2. Open `about:addons`, click ⚙ › **Install Add-on From File…** and choose the file.

Firefox updates JobToFill by itself. In Chrome, unzip a newer release over the same folder and click the reload arrow on JobToFill’s card. Other ways to install: [docs/install.md](docs/install.md).

## Get started

1. **Fill in your profile.** The settings page opens when you install. The **Get started** list at the top shows what to add: your name and email, your CV and your education.
2. **Add an AI key** if you want cover letters and AI answers (see [AI](#ai-optional)).
3. **Open a job application and press Alt+Shift+F**, or click the JobToFill button › _Fill this page_.
4. **Check every answer, then press Submit.**

## Everyday use

| To                                    | Do this                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| Fill a page                           | **Alt+Shift+F**, or the JobToFill button › _Fill this page_ |
| Undo a fill                           | _Undo_ in the popup, or in the message on the page          |
| Write a cover letter                  | JobToFill button › _Write cover letter_                     |
| Get the letter, CV and form in one go | JobToFill button › _Quick apply_                            |
| Remember answers you typed            | JobToFill button › _Learn from this page_                   |
| Put one detail into a box             | Right-click the box › _Insert from profile_                 |

More: [docs/using.md](docs/using.md).

## AI (optional)

JobToFill works without AI. With your own API key it also answers the questions it doesn’t know and writes cover letters. You pay the provider directly: a letter costs from a tenth of a cent to about 10¢, depending on the model.

1. Get a key from [OpenRouter](https://openrouter.ai/settings/keys), [Anthropic (Claude)](https://console.anthropic.com/settings/keys) or [DeepSeek](https://platform.deepseek.com/api_keys).
2. Paste it into Settings › _Cover letters & AI_ and click **Test connection**.

By default the AI isn’t given diversity, legal, health or ID questions. You can let it answer them under Settings › _Cover letters & AI_ › _Questions the AI may also answer_.

## Privacy

- Your profile is kept in your browser, with a backup file in your Downloads folder.
- Your details are sent nowhere except to the AI provider you choose (only when you use AI) and to Nylas (only if you connect your inbox for emailed codes).
- Passwords and card numbers are never sent to the AI. They are only filled in on secure (`https`) pages, when you start a fill, and a saved password only on its own site.

Full details: [docs/privacy.md](docs/privacy.md).

## Help

- **Nothing happens:** click the JobToFill button › _Fill this page_. It says what’s wrong; often you just need to click **Allow**.
- **A box is wrong or empty:** right-click it › _Insert from profile_, or type the answer and click _Learn from this page_ so it’s remembered.
- **Your details are gone after reinstalling:** the settings page offers to restore them from `Downloads/JobToFill/jobtofill-backup.json`.
- **Still stuck?** See [troubleshooting](docs/troubleshooting.md), or [report a form that fills wrongly](https://github.com/rob435/JobToFill/issues/new?template=form-fills-wrongly.yml).

## More

- [All features](docs/features.md) · [Every setting](docs/settings.md) · [Using it](docs/using.md) · [Install options](docs/install.md) · [Troubleshooting](docs/troubleshooting.md) · [Privacy](docs/privacy.md)
- For developers: [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md)
