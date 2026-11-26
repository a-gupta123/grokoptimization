export const TOKEN_FIELDS = [
  { key: 'prompt-text-tokens', label: 'New input' },
  { key: 'cached-prompt-text-tokens', label: 'Cache reads' },
  { key: 'cache-write-text-tokens', label: 'Cache writes' },
  { key: 'completion-text-tokens', label: 'Output' },
] as const

export type UsageEvent = {
  billingItemId: string
  eventTime: string
  product: string
  tokens: Record<(typeof TOKEN_FIELDS)[number]['key'], number | null>
}

export type UsageParse =
  | { ok: true; events: UsageEvent[] }
  | { ok: false; error: string }

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const source = text.replace(/^\uFEFF/, '')

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((cell) => cell.length > 0)) rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    if (row.some((cell) => cell.length > 0)) rows.push(row)
  }
  return rows
}

function totalsKind(periodStart: string): 'daily' | 'hourly' {
  return /^\d{4}-\d{2}-\d{2}$/.test(periodStart.trim()) ? 'daily' : 'hourly'
}

const OFFSET_TIME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})$/i
const NAMED_TIME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)[ ]+([A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/

function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const wholeMs = Math.trunc(utcMs / 1000) * 1000
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(wholeMs))
  const bag: Record<string, string> = {}
  for (const part of parts) bag[part.type] = part.value
  let hour = Number(bag.hour)
  let day = Number(bag.day)
  if (hour === 24) {
    hour = 0
    day += 1
  }
  const asUtc = Date.UTC(Number(bag.year), Number(bag.month) - 1, day, hour, Number(bag.minute), Number(bag.second))
  return asUtc - wholeMs
}

function wallTimeInZone(local: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(local)
  if (!match) return null
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3) || '0')
  const utcGuess = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    millis,
  )
  try {
    let instant = utcGuess - zoneOffsetMs(timeZone, utcGuess)
    instant = utcGuess - zoneOffsetMs(timeZone, instant)
    return Number.isFinite(instant) ? instant : null
  } catch {
    return null
  }
}

export function parseTimestamp(value: string): number | null {
  const trimmed = value.trim()
  const named = NAMED_TIME.exec(trimmed)
  if (named) return wallTimeInZone(named[1], named[2])
  if (!OFFSET_TIME.test(trimmed)) return null
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

export function matchRunUsage(
  events: UsageEvent[],
  start: string,
  end: string,
): { ok: true; events: UsageEvent[] } | { ok: false; error: string } {
  const startMs = parseTimestamp(start)
  const endMs = parseTimestamp(end)
  if (startMs == null || endMs == null) {
    return {
      ok: false,
      error:
        'Enter a start and an end with a timezone offset, such as 2026-11-23T14:28:08.026Z or 2026-11-23T09:28:08.026-05:00.',
    }
  }
  if (endMs < startMs) {
    return { ok: false, error: 'The end time is before the start time.' }
  }

  const seen = new Set<string>()
  const matched: UsageEvent[] = []
  for (const event of events) {
    if (event.product.trim() !== 'grok-bot') continue
    const time = parseTimestamp(event.eventTime)
    if (time == null || time < startMs || time >= endMs) continue
    const id = event.billingItemId.trim()
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    matched.push(event)
  }
  return { ok: true, events: matched }
}

export type TokenRollup = {
  value: number | null
  missingRows: number
}

export type WindowUsage = {
  rows: number
  total: TokenRollup
  newInput: TokenRollup
  cacheReads: TokenRollup
  cacheWrites: TokenRollup
  output: TokenRollup
}

function rollup(events: UsageEvent[], key: (typeof TOKEN_FIELDS)[number]['key']): TokenRollup {
  if (events.length === 0) return { value: 0, missingRows: 0 }
  let known = 0
  let missingRows = 0
  let anyKnown = false
  for (const event of events) {
    const value = event.tokens[key]
    if (value == null) {
      missingRows++
    } else {
      anyKnown = true
      known += value
    }
  }
  return { value: anyKnown ? known : null, missingRows }
}

export function summarizeWindow(events: UsageEvent[]): WindowUsage {
  const newInput = rollup(events, 'prompt-text-tokens')
  const cacheReads = rollup(events, 'cached-prompt-text-tokens')
  const cacheWrites = rollup(events, 'cache-write-text-tokens')
  const output = rollup(events, 'completion-text-tokens')
  const parts = [newInput, cacheReads, cacheWrites, output]
  const anyKnown = parts.some((part) => part.value != null)
  const missingRows = events.filter((event) =>
    TOKEN_FIELDS.some((field) => event.tokens[field.key] == null),
  ).length
  const total: TokenRollup =
    events.length === 0
      ? { value: 0, missingRows: 0 }
      : {
          value: anyKnown ? parts.reduce((sum, part) => sum + (part.value ?? 0), 0) : null,
          missingRows,
        }

  return { rows: events.length, total, newInput, cacheReads, cacheWrites, output }
}

function tokenCount(usage: Record<string, unknown>, key: string): number | null {
  const value = usage[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

export function parseUsageExport(text: string): UsageParse {
  const rows = parseCsv(text.trim())
  if (rows.length === 0) {
    return { ok: false, error: 'The CSV is empty.' }
  }

  const headers = rows[0].map((header) => header.trim())
  const headerSet = new Set(headers)
  if (headerSet.has('period_start') && headerSet.has('period_end') && headerSet.has('tokens')) {
    const periodIndex = headers.indexOf('period_start')
    const periodStart = rows[1]?.[periodIndex] ?? ''
    const kind = totalsKind(periodStart)
    return {
      ok: false,
      error: `This is the ${kind} totals CSV. Upload the personal unified usage export instead. That file lists each event, with Event Time, Product, and token counts inside Usage.`,
    }
  }

  const idIndex = headers.indexOf('Billing Item ID')
  const timeIndex = headers.indexOf('Event Time')
  const productIndex = headers.indexOf('Product')
  const usageIndex = headers.indexOf('Usage')
  if (idIndex < 0 || timeIndex < 0 || productIndex < 0 || usageIndex < 0) {
    return {
      ok: false,
      error:
        'This CSV is not the personal unified usage export. That file has Billing Item ID, Event Time, Product, and Usage.',
    }
  }

  const events: UsageEvent[] = []
  for (const row of rows.slice(1)) {
    let usage: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(row[usageIndex] ?? '')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          error: 'A Usage cell is not an object of token counts.',
        }
      }
      usage = parsed as Record<string, unknown>
    } catch {
      return {
        ok: false,
        error: 'A Usage cell is not JSON. Upload the personal unified usage export, not a totals CSV.',
      }
    }

    const tokens = {
      'prompt-text-tokens': tokenCount(usage, 'prompt-text-tokens'),
      'cache-write-text-tokens': tokenCount(usage, 'cache-write-text-tokens'),
      'cached-prompt-text-tokens': tokenCount(usage, 'cached-prompt-text-tokens'),
      'completion-text-tokens': tokenCount(usage, 'completion-text-tokens'),
    }
    events.push({
      billingItemId: row[idIndex] ?? '',
      eventTime: row[timeIndex] ?? '',
      product: row[productIndex] ?? '',
      tokens,
    })
  }

  if (events.length === 0) {
    return { ok: false, error: 'The usage export has no events.' }
  }
  return { ok: true, events }
}
