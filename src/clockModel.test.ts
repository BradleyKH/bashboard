import { describe, expect, it } from 'vitest'
import { clockBits, clockLabel, clockText, sixBits } from './clockModel'

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 31, h, m, s)
const str = (bits: boolean[]) => bits.map((b) => (b ? '1' : '0')).join('')

describe('sixBits', () => {
  it('is most significant bit first', () => {
    expect(str(sixBits(1))).toBe('000001')
    expect(str(sixBits(32))).toBe('100000')
    expect(str(sixBits(59))).toBe('111011')
  })
})

describe('clockText', () => {
  it('shows midnight and noon as 12:00', () => {
    expect(clockText(at(0, 0))).toBe('12:00')
    expect(clockText(at(12, 0))).toBe('12:00')
  })
  it('has no leading zero on the hour and two-digit minutes', () => {
    expect(clockText(at(9, 7))).toBe('9:07')
    expect(clockText(at(13, 5))).toBe('1:05')
    expect(clockText(at(23, 59, 59))).toBe('11:59')
  })
})

describe('clockLabel', () => {
  it('adds AM or PM', () => {
    expect(clockLabel(at(20, 3))).toBe('8:03 PM')
    expect(clockLabel(at(0, 0))).toBe('12:00 AM')
    expect(clockLabel(at(12, 0))).toBe('12:00 PM')
  })
})

describe('clockBits', () => {
  it('is all off at midnight', () => {
    const b = clockBits(at(0, 0, 0))
    expect([str(b.hours), str(b.minutes), str(b.seconds)]).toEqual(['000000', '000000', '000000'])
  })
  it('uses the 24-hour value at noon', () => {
    expect(str(clockBits(at(12, 0)).hours)).toBe('001100')
  })
  it('fills the columns at 23:59:59', () => {
    const b = clockBits(at(23, 59, 59))
    expect([str(b.hours), str(b.minutes), str(b.seconds)]).toEqual(['010111', '111011', '111011'])
  })
})
