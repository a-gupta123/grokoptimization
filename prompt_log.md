# Prompt log

Append each prompt used to change this app or the incident-digest bot. Newest entry first. Include the date and the prompt text.

## 2026-11-25

Deploy with the configured hosting account and verify imports, copy buttons, saved runs, and comparison at the public URL. Add the project link to my portfolio if you have access to the repo.

Test the full flow with the sanitized sample. If you have access to Grok Bot and its usage export, run a baseline and revised workflow with the same input, check both outputs, and verify the token totals against the CSV. Use browser testing to catch and fix usability issues. Clearly label sample results and any checks you couldn't perform.

Add 3 to 5 meaningful tests and set up GitHub Actions to run them on every push. Cover CSV parsing, timezone and window boundaries, duplicate ids, and comparison totals.

Save analyzed runs in the browser without storing the raw CSV or account identifiers. Let me compare two runs of the same task by token usage, step changes, and whether they passed the same success check.

Add a copyable Grok Bot prompt for each finding. Each prompt should change one thing and keep the same task, input, and output requirements.

Show the workflow steps in order with their actions, tool calls, and results. Flag repeated lookups, failed actions with fallbacks, and repeated status updates only when the trace supports it. Show the step numbers and explain each finding.

Show total tokens, new input, cache reads, cache writes, output, and matched billing rows. Label it "usage in the run window" and handle missing data.

Match usage CSV rows to the trace's start and end times. Handle timezone offsets, include the start and exclude the end, filter to grok-bot, and dedupe by billing item id.

## 2026-11-24

Accept the trace structure from my sample. Show the task, steps, and result, and let me confirm or fix the run times before analyzing it.

Parse the personal unified usage export, including event time, product, and the token counts inside Usage. Show an error if I upload the daily or hourly totals CSV.

Let me upload the usage events CSV and paste the run trace JSON. Show where to get both and add a button to try the sample.

Add a copyable prompt that asks Grok Bot for the task, input, steps in order, tool calls, and final result as JSON. Ask for start and end times with a timezone. Use null for unknowns.

Make a small sanitized sample from the usage events CSV and run trace. Remove emails, account ids, and private details. Keep the real file structure.

Set up React, TypeScript, and Vite. Start this log. Ignore raw exports and secrets. Remote: https://github.com/a-gupta123/grokoptimization.git

Write a short spec for a site that takes a Grok bot usage CSV and run trace, finds possible inefficiencies, and gives prompts to test changes. Use one repeatable task for the demo.
