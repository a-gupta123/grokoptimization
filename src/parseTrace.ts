export type ToolCall = {
  name: string | null
  arguments: string | null
  result: string | null
}

export type WorkflowStep = {
  number: number
  action: string | null
  toolCalls: ToolCall[]
  result: string | null
  failed: boolean
  failureDetail: string | null
  fallback: boolean
  statusText: string | null
}

export type Finding = {
  kind: 'repeated-lookup' | 'failed-fallback' | 'repeated-status'
  steps: number[]
  explanation: string
  prompt: string
}

type RunBrief = {
  task: string | null
  input: string | null
  outputRequirements: string | null
}

export type ParsedTrace = {
  task: string | null
  steps: WorkflowStep[]
  findings: Finding[]
  result: string | null
  outputRequirements: string | null
  start: string
  end: string
}

export type TraceParse = { ok: true; trace: ParsedTrace } | { ok: false; error: string }

type Entry = Record<string, unknown>

function textOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function jsonText(value: unknown): string | null {
  const direct = textOf(value)
  if (direct) return direct
  if (!value || typeof value !== 'object') return null
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortKeys(record[key])
      return sorted
    }, {})
}

function canonical(value: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(value)))
  } catch {
    return value
  }
}

function supported(value: string | null): string | null {
  if (!value || value === '[redacted]') return null
  return value
}

function entryTime(entry: Entry): number | null {
  return typeof entry.timestampMs === 'number' && Number.isFinite(entry.timestampMs)
    ? entry.timestampMs
    : null
}

function userText(entry: Entry): string | null {
  return textOf(entry.content)
}

function botText(entry: Entry): string | null {
  const message = entry.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  return textOf((message as { content?: unknown }).content)
}

function eventText(entry: Entry): string | null {
  const event = entry.event
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'Event'
  const record = event as { type?: unknown; action?: unknown }
  const type = textOf(record.type)
  const action = textOf(record.action)
  if (type && action) return `${type}: ${action}`
  return type ?? action ?? 'Event'
}

function stepAction(entry: Entry): string | null {
  if (entry.kind === 'send-message') return botText(entry)
  if (entry.kind === 'message') {
    const text = userText(entry)
    return text ? `You: ${text}` : null
  }
  if (entry.kind === 'event') return eventText(entry)
  return null
}

function blankStep(number: number): WorkflowStep {
  return {
    number,
    action: null,
    toolCalls: [],
    result: null,
    failed: false,
    failureDetail: null,
    fallback: false,
    statusText: null,
  }
}

function failureDetail(record: Entry, resultText: string | null): string | null {
  if (record.failed === true || record.ok === false) {
    return textOf(record.error) ?? resultText ?? 'The trace marks it as failed.'
  }
  const status = textOf(record.status)?.toLowerCase()
  if (status === 'failed' || status === 'error' || status === 'failure') {
    return textOf(record.error) ?? resultText ?? status
  }
  const error = textOf(record.error)
  if (error) return error
  return failureFromText(resultText)
}

function failureFromText(resultText: string | null): string | null {
  if (!resultText || resultText === '[redacted]') return null
  if (resultText.startsWith('{') || resultText.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(resultText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return failureDetail(parsed as Entry, null)
      }
    } catch {
      return null
    }
  }
  const match = /^(error|failed|failure)\b[:\s-]*(.*)$/i.exec(resultText)
  if (!match || resultText.length > 240) return null
  return resultText
}

function marksFallback(record: Entry, action: string | null, toolName: string | null): boolean {
  if (record.fallback === true || typeof record.fallbackOf === 'number') return true
  return /\bfallback\b/i.test(`${action ?? ''}\n${toolName ?? ''}`)
}

function statusTextOf(record: Entry, action: string | null): string | null {
  if (record.statusUpdate === true) {
    return supported(textOf(record.statusText) ?? textOf(record.status) ?? action)
  }
  const match = /^(?:status(?:\s+update)?)\s*[:\-]\s*(.+)$/i.exec(action ?? '')
  return supported(match?.[1]?.trim() ?? null)
}

