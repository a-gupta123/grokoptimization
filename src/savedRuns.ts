import type { WorkflowStep } from './parseTrace'
import type { WindowUsage } from './parseUsage'

const STORAGE_KEY = 'grokop.analyzed-runs'

export type StoredTokens = {
  total: number | null
  newInput: number | null
  cacheReads: number | null
  cacheWrites: number | null
  output: number | null
  rows: number | null
  missingRows: number
}

export type StoredStep = {
  number: number
  action: string | null
  toolCalls: { name: string | null; arguments: string | null; result: string | null }[]
  result: string | null
}

export type SavedRun = {
  id: string
  savedAt: string
  passed: boolean
  successCheck: string
  start: string
  end: string
  tokens: StoredTokens
  steps: StoredStep[]
}

export type SavedTask = {
  task: string
  successCheck: string
  runs: SavedRun[]
}

export type StepChange =
  | { kind: 'unchanged'; count: number }
  | { kind: 'removed'; step: number; text: string }
  | { kind: 'added'; step: number; text: string }
  | { kind: 'changed'; fromStep: number; toStep: number; before: string; after: string }

const DEFAULT_CHECK = "The final result meets the task's output requirements."

export function redactAccounts(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[account]')
    .replace(/auth0\|user_[A-Za-z0-9]+/gi, '[account]')
    .replace(/\buser_[A-Za-z0-9]+\b/g, '[account]')
}

function clean(text: string | null): string | null {
  if (text == null) return null
  const redacted = redactAccounts(text).trim()
  return redacted.length > 0 ? redacted : null
}

export function defaultSuccessCheck(outputRequirements: string | null): string {
  return clean(outputRequirements) ?? DEFAULT_CHECK
}

function storedSteps(steps: WorkflowStep[]): StoredStep[] {
  return steps.map((step) => ({
    number: step.number,
    action: clean(step.action),
    toolCalls: step.toolCalls.map((call) => ({
      name: clean(call.name),
      arguments: clean(call.arguments),
      result: clean(call.result),
    })),
    result: clean(step.result),
  }))
}

function storedTokens(usage: WindowUsage | null): StoredTokens {
  if (!usage) {
    return {
      total: null,
      newInput: null,
      cacheReads: null,
      cacheWrites: null,
      output: null,
      rows: null,
      missingRows: 0,
    }
  }
  return {
    total: usage.total.value,
    newInput: usage.newInput.value,
    cacheReads: usage.cacheReads.value,
    cacheWrites: usage.cacheWrites.value,
    output: usage.output.value,
    rows: usage.rows,
    missingRows: usage.total.missingRows,
  }
}

export function stepText(step: StoredStep): string {
  const tools =
    step.toolCalls.length === 0
      ? 'No tool call'
      : step.toolCalls
          .map(
            (call) =>
              `${call.name ?? 'Unnamed tool'} (${call.arguments ?? 'no arguments'}) -> ${call.result ?? 'no result'}`,
          )
          .join('; ')
  return `${step.action ?? 'No action'}. ${tools}. Result: ${step.result ?? 'none'}.`
}

export function compareSteps(left: StoredStep[], right: StoredStep[]): StepChange[] {
  const a = left.map(stepText)
  const b = right.map(stepText)
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const raw: StepChange[] = []
  let unchanged = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      unchanged++
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: 'removed', step: left[i].number, text: a[i] })
      i++
    } else {
      raw.push({ kind: 'added', step: right[j].number, text: b[j] })
      j++
    }
  }
  while (i < n) {
    raw.push({ kind: 'removed', step: left[i].number, text: a[i] })
    i++
  }
  while (j < m) {
    raw.push({ kind: 'added', step: right[j].number, text: b[j] })
    j++
  }
  return [{ kind: 'unchanged', count: unchanged }, ...raw]
}

export function loadSavedTasks(storage: Storage = localStorage): SavedTask[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSavedTask)
  } catch {
    return []
  }
}

export function writeSavedTasks(tasks: SavedTask[], storage: Storage = localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(tasks))
}

function isSavedTask(value: unknown): value is SavedTask {
  if (!value || typeof value !== 'object') return false
  const task = value as SavedTask
  return typeof task.task === 'string' && typeof task.successCheck === 'string' && Array.isArray(task.runs)
}

export function addSavedRun(
  tasks: SavedTask[],
  input: {
    task: string
    outputRequirements: string | null
    successCheck: string
    passed: boolean
    start: string
    end: string
    usage: WindowUsage | null
    steps: WorkflowStep[]
  },
): SavedTask[] {
  const task = clean(input.task)
  if (!task) return tasks
  const existing = tasks.find((item) => item.task === task)
  const successCheck = existing?.successCheck || clean(input.successCheck) || defaultSuccessCheck(input.outputRequirements)
  const run: SavedRun = {
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    passed: input.passed,
    successCheck,
    start: input.start,
    end: input.end,
    tokens: storedTokens(input.usage),
    steps: storedSteps(input.steps),
  }
  if (!existing) {
    return [...tasks, { task, successCheck, runs: [run] }]
  }
  return tasks.map((item) => (item.task === task ? { ...item, runs: [...item.runs, run] } : item))
}

export function sameSuccessCheck(left: SavedRun, right: SavedRun): boolean {
  return left.successCheck.trim() === right.successCheck.trim()
}

export function tokenDelta(left: number | null, right: number | null): number | null {
  if (left == null || right == null) return null
  return right - left
}
