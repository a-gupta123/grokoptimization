import { useEffect, useState } from 'react'
import sampleUsage from '../fixtures/sample/personal-unified-usage.csv?raw'
import sampleTrace from '../fixtures/sample/transcript.json?raw'
import { parseTrace } from './parseTrace'
import {
  addSavedRun,
  compareSteps,
  defaultSuccessCheck,
  loadSavedTasks,
  redactAccounts,
  sameSuccessCheck,
  tokenDelta,
  writeSavedTasks,
  type SavedRun,
  type SavedTask,
  type StoredTokens,
} from './savedRuns'
import {
  matchRunUsage,
  parseTimestamp,
  parseUsageExport,
  summarizeWindow,
  TOKEN_FIELDS,
  type TokenRollup,
  type UsageEvent,
} from './parseUsage'
import './App.css'

export const RUN_TRACE_PROMPT = `Reply with one JSON object and no other text. Describe the run you just finished. Use null for anything you do not know. Do not guess.

{
  "task": null,
  "input": null,
  "steps": null,
  "toolCalls": null,
  "finalResult": null,
  "start": null,
  "end": null
}

When you know the steps, steps is an array of short strings in the order they happened. When you know the tool calls, toolCalls is an array in the order they ran, and each item has this shape: {"order": 1, "name": null, "arguments": null, "result": null}. Use null for a tool call's name, arguments, or result when that part is unknown. Use null for steps or toolCalls when you do not know them.
finalResult is the run's final answer. Use null when there is no final result yet or you do not know it.
start and end are the run's start and end times, each with a timezone. Prefer an offset, such as 2026-11-24T20:28:00-05:00. If you know the timezone name and not the offset, use the name, such as 2026-11-24T20:28:00 America/New_York. Use null when a time is unknown.`

const PREVIEW_LIMIT = 100