function isLookup(name: string): boolean {
  return /(^|[^a-z])(read|lookup|look up|search|grep|glob|get|list|fetch|find|open|query|stat|cat)([^a-z]|$)/i.test(
    name,
  )
}

function parseToolCall(value: unknown): { call: ToolCall; failed: boolean; failureDetail: string | null; fallback: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Entry
  const name = textOf(record.name) ?? textOf(record.tool)
  const args = jsonText(record.arguments ?? record.args)
  const result = jsonText(record.result)
  if (!name && !args && !result && record.failed !== true && record.fallback !== true) return null
  const detail = failureDetail(record, result)
  return {
    call: { name, arguments: args, result },
    failed: detail != null,
    failureDetail: detail,
    fallback: marksFallback(record, null, name),
  }
}

function stepFromValue(value: unknown, number: number): WorkflowStep | null {
  if (typeof value === 'string') {
    const action = textOf(value)
    if (!action) return null
    const step = blankStep(number)
    step.action = action
    step.fallback = /\bfallback\b/i.test(action)
    step.statusText = statusTextOf({}, action)
    return step
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Entry
  const action = textOf(record.action) ?? textOf(record.text) ?? textOf(record.description)
  const result = jsonText(record.result)
  const step = blankStep(number)
  step.action = action
  step.result = result
  const detail = failureDetail(record, result)
  step.failed = detail != null
  step.failureDetail = detail
  step.fallback = marksFallback(record, action, textOf(record.tool) ?? textOf(record.name))
  step.statusText = statusTextOf(record, action)

  const nested = Array.isArray(record.toolCalls) ? record.toolCalls : []
  const single = parseToolCall({
    name: record.tool ?? record.name,
    arguments: record.arguments ?? record.args,
    result: record.toolResult,
    failed: record.failed,
    error: record.error,
    fallback: record.fallback,
  })
  for (const item of nested) {
    const parsed = parseToolCall(item)
    if (!parsed) continue
    step.toolCalls.push(parsed.call)
    if (parsed.failed) {
      step.failed = true
      step.failureDetail ??= parsed.failureDetail
    }
    if (parsed.fallback) step.fallback = true
  }
  if (single && (textOf(record.tool) || textOf(record.name) || record.arguments || record.args || record.toolResult)) {
    step.toolCalls.push(single.call)
    if (single.failed) {
      step.failed = true
      step.failureDetail ??= single.failureDetail
    }
    if (single.fallback) step.fallback = true
  }
  if (!step.action && step.toolCalls.length === 0 && !step.result && !step.failed && !step.fallback && !step.statusText) {
    return null
  }
  return step
}

function attachToolCalls(steps: WorkflowStep[], toolCalls: unknown): WorkflowStep[] {
  if (!Array.isArray(toolCalls)) return steps
  const next = steps.map((step) => ({ ...step, toolCalls: [...step.toolCalls] }))
  toolCalls.forEach((raw, index) => {
    const parsed = parseToolCall(raw)
    if (!parsed) return
    const order =
      raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Entry).order === 'number'
        ? (raw as Entry).order
        : null
    const orderNumber = typeof order === 'number' && Number.isFinite(order) ? order : null
    let step = orderNumber == null ? next[index] : next.find((item) => item.number === orderNumber)
    if (!step) {
      step = blankStep(orderNumber ?? next.length + 1)
      next.push(step)
      next.sort((a, b) => a.number - b.number)
    }
    step.toolCalls.push(parsed.call)
    if (parsed.failed) {
      step.failed = true
      step.failureDetail ??= parsed.failureDetail
    }
    if (parsed.fallback) step.fallback = true
  })
  return next
}

