import { describe, expect, it } from 'vitest'
import sampleUsage from '../fixtures/sample/personal-unified-usage.csv?raw'
import { matchRunUsage, parseTimestamp, parseUsageExport, summarizeWindow, type UsageEvent } from './parseUsage'
import { tokenDelta } from './savedRuns'

const START = '2026-11-23T14:28:08.026Z'
const END = '2026-11-25T00:50:34.004Z'

function usageCell(counts: Record<string, number | null>) {
  return JSON.stringify(counts).replaceAll('"', '""')
}

function csv(rows: string[]) {
  return ['Billing Item ID,Event Time,Product,Usage', ...rows].join('\n')
}

function row(id: string, time: string, product: string, counts: Record<string, number | null>) {
  return `${id},${time},${product},"${usageCell(counts)}"`
}

const fullCounts = {
  'prompt-text-tokens': 10,
  'cached-prompt-text-tokens': 20,
  'cache-write-text-tokens': 30,
  'completion-text-tokens': 40,
}

describe('usage export', () => {
  it('parses quoted Usage JSON and string token counts', () => {
    const parsed = parseUsageExport(sampleUsage)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.events).toHaveLength(15)
    expect(parsed.events[0]).toMatchObject({
      billingItemId: '0a2c30e4-271a-5be2-af67-22c38c0498b1',
      eventTime: '2026-11-23T14:28:08.034Z',
      product: 'grok-bot',
      tokens: {
        'prompt-text-tokens': 4,
        'cached-prompt-text-tokens': 125040,
        'cache-write-text-tokens': 574,
        'completion-text-tokens': 191,
      },
    })
  })

  it('rejects a daily totals CSV', () => {
    const totals = 'period_start,period_end,tokens\n2026-11-23,2026-11-24,100\n'
    const parsed = parseUsageExport(totals)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('daily totals CSV')
  })

  it('includes the start, excludes the end, and treats a named zone as the same instant', () => {
    const parsed = parseUsageExport(sampleUsage)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const namedStart = '2026-11-23T09:28:08.026 America/New_York'
    const offsetStart = '2026-11-23T09:28:08.026-05:00'
    expect(parseTimestamp(namedStart)).toBe(parseTimestamp(START))
    expect(parseTimestamp(offsetStart)).toBe(parseTimestamp(START))

    const open = matchRunUsage(parsed.events, START, END)
    const fromOffset = matchRunUsage(parsed.events, offsetStart, END)
    expect(open.ok && fromOffset.ok).toBe(true)
    if (!open.ok || !fromOffset.ok) return
    expect(open.events).toHaveLength(15)
    expect(fromOffset.events.map((event) => event.billingItemId)).toEqual(
      open.events.map((event) => event.billingItemId),
    )

    const lastEvent = parsed.events[parsed.events.length - 1].eventTime
    const atFirstEvent = matchRunUsage(parsed.events, parsed.events[0].eventTime, END)
    const endAtLastEvent = matchRunUsage(parsed.events, START, lastEvent)
    expect(atFirstEvent.ok && endAtLastEvent.ok).toBe(true)
    if (!atFirstEvent.ok || !endAtLastEvent.ok) return
    expect(atFirstEvent.events[0].billingItemId).toBe(parsed.events[0].billingItemId)
    expect(endAtLastEvent.events).toHaveLength(14)
    expect(endAtLastEvent.events.some((event) => event.eventTime === lastEvent)).toBe(false)
  })

  it('keeps the first row when a billing item id is repeated', () => {
    const parsed = parseUsageExport(
      csv([
        row('same-id', '2026-11-23T14:28:08.034Z', 'grok-bot', fullCounts),
        row('same-id', '2026-11-23T14:28:09.000Z', 'grok-bot', {
          'prompt-text-tokens': 999,
          'cached-prompt-text-tokens': 999,
          'cache-write-text-tokens': 999,
          'completion-text-tokens': 999,
        }),
        row('other-product', '2026-11-23T14:28:10.000Z', 'grok-api', fullCounts),
        row('at-end', END, 'grok-bot', fullCounts),
      ]),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const matched = matchRunUsage(parsed.events, START, END)
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    expect(matched.events.map((event) => event.billingItemId)).toEqual(['same-id'])
    expect(matched.events[0].tokens['prompt-text-tokens']).toBe(10)
  })

  it('compares window totals as run B minus run A', () => {
    const parsed = parseUsageExport(sampleUsage)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const matched = matchRunUsage(parsed.events, START, END)
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    const sample = summarizeWindow(matched.events)
    expect(sample).toMatchObject({
      rows: 15,
      total: { value: 1233451, missingRows: 0 },
      newInput: { value: 499, missingRows: 0 },
      cacheReads: { value: 1116041, missingRows: 0 },
      cacheWrites: { value: 110460, missingRows: 0 },
      output: { value: 6451, missingRows: 0 },
    })

    const partial: UsageEvent = {
      billingItemId: 'partial',
      eventTime: '2026-11-23T14:28:08.034Z',
      product: 'grok-bot',
      tokens: {
        'prompt-text-tokens': 5,
        'cached-prompt-text-tokens': null,
        'cache-write-text-tokens': 3,
        'completion-text-tokens': 2,
      },
    }
    const incomplete = summarizeWindow([partial])
    expect(incomplete.total).toEqual({ value: 10, missingRows: 1 })
    expect(incomplete.cacheReads).toEqual({ value: null, missingRows: 1 })

    expect(tokenDelta(sample.total.value, incomplete.total.value)).toBe(10 - 1233451)
    expect(tokenDelta(sample.cacheReads.value, incomplete.cacheReads.value)).toBeNull()
    expect(tokenDelta(sample.newInput.value, 0)).toBe(-499)
  })
})
