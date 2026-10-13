# Security

## Reporting a vulnerability

Please don’t open a public issue. Report it privately through GitHub: the repository’s **Security** tab › **Report a vulnerability** ([direct link](https://github.com/rob435/JobToFill/security/advisories/new)). Only the maintainers see it.

Say what an attacker could do and how: a web page or a frame in it, another extension, a crafted job posting or email, a file. Steps or a page that shows it help most, with your browser and JobToFill version (at the bottom of the toolbar popup).

Fixes go out in a new release. Firefox installs from a release update themselves; an unpacked install needs the newer `jobtofill-chrome.zip` unzipped over its folder. Only the latest release is supported.

## What counts

JobToFill holds a lot about the person using it, so these are vulnerabilities:

- A web page, a frame or another extension reading the profile, documents, saved logins, cards or API keys.
- Logins or cards filled where they must not be: a page that isn’t HTTPS, another site, a hidden or off-screen field, a third-party frame.
- Personal details, documents or keys sent anywhere except the AI provider the person chose (with their key) and Nylas (for emailed codes), or sent there before the person switched that on.
- The AI being sent what it must never see: diversity and equal-opportunity answers, declarations, identity numbers.
- Personal details left in a bug-report snapshot or a redacted page map.
- JobToFill submitting an application, or clicking anything beyond what [docs/privacy.md](docs/privacy.md) lists.

Not in scope: someone who can already open the browser profile or the Downloads folder reading what is kept there. Logins, cards and keys are stored unencrypted by design, as [docs/privacy.md](docs/privacy.md) says.

## What JobToFill holds

- **In the browser’s extension storage:** the profiles (contact details, address, education, work history, answers, equal-opportunity answers), documents (CVs, cover letters and the material for them), saved logins and cards, the API keys for the AI provider and Nylas, settings and history.
- **In the Downloads folder:** `JobToFill/jobtofill-backup.json`, rewritten after each change unless automatic backups are off: plain JSON, logins, cards and API keys included (the keys can be left out).
- **In the browser’s session memory only:** the last few job pages each tab showed, to find the job behind an application.

There are no servers and no analytics. Everything that does leave the browser, and when, is in [docs/privacy.md](docs/privacy.md).
