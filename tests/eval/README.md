# AI eval

Measures the two AI features on fixed data, so providers, models and prompt changes can be compared on quality, cost and time:

- **Answers**: `answers.answer()` on the questions a fill leaves empty on 40 live application forms (276 questions, each labelled by hand).
- **Cover letters**: `letter.analyse()` then `letter.write()` on 12 postings from those forms.

It runs exactly what ships: the extension's own pipelines through its own chat client (`ai.js`), with the provider, model and key you give it. Nothing is re-implemented. The candidate is the live survey's fictional applicant (`SURVEY_PROFILE` and `SURVEY_CV` in `tests/live/profile.mjs`), answering as on 2 October 2026. The data files hold public job postings and form questions only; email addresses and phone numbers in them are removed.

## Running a model

```bash
OPENROUTER_API_KEY=sk-or-… node tests/eval/run.mjs --suite all --provider openrouter --model deepseek/deepseek-v4.1-flash --split train
ANTHROPIC_API_KEY=sk-ant-… node tests/eval/run.mjs --provider anthropic --model claude-sonnet-5-5 --split train
OPENROUTER_API_KEY=sk-or-… node tests/eval/run.mjs --provider openrouter --model anthropic/claude-sonnet-5.5 --label sonnet-train --split train
DEEPSEEK_API_KEY=sk-… node tests/eval/run.mjs --provider deepseek --model deepseek-chat
AI_API_KEY=… node tests/eval/run.mjs --provider custom --base-url https://api.example.com/v1 --model some-model
```

`--suite answers|letters|all`, `--split train|test|all`, `--cases N` (the first N of each suite), `--reps N` (each case N times), `--concurrency 4`, `--label name`, `--out dir`, `--fast` (Claude Opus's fast mode, with `--provider anthropic --model claude-opus-5-5`: compare its time and cost with a run without it). A missing key stops it before any call. Errors in one case (a malformed reply, a rate limit) are recorded and the run goes on; Ctrl-C stops it and keeps what's done.

Each run writes `tests/eval/runs/<time>-<label or model>/` (not committed): `config.json`, `cassette.jsonl` (every call: messages, options, reply, usage, time), `results.json` (every case and question, graded) and `summary.json`, then prints its scoreboard line.

`--provider fake --model oracle` (or `null`) runs the harness on scripted replies: the oracle answers what the labels say should be answered and writes a letter that passes every check, so it must score full coverage, no violations and every letter passing; the null model must score nothing. A miss on the oracle is a question the extension withholds although its label says to answer it: one of the two is wrong (this is how the `disciplines`, accommodation-boilerplate and parents' education cases in `answers.withheld()` were found). If either doesn't, the harness is broken, not the model.

## Replay

```bash
node tests/eval/run.mjs --replay tests/eval/runs/<run>             # no key, no network, no cost
node tests/eval/run.mjs --replay tests/eval/runs/<run> --replay-loose
```

A replay runs the same pipelines again and serves each case's recorded replies in order, so changed graders or labels re-score an old run for free. A call whose prompt differs from the recording (the pipeline or the data changed) fails its case; `--replay-loose` serves the recorded reply anyway.

## What the numbers mean

Each question is labelled `answer` (the candidate's material settles it, plus preferences and motivation the product is meant to write) or `skip` (the material can't settle it: a referrer, a GPA conversion, a salary; or it is never the AI's to answer: diversity, declarations, legal and health questions without guidance). Skip labels name a category; choice questions can list the `acceptable` options.

```bash
node tests/eval/scoreboard.mjs                       # every run in tests/eval/runs
node tests/eval/scoreboard.mjs tests/eval/runs/<a> tests/eval/runs/<b> --split test
```

| Column     | Meaning                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| cover      | answered and labelled `answer` ÷ labelled `answer`                                                                                 |
| safe       | answered and labelled `answer` ÷ answered                                                                                          |
| violations | answers to questions labelled `skip` (invented, or never the AI's): the worst failure. `summary.json` breaks them down by category |
| miss       | `answer` questions left empty, by why: withheld, dropped, invalid, omitted or the model's own skip                                 |
| drop       | answers the pipeline threw away for failing its checks (invented numbers or tools, another employer's name)                        |
| letters    | letters with no check errors left after the retries                                                                                |
| judge      | supported rate, then mean scores 1–5: answers the question / specificity / voice (letters add structure / fit)                     |
| cost       | `usage.cost` where the provider reports it (OpenRouter), else tokens × `prices.mjs`; `?` when unknown                              |
| mean       | time per case                                                                                                                      |

`results.json` has every question's answer, warnings and grade, and `summary.json` the wrong choices, warnings, numbers by question kind, case errors by kind (rate limits and timeouts are plumbing, not the model), and which models actually answered.

## The judge

```bash
ANTHROPIC_API_KEY=sk-ant-… node tests/eval/run.mjs … --judge
ANTHROPIC_API_KEY=sk-ant-… node tests/eval/run.mjs --replay tests/eval/runs/<run> --judge
```

Claude Opus 5.5 grades each written answer of eight words or more and each letter against a fixed rubric (`judge.mjs`): whether every claim about the candidate is backed (with the unbacked quotes), how well it answers the question, specificity, voice, and for letters structure and fit. The rubric and the candidate's material are cached across calls, and a form's posting across its answers. A refusal or a cut-off reply is recorded as unavailable. Its cost is kept apart from the run's. A replay judged again reuses the grades already made. The judge is the same family as the Claude models under test, so read its scores beside the label-based numbers, not instead of them.

## Train and test

Every form and posting is in `train` (about 70%) or `test`, by employer. Tune prompts on `--split train` only, and report `--split test` (or `--split all` with `scoreboard.mjs --split test`) once a change is settled. The test split is small (11 forms, 4 letters): a few questions either way is noise, so compare with `--reps 3` before trusting a small difference.

## Cost

A full run is about 100 model calls and 0.3–0.5M input tokens: roughly $0.25 on DeepSeek V4.1 Flash, $0.10 on Claude Haiku 5.5, $2 on Claude Sonnet 5.5 and $3.50 on Claude Opus 5.5, more for models that reason. The train split is about 70% of that. Judging a full run (about 70 pieces) adds roughly $2–4.

## Changing the data

`node tests/eval/build.mjs` reads the open programmes on Trackr again (`--region`, `--industry`, `--limit`, `--save raw.json`; `--from raw.json` rebuilds from saved forms) and picks a spread of forms with questions left for the AI, one per employer. Labels are kept for every question that hasn't changed; new ones come out unlabelled and `npm run test:unit` fails until they're labelled. Label by reading each question against the candidate's profile and CV, never by running the extension's own rules.
