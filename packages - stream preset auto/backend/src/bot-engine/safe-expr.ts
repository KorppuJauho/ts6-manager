// Minimal condition-expression evaluator replacing expr-eval
// (GHSA-8gw3-rxh4-v6jx, GHSA-jc85-fpwf-qm7x — no patched version exists).
//
// Supported grammar (superset of what the bot editor documents):
//   - literals: numbers, 'strings', "strings", true, false
//   - scope lookups with dot access: event.client_type, var.counter, temp.api.status
//   - function calls: contains(a, b), lower(s), split(s, sep, i), ...
//   - operators by precedence: or < and < not < == != < <= > >= < + - < * / % < unary - < ^
// Like expr-eval, == and != are strict, and/or/not coerce to boolean,
// and unknown top-level identifiers throw (nested missing keys yield undefined).

type Fn = (...args: any[]) => any;

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

interface Token {
  type: 'num' | 'str' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      tokens.push({ type: 'num', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== ch) {
        if (input[j] === '\\' && j + 1 < input.length) { out += input[j + 1]; j += 2; }
        else { out += input[j]; j++; }
      }
      if (j >= input.length) throw new Error('Unterminated string literal');
      tokens.push({ type: 'str', value: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j])) j++;
      tokens.push({ type: 'ident', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',' }); i++; continue; }
    const two = input.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if ('<>+-*/%^'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

class ExprParser {
  private pos = 0;

  constructor(
    private tokens: Token[],
    private scope: Record<string, any>,
    private functions: Record<string, Fn>,
  ) {}

  parse(): any {
    const value = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token '${this.tokens[this.pos].value}'`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private matchIdent(name: string): boolean {
    const t = this.peek();
    if (t?.type === 'ident' && t.value === name) { this.pos++; return true; }
    return false;
  }

  private matchOp(...ops: string[]): string | null {
    const t = this.peek();
    if (t?.type === 'op' && ops.includes(t.value)) { this.pos++; return t.value; }
    return null;
  }

  private parseOr(): any {
    let left = this.parseAnd();
    while (this.matchIdent('or')) {
      // No short-circuit: the right side must always be parsed to consume its tokens
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): any {
    let left = this.parseNot();
    while (this.matchIdent('and')) {
      const right = this.parseNot();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseNot(): any {
    if (this.matchIdent('not')) return !this.parseNot();
    return this.parseComparison();
  }

  private parseComparison(): any {
    let left = this.parseAdditive();
    let op: string | null;
    while ((op = this.matchOp('==', '!=', '<=', '>=', '<', '>'))) {
      const right = this.parseAdditive();
      switch (op) {
        case '==': left = left === right; break;
        case '!=': left = left !== right; break;
        case '<=': left = left <= right; break;
        case '>=': left = left >= right; break;
        case '<': left = left < right; break;
        case '>': left = left > right; break;
      }
    }
    return left;
  }

  private parseAdditive(): any {
    let left = this.parseMultiplicative();
    let op: string | null;
    while ((op = this.matchOp('+', '-'))) {
      const right = this.parseMultiplicative();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseMultiplicative(): any {
    let left = this.parseUnary();
    let op: string | null;
    while ((op = this.matchOp('*', '/', '%'))) {
      const right = this.parseUnary();
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  private parseUnary(): any {
    if (this.matchOp('-')) return -this.parseUnary();
    return this.parsePower();
  }

  private parsePower(): any {
    const base = this.parsePrimary();
    if (this.matchOp('^')) return Math.pow(base, this.parseUnary());
    return base;
  }

  private parsePrimary(): any {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of expression');

    if (t.type === 'num') { this.pos++; return parseFloat(t.value); }
    if (t.type === 'str') { this.pos++; return t.value; }
    if (t.type === 'lparen') {
      this.pos++;
      const value = this.parseOr();
      if (this.peek()?.type !== 'rparen') throw new Error("Expected ')'");
      this.pos++;
      return value;
    }
    if (t.type === 'ident') {
      this.pos++;
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (this.peek()?.type === 'lparen') return this.callFunction(t.value);
      return this.resolveIdent(t.value);
    }
    throw new Error(`Unexpected token '${t.value}'`);
  }

  private callFunction(name: string): any {
    if (name.includes('.')) throw new Error(`Unknown function '${name}'`);
    const fn = Object.prototype.hasOwnProperty.call(this.functions, name)
      ? this.functions[name]
      : undefined;
    if (!fn) throw new Error(`Unknown function '${name}'`);
    this.pos++; // consume '('
    const args: any[] = [];
    if (this.peek()?.type !== 'rparen') {
      args.push(this.parseOr());
      while (this.peek()?.type === 'comma') {
        this.pos++;
        args.push(this.parseOr());
      }
    }
    if (this.peek()?.type !== 'rparen') throw new Error("Expected ')'");
    this.pos++;
    return fn(...args);
  }

  private resolveIdent(path: string): any {
    const segments = path.split('.');
    if (segments.some((s) => s === '' || FORBIDDEN_SEGMENTS.has(s))) {
      throw new Error(`Invalid identifier '${path}'`);
    }
    const top = segments[0];
    if (!Object.prototype.hasOwnProperty.call(this.scope, top)) {
      throw new Error(`Undefined variable '${top}'`);
    }
    let current: any = this.scope[top];
    for (const segment of segments.slice(1)) {
      if (current == null || typeof current !== 'object') return undefined;
      current = Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined;
    }
    return current;
  }
}

export class SafeExpressionEvaluator {
  readonly functions: Record<string, Fn> = Object.create(null);

  evaluate(expression: string, scope: Record<string, any>): any {
    return new ExprParser(tokenize(expression), scope, this.functions).parse();
  }
}
