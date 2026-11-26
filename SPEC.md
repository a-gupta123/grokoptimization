# Spec: Grok run review

A single-page site. You give it a Grok bot usage CSV and the matching run trace. It lists likely waste in that run and returns prompts you can paste to test a tighter version of the same task.

## Demo task

One task, used every time you open the demo.

**Incident digest.** Frozen task text:

> Read `incidents/` for the last 24 hours. Reply with exactly five lines: what broke, who is affected, current status, owner, next check. Skip incidents already marked resolved.

The demo always loads the same corpus and the same recorded run in `fixtures/incident-digest/` (`usage.csv`, `trace.jsonl`). A test is a re-run of this task text (plus one added constraint) against that corpus. The site compares the new CSV and trace to the fixture.

## Inputs

Both files are required and must be the same run. `step_id` joins them.

**usage.csv** — one row per model or tool call:

- `step_id`
- `kind` — `model` or `tool`
- `name` — model id or tool name
- `input_tokens`, `output_tokens` — integers
- `latency_ms` — integer
- `cached_tokens` — integer, `0` when the prefix was not cached

**trace.jsonl** — one JSON object per step, in order:

- `step_id`
- `role` — `user`, `assistant`, or `tool`
- `text` — prompt, reply, or tool output
- `tool`, `args` — present when the assistant calls a tool
- `cites` — earlier `step_id`s this step actually uses

The first `user` step is the task text. The demo opens with the fixture already loaded.

## Checks

Four checks. Each one names the `step_id`s involved and a token estimate: the sum of `input_tokens` on steps that repeat or discard work. A check with no match stays off the page.

1. **Repeated read.** The same tool name and args, or the same tool output, show up on more than one step.
2. **Unused bulk.** A tool output is longer than 2,000 characters, and later steps cite only a short slice of it.
3. **Second draft.** The assistant writes a structured answer, then a later assistant step restates it as the five-line digest.
4. **Cold context.** `cached_tokens` is `0` on a model call whose prompt repeats a prefix already sent earlier in this run.

## Test prompts

Each finding includes one test prompt: the original task text plus a single constraint aimed at that check. Copy it, run the bot on the same `incidents/` corpus, and upload the new CSV and trace.

The demo prompts are fixed:

1. Repeated read — "Open each incident file at most once. Keep a private list of path to status, and do not reopen a path."
2. Unused bulk — "Read only the title, status, owner, and affected-service lines. Do not load full incident bodies."
3. Second draft — "Reply with the five lines only. Do not write an outline or JSON first."
4. Cold context — "Put the standing rules in a stable prefix at the top of the prompt, and do not paraphrase them between calls."

After the second upload, the page shows the fixture run and the re-run together: token totals, and pass or fail for each of the four checks.

## Page

One screen.

- Header: task name, total input tokens, total output tokens, step count.
- Findings: check name, step ids, token estimate, test prompt, copy button.
- Compare: fixture column and re-run column.

## This version

The page reviews this one task. It scores uploads of that task. It does not keep a history of other tasks, re-run the bot, or edit the bot's tools. Findings stay inside the four checks.
