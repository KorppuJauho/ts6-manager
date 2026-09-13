import { describe, it, expect, beforeEach } from 'vitest';
import { SafeExpressionEvaluator } from './safe-expr.js';

describe('SafeExpressionEvaluator', () => {
  let ev: SafeExpressionEvaluator;
  const scope = {
    event: {
      client_type: 0,
      ctid: 42,
      client_nickname: 'AdminBob',
      client_servergroups: '6,7,8',
      reasonid: 5,
    },
    var: { counter: 3 },
    temp: { api: { status: 200 } },
    time: { hours: 14, dayOfWeek: 2 },
  };

  beforeEach(() => {
    ev = new SafeExpressionEvaluator();
    // Same registry as ExecutionContext
    ev.functions.contains = (str: string, sub: string) => (String(str).includes(String(sub)) ? 1 : 0);
    ev.functions.startsWith = (str: string, p: string) => (String(str).startsWith(String(p)) ? 1 : 0);
    ev.functions.endsWith = (str: string, s: string) => (String(str).endsWith(String(s)) ? 1 : 0);
    ev.functions.lower = (str: string) => String(str).toLowerCase();
    ev.functions.upper = (str: string) => String(str).toUpperCase();
    ev.functions.length = (str: string) => String(str).length;
    ev.functions.split = (str: string, sep: string, i: number) => String(str).split(String(sep))[i] ?? '';
  });

  describe('expressions used by the shipped bot templates', () => {
    it.each([
      ['event.client_type == 0', true],
      ['event.ctid == 42', true],
      ['event.ctid == 10', false],
      ["contains(event.client_servergroups,'7')", 1],
      ["contains(event.client_servergroups,'99')", 0],
      ["contains(event.client_servergroups,'7') == 0", false],
      ["contains(lower(event.client_nickname),'admin')", 1],
      ["contains(lower(event.client_nickname),'admin') or contains(lower(event.client_nickname),'mod')", true],
      ["startsWith(event.client_nickname, 'Admin')", 1],
      ['event.reasonid == 5', true],
    ])('%s → %s', (expr, expected) => {
      expect(ev.evaluate(expr, scope)).toBe(expected);
    });
  });

  describe('operators', () => {
    it('respects arithmetic precedence', () => {
      expect(ev.evaluate('1 + 2 * 3', scope)).toBe(7);
      expect(ev.evaluate('(1 + 2) * 3', scope)).toBe(9);
      expect(ev.evaluate('10 % 3', scope)).toBe(1);
      expect(ev.evaluate('2 ^ 3', scope)).toBe(8);
      expect(ev.evaluate('-2 + 5', scope)).toBe(3);
    });

    it('supports and/or/not with comparisons', () => {
      expect(ev.evaluate('event.ctid > 40 and event.ctid < 50', scope)).toBe(true);
      expect(ev.evaluate('event.ctid > 100 or var.counter >= 3', scope)).toBe(true);
      expect(ev.evaluate('not (event.client_type == 0)', scope)).toBe(false);
      expect(ev.evaluate('time.hours >= 8 and time.hours <= 22', scope)).toBe(true);
    });

    it('uses strict equality like expr-eval', () => {
      expect(ev.evaluate("event.ctid == '42'", scope)).toBe(false);
      expect(ev.evaluate("event.client_nickname == 'AdminBob'", scope)).toBe(true);
      expect(ev.evaluate('event.ctid != 10', scope)).toBe(true);
    });

    it('handles string literals with both quote styles and escapes', () => {
      expect(ev.evaluate('"a,b" == \'a,b\'', scope)).toBe(true);
      expect(ev.evaluate("'it\\'s' == 'it\\'s'", scope)).toBe(true);
    });
  });

  describe('scope resolution', () => {
    it('resolves nested dot paths', () => {
      expect(ev.evaluate('temp.api.status == 200', scope)).toBe(true);
    });

    it('yields undefined for missing nested keys', () => {
      expect(ev.evaluate('temp.api.missing == 200', scope)).toBe(false);
    });

    it('throws on unknown top-level identifiers', () => {
      expect(() => ev.evaluate('nope.thing == 1', scope)).toThrow(/Undefined variable/);
    });
  });

  describe('hardening', () => {
    it('rejects prototype-pollution path segments', () => {
      expect(() => ev.evaluate('event.__proto__.polluted == 1', scope)).toThrow(/Invalid identifier/);
      expect(() => ev.evaluate('event.constructor.prototype == 1', scope)).toThrow(/Invalid identifier/);
    });

    it('does not reach inherited properties', () => {
      expect(ev.evaluate('event.toString == 1', scope)).toBe(false);
    });

    it('rejects unknown functions, including Object builtins', () => {
      expect(() => ev.evaluate('hasOwnProperty(event)', scope)).toThrow(/Unknown function/);
      expect(() => ev.evaluate('toString()', scope)).toThrow(/Unknown function/);
    });

    it('rejects malformed input', () => {
      expect(() => ev.evaluate('event.ctid ==', scope)).toThrow();
      expect(() => ev.evaluate("'unterminated", scope)).toThrow(/Unterminated/);
      expect(() => ev.evaluate('1; process.exit()', scope)).toThrow();
      expect(() => ev.evaluate('a = 1', scope)).toThrow();
    });
  });
});