function stepList(numbers: number[]): string {
  const unique = [...new Set(numbers)]
  if (unique.length === 1) return `Step ${unique[0]}`
  if (unique.length === 2) return `Steps ${unique[0]} and ${unique[1]}`
  return `Steps ${unique.slice(0, -1).join(', ')}, and ${unique.at(-1)}`
}

function requirementText(value: unknown): string | null {
  return textOf(value) ?? jsonText(value)
}

function findingPrompt(change: string, brief: RunBrief): string {
  return [
    'Do the same task again. Use the same input. Meet the same output requirements. Change only this:',
    change,
    '',
    'Task:',
    brief.task ?? 'Not in this trace. Use the same task as the run you just finished.',
    '',
    'Input:',
    brief.input ?? 'Not in this trace. Use the same input as that run.',
    '',
    'Output requirements:',
    brief.outputRequirements ??
      'Not in this trace. Keep the output requirements already in the task. Do not change what the answer must contain or how it must be shaped.',
  ].join('\n')
}

export function workflowFindings(steps: WorkflowStep[], brief: RunBrief): Finding[] {
  const findings: Finding[] = []

  const lookups = new Map<string, { name: string; args: string; steps: number[]; count: number }>()
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const name = supported(call.name)
      const args = supported(call.arguments)
      if (!name || !args || !isLookup(name)) continue
      const key = `${name.toLowerCase()}\n${canonical(args)}`
      const group = lookups.get(key) ?? { name, args, steps: [], count: 0 }
      group.steps.push(step.number)
      group.count += 1
      lookups.set(key, group)
    }
  }
  for (const group of lookups.values()) {
    const unique = [...new Set(group.steps)]
    if (group.count < 2) continue
    const where =
      unique.length === 1
        ? `Step ${unique[0]} calls ${group.name} ${group.count} times`
        : `${stepList(unique)} call ${group.name}`
    findings.push({
      kind: 'repeated-lookup',
      steps: unique,
      explanation: `${where} with the same arguments: ${group.args}.`,
      prompt: findingPrompt(
        `Call ${group.name} at most once with ${group.args}, and reuse the first result.`,
        brief,
      ),
    })
  }

  const fallbacks = steps.filter((step) => step.fallback)
  const claimed = new Set<number>()
  for (const fallback of fallbacks) {
    const failed = steps.filter((step) => step.failed && step.number < fallback.number && !claimed.has(step.number))
    if (failed.length === 0) continue
    const previousFallback = fallbacks.filter((step) => step.number < fallback.number).at(-1)
    const batch = failed.filter((step) => previousFallback == null || step.number > previousFallback.number)
    if (batch.length === 0) continue
    batch.forEach((step) => claimed.add(step.number))
    const details = batch
      .map((step) => step.failureDetail)
      .filter((detail): detail is string => !!detail)
    const detailText =
      details.length > 0
        ? ` ${details.map((detail) => (detail.endsWith('.') ? detail : `${detail}.`)).join(' ')}`
        : ''
    const fallbackAction = fallback.action ? `: ${fallback.action}` : ''
    const failedAction = batch.map((step) => step.action).find((action) => action) ?? null
    const change = failedAction
      ? `If "${failedAction}" fails, report the failure and stop instead of using a fallback.`
      : 'If an action fails, report the failure and stop instead of using a fallback.'
    findings.push({
      kind: 'failed-fallback',
      steps: [...batch.map((step) => step.number), fallback.number],
      explanation: `${stepList(batch.map((step) => step.number))} failed.${detailText} ${stepList([fallback.number])} is the fallback${fallbackAction}.`,
      prompt: findingPrompt(change, brief),
    })
  }

  const statuses = new Map<string, number[]>()
  for (const step of steps) {
    if (!step.statusText) continue
    const group = statuses.get(step.statusText) ?? []
    group.push(step.number)
    statuses.set(step.statusText, group)
  }
  for (const [status, numbers] of statuses) {
    const unique = [...new Set(numbers)]
    if (unique.length < 2) continue
    findings.push({
      kind: 'repeated-status',
      steps: unique,
      explanation: `${stepList(unique)} repeat the status “${status}”.`,
      prompt: findingPrompt(`Send the status "${status}" once, and do not post it again.`, brief),
    })
  }

  return findings
}