function UsageTable({ events }: { events: UsageEvent[] }) {
  return (
    <div className="table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th className="billing-id">Billing item</th>
            <th className="event-time">Event time</th>
            <th>Product</th>
            {TOKEN_FIELDS.map((field) => (
              <th key={field.key}>{field.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`${event.billingItemId}-${event.eventTime}-${index}`}>
              <td className="billing-id" title={event.billingItemId || undefined}>
                {event.billingItemId || '—'}
              </td>
              <td className="event-time">{event.eventTime}</td>
              <td>{event.product}</td>
              {TOKEN_FIELDS.map((field) => (
                <td key={field.key}>{event.tokens[field.key] ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function findingTitle(kind: 'repeated-lookup' | 'failed-fallback' | 'repeated-status') {
  if (kind === 'repeated-lookup') return 'Repeated lookup'
  if (kind === 'failed-fallback') return 'Failed action with a fallback'
  return 'Repeated status update'
}

function formatCount(value: number | null) {
  return value == null ? '—' : value.toLocaleString('en-US')
}

function formatDelta(left: number | null, right: number | null) {
  const delta = tokenDelta(left, right)
  if (delta == null) return '—'
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString('en-US')}`
}

function runLabel(run: SavedRun) {
  const when = new Date(run.savedAt)
  const time = Number.isNaN(when.getTime()) ? run.savedAt : when.toLocaleString()
  return `${time} · ${run.passed ? 'passed' : 'did not pass'}`
}

const TOKEN_ROWS: { label: string; key: keyof StoredTokens }[] = [
  { label: 'Total tokens', key: 'total' },
  { label: 'New input', key: 'newInput' },
  { label: 'Cache reads', key: 'cacheReads' },
  { label: 'Cache writes', key: 'cacheWrites' },
  { label: 'Output', key: 'output' },
  { label: 'Matched billing rows', key: 'rows' },
]

function TokenFigure({ label, rollup }: { label: string; rollup: TokenRollup }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {rollup.value == null ? '—' : rollup.value.toLocaleString('en-US')}
        {rollup.missingRows > 0 && (
          <span className="missing">
            {rollup.missingRows} {rollup.missingRows === 1 ? 'row is' : 'rows are'} missing this count
          </span>
        )}
      </dd>
    </div>
  )
}

function RunComparison({ left, right }: { left: SavedRun; right: SavedRun }) {
  const stepChanges = compareSteps(left.steps, right.steps)
  const unchanged = stepChanges.find((change) => change.kind === 'unchanged')
  return (
    <div className="comparison">
      <h4>Token usage</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Measure</th>
              <th>Run A</th>
              <th>Run B</th>
              <th>B − A</th>
            </tr>
          </thead>
          <tbody>
            {TOKEN_ROWS.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>
                  {formatCount(left.tokens[row.key])}
                  {row.key === 'total' && left.tokens.missingRows > 0 ? ' (incomplete)' : ''}
                </td>
                <td>
                  {formatCount(right.tokens[row.key])}
                  {row.key === 'total' && right.tokens.missingRows > 0 ? ' (incomplete)' : ''}
                </td>
                <td>{formatDelta(left.tokens[row.key], right.tokens[row.key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Step changes</h4>
      <p>
        {unchanged?.kind === 'unchanged' ? `${unchanged.count} steps are the same.` : 'No steps are the same.'}
      </p>
      {stepChanges.every((change) => change.kind === 'unchanged') ? (
        <p>No step changes.</p>
      ) : (
        <ul className="findings">
          {stepChanges.map((change, index) => {
            if (change.kind === 'unchanged') return null
            if (change.kind === 'changed') {
              return (
                <li key={`${change.fromStep}-${change.toStep}-${index}`}>
                  Step {change.fromStep} in run A changed at step {change.toStep} in run B.
                  <span className="step-diff">A: {change.before}</span>
                  <span className="step-diff">B: {change.after}</span>
                </li>
              )
            }
            if (change.kind === 'removed') {
              return (
                <li key={`removed-${change.step}-${index}`}>
                  Step {change.step} is only in run A. {change.text}
                </li>
              )
            }
            return (
              <li key={`added-${change.step}-${index}`}>
                Step {change.step} is only in run B. {change.text}
              </li>
            )
          })}
        </ul>
      )}
      <h4>Success check</h4>
      {sameSuccessCheck(left, right) ? (
        <p>
          {`Both runs use the same success check: ${left.successCheck} Run A ${left.passed ? 'passed' : 'did not pass'}. Run B ${right.passed ? 'passed' : 'did not pass'}.`}
        </p>
      ) : (
        <p>
          These runs were not judged on the same success check. Run A used “{left.successCheck}” and{' '}
          {left.passed ? 'passed' : 'did not pass'}. Run B used “{right.successCheck}” and{' '}
          {right.passed ? 'passed' : 'did not pass'}.
        </p>
      )}
    </div>
  )
}

function App() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'selected'>('idle')
  const [copiedFinding, setCopiedFinding] = useState<string | null>(null)
  const [usageName, setUsageName] = useState('')
  const [usageText, setUsageText] = useState('')
  const [traceText, setTraceText] = useState('')
  const [fileKey, setFileKey] = useState(0)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [timesConfirmed, setTimesConfirmed] = useState(false)
  const [timeError, setTimeError] = useState<string | null>(null)
  const [savedTasks, setSavedTasks] = useState<SavedTask[]>([])
  const [passed, setPassed] = useState<boolean | null>(null)
  const [checkDraft, setCheckDraft] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [compareChoice, setCompareChoice] = useState<Record<string, { left: string; right: string }>>({})

  const usage = usageText.trim() ? parseUsageExport(usageText) : null
  const trace = parseTrace(traceText)
  const preview = usage?.ok ? usage.events.slice(0, PREVIEW_LIMIT) : []
  const matched =
    timesConfirmed && usage?.ok ? matchRunUsage(usage.events, start, end) : null
  const matchedPreview = matched?.ok ? matched.events.slice(0, PREVIEW_LIMIT) : []
  const windowUsage = matched?.ok ? summarizeWindow(matched.events) : null
  const taskKey = trace?.ok ? (redactAccounts(trace.trace.task ?? '').trim() || null) : null
  const savedTask = taskKey ? savedTasks.find((item) => item.task === taskKey) : undefined
  const successCheck = savedTask?.successCheck ?? checkDraft
  const usingSample = usageText === sampleUsage && traceText.trim() === sampleTrace.trim()

  useEffect(() => {
    setSavedTasks(loadSavedTasks())
  }, [])

  useEffect(() => {
    setTimesConfirmed(false)
    setTimeError(null)
    setCopiedFinding(null)
    setPassed(null)
    setSaveError(null)
    setSaveMessage(null)
    if (trace?.ok) {
      setStart(trace.trace.start)
      setEnd(trace.trace.end)
      setCheckDraft(defaultSuccessCheck(trace.trace.outputRequirements))
    }
  }, [traceText])

  function selectPrompt(selector: string) {
    const prompt = document.querySelector(selector)
    if (!prompt) return
    const range = document.createRange()
    range.selectNodeContents(prompt)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  async function copyText(text: string, selector: string) {
    let copied = false
    try {
      const write = navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => false)
      copied = await Promise.race([
        write,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ])
    } catch {
      copied = false
    }
    if (!copied) selectPrompt(selector)
    return copied
  }

  async function copyPrompt() {
    const copied = await copyText(RUN_TRACE_PROMPT, '.run-trace-prompt')
    setCopyState(copied ? 'copied' : 'selected')
  }

  function onUsageFile(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setUsageName(file.name)
      setUsageText(typeof reader.result === 'string' ? reader.result : '')
    }
    reader.readAsText(file)
  }

  function changeTime(which: 'start' | 'end', value: string) {
    setTimesConfirmed(false)
    setTimeError(null)
    if (which === 'start') setStart(value)
    else setEnd(value)
  }

  function confirmTimes() {
    const startMs = parseTimestamp(start)
    const endMs = parseTimestamp(end)
    if (startMs == null || endMs == null) {
      setTimeError(
        'Enter a start and an end with a timezone offset, such as 2026-11-23T14:28:08.026Z or 2026-11-23T09:28:08.026-05:00.',
      )
      setTimesConfirmed(false)
      return
    }
    if (endMs < startMs) {
      setTimeError('The end time is before the start time.')
      setTimesConfirmed(false)
      return
    }
    setTimeError(null)
    setTimesConfirmed(true)
  }

  function saveRun() {
    if (!trace?.ok || !taskKey) {
      setSaveError('This trace has no task, so it cannot be saved for a later comparison.')
      return
    }
    if (passed == null) {
      setSaveError('Mark whether this run passed the success check before saving it.')
      return
    }
    if (!successCheck.trim()) {
      setSaveError('Enter the success check this run should be judged against.')
      return
    }
    const next = addSavedRun(savedTasks, {
      task: taskKey,
      outputRequirements: trace.trace.outputRequirements,
      successCheck,
      passed,
      start,
      end,
      usage: windowUsage,
      steps: trace.trace.steps,
    })
    try {
      writeSavedTasks(next)
    } catch {
      setSaveError('The browser could not store this run.')
      setSaveMessage(null)
      return
    }
    setSavedTasks(next)
    setSaveError(null)
    setSaveMessage('Saved. Compare it with another run of this task under Saved runs.')
    setPassed(null)
    const saved = next.find((item) => item.task === taskKey)
    const newest = saved?.runs[saved.runs.length - 1]
    if (saved && newest && saved.runs.length > 1) {
      setCompareChoice((current) => {
        const previous = current[saved.task]
        const stillThere = previous && saved.runs.some((run) => run.id === previous.left) && previous.left !== newest.id
        const left = stillThere ? previous.left : saved.runs[saved.runs.length - 2].id
        return { ...current, [saved.task]: { left, right: newest.id } }
      })
    }
    requestAnimationFrame(() => {
      document.getElementById('saved-runs')?.scrollIntoView({ block: 'start' })
    })
  }

  function trySample() {
    setUsageName('personal-unified-usage.csv (sanitized sample)')
    setUsageText(sampleUsage)
    setTraceText(sampleTrace.trim())
    setFileKey((key) => key + 1)
    requestAnimationFrame(() => {
      document.getElementById('usage-csv')?.scrollIntoView({ block: 'start' })
    })
  }

  return (
    <main className="prompt-page">
      <h1>Grok run review</h1>
      <p>Upload a usage events CSV and paste the run trace JSON from the same run.</p>
      <button type="button" className="sample" onClick={trySample}>
        Try the sanitized sample
      </button>

      <section id="usage-csv">
        <h2>Usage events CSV</h2>
        <p>
          Open{' '}
          <a href="https://grok.com/dashboard" target="_blank" rel="noreferrer">
            grok.com/dashboard
          </a>
          , go to Usage, and export the usage events. The download is named
          personal-unified-usage plus the date. If the account is still billed
          through Cursor, export it from Usage on{' '}
          <a href="https://cursor.com/dashboard" target="_blank" rel="noreferrer">
            cursor.com/dashboard
          </a>
          .
        </p>
        <label className="file-field">
          Usage events file
          <input
            key={fileKey}
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => onUsageFile(event.target.files?.[0])}
          />
        </label>
        {usage && !usage.ok && <p className="note bad">{usage.error}</p>}
        {usage?.ok && (
          <>
            <p className="note ok">
              {usageName || 'Usage CSV'}: {usage.events.length} usage{' '}
              {usage.events.length === 1 ? 'event' : 'events'}.
              {usage.events.length > preview.length
                ? ` Showing the first ${preview.length}.`
                : ''}
              {usingSample ? ' Sanitized sample, not a live usage export.' : ''}
            </p>
            <UsageTable events={preview} />
          </>
        )}
      </section>

      <section>
        <h2>Run trace JSON</h2>
        <p>
          Paste the transcript JSON. The sample shape has schemaVersion and
          value.entries. Each entry has a kind, the text, and timestampMs. You
          can also send the prompt below and paste that reply.
        </p>
        <pre className="prompt-text run-trace-prompt">{RUN_TRACE_PROMPT}</pre>
        <button type="button" onClick={copyPrompt}>
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'selected'
              ? 'Prompt selected'
              : 'Copy prompt'}
        </button>
        <label className="trace-field">
          Run trace JSON
          <textarea
            value={traceText}
            onChange={(event) => setTraceText(event.target.value)}
            placeholder='{"task": null, "input": null, "steps": null, "toolCalls": null, "finalResult": null, "start": null, "end": null}'
            spellCheck={false}
          />
        </label>
        {trace && !trace.ok && <p className="note bad">{trace.error}</p>}
        {trace?.ok && (
          <div className="review">
            <h3>Task</h3>
            <p>{trace.trace.task ?? 'No task in this trace.'}</p>
            <h3>Workflow</h3>
            {trace.trace.steps.length > 0 ? (
              <ol className="workflow">
                {trace.trace.steps.map((step) => (
                  <li key={step.number} value={step.number}>
                    <p>
                      <span className="step-label">Action.</span> {step.action ?? 'Not in this trace.'}
                    </p>
                    <p>
                      <span className="step-label">Tool calls.</span>{' '}
                      {step.toolCalls.length === 0
                        ? 'Not in this trace.'
                        : step.toolCalls.map((call, index) => (
                            <span key={`${step.number}-${index}`} className="tool-call">
                              {call.name ?? 'Unnamed tool'}. Arguments: {call.arguments ?? 'not in this trace'}.
                              Result: {call.result ?? 'not in this trace'}.
                            </span>
                          ))}
                    </p>
                    <p>
                      <span className="step-label">Result.</span> {step.result ?? 'Not in this trace.'}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No workflow steps in this trace.</p>
            )}
            <h3>Findings</h3>
            {trace.trace.findings.length > 0 ? (
              <ul className="findings">
                {trace.trace.findings.map((finding) => {
                  const findingId = `${finding.kind}-${finding.steps.join('-')}`
                  return (
                    <li key={findingId}>
                      <span className="step-label">{findingTitle(finding.kind)}.</span> {finding.explanation}
                      <pre className="prompt-text" data-prompt={findingId}>
                        {finding.prompt}
                      </pre>
                      <button
                        type="button"
                        onClick={async () => {
                          const copied = await copyText(finding.prompt, `[data-prompt="${findingId}"]`)
                          setCopiedFinding(copied ? findingId : `${findingId}:selected`)
                        }}
                      >
                        {copiedFinding === findingId
                          ? 'Copied'
                          : copiedFinding === `${findingId}:selected`
                            ? 'Prompt selected'
                            : 'Copy prompt'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p>
                No repeated lookup, failed action with a fallback, or repeated status update is
                supported by this trace.
              </p>
            )}
            <h3>Result</h3>
            <p>{trace.trace.result ?? 'No result in this trace.'}</p>
            <h3>Run times</h3>
            <p>
              Suggested from the first entry and the later of the last entry and
              persistedAt, in UTC. Change either time if the run window is wrong.
            </p>
            <label className="trace-field">
              Start
              <input value={start} onChange={(event) => changeTime('start', event.target.value)} />
            </label>
            <label className="trace-field">
              End
              <input value={end} onChange={(event) => changeTime('end', event.target.value)} />
            </label>
            <button type="button" onClick={confirmTimes} disabled={timesConfirmed}>
              {timesConfirmed ? 'Times confirmed' : 'Confirm times'}
            </button>
            {timeError && <p className="note bad">{timeError}</p>}
          </div>
        )}
      </section>

      <section id="analysis">
        <h2>Analysis</h2>
        {usingSample && (
          <p className="note">
            {timesConfirmed
              ? 'Sample result. These totals come from the sanitized fixture matched to the sample transcript.'
              : 'Sample result. Confirm the run times to match the sanitized CSV to this transcript.'}
          </p>
        )}
        {!trace?.ok && <p>Paste a trace to review the run.</p>}
        {trace?.ok && !timesConfirmed && (
          <p>Confirm or fix the run times before analyzing this run.</p>
        )}
        {trace?.ok && timesConfirmed && !usage && (
          <p>Upload the usage events CSV to match rows in this window.</p>
        )}
        {trace?.ok && timesConfirmed && usage && !usage.ok && (
          <p className="note bad">{usage.error}</p>
        )}
        {trace?.ok && timesConfirmed && usage?.ok && matched && !matched.ok && (
          <p className="note bad">{matched.error}</p>
        )}
        {trace?.ok && timesConfirmed && matched?.ok && windowUsage && (
          <>
            <h3>Usage in the run window</h3>
            <dl className="usage-summary">
              <TokenFigure label="Total tokens" rollup={windowUsage.total} />
              <TokenFigure label="New input" rollup={windowUsage.newInput} />
              <TokenFigure label="Cache reads" rollup={windowUsage.cacheReads} />
              <TokenFigure label="Cache writes" rollup={windowUsage.cacheWrites} />
              <TokenFigure label="Output" rollup={windowUsage.output} />
              <div>
                <dt>Matched billing rows</dt>
                <dd>{windowUsage.rows.toLocaleString('en-US')}</dd>
              </div>
            </dl>
            <p className="note">
              {start} inclusive through {end} exclusive. Repeated billing item ids are kept once.
              {matched.events.length > matchedPreview.length
                ? ` Showing the first ${matchedPreview.length} rows.`
                : ''}
            </p>
            {matchedPreview.length > 0 && <UsageTable events={matchedPreview} />}
          </>
        )}
        {trace?.ok && timesConfirmed && (
          <div className="save-run">
            <h3>Save this run</h3>
            <p>
              The browser keeps the task, token totals, steps, and whether the run passed. It does
              not keep the CSV, billing item ids, email addresses, or account ids.
            </p>
            <label className="trace-field">
              Success check
              {savedTask ? (
                <textarea value={savedTask.successCheck} readOnly />
              ) : (
                <textarea value={checkDraft} onChange={(event) => setCheckDraft(event.target.value)} />
              )}
            </label>
            {savedTask && (
              <p className="note">Later runs of this task use this same success check.</p>
            )}
            <div className="pass-choice">
              <label>
                <input
                  type="radio"
                  name="passed"
                  checked={passed === true}
                  onChange={() => setPassed(true)}
                />{' '}
                Passed
              </label>
              <label>
                <input
                  type="radio"
                  name="passed"
                  checked={passed === false}
                  onChange={() => setPassed(false)}
                />{' '}
                Did not pass
              </label>
            </div>
            <button type="button" onClick={saveRun}>
              Save run
            </button>
            {saveError && <p className="note bad">{saveError}</p>}
            {saveMessage && <p className="note ok">{saveMessage}</p>}
          </div>
        )}
      </section>

      <section id="saved-runs">
        <h2>Saved runs</h2>
        {savedTasks.length === 0 ? (
          <p>No analyzed runs are saved in this browser yet.</p>
        ) : (
          savedTasks.map((item) => {
            const choice = compareChoice[item.task] ?? {
              left: item.runs[0]?.id ?? '',
              right: item.runs[1]?.id ?? item.runs[0]?.id ?? '',
            }
            const left = item.runs.find((run) => run.id === choice.left)
            const right = item.runs.find((run) => run.id === choice.right)
            const comparable = left && right && left.id !== right.id
            return (
              <div key={item.task} className="saved-task">
                <h3>{item.task}</h3>
                <p>{item.runs.length === 1 ? '1 saved run' : `${item.runs.length} saved runs`}.</p>
                {item.runs.length < 2 ? (
                  <p>Save another run of this task to compare it.</p>
                ) : (
                  <>
                    <div className="compare-picks">
                      <label className="trace-field">
                        Run A
                        <select
                          value={choice.left}
                          onChange={(event) =>
                            setCompareChoice((current) => ({
                              ...current,
                              [item.task]: { ...choice, left: event.target.value },
                            }))
                          }
                        >
                          {item.runs.map((run) => (
                            <option key={run.id} value={run.id}>
                              {runLabel(run)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="trace-field">
                        Run B
                        <select
                          value={choice.right}
                          onChange={(event) =>
                            setCompareChoice((current) => ({
                              ...current,
                              [item.task]: { ...choice, right: event.target.value },
                            }))
                          }
                        >
                          {item.runs.map((run) => (
                            <option key={run.id} value={run.id}>
                              {runLabel(run)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {comparable && (
                      <RunComparison left={left} right={right} />
                    )}
                  </>
                )}
              </div>
            )
          })
        )}
      </section>
    </main>
  )
}

export default App