function withFindings(
  trace: Omit<ParsedTrace, 'findings' | 'outputRequirements'>,
  brief: RunBrief,
): ParsedTrace {
  return {
    ...trace,
    outputRequirements: brief.outputRequirements,
    findings: workflowFindings(trace.steps, brief),
  }
}

function parseSummary(record: Entry): TraceParse | null {
  if (!('task' in record) && !('steps' in record) && !('finalResult' in record) && !('toolCalls' in record)) {
    return null
  }
  const rawSteps = Array.isArray(record.steps) ? record.steps : []
  const steps = rawSteps.flatMap((step, index) => {
    const parsed = stepFromValue(step, index + 1)
    return parsed ? [parsed] : []
  })
  return {
    ok: true,
    trace: withFindings(
      {
        task: textOf(record.task),
        steps: attachToolCalls(steps, record.toolCalls),
        result: textOf(record.finalResult) ?? jsonText(record.finalResult),
        start: textOf(record.start) ?? '',
        end: textOf(record.end) ?? '',
      },
      {
        task: textOf(record.task),
        input: requirementText(record.input),
        outputRequirements: requirementText(record.outputRequirements),
      },
    ),
  }
}

function parseTranscript(record: Entry): TraceParse | null {
  const value = record.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = (value as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return null

  const ordered = entries.filter(
    (entry): entry is Entry => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  )
  ordered.sort((a, b) => {
    const seqA = typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER
    const seqB = typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER
    if (seqA !== seqB) return seqA - seqB
    return (entryTime(a) ?? 0) - (entryTime(b) ?? 0)
  })

  const taskIndex = ordered.findIndex(
    (entry) => entry.kind === 'message' && (entry.role === 'user' || entry.role == null),
  )
  const task = taskIndex >= 0 ? userText(ordered[taskIndex]) : null

  let resultIndex = -1
  for (let index = ordered.length - 1; index >= 0; index--) {
    if (ordered[index].kind === 'send-message') {
      resultIndex = index
      break
    }
  }
  const result = resultIndex >= 0 ? botText(ordered[resultIndex]) : null

  const steps = ordered.flatMap((entry, index) => {
    if (index === taskIndex || index === resultIndex) return []
    const action = stepAction(entry)
    if (!action) return []
    const step = blankStep(0)
    step.action = action
    return [step]
  })
  steps.forEach((step, index) => {
    step.number = index + 1
  })

  const times = ordered.map(entryTime).filter((time): time is number => time != null)
  const persisted = (value as { persistedAt?: unknown }).persistedAt
  const startMs = times.length > 0 ? Math.min(...times) : null
  const endCandidates = [...times]
  if (typeof persisted === 'number' && Number.isFinite(persisted)) endCandidates.push(persisted)
  const endMs = endCandidates.length > 0 ? Math.max(...endCandidates) : null

  return {
    ok: true,
    trace: withFindings(
      {
        task,
        steps,
        result,
        start: startMs == null ? '' : new Date(startMs).toISOString(),
        end: endMs == null ? '' : new Date(endMs).toISOString(),
      },
      { task, input: null, outputRequirements: null },
    ),
  }
}

export function parseTrace(text: string): TraceParse | null {
  if (!text.trim()) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'The run trace is not valid JSON.' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'The run trace needs to be a JSON object.' }
  }
  const record = data as Entry
  const transcript = parseTranscript(record)
  if (transcript) return transcript
  const summary = parseSummary(record)
  if (summary) return summary
  return {
    ok: false,
    error:
      'This trace does not match the sample. Paste the transcript JSON with schemaVersion and value.entries.',
  }
}
