/**
 * Translates Crystal Reports formulas (Crystal syntax) into SSRS expressions (VB.NET syntax).
 *
 * The translator parses the formula into a small syntax tree and emits an equivalent
 * expression. Anything without a faithful equivalent (variables, multi-statement formulas,
 * unknown functions, print-state functions) is reported in `issues` for manual review.
 */

import { isBasicSyntax, translateBasic } from './basic.ts';

export interface FormulaContext {
  /** Dataset field name for a database field, or undefined if unknown. */
  field(table: string, column: string): string | undefined;
  /** Translated expression (without "=") of another formula, or undefined if unknown. */
  formula(name: string): string | undefined;
  /** SSRS parameter name for a Crystal parameter. */
  parameter(name: string): string;
  /** SSRS group scope for a Crystal group field ("Table.Field"), used by aggregates. */
  groupScope?(fieldRef: string): string | undefined;
  /** Expression for a running total ({#name}), or undefined if unknown. */
  runningTotal?(name: string): string | undefined;
  /** VB name of a Crystal custom function (a formula written as "Function (...)"), or undefined. */
  customFunction?(name: string): string | undefined;
  /** For a range parameter: the SSRS parameters holding its start and end. */
  parameterRange?(name: string): { start: string; end: string } | undefined;
  /** Whether a parameter accepts several values. */
  parameterMultiple?(name: string): boolean;
  /** Expression for the next record's value of a database field (Crystal Next()), or undefined. */
  nextValue?(fieldRef: string): string | undefined;
  /** Value type ("date", "dateTime", "string", ...) of a database field, if known. */
  fieldType?(fieldRef: string): string | undefined;
  /**
   * Prefix for Global variables' class members. Crystal Global variables belong to one report (Shared ones are
   * shared with subreports), so a subreport placed inside another report keeps its own copies.
   */
  memberPrefix?: string;
  /** The dataset the formula reads (a subreport placed inside another report has its own), for OnLastRecord's count. */
  dataset?(): string;
}

export interface Translation {
  /** SSRS expression including the leading "=". */
  expression: string;
  issues: string[];
  /** VB function for the report's Code block, when the formula needed statements. */
  code?: string;
  /** Class-level variables (Global/Shared Crystal variables) the code uses: name -> VB type. */
  members?: Record<string, string>;
  /** Shared VB helper functions the code or expression calls (see CODE_HELPERS). */
  helpers?: string[];
}

// ---- tokens ----------------------------------------------------------------------------

type Token =
  | { kind: 'number'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'date'; value: string }
  | { kind: 'field'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'eof'; value: '' };

const OPERATORS = [':=', '<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '\\', '^', '&', '%', '(', ')', '[', ']', ',', ';', ':'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '"' || c === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= source.length) throw new Error('unterminated string');
        if (source[i] === c) {
          if (source[i + 1] === c) {
            value += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i++];
      }
      tokens.push({ kind: 'string', value });
    } else if (c === '{') {
      const end = source.indexOf('}', i);
      if (end < 0) throw new Error('unterminated field reference');
      tokens.push({ kind: 'field', value: source.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '#') {
      const end = source.indexOf('#', i + 1);
      if (end < 0) throw new Error('unterminated date literal');
      tokens.push({ kind: 'date', value: source.slice(i + 1, end) });
      i = end + 1;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const m = /^([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ kind: 'number', value: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'ident', value: m[0] });
      i += m[0].length;
    } else {
      const op = OPERATORS.find((o) => source.startsWith(o, i));
      if (!op) throw new Error(`unexpected character "${c}"`);
      tokens.push({ kind: 'op', value: op });
      i += op.length;
    }
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---- syntax tree -----------------------------------------------------------------------

export type Node =
  | { t: 'literal'; vb: string }
  | { t: 'field'; ref: string }
  | { t: 'name'; name: string }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'unary'; op: string; arg: Node }
  | { t: 'binary'; op: string; left: Node; right: Node }
  | { t: 'if'; cond: Node; then: Node; else?: Node }
  | { t: 'in'; value: Node; list: Node[]; negate: boolean }
  | { t: 'range'; value: Node; from: Node; to: Node; negate: boolean }
  | { t: 'select'; value: Node; cases: { match: Node[]; result: Node }[]; otherwise?: Node }
  | { t: 'array'; items: Node[] }
  | { t: 'index'; base: Node; from: Node; to?: Node }
  | { t: 'rangeValue'; from: Node; to: Node };

/** Statements of a multi-statement formula. */
type Stmt =
  | { s: 'decl'; scope: string; vtype: string; array: boolean; range?: boolean; name: string; init?: Node }
  | { s: 'redim'; name: string; size: Node; preserve: boolean }
  | { s: 'select'; value: Node; cases: { match: Node[]; body: Stmt[] }[]; otherwise?: Stmt[] }
  | { s: 'assign'; name: string; index?: Node; value: Node }
  | { s: 'expr'; expr: Node }
  | { s: 'if'; cond: Node; then: Stmt[]; else?: Stmt[] }
  | { s: 'for'; name: string; from: Node; to: Node; step?: Node; body: Stmt[] }
  | { s: 'while'; cond: Node; body: Stmt[]; post: boolean }
  | { s: 'exit'; what: string }
  | { s: 'timing'; word: string };

interface Program {
  params?: { name: string; vtype: string; array: boolean; range: boolean; optional?: Node }[];
  body: Stmt[];
}

const VB_TYPES: Record<string, string> = {
  numbervar: 'Double', currencyvar: 'Decimal', stringvar: 'String', booleanvar: 'Boolean',
  datevar: 'Date', timevar: 'Date', datetimevar: 'Date', numbervarrange: 'Object', datevarrange: 'Object',
};
const TIMING_WORDS = ['whileprintingrecords', 'whilereadingrecords', 'beforereadingrecords', 'evaluateafter'];

const KEYWORD = (value: string) => value.toLowerCase();

/** Variable declarations ("NumberVar x := ...") without a Local/Global/Shared scope keyword. */
const VARIABLE_TYPES = ['numbervar', 'currencyvar', 'stringvar', 'booleanvar', 'datevar', 'timevar', 'datetimevar', 'numbervarrange', 'datevarrange'];

class Parser {
  private pos = 0;
  readonly issues: string[] = [];
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    return this.tokens[this.pos++] ?? this.tokens[this.tokens.length - 1];
  }
  private isOp(value: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.value === value;
  }
  private isWord(...words: string[]): boolean {
    const t = this.peek();
    return t.kind === 'ident' && words.includes(KEYWORD(t.value));
  }
  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new Error(`expected "${value}" but found "${this.peek().value || 'end of formula'}"`);
    this.pos++;
  }
  private expectWord(word: string): void {
    if (!this.isWord(word)) throw new Error(`expected "${word}" but found "${this.peek().value || 'end of formula'}"`);
    this.pos++;
  }

  /** A formula is a sequence of statements; its value is the last one. */
  parseFormula(): Node {
    const statements: Node[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.isOp(';')) {
        this.pos++;
        continue;
      }
      if (this.isWord('whilereadingrecords', 'beforereadingrecords', 'evaluateafter')) {
        // Evaluation-time hints: an SSRS expression is already evaluated per row, in dependency order.
        while (this.peek().kind !== 'eof' && !this.isOp(';')) this.pos++;
        continue;
      }
      if (this.isWord('whileprintingrecords')) {
        this.issues.push('uses WhilePrintingRecords; SSRS evaluates it as the report renders, check totals across pages');
        this.pos++;
        continue;
      }
      if (this.isWord('local', 'global', 'shared', ...VARIABLE_TYPES)) {
        this.issues.push(`uses "${this.peek().value}" (variables / evaluation timing) which needs manual conversion, e.g. to custom code or a running total`);
        while (this.peek().kind !== 'eof' && !this.isOp(';')) this.pos++;
        continue;
      }
      if (this.peek().kind === 'ident' && this.peek(1).kind === 'op' && this.peek(1).value === ':=') {
        this.issues.push('assigns variables, which needs manual conversion (custom code or a calculated field)');
        while (this.peek().kind !== 'eof' && !this.isOp(';')) this.pos++;
        continue;
      }
      if (this.isWord('for', 'while', 'do', 'exit', 'function')) {
        throw new Error(`uses "${this.peek().value}" (loops or custom functions)`);
      }
      statements.push(this.parseExpression());
      if (!this.isOp(';') && this.peek().kind !== 'eof') throw new Error(`unexpected "${this.peek().value}"`);
    }
    if (statements.length === 0) return { t: 'literal', vb: 'Nothing' };
    if (statements.length > 1) this.issues.push('has several statements; only the last one is used as the value');
    return statements[statements.length - 1];
  }

  parseExpression(): Node {
    if (this.isWord('if')) {
      this.pos++;
      const cond = this.parseExpression();
      this.expectWord('then');
      const then = this.parseExpression();
      let otherwise: Node | undefined;
      if (this.isWord('else')) {
        this.pos++;
        otherwise = this.parseExpression();
      }
      return { t: 'if', cond, then, else: otherwise };
    }
    if (this.isWord('select')) return this.parseSelect();
    return this.parseOr();
  }

  private parseSelect(): Node {
    this.expectWord('select');
    const value = this.parseOr();
    const cases: { match: Node[]; result: Node }[] = [];
    let otherwise: Node | undefined;
    while (this.isWord('case', 'default')) {
      if (this.isWord('default')) {
        this.pos++;
        this.expectOp(':');
        otherwise = this.parseExpression();
        continue;
      }
      this.pos++;
      const match = [this.parseCaseItem(value)];
      while (this.isOp(',')) {
        this.pos++;
        match.push(this.parseCaseItem(value));
      }
      this.expectOp(':');
      cases.push({ match, result: this.parseExpression() });
    }
    return { t: 'select', value, cases, otherwise };
  }

  parseCaseItemPublic(value: Node): Node {
    return this.parseCaseItem(value);
  }

  private parseCaseItem(value: Node): Node {
    const from = this.parseAdditive();
    if (this.isWord('to')) {
      this.pos++;
      return { t: 'range', value, from, to: this.parseAdditive(), negate: false };
    }
    return { t: 'binary', op: '=', left: value, right: from };
  }

  /**
   * Lowest precedence first, as Crystal defines it: Imp, Eqv, Xor, Or, And, Not, comparisons, &, + -,
   * Mod, \, * / %, ^, unary minus. Every binary level is left-associative.
   */
  private parseOr(): Node {
    return this.parseLevel(['imp'], () => this.parseLevel(['eqv'], () => this.parseLevel(['xor'], () => this.parseOrOnly())));
  }

  private parseLevel(words: string[], next: () => Node): Node {
    let left = next();
    while (this.isWord(...words)) {
      const op = KEYWORD(this.next().value);
      left = { t: 'binary', op, left, right: next() };
    }
    return left;
  }

  private parseOrOnly(): Node {
    let left = this.parseAnd();
    while (this.isWord('or')) {
      this.pos++;
      left = { t: 'binary', op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.isWord('and')) {
      this.pos++;
      left = { t: 'binary', op: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.isWord('not')) {
      this.pos++;
      return { t: 'unary', op: 'not', arg: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    let left = this.parseConcat();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.value)) {
        this.pos++;
        left = { t: 'binary', op: t.value, left, right: this.parseConcat() };
      } else if (this.isWord('in') || (this.isWord('not') && this.peek(1).kind === 'ident' && KEYWORD(this.peek(1).value) === 'in')) {
        const negate = this.isWord('not');
        this.pos += negate ? 2 : 1;
        if (this.isOp('[')) {
          this.pos++;
          const list: Node[] = [];
          while (!this.isOp(']')) {
            list.push(this.parseConcat());
            if (this.isOp(',')) this.pos++;
            else break;
          }
          this.expectOp(']');
          left = { t: 'in', value: left, list, negate };
        } else {
          const from = this.parseConcat();
          if (this.isWord('to')) {
            this.pos++;
            left = { t: 'range', value: left, from, to: this.parseConcat(), negate };
          } else {
            // "x in {?rangeParameter}" or a named range such as LastFullMonth.
            left = { t: 'call', name: '$inRange', args: [left, from] };
            if (negate) left = { t: 'unary', op: 'not', arg: left };
          }
        }
      } else if (this.isWord('like', 'startswith')) {
        const op = KEYWORD(this.next().value);
        left = { t: 'binary', op, left, right: this.parseConcat() };
      } else {
        return left;
      }
    }
  }

  private parseConcat(): Node {
    let left = this.parseAdditive();
    while (this.isOp('&')) {
      this.pos++;
      left = { t: 'binary', op: '&', left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMod();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value;
      left = { t: 'binary', op, left, right: this.parseMod() };
    }
    return left;
  }

  private parseMod(): Node {
    let left = this.parseIntegerDivision();
    while (this.isWord('mod')) {
      this.pos++;
      left = { t: 'binary', op: 'mod', left, right: this.parseIntegerDivision() };
    }
    return left;
  }

  private parseIntegerDivision(): Node {
    let left = this.parseMultiplicative();
    while (this.isOp('\\')) {
      this.pos++;
      left = { t: 'binary', op: '\\', left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parsePower();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value;
      left = { t: 'binary', op, left, right: this.parsePower() };
    }
    return left;
  }

  private parsePower(): Node {
    let left = this.parseUnary();
    while (this.isOp('^')) {
      this.pos++;
      left = { t: 'binary', op: '^', left, right: this.parseUnary() };
    }
    return left;
  }

  /** Unary minus binds tighter than ^ in Crystal: -2^2 is 4. */
  private parseUnary(): Node {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next().value;
      const arg = this.parseUnary();
      return op === '-' ? { t: 'unary', op: '-', arg } : arg;
    }
    return this.parsePrimary();
  }

  /** Subscripts: x[i] (array element or character) and s[a to b] (substring). */
  private postfix(node: Node): Node {
    while (this.isOp('[')) {
      this.pos++;
      const from = this.parseConcat();
      let to: Node | undefined;
      if (this.isWord('to')) {
        this.pos++;
        to = this.parseConcat();
      }
      this.expectOp(']');
      node = { t: 'index', base: node, from, to };
    }
    return node;
  }

  // ---- statements (multi-statement formulas and custom functions) --------------------------

  private inFunction = false;

  parseProgram(): Program {
    let params: Program['params'];
    if (this.isWord('function')) {
      this.inFunction = true;
      this.pos++;
      this.expectOp('(');
      params = [];
      while (!this.isOp(')')) {
        const optional = this.isWord('optional');
        if (optional) this.pos++;
        const vtype = KEYWORD(this.next().value);
        if (!VB_TYPES[vtype]) throw new Error(`unknown parameter type "${vtype}"`);
        const array = this.isWord('array');
        if (array) this.pos++;
        const range = this.isWord('range');
        if (range) this.pos++;
        const name = this.next().value;
        let defaultValue: Node | undefined;
        if (this.isOp(':=')) {
          this.pos++;
          defaultValue = this.parseExpression();
        }
        params.push({ name, vtype, array, range, ...(optional || defaultValue ? { optional: defaultValue ?? { t: 'literal', vb: 'Nothing' } } : {}) });
        if (this.isOp(',')) this.pos++;
        else break;
      }
      this.expectOp(')');
    }
    const body = this.parseStatements();
    if (this.peek().kind !== 'eof') throw new Error(`unexpected "${this.peek().value}"`);
    return { params, body };
  }

  /** Declarations found inside a statement (see "NumberVar x > 1"), emitted before it. */
  private readonly pending: Stmt[] = [];

  private parseStatements(): Stmt[] {
    const stmts: Stmt[] = [];
    while (this.peek().kind !== 'eof' && !this.isOp(')')) {
      if (this.isOp(';')) {
        this.pos++;
        continue;
      }
      const stmt = this.parseStatement();
      stmts.push(...this.pending.splice(0), stmt);
      if (!this.isOp(';') && !this.isOp(')') && this.peek().kind !== 'eof' && !this.isWord('else', 'case', 'default')) {
        throw new Error(`unexpected "${this.peek().value}"`);
      }
      if (this.isWord('else', 'case', 'default')) break;
    }
    return stmts;
  }

  /** A statement, or a parenthesised statement list after then/else/do. */
  private parseBlock(): Stmt[] {
    if (this.isOp('(')) {
      const start = this.pos;
      try {
        this.pos++;
        const stmts = this.parseStatements();
        this.expectOp(')');
        if (this.isOp(';') || this.isOp(')') || this.isWord('else', 'while', 'case', 'default') || this.peek().kind === 'eof') return stmts;
      } catch {
        // not a block: fall back to an expression statement
      }
      this.pos = start;
    }
    return [this.parseStatement()];
  }

  /** An expression, or a range literal "a To b" (assigned to range variables). */
  private parseValue(): Node {
    const value = this.parseExpression();
    if (this.isWord('to')) {
      this.pos++;
      return { t: 'rangeValue', from: value, to: this.parseExpression() };
    }
    return value;
  }

  private parseStatement(): Stmt {
    if (this.isWord(...TIMING_WORDS)) {
      const word = this.next().value;
      if (KEYWORD(word) === 'evaluateafter') {
        this.expectOp('(');
        this.parseExpression();
        this.expectOp(')');
      }
      return { s: 'timing', word };
    }
    if (this.isWord('select')) {
      this.pos++;
      const value = this.parseOr();
      const cases: { match: Node[]; body: Stmt[] }[] = [];
      let otherwise: Stmt[] | undefined;
      while (this.isWord('case', 'default')) {
        if (this.isWord('default')) {
          this.pos++;
          this.expectOp(':');
          otherwise = this.parseBlock();
          continue;
        }
        this.pos++;
        const match = [this.parseCaseItemPublic(value)];
        while (this.isOp(',')) {
          this.pos++;
          match.push(this.parseCaseItemPublic(value));
        }
        this.expectOp(':');
        cases.push({ match, body: this.parseBlock() });
      }
      return { s: 'select', value, cases, otherwise };
    }
    if (this.isWord('redim')) {
      this.pos++;
      const preserve = this.isWord('preserve');
      if (preserve) this.pos++;
      const name = this.next().value;
      this.expectOp('[');
      const size = this.parseExpression();
      this.expectOp(']');
      return { s: 'redim', name, size, preserve };
    }
    if (this.isWord('local', 'global', 'shared') || this.isWord(...VARIABLE_TYPES)) {
      // Without a scope keyword, variables are global in a formula but local in a custom function.
      const scope = this.isWord('local', 'global', 'shared') ? KEYWORD(this.next().value) : this.inFunction ? 'local' : 'global';
      const vtype = KEYWORD(this.next().value);
      if (!VB_TYPES[vtype]) throw new Error(`unknown variable type "${vtype}"`);
      const array = this.isWord('array');
      if (array) this.pos++;
      const range = this.isWord('range');
      if (range) this.pos++;
      const name = this.next().value;
      let init: Node | undefined;
      if (this.isOp(':=')) {
        this.pos++;
        init = this.parseValue();
      } else if (!this.isOp(';') && !this.isOp(')') && this.peek().kind !== 'eof' && !this.isWord('else')) {
        // "NumberVar x > 1": declares x, then the statement is an expression starting with it.
        this.pos--;
        this.pending.push({ s: 'decl', scope, vtype, array, range, name });
        return { s: 'expr', expr: this.parseExpression() };
      }
      return { s: 'decl', scope, vtype, array, range, name, init };
    }
    if (this.isWord('for')) {
      this.pos++;
      const name = this.next().value;
      this.expectOp(':=');
      const from = this.parseExpression();
      this.expectWord('to');
      const to = this.parseExpression();
      let step: Node | undefined;
      if (this.isWord('step')) {
        this.pos++;
        step = this.parseExpression();
      }
      this.expectWord('do');
      return { s: 'for', name, from, to, step, body: this.parseBlock() };
    }
    if (this.isWord('while')) {
      this.pos++;
      const cond = this.parseExpression();
      this.expectWord('do');
      return { s: 'while', cond, body: this.parseBlock(), post: false };
    }
    if (this.isWord('do')) {
      this.pos++;
      const body = this.parseBlock();
      this.expectWord('while');
      return { s: 'while', cond: this.parseExpression(), body, post: true };
    }
    if (this.isWord('exit')) {
      this.pos++;
      return { s: 'exit', what: KEYWORD(this.next().value) };
    }
    if (this.isWord('if')) {
      this.pos++;
      const cond = this.parseExpression();
      this.expectWord('then');
      const then = this.parseBlock();
      let otherwise: Stmt[] | undefined;
      if (this.isWord('else')) {
        this.pos++;
        otherwise = this.parseBlock();
      }
      return { s: 'if', cond, then, else: otherwise };
    }
    if (this.peek().kind === 'ident' && this.peek(1).kind === 'op' && this.peek(1).value === ':=') {
      const name = this.next().value;
      this.pos++;
      return { s: 'assign', name, value: this.parseValue() };
    }
    if (this.peek().kind === 'ident' && this.peek(1).kind === 'op' && this.peek(1).value === '[') {
      const start = this.pos;
      const name = this.next().value;
      this.pos++;
      const index = this.parseConcat();
      if (this.isOp(']') && this.peek(1).kind === 'op' && this.peek(1).value === ':=') {
        this.pos += 2;
        return { s: 'assign', name, index, value: this.parseExpression() };
      }
      this.pos = start;
    }
    return { s: 'expr', expr: this.parseExpression() };
  }

  private parsePrimary(): Node {
    const t = this.next();
    switch (t.kind) {
      case 'number':
        return { t: 'literal', vb: t.value.replace(/\.$/, '') };
      case 'string':
        return { t: 'literal', vb: vbString(t.value) };
      case 'date':
        return { t: 'literal', vb: `CDate(${vbString(t.value)})` };
      case 'field':
        return this.postfix({ t: 'field', ref: t.value });
      case 'op':
        if (t.value === '(') {
          const inner = this.parseExpression();
          this.expectOp(')');
          return this.postfix(inner);
        }
        if (t.value === '[') {
          const items: Node[] = [];
          while (!this.isOp(']')) {
            items.push(this.parseExpression());
            if (this.isOp(',')) this.pos++;
            else break;
          }
          this.expectOp(']');
          return { t: 'array', items };
        }
        throw new Error(`unexpected "${t.value}"`);
      case 'ident': {
        if (this.isOp('(')) {
          this.pos++;
          const args: Node[] = [];
          while (!this.isOp(')')) {
            args.push(this.parseExpression());
            if (this.isOp(',')) this.pos++;
            else break;
          }
          this.expectOp(')');
          return this.postfix({ t: 'call', name: t.value, args });
        }
        return this.postfix({ t: 'name', name: t.value });
      }
      default:
        throw new Error('unexpected end of formula');
    }
  }
}

// ---- emitting --------------------------------------------------------------------------

/**
 * A VB string literal; line breaks of any kind become vbCrLf (a VB literal cannot span lines). VB also takes the
 * typographic and full-width double quotes (“ ” ＂) as quote marks: inside a literal they would end it, so they
 * are added as characters (ChrW).
 */
export const vbString = (value: string) =>
  value.split(/\r\n|[\r\n\u0085\u2028\u2029]/).map((line) => `"${line.replace(/"/g, '""').replace(/[\u201C\u201D\uFF02]/g, (q) => `" & ChrW(${q.charCodeAt(0)}) & "`)}"`)
    .join(' & vbCrLf & ').replace(/^"" & | & ""$/g, '').replace(/ & "" & /g, ' & ').replace(/^"" & | & ""$/g, '');

const BINARY_VB: Record<string, string> = {
  and: 'AndAlso',
  or: 'OrElse',
  xor: 'Xor',
  mod: 'Mod',
  like: 'Like',
  '=': '=',
  '<>': '<>',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '\\': '\\',
  '^': '^',
  '&': '&',
};

/** Functions whose VB equivalent takes the same arguments. */
export const SAME_ARGS: Record<string, string> = {
  uppercase: 'UCase', ucase: 'UCase', lowercase: 'LCase', lcase: 'LCase',
  trim: 'Trim', trimleft: 'LTrim', ltrim: 'LTrim', trimright: 'RTrim', rtrim: 'RTrim',
  left: 'Left', right: 'Right', mid: 'Mid', length: 'Len', len: 'Len',
  instr: 'InStr', instrrev: 'InStrRev', replace: 'Replace', strreverse: 'StrReverse', space: 'Space',
  chr: 'Chr', chrw: 'ChrW', asc: 'Asc', ascw: 'AscW', val: 'Val',
  tonumber: 'CDbl', cdbl: 'CDbl', cstr: 'CStr', cbool: 'CBool', cdate: 'CDate', ccur: 'CDec', int: 'Int',
  abs: 'Abs', sgn: 'Sign', sqr: 'Sqrt', sqrt: 'Sqrt', exp: 'Exp', log: 'Log', sin: 'Sin', cos: 'Cos', tan: 'Tan', atn: 'Atan', fix: 'Fix',

  year: 'Year', month: 'Month', day: 'Day', hour: 'Hour', minute: 'Minute', second: 'Second',
  dateadd: 'DateAdd', datediff: 'DateDiff', datepart: 'DatePart', dayofweek: 'Weekday', weekday: 'Weekday',
  monthname: 'MonthName', weekdayname: 'WeekdayName',
  dateserial: 'DateSerial', timeserial: 'TimeSerial', isnumber: 'IsNumeric', numerictext: 'IsNumeric', lbound: 'LBound',
  strcmp: 'StrComp', filter: 'Filter',
  iif: 'IIf', choose: 'Choose', switch: 'Switch', isnumeric: 'IsNumeric', isdate: 'IsDate',
};

const AGGREGATES: Record<string, string> = {
  sum: 'Sum', count: 'Count', average: 'Avg', maximum: 'Max', minimum: 'Min',
  distinctcount: 'CountDistinct', stddev: 'StDev', pthstddev: 'StDevP', variance: 'Var', popvariance: 'VarP',
  populationstddev: 'StDevP', populationvariance: 'VarP',
};

/** Crystal special fields and keywords used as bare names. */
export const NAMES: Record<string, string> = {
  true: 'True', false: 'False', null: 'Nothing',
  pi: 'Math.PI', timer: 'Timer', rnd: 'Rnd()',
  currentdate: 'Today()', today: 'Today()', currentdatetime: 'Now()', currenttime: 'TimeOfDay', printdate: 'Globals!ExecutionTime',
  printtime: 'Globals!ExecutionTime', datadate: 'Globals!ExecutionTime', datatime: 'Globals!ExecutionTime',
  pagenumber: 'Globals!PageNumber', totalpagecount: 'Globals!TotalPages', reporttitle: 'Globals!ReportName',
  filename: 'Globals!ReportName', recordnumber: 'RowNumber(Nothing)',
  crblack: '"Black"', crwhite: '"White"', crred: '"Red"', crgreen: '"Green"', crblue: '"Blue"', cryellow: '"Yellow"',
  crmaroon: '"Maroon"', crnavy: '"Navy"', crolive: '"Olive"', crpurple: '"Purple"', crteal: '"Teal"', crgray: '"Gray"',
  crsilver: '"Silver"', crlime: '"Lime"', craqua: '"Aqua"', crfuchsia: '"Fuchsia"', nocolor: '"Transparent"', crnocolor: '"Transparent"',
  crnone: 'Nothing',
  // Font style and line style values of formatting formulas, as SSRS names them.
  crregular: '"Regular"', crbold: '"Bold"', critalic: '"Italic"', crbolditalic: '"BoldItalic"',
  crnoline: '"None"', crsingleline: '"Solid"', crdoubleline: '"Double"', crdashedline: '"Dashed"', crdottedline: '"Dotted"',
  onfirstrecord: '(RowNumber(Nothing) = 1)', onlastrecord: '(RowNumber(Nothing) = CountRows("DataSet1"))',
  inrepeatedgroupheader: 'False', drilldowngrouplevel: '0',
  crsunday: 'FirstDayOfWeek.Sunday', crmonday: 'FirstDayOfWeek.Monday', crtuesday: 'FirstDayOfWeek.Tuesday',
  crwednesday: 'FirstDayOfWeek.Wednesday', crthursday: 'FirstDayOfWeek.Thursday', crfriday: 'FirstDayOfWeek.Friday',
  crsaturday: 'FirstDayOfWeek.Saturday', crusesystem: 'FirstDayOfWeek.System',
  // Conditional formatting: the value being formatted, and "leave the property unchanged".
  currentfieldvalue: 'Me.Value', defaultattribute: 'Nothing',
};

/** Special fields that appear in braces or as field objects, e.g. {PageNumber} or "Page N of M". */
export const SPECIAL_FIELDS: Record<string, string> = {
  'page number': 'Globals!PageNumber',
  'total page count': 'Globals!TotalPages',
  'page n of m': '"Page " & Globals!PageNumber & " of " & Globals!TotalPages',
  'print date': 'Globals!ExecutionTime',
  'print time': 'Globals!ExecutionTime',
  'data date': 'Globals!ExecutionTime',
  'data time': 'Globals!ExecutionTime',
  'modification date': 'Globals!ExecutionTime',
  'modification time': 'Globals!ExecutionTime',
  'record number': 'RowNumber(Nothing)',
  'report title': 'Globals!ReportName',
  'file path and name': 'Globals!ReportName',
  'report comments': '""',
};

/** The review note for a formula converted to custom code; folds in the print-time note, if any. */
export function customCodeNote(issues: string[], name: string, origin = ''): string {
  const timing = issues.findIndex((i) => /^uses whileprintingrecords;/i.test(i));
  if (timing >= 0) issues.splice(timing, 1);
  return `was converted to custom code (Code.${name})${origin}${timing >= 0 ? '; it uses WhilePrintingRecords, so it runs as SSRS renders each page (check totals across pages)' : ''}; review the VB function`;
}

/** VB helpers shared by translated formulas; each is added to the report Code block once. */
export const CODE_HELPERS: Record<string, string> = {
  // Crystal's ToText/CStr of a value whose type is only known when the report runs: a number gets two decimals
  // and thousands separators, as in Crystal; anything else is shown as it is.
  CrToText: [
    'Public Function CrToText(ByVal value As Object) As String',
    '    If value Is Nothing Then Return ""',
    '    If TypeOf value Is String Then Return CStr(value)',
    '    If IsNumeric(value) Then Return FormatNumber(value, 2)',
    '    Return CStr(value)',
    'End Function',
  ].join('\r\n'),
  // Sum, Average, Maximum, Minimum and Count over an array; "first" is 1 for Crystal arrays, 0 for parameters.
  CrArrayAgg: [
    'Public Function CrArrayAgg(ByVal items As Object, ByVal op As String, ByVal first As Integer) As Object',
    '    Dim result As Object = Nothing',
    '    Dim n As Integer = 0',
    '    For i As Integer = first To UBound(items)',
    '        Dim v As Object = items(i)',
    '        If v Is Nothing Then Continue For',
    '        n += 1',
    '        Select Case op',
    '            Case "sum", "average"',
    '                result = If(result Is Nothing, v, result + v)',
    '            Case "maximum"',
    '                If result Is Nothing OrElse v > result Then result = v',
    '            Case "minimum"',
    '                If result Is Nothing OrElse v < result Then result = v',
    '        End Select',
    '    Next',
    '    If op = "count" Or op = "distinctcount" Then Return n',
    '    If op = "average" Then Return If(n = 0, Nothing, result / n)',
    '    Return result',
    'End Function',
  ].join('\n'),
  // Crystal arrays are 1-based; generated arrays keep slot 0 unused.
  CrSplit: [
    'Public Function CrSplit(ByVal text As Object, ByVal delimiter As Object) As Object()',
    '    Dim parts() As String = Split(CStr(text), CStr(delimiter))',
    '    Dim result(parts.Length) As Object',
    '    Array.Copy(parts, 0, result, 1, parts.Length)',
    '    Return result',
    'End Function',
  ].join('\n'),
  CrJoin: [
    'Public Function CrJoin(ByVal items As Object, ByVal delimiter As Object) As String',
    '    Dim parts As New System.Collections.Generic.List(Of String)',
    '    For i As Integer = 1 To UBound(items)',
    '        parts.Add(CStr(items(i)))',
    '    Next',
    '    Return String.Join(CStr(delimiter), parts.ToArray())',
    'End Function',
  ].join('\n'),
  // Crystal's Even/Odd: rounds away from zero to the nearest even/odd whole number.
  CrEven: [
    'Public Function CrEven(ByVal x As Double) As Double',
    '    Dim n As Double = Math.Ceiling(Math.Abs(x))',
    '    If n Mod 2 <> 0 Then n += 1',
    '    Return If(x < 0, -n, n)',
    'End Function',
  ].join('\n'),
  CrOdd: [
    'Public Function CrOdd(ByVal x As Double) As Double',
    '    Dim n As Double = Math.Ceiling(Math.Abs(x))',
    '    If n Mod 2 = 0 Then n += 1',
    '    Return If(x < 0, -n, n)',
    'End Function',
  ].join('\n'),
  // Crystal's ToWords: a number in words, with its cents as "and nn / 100"; decimals sets how many places.
  CrToWords: [
    'Public Function CrToWords(ByVal value As Object, Optional ByVal decimals As Integer = 2) As String',
    '    If value Is Nothing Then Return ""',
    '    Dim x As Decimal = Math.Round(Math.Abs(CDec(value)), decimals, MidpointRounding.AwayFromZero)',
    '    Dim whole As Long = CLng(Math.Floor(x))',
    '    Dim words As String = CrWords(whole)',
    '    If CDec(value) < 0 Then words = "minus " & words',
    '    If decimals > 0 Then words &= " and " & CLng((x - whole) * CDec(10 ^ decimals)).ToString().PadLeft(decimals, "0"c) & " / " & CLng(10 ^ decimals).ToString()',
    '    Return words',
    'End Function',
    'Private Function CrWords(ByVal n As Long) As String',
    '    Dim ones() As String = {"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"}',
    '    Dim tens() As String = {"", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"}',
    '    If n < 20 Then Return ones(CInt(n))',
    '    If n < 100 Then Return tens(CInt(n \\ 10)) & If(n Mod 10 > 0, "-" & ones(CInt(n Mod 10)), "")',
    '    If n < 1000 Then Return ones(CInt(n \\ 100)) & " hundred" & If(n Mod 100 > 0, " " & CrWords(n Mod 100), "")',
    '    Dim units() As Long = {1000000000000L, 1000000000L, 1000000L, 1000L}',
    '    Dim names() As String = {"trillion", "billion", "million", "thousand"}',
    '    For i As Integer = 0 To units.Length - 1',
    '        If n >= units(i) Then Return CrWords(n \\ units(i)) & " " & names(i) & If(n Mod units(i) > 0, " " & CrWords(n Mod units(i)), "")',
    '    Next',
    '    Return ""',
    'End Function',
  ].join('\n'),
  // Crystal's Picture: each x in the pattern takes the next character of the text; other characters are kept,
  // and characters left over are added at the end.
  CrPicture: [
    'Public Function CrPicture(ByVal text As Object, ByVal pattern As Object) As String',
    '    Dim s As String = CStr(text)',
    '    Dim result As New System.Text.StringBuilder()',
    '    Dim i As Integer = 0',
    '    For Each c As Char In CStr(pattern)',
    '        If Char.ToLower(c) = "x"c Then',
    '            If i < s.Length Then result.Append(s(i))',
    '            i += 1',
    '        Else',
    '            result.Append(c)',
    '        End If',
    '    Next',
    '    If i < s.Length Then result.Append(s.Substring(i))',
    '    Return result.ToString()',
    'End Function',
  ].join('\n'),
  CrRoman: [
    'Public Function CrRoman(ByVal value As Object) As String',
    '    Dim n As Integer = CInt(value)',
    '    Dim values() As Integer = {1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1}',
    '    Dim symbols() As String = {"M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"}',
    '    Dim result As String = ""',
    '    For i As Integer = 0 To values.Length - 1',
    '        While n >= values(i)',
    '            result &= symbols(i)',
    '            n -= values(i)',
    '        End While',
    '    Next',
    '    Return result',
    'End Function',
  ].join('\n'),
  // Crystal's ExtractString: the text between the first start marker and the next end marker ("" if missing).
  CrExtractString: [
    'Public Function CrExtractString(ByVal text As Object, ByVal startText As Object, ByVal endText As Object) As String',
    '    Dim s As String = CStr(text)',
    '    Dim a As Integer = s.IndexOf(CStr(startText))',
    '    If a < 0 Then Return ""',
    '    a += CStr(startText).Length',
    '    Dim b As Integer = s.IndexOf(CStr(endText), a)',
    '    If b < 0 Then Return ""',
    '    Return s.Substring(a, b - a)',
    'End Function',
  ].join('\n'),
  CrAdd: [
    'Public Function CrAdd(ByVal a As Object, ByVal b As Object) As Object',
    '    If TypeOf a Is Date AndAlso Not TypeOf b Is Date Then Return DateAdd("d", CDbl(b), CDate(a))',
    '    If TypeOf b Is Date AndAlso Not TypeOf a Is Date Then Return DateAdd("d", CDbl(a), CDate(b))',
    '    Return a + b',
    'End Function',
  ].join('\n'),
  CrSubtract: [
    'Public Function CrSubtract(ByVal a As Object, ByVal b As Object) As Object',
    '    If TypeOf a Is Date AndAlso TypeOf b Is Date Then Return DateDiff("d", CDate(b), CDate(a))',
    '    If TypeOf a Is Date Then Return DateAdd("d", -CDbl(b), CDate(a))',
    '    Return a - b',
    'End Function',
  ].join('\n'),
};

/** Translates a multi-statement formula or custom function into a VB function for the report Code block. */
function translateToCode(tokens: Token[], ctx: FormulaContext, name: string): Translation {
  const issues: string[] = [];
  try {
    const program = new Parser(tokens).parseProgram();
    const emitter = new Emitter(ctx, issues);
    emitter.inCode = true;
    const writer = new CodeWriter(emitter);
    const raw = writer.write(program, name);
    if (program.params) {
      // A custom function: called from other formulas with its own arguments.
      return { expression: `=Code.${name}()`, issues, code: raw, members: emitter.members, helpers: [...emitter.helpers] };
    }
    const { code, args } = extractArguments(raw);
    const signature = args.map((_, i) => `ByVal a${i + 1} As Object`).join(', ');
    const finalCode = code.replace(`Public Function ${name}() As Object`, `Public Function ${name}(${signature}) As Object`);
    issues.push(customCodeNote(issues, name));
    return { expression: `=Code.${name}(${args.join(', ')})`, issues, code: finalCode, members: emitter.members, helpers: [...emitter.helpers] };
  } catch (err) {
    issues.push(`could not be parsed (${(err as Error).message}); needs manual conversion`);
    return { expression: '=Nothing', issues };
  }
}

const T = 'Today()';
/** Crystal's named date ranges: [start, end] (inclusive days) as VB and T-SQL expressions. */
const NAMED_DATE_RANGES: Record<string, { vb: [string, string]; sql: [string, string] }> = (() => {
  const d = 'CAST(GETDATE() AS date)';
  const vbDays = (n: number) => `DateAdd("d", ${n}, ${T})`;
  const sqlDays = (n: number) => `DATEADD(day, ${n}, ${d})`;
  const table: Record<string, { vb: [string, string]; sql: [string, string] }> = {
    lastfullmonth: { vb: [`DateSerial(Year(${T}), Month(${T}) - 1, 1)`, `DateSerial(Year(${T}), Month(${T}), 0)`], sql: [`DATEADD(month, -1, DATEFROMPARTS(YEAR(${d}), MONTH(${d}), 1))`, `EOMONTH(${d}, -1)`] },
    monthtodate: { vb: [`DateSerial(Year(${T}), Month(${T}), 1)`, T], sql: [`DATEFROMPARTS(YEAR(${d}), MONTH(${d}), 1)`, d] },
    yeartodate: { vb: [`DateSerial(Year(${T}), 1, 1)`, T], sql: [`DATEFROMPARTS(YEAR(${d}), 1, 1)`, d] },
    lastyearmtd: { vb: [`DateSerial(Year(${T}) - 1, Month(${T}), 1)`, `DateAdd("yyyy", -1, ${T})`], sql: [`DATEFROMPARTS(YEAR(${d}) - 1, MONTH(${d}), 1)`, `DATEADD(year, -1, ${d})`] },
    lastyearytd: { vb: [`DateSerial(Year(${T}) - 1, 1, 1)`, `DateAdd("yyyy", -1, ${T})`], sql: [`DATEFROMPARTS(YEAR(${d}) - 1, 1, 1)`, `DATEADD(year, -1, ${d})`] },
    last7days: { vb: [vbDays(-6), T], sql: [sqlDays(-6), d] },
    lastfullweek: { vb: [`DateAdd("d", -Weekday(${T}) - 6, ${T})`, `DateAdd("d", -Weekday(${T}), ${T})`], sql: [`DATEADD(day, -DATEPART(weekday, ${d}) - 6, ${d})`, `DATEADD(day, -DATEPART(weekday, ${d}), ${d})`] },
    weektodatefromsun: { vb: [`DateAdd("d", 1 - Weekday(${T}), ${T})`, T], sql: [`DATEADD(day, 1 - DATEPART(weekday, ${d}), ${d})`, d] },
    last4weekstosun: { vb: [`DateAdd("d", -Weekday(${T}) - 27, ${T})`, `DateAdd("d", -Weekday(${T}) + 1, ${T})`], sql: [`DATEADD(day, -DATEPART(weekday, ${d}) - 27, ${d})`, `DATEADD(day, -DATEPART(weekday, ${d}) + 1, ${d})`] },
    alldatestotoday: { vb: ['DateTime.MinValue', T], sql: [`'17530101'`, d] },
    alldatestoyesterday: { vb: ['DateTime.MinValue', vbDays(-1)], sql: [`'17530101'`, sqlDays(-1)] },
    alldatesfromtoday: { vb: [T, 'DateTime.MaxValue.Date'], sql: [d, `'99991230'`] },
    alldatesfromtomorrow: { vb: [vbDays(1), 'DateTime.MaxValue.Date'], sql: [sqlDays(1), `'99991230'`] },
    next30days: { vb: [T, vbDays(29)], sql: [d, sqlDays(29)] },
    next31to60days: { vb: [vbDays(30), vbDays(59)], sql: [sqlDays(30), sqlDays(59)] },
    next61to90days: { vb: [vbDays(60), vbDays(89)], sql: [sqlDays(60), sqlDays(89)] },
    next91to365days: { vb: [vbDays(90), vbDays(364)], sql: [sqlDays(90), sqlDays(364)] },
    aged0to30days: { vb: [vbDays(-30), T], sql: [sqlDays(-30), d] },
    aged31to60days: { vb: [vbDays(-60), vbDays(-31)], sql: [sqlDays(-60), sqlDays(-31)] },
    aged61to90days: { vb: [vbDays(-90), vbDays(-61)], sql: [sqlDays(-90), sqlDays(-61)] },
    over90days: { vb: ['DateTime.MinValue', vbDays(-91)], sql: [`'17530101'`, sqlDays(-91)] },
  };
  const quarter = (q: number) => ({ vb: [`DateSerial(Year(${T}), ${q * 3 - 2}, 1)`, `DateSerial(Year(${T}), ${q * 3 + 1}, 0)`] as [string, string], sql: [`DATEFROMPARTS(YEAR(${d}), ${q * 3 - 2}, 1)`, `EOMONTH(DATEFROMPARTS(YEAR(${d}), ${q * 3}, 1))`] as [string, string] });
  table.calendar1stqtr = quarter(1);
  table.calendar2ndqtr = quarter(2);
  table.calendar3rdqtr = quarter(3);
  table.calendar4thqtr = quarter(4);
  table.calendar1sthalf = { vb: [`DateSerial(Year(${T}), 1, 1)`, `DateSerial(Year(${T}), 6, 30)`], sql: [`DATEFROMPARTS(YEAR(${d}), 1, 1)`, `DATEFROMPARTS(YEAR(${d}), 6, 30)`] };
  table.calendar2ndhalf = { vb: [`DateSerial(Year(${T}), 7, 1)`, `DateSerial(Year(${T}), 12, 31)`], sql: [`DATEFROMPARTS(YEAR(${d}), 7, 1)`, `DATEFROMPARTS(YEAR(${d}), 12, 31)`] };
  return table;
})();

/** Crystal colours are integers in BGR order (0x00BBGGRR); SSRS wants "#RRGGBB". */
export function crystalColor(value: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(value & 0xff)}${hex((value >> 8) & 0xff)}${hex((value >> 16) & 0xff)}`;
}

interface VariableInfo {
  vb: string;
  vtype: string;
  array: boolean;
  /** A Crystal range variable, held as a two-element array (start, end). */
  range?: boolean;
}

export class Emitter {
  readonly issues: string[];
  /** Variables in scope when emitting custom code (Crystal name, lower case -> info). */
  readonly variables = new Map<string, VariableInfo>();
  /** Class-level members needed by custom code: VB name -> VB type. */
  readonly members: Record<string, string> = {};
  /** Names of CODE_HELPERS functions used. */
  readonly helpers = new Set<string>();
  inCode = false;
  /** The formula's result is True/False: an "if" without "else" defaults to False. */
  booleanResult = false;
  readonly ctx: FormulaContext;

  constructor(ctx: FormulaContext, issues: string[]) {
    this.ctx = ctx;
    this.issues = issues;
  }

  /** Emits a value that becomes the formula's result; with colors on, numeric colours become "#RRGGBB". */
  result(node: Node, colors: boolean): string {
    if (colors) {
      if (node.t === 'literal' && /^\d+$/.test(node.vb)) return vbString(crystalColor(Number(node.vb)));
      if (node.t === 'call' && node.name.toLowerCase() === 'color' && node.args.every((a) => a.t === 'literal' && /^\d+$/.test(a.vb))) {
        const [r, g, b] = node.args.map((a) => Number((a as { vb: string }).vb));
        return vbString(crystalColor(r | (g << 8) | (b << 16)));
      }
      if (node.t === 'if') {
        return `IIf(${this.emit(node.cond)}, ${this.result(node.then, true)}, ${node.else ? this.result(node.else, true) : 'Nothing'})`;
      }
      if (node.t === 'select') {
        const pairs = node.cases.flatMap((c) => [c.match.map((m) => this.emit(m)).join(' OrElse '), this.result(c.result, true)]);
        if (node.otherwise) pairs.push('True', this.result(node.otherwise, true));
        return `Switch(${pairs.join(', ')})`;
      }
    }
    return this.emit(node);
  }

  private note(message: string): void {
    if (!this.issues.includes(message)) this.issues.push(message);
  }

  fieldRef(ref: string): string {
    const prefix = ref[0];
    const name = ref.slice(1);
    if (prefix === '@') {
      const expression = this.ctx.formula(name);
      if (expression === undefined) {
        this.note(`references unknown formula {@${name}}`);
        return 'Nothing';
      }
      return `(${expression})`;
    }
    if (prefix === '?') {
      const range = this.ctx.parameterRange?.(name);
      if (range) return `New Object() {Parameters!${range.start}.Value, Parameters!${range.end}.Value}`;
      return `Parameters!${this.ctx.parameter(name)}.Value`;
    }
    if (prefix === '#') {
      const expression = this.ctx.runningTotal?.(name);
      if (expression) return expression;
      this.note(`references running total {${ref}} which could not be converted`);
      return 'Nothing';
    }
    if (prefix === '%') {
      this.note(`references SQL expression {${ref}} which needs manual conversion`);
      return 'Nothing';
    }
    const special = SPECIAL_FIELDS[ref.toLowerCase()];
    if (special) return special;
    const dot = ref.lastIndexOf('.');
    if (dot > 0) {
      const field = this.ctx.field(ref.slice(0, dot), ref.slice(dot + 1));
      if (field) return `Fields!${field}.Value`;
    }
    this.note(`references unknown field {${ref}}`);
    return 'Nothing';
  }

  emit(node: Node): string {
    switch (node.t) {
      case 'literal':
        return node.vb;
      case 'field':
        return this.fieldRef(node.ref);
      case 'name': {
        const variable = this.variables.get(node.name.toLowerCase());
        if (variable) return variable.vb;
        const vb = NAMES[node.name.toLowerCase()];
        if (vb) return vb;
        this.note(`uses "${node.name}" which has no direct SSRS equivalent`);
        return 'Nothing';
      }
      case 'unary':
        return node.op === 'not' ? `Not (${this.emit(node.arg)})` : `(-(${this.emit(node.arg)}))`;
      case 'binary':
        return this.emitBinary(node.op, node.left, node.right);
      case 'if': {
        const then = this.emit(node.then);
        const otherwise = node.else ? this.emit(node.else) : this.defaultFor(node.then);
        // IIf evaluates both branches; If() evaluates only the chosen one, so a guarded division cannot fail.
        const fn = /[/\\]|\bMod\b/.test(`${then} ${otherwise}`) ? 'If' : 'IIf';
        return `${fn}(${this.emit(node.cond)}, ${then}, ${otherwise})`;
      }
      case 'in': {
        if (node.list.length === 0) return node.negate ? 'True' : 'False';
        const emitted = this.emit(node.value);
        const value = this.isTextField(node.value) ? `RTrim(${emitted})` : emitted;
        const test = node.list.map((item) => `${value} = ${this.emit(item)}`).join(' OrElse ');
        return node.negate ? `Not (${test})` : `(${test})`;
      }
      case 'range': {
        const value = this.emit(node.value);
        const test = `(${value} >= ${this.emit(node.from)} AndAlso ${value} <= ${this.emit(node.to)})`;
        return node.negate ? `Not ${test}` : test;
      }
      case 'select': {
        const pairs = node.cases.flatMap((c) => [c.match.map((m) => this.emit(m)).join(' OrElse '), this.emit(c.result)]);
        // Without "default", Crystal returns the default of the result type.
        const otherwise = node.otherwise ? this.emit(node.otherwise) : node.cases[0] ? this.defaultFor(node.cases[0].result) : 'Nothing';
        pairs.push('True', otherwise);
        return `Switch(${pairs.join(', ')})`;
      }
      case 'array':
        // Crystal arrays start at 1: slot 0 stays unused, so indexes and UBound() match.
        return `New Object() {Nothing${node.items.map((i) => `, ${this.emit(i)}`).join('')}}`;
      case 'call':
        return this.emitCall(node.name, node.args);
      case 'rangeValue':
        return `New Object() {${this.emit(node.from)}, ${this.emit(node.to)}}`;
      case 'index': {
        const base = this.emit(node.base);
        const variable = node.base.t === 'name' ? this.variables.get(node.base.name.toLowerCase()) : undefined;
        if (variable?.array || this.isArrayNode(node.base)) {
          if (node.to) this.note('uses an array range, which needs manual conversion');
          return `${base}(${this.emit(node.from)})`;
        }
        if (this.isMultiParameter(node.base)) {
          // Parameter values are 0-based; Crystal counts from 1.
          return `${base}((${this.emit(node.from)}) - 1)`;
        }
        const from = this.emit(node.from);
        return node.to ? `Mid(${base}, ${from}, (${this.emit(node.to)}) - (${from}) + 1)` : `Mid(${base}, ${from}, 1)`;
      }
    }
  }

  /** Start and end expressions of a range variable or range parameter. */
  private rangeOf(node: Node): { start: string; end: string } | undefined {
    if (node.t === 'name') {
      const v = this.variables.get(node.name.toLowerCase());
      if (v?.range) return { start: `${v.vb}(0)`, end: `${v.vb}(1)` };
    }
    if (node.t === 'field' && node.ref.startsWith('?')) {
      const range = this.ctx.parameterRange?.(node.ref.slice(1));
      if (range) return { start: `Parameters!${range.start}.Value`, end: `Parameters!${range.end}.Value` };
    }
    return undefined;
  }

  /** "x = {?rangeParam}" means "x within the range"; "x = {?multiParam}" means "x is one of the values". */
  private parameterComparison(op: string, left: Node, right: Node): string | undefined {
    if (op !== '=' && op !== '<>') return undefined;
    const [value, param] = right.t === 'field' && right.ref.startsWith('?') ? [left, right.ref.slice(1)] : left.t === 'field' && left.ref.startsWith('?') ? [right, left.ref.slice(1)] : [];
    if (!value || param === undefined) return undefined;
    const range = this.ctx.parameterRange?.(param);
    const v = () => this.emit(value);
    if (range) {
      const x = v();
      const test = `(${x} >= Parameters!${range.start}.Value AndAlso ${x} <= Parameters!${range.end}.Value)`;
      return op === '=' ? test : `Not ${test}`;
    }
    if (this.ctx.parameterMultiple?.(param)) {
      const test = `(Array.IndexOf(Parameters!${this.ctx.parameter(param)}.Value, ${v()}) >= 0)`;
      return op === '=' ? test : `Not ${test}`;
    }
    return undefined;
  }

  /** A multi-value report parameter ({?Name} allowing several values). */
  private isMultiParameter(node: Node): boolean {
    return node.t === 'field' && node.ref.startsWith('?') && this.ctx.parameterMultiple?.(node.ref.slice(1)) === true;
  }

  /** An array value in the generated code: a literal, an array variable or Split(). */
  private isArrayNode(node: Node): boolean {
    if (node.t === 'array') return true;
    if (node.t === 'call' && node.name.toLowerCase() === 'split') return true;
    if (node.t === 'name') return this.variables.get(node.name.toLowerCase())?.array === true;
    return false;
  }

  private isStringNode(node: Node): boolean {
    if (node.t === 'literal') return node.vb.startsWith('"');
    if (node.t === 'field' && !node.ref.startsWith('@') && !node.ref.startsWith('?')) return ['string', 'memo'].includes(this.ctx.fieldType?.(node.ref) ?? '');
    if (node.t === 'name') return this.variables.get(node.name.toLowerCase())?.vtype === 'stringvar';
    return false;
  }

  /**
   * Crystal InStr / InStrRev with typed arguments. VB has several InStr overloads; with untyped (Object) field
   * values SSRS cannot choose one (error BC30519), so every argument is converted to the parameter's type.
   *   InStr(text, search)  InStr(start, text, search)  InStr(text, search, compare)  InStr(start, text, search, compare)
   *   InStrRev(text, search [, start [, compare]])
   * Crystal's compare is 0 (case-sensitive) or 1 (case-insensitive).
   */
  private instr(key: 'instr' | 'instrrev', args: Node[]): string {
    const text = (n: Node) => `CStr(${this.emit(n)})`;
    const whole = (n: Node) => `CInt(${this.emit(n)})`;
    const compare = (n: Node) => {
      const value = this.emit(n);
      if (value === '1') return 'CompareMethod.Text';
      if (value === '0') return 'CompareMethod.Binary';
      return `IIf(${value} = 1, CompareMethod.Text, CompareMethod.Binary)`;
    };
    if (key === 'instrrev') {
      const parts = [text(args[0]), text(args[1])];
      if (args[2]) parts.push(whole(args[2]));
      if (args[3]) parts.push(compare(args[3]));
      return `InStrRev(${parts.join(', ')})`;
    }
    if (args.length >= 4) return `InStr(${whole(args[0])}, ${text(args[1])}, ${text(args[2])}, ${compare(args[3])})`;
    if (args.length === 3) {
      // The start form begins with a number; the compare form begins with text and ends with 0 or 1.
      const startForm = this.isNumberNode(args[0]) || (!this.isStringNode(args[0]) && this.isStringNode(args[2]));
      return startForm
        ? `InStr(${whole(args[0])}, ${text(args[1])}, ${text(args[2])})`
        : `InStr(${text(args[0])}, ${text(args[1])}, ${compare(args[2])})`;
    }
    return `InStr(${args.map(text).join(', ')})`;
  }

  private isNumberNode(node: Node): boolean {
    if (node.t === 'literal') return /^-?[\d.]+$/.test(node.vb);
    if (node.t === 'field' && !node.ref.startsWith('@') && !node.ref.startsWith('?')) return ['integer', 'number', 'currency'].includes(this.ctx.fieldType?.(node.ref) ?? '');
    if (node.t === 'name') return ['numbervar', 'currencyvar'].includes(this.variables.get(node.name.toLowerCase())?.vtype ?? '');
    return false;
  }

  /** A value VB sees as a number: a numeric literal, field or variable, a function giving a number, or sums of them. */
  private isNumericValue(node: Node): boolean {
    if (this.isNumberNode(node)) return true;
    if (node.t === 'call') return ['year', 'month', 'day', 'hour', 'minute', 'second', 'dayofweek', 'weekday', 'len', 'length', 'tonumber', 'cdbl', 'int', 'round', 'abs', 'datediff', 'datepart', 'instr', 'remainder', 'truncate', 'fix', 'count', 'sum'].includes(node.name.toLowerCase());
    if (node.t === 'binary') return ['+', '-', '*', '/', '\\', 'mod'].includes(node.op) && this.isNumericValue(node.left) && this.isNumericValue(node.right);
    if (node.t === 'unary') return node.op === '-' && this.isNumericValue(node.arg);
    return false;
  }

  /** A database field of a text type. */
  private isTextField(node: Node): boolean {
    return node.t === 'field' && !node.ref.startsWith('@') && !node.ref.startsWith('?') && ['string', 'memo'].includes(this.ctx.fieldType?.(node.ref) ?? '');
  }

  private isTextNode(node: Node): boolean {
    if (node.t === 'literal') return node.vb.startsWith('"');
    if (node.t === 'field' && !node.ref.startsWith('@') && !node.ref.startsWith('?')) return ['string', 'memo'].includes(this.ctx.fieldType?.(node.ref) ?? '');
    if (node.t === 'name') return this.variables.get(node.name.toLowerCase())?.vtype === 'stringvar';
    return false;
  }

  /** Crystal's value for an "if" without "else": the default of the "then" branch's type. */
  defaultFor(node: Node): string {
    if (node.t === 'literal') {
      if (node.vb.startsWith('"')) return '""';
      if (/^-?[\d.]+$/.test(node.vb)) return '0';
      if (node.vb === 'True' || node.vb === 'False') return 'False';
    }
    if (node.t === 'call' && ['totext', 'cstr', 'left', 'right', 'mid', 'trim', 'ucase', 'lcase', 'uppercase', 'lowercase', 'replace', 'propercase'].includes(node.name.toLowerCase())) return '""';
    if (node.t === 'binary') {
      if (['+', '-', '*', '/', '%', '^'].includes(node.op) && !this.isDate(node)) {
        const l = this.defaultFor(node.left);
        return l === '""' && node.op === '+' ? '""' : l === 'Nothing' ? this.defaultFor(node.right) : l === '""' ? 'Nothing' : '0';
      }
      if (node.op === '&') return '""';
      if (['=', '<>', '<', '>', '<=', '>=', 'and', 'or'].includes(node.op)) return 'False';
    }
    if (node.t === 'field' && !node.ref.startsWith('@') && !node.ref.startsWith('?')) {
      const type = this.ctx.fieldType?.(node.ref);
      if (type && ['string', 'memo'].includes(type)) return '""';
      if (type && ['integer', 'number', 'currency'].includes(type)) return '0';
      if (type === 'boolean') return 'False';
    }
    if (node.t === 'name') {
      const v = this.variables.get(node.name.toLowerCase());
      if (v && !v.array && !v.range) {
        if (['numbervar', 'currencyvar'].includes(v.vtype)) return '0';
        if (v.vtype === 'stringvar') return '""';
        if (v.vtype === 'booleanvar') return 'False';
      }
    }
    if (this.booleanResult) return 'False';
    if (!this.isDate(node)) this.note('has an "if" without "else" whose result type is unknown; Crystal returns that type\'s default value there, SSRS returns Nothing');
    return 'Nothing';
  }

  /** Whether an expression is a call to a report custom function (its result type is only known at run time). */
  private isCustomCall(node: Node): boolean {
    return node.t === 'call' && !SAME_ARGS[node.name.toLowerCase()] && this.ctx.customFunction?.(node.name) !== undefined;
  }

  /** Whether an expression is a date or date-time (Crystal adds days with + and subtracts dates with -). */
  private isDate(node: Node): boolean {
    switch (node.t) {
      case 'name': {
        const v = this.variables.get(node.name.toLowerCase());
        if (v) return ['datevar', 'datetimevar'].includes(v.vtype) && !v.array && !v.range;
        return ['currentdate', 'today', 'currentdatetime', 'printdate', 'datadate', 'modificationdate'].includes(node.name.toLowerCase());
      }
      case 'literal':
        return node.vb.startsWith('CDate(');
      case 'field':
        return !node.ref.startsWith('@') && !node.ref.startsWith('?') && /^(date|dateTime)$/.test(this.ctx.fieldType?.(node.ref) ?? '');
      case 'call':
        return ['cdate', 'date', 'datetime', 'cdatetime', 'datetimevalue', 'dtstodate', 'dateserial', 'dateadd', 'datevalue', 'minimum', 'maximum'].includes(node.name.toLowerCase()) && (node.name.toLowerCase() !== 'minimum' && node.name.toLowerCase() !== 'maximum' || this.isDate(node.args[0]));
      case 'index':
        return node.base.t === 'name' && ['datevar', 'datetimevar'].includes(this.variables.get(node.base.name.toLowerCase())?.vtype ?? '');
      case 'binary':
        return (node.op === '+' || node.op === '-') && this.isDate(node.left) && !this.isDate(node.right);
      default:
        return false;
    }
  }

  private emitBinary(op: string, left: Node, right: Node): string {
    const special = this.parameterComparison(op, left, right);
    if (special) return special;
    if (op === '+' || op === '-') {
      const leftDate = this.isDate(left);
      const rightDate = this.isDate(right);
      if (leftDate && rightDate && op === '-') return `DateDiff("d", ${this.emit(right)}, ${this.emit(left)})`;
      if (leftDate && !rightDate) return `DateAdd("d", ${op === '-' ? '-' : ''}(${this.emit(right)}), ${this.emit(left)})`;
      if (rightDate && !leftDate && op === '+') return `DateAdd("d", ${this.emit(left)}, ${this.emit(right)})`;
      if (!leftDate && !rightDate && (this.isCustomCall(left) || this.isCustomCall(right))) {
        // A custom function may return a date: decide at run time, as Crystal's typed arithmetic would.
        this.helpers.add(op === '+' ? 'CrAdd' : 'CrSubtract');
        return `${this.inCode ? '' : 'Code.'}${op === '+' ? 'CrAdd' : 'CrSubtract'}(${this.emit(left)}, ${this.emit(right)})`;
      }
    }
    if (op === 'startswith') {
      // CStr turns a null field into "", so no NullReferenceException.
      const l = this.emit(left);
      if (right.t === 'array') return `(${right.items.map((i) => `CStr(${l}).StartsWith(${this.emit(i)})`).join(' OrElse ')})`;
      return `CStr(${l}).StartsWith(${this.emit(right)})`;
    }
    let l = this.emit(left);
    let r = this.emit(right);
    // Crystal ignores trailing spaces when comparing text (fixed-width database columns come padded); SSRS does
    // not, so a text field is compared without them.
    if (['=', '<>', '<', '>', '<=', '>='].includes(op) && (this.isTextNode(left) || this.isTextNode(right))) {
      if (this.isTextField(left)) l = `RTrim(${l})`;
      if (this.isTextField(right)) r = `RTrim(${r})`;
    }
    if (op === '%') return `((${l}) / (${r}) * 100)`;
    if (op === 'eqv') return `((${l}) = (${r}))`;
    if (op === 'imp') return `(Not (${l}) OrElse (${r}))`;
    return this.nullWhereNull(op, l, r);
  }

  /**
   * Crystal stops at a null field it reaches, printing nothing for the formula: text joined to a null field, or
   * arithmetic with one, gives nothing (SSRS would carry on with an empty value: "" & "%" printing "%"). Only where it
   * is reached: a branch not taken (if ... then "----" else ...) is not.
   */
  private nullWhereNull(op: string, l: string, r: string): string {
    const plain = `(${l} ${BINARY_VB[op]} ${r})`;
    if (this.inCode || !['+', '-', '*', '/', '&'].includes(op)) return plain;
    // A side already guarded joins on under one guard (a + b + c tests its fields once).
    const unwrap = (side: string) => this.guarded.get(side) ?? { body: side, fields: [] as string[] };
    const left = unwrap(l);
    const right = unwrap(r);
    const joined = `(${left.body} ${BINARY_VB[op]} ${right.body})`;
    // (Not a field read by an aggregate, or tested for nulls in the formula.)
    if (/\b(Sum|Count|CountDistinct|Avg|Min|Max|First|Last|RunningValue|Previous|IsNothing)\(/.test(joined)) return plain;
    const fields = [...new Set([...left.fields, ...right.fields, ...(joined.match(/Fields!\w+\.Value/g) ?? [])])];
    if (!fields.length) return plain;
    const guard = `IIf(${fields.map((f) => `IsNothing(${f})`).join(' OrElse ')}, Nothing, ${joined})`;
    this.guarded.set(guard, { body: joined, fields });
    return guard;
  }

  /** Joins nullWhereNull guarded: what each joins, and the fields it tests. */
  private readonly guarded = new Map<string, { body: string; fields: string[] }>();

  private emitCall(name: string, args: Node[]): string {
    const key = name.toLowerCase();
    const a = () => args.map((x) => this.emit(x));

    if (key === '$inrange') {
      const special = this.parameterComparison('=', args[0], args[1]);
      if (special) return special;
      const range = this.rangeOf(args[1]);
      if (range) {
        const value = this.emit(args[0]);
        return `(${value} >= ${range.start} AndAlso ${value} <= ${range.end})`;
      }
      const named = args[1].t === 'name' ? NAMED_DATE_RANGES[args[1].name.toLowerCase()] : undefined;
      if (named) {
        const value = this.emit(args[0]);
        return `(${value} >= ${named.vb[0]} AndAlso ${value} < DateAdd("d", 1, ${named.vb[1]}))`;
      }
      if (this.isArrayNode(args[1])) {
        // Membership in a (1-based) array; slot 0 is unused.
        const [value, target] = a();
        return `(Array.IndexOf(${target}, ${value}) > 0)`;
      }
      if (args[1].t === 'literal' || this.isStringNode(args[1])) {
        // "x in <string>" tests for a substring.
        const [value, target] = a();
        return `(InStr(CStr(${target}), CStr(${value})) > 0)`;
      }
      this.note('tests a value against a range parameter or named date range; check the translated comparison');
      const [value, target] = a();
      return `(${value} = ${target})`;
    }
    if ((key === 'minimum' || key === 'maximum') && args.length === 1) {
      const range = this.rangeOf(args[0]);
      if (range) return key === 'minimum' ? range.start : range.end;
    }
    if (AGGREGATES[key] && args.length === 1 && (this.isMultiParameter(args[0]) || this.isArrayNode(args[0]))) {
      // Crystal array functions: Sum([...]), Count({?Multi}), ... over the array's elements.
      const multi = this.isMultiParameter(args[0]);
      if (multi && key === 'count') return `Parameters!${this.ctx.parameter((args[0] as { ref: string }).ref.slice(1))}.Count`;
      this.helpers.add('CrArrayAgg');
      return `${this.inCode ? '' : 'Code.'}CrArrayAgg(${this.emit(args[0])}, ${vbString(key)}, ${multi ? 0 : 1})`;
    }
    if (AGGREGATES[key]) {
      const [target, group] = args;
      const inner = target ? this.emit(target) : 'Nothing';
      let scope = '';
      if (group) {
        const ref = group.t === 'field' ? group.ref : undefined;
        const name = ref ? this.ctx.groupScope?.(ref) : undefined;
        if (name) scope = `, ${vbString(name)}`;
        else if (name !== '') this.note(`aggregates over a group that could not be matched (${ref ?? 'expression'}); check the scope`);
        if (args.length > 2) this.note('uses a date-grouping condition in a summary; check the grouping');
      }
      return `${AGGREGATES[key]}(${inner}${scope})`;
    }
    switch (key) {
      case 'isnull':
        return `IsNothing(${a()[0]})`;
      case 'totext':
      case 'cstr': {
        const [value, second, third] = a();
        if (second === undefined) {
          // Crystal shows numbers with two decimals and thousands separators.
          if (this.isNumberNode(args[0])) return `FormatNumber(${value}, 2)`;
          if (this.isTextNode(args[0])) return `CStr(${value})`;
          // The type is not known here: decided when the report runs.
          this.helpers.add('CrToText');
          return `${this.inCode ? "" : "Code."}CrToText(${value})`;
        }
        if (/^-?\d+$/.test(second)) {
          if (third === undefined) return `FormatNumber(${value}, ${second})`;
          if (third === '""') return `FormatNumber(${value}, ${second}, , , TriState.False)`;
          if (third !== '","') this.note(`formats a number with the thousands separator ${third}; SSRS uses the report's language`);
          if (args.length > 3) this.note('sets a decimal separator in ToText; SSRS uses the report\'s language');
          return `FormatNumber(${value}, ${second})`;
        }
        return `Format(${value}, ${second})`;
      }
      case 'rgb':
      case 'color': {
        const [r, g, b] = a();
        return `String.Format("#{0:X2}{1:X2}{2:X2}", CInt(${r}), CInt(${g}), CInt(${b}))`;
      }
      case 'propercase':
        return `StrConv(${a()[0]}, VbStrConv.ProperCase)`;
      case 'replicatestring': {
        const [text, count] = a();
        return `StrDup(${count}, ${text})`;
      }
      case 'remainder': {
        const [x, y] = a();
        return `(${x} Mod ${y})`;
      }
      case 'date':
      case 'cdate':
      case 'datevalue':
      case 'datetime':
      case 'datetimevalue':
      case 'cdatetime':
      case 'dtstodate': {
        // Crystal builds a date (or date-time) from year, month, day [, hour, minute, second], from a date and a
        // time, from a number of days, or from text or a date.
        const v = a();
        if (v.length >= 6) return `DateSerial(${v.slice(0, 3).join(', ')}).Add(TimeSerial(${v.slice(3, 6).join(', ')}).TimeOfDay)`;
        if (v.length >= 3) return `DateSerial(${v.slice(0, 3).join(', ')})`;
        if (v.length === 2) {
          // Time(x) of one value is already a time of day (a TimeSpan, which CDate does not take).
          const time = args[1].t === 'call' && ['time', 'ctime', 'timevalue'].includes(args[1].name.toLowerCase()) && args[1].args.length < 3;
          return `CDate(${v[0]}).Date.Add(${time ? v[1] : `CDate(${v[1]}).TimeOfDay`})`;
        }
        // A number is a count of days (VB will not turn a number into a date).
        if (args[0] && this.isNumericValue(args[0])) return `DateTime.FromOADate(CDbl(${v[0]}))`;
        return key === 'datevalue' ? `CDate(${v[0]}).Date` : `CDate(${v[0]})`;
      }
      case 'time':
      case 'ctime':
      case 'timevalue': {
        const v = a();
        if (v.length >= 3) return `TimeSerial(${v.slice(0, 3).join(', ')})`;
        if (args[0] && this.isNumericValue(args[0])) return `DateTime.FromOADate(CDbl(${v[0]})).TimeOfDay`;
        return `CDate(${v[0]}).TimeOfDay`;
      }
      case 'roundup': {
        const [x, n] = a();
        return n === undefined ? `Math.Ceiling(${x})` : `(Math.Ceiling(${x} * 10 ^ ${n}) / 10 ^ ${n})`;
      }
      case 'urldecode':
        return `System.Uri.UnescapeDataString(CStr(${a()[0]}).Replace("+", " "))`;
      case 'urlencode':
        return `System.Uri.EscapeDataString(CStr(${a()[0]}))`;
      case 'truncate': {
        const [x, n] = a();
        return n === undefined ? `Fix(${x})` : `(Fix(${x} * 10 ^ ${n}) / 10 ^ ${n})`;
      }
      case 'round': {
        // Crystal rounds halves away from zero (Math.Round would round them to even).
        const [x, n] = a();
        if (n === undefined) return `Math.Round(${x}, MidpointRounding.AwayFromZero)`;
        const places = args[1].t === 'unary' && args[1].op === '-' ? this.emit(args[1].arg) : /^\(?-(\d+)\)?$/.exec(n)?.[1];
        if (places !== undefined) return `(Math.Round(${x} / 10 ^ ${places}, MidpointRounding.AwayFromZero) * 10 ^ ${places})`;
        return `Math.Round(${x}, ${n}, MidpointRounding.AwayFromZero)`;
      }
      case 'join':
        if (args[0] && this.isMultiParameter(args[0])) {
          // Parameter values are a 0-based array.
          const [items, separator] = a();
          return `Join(${items}, ${separator ?? '" "'})`;
        }
      // falls through
      case 'split': {
        const helper = key === 'split' ? 'CrSplit' : 'CrJoin';
        this.helpers.add(helper);
        const [first, second] = a();
        return `${this.inCode ? '' : 'Code.'}${helper}(${first}, ${second ?? '" "'})`;
      }
      case 'ubound':
        if (args[0] && this.isMultiParameter(args[0])) return `Parameters!${this.ctx.parameter((args[0] as { ref: string }).ref.slice(1))}.Count`;
        return `UBound(${a()[0]})`;
      case 'previous':
        return `Previous(${a()[0]})`;
      case 'previousisnull':
        return `IsNothing(Previous(${a()[0]}))`;
      case 'next':
      case 'nextvalue':
      case 'nextisnull': {
        const ref = args[0]?.t === 'field' ? args[0].ref : undefined;
        const next = ref ? this.ctx.nextValue?.(ref) : undefined;
        if (!next) {
          this.note(`uses ${name}() on something other than a database field; SSRS has no Next(), so it needs manual conversion`);
          return 'Nothing';
        }
        return key === 'nextisnull' ? `IsNothing(${next})` : next;
      }
      case 'previousvalue':
        return `Previous(${a()[0]})`;
      case 'hasvalue':
        return `(Not IsNothing(${a()[0]}))`;
      case 'istime':
      case 'isdatetime':
        return `IsDate(${a()[0]})`;
      case 'dtstotimestring':
        return `Format(CDate(${a()[0]}), "HH:mm:ss")`;
      case 'dtstoseconds':
        return `CDate(${a()[0]}).TimeOfDay.TotalSeconds`;
      case 'shiftdatetime':
        this.note('uses ShiftDateTime; SSRS shows the date-time as stored (no time zone shift)');
        return a()[0] ?? 'Nothing';
      case 'makearray':
        // A Crystal array (1-based; slot 0 unused).
        return `New Object() {Nothing${a().map((v) => `, ${v}`).join('')}}`;
      case 'ceiling':
      case 'floor': {
        const [x, m] = a();
        const fn = key === 'ceiling' ? 'Math.Ceiling' : 'Math.Floor';
        return m === undefined ? `${fn}(${x})` : `(${fn}(${x} / ${m}) * ${m})`;
      }
      case 'mround': {
        const [x, m] = a();
        return `(Math.Round(${x} / ${m}, MidpointRounding.AwayFromZero) * ${m})`;
      }
      case 'even':
      case 'odd':
      case 'towords':
      case 'picture':
      case 'roman':
      case 'extractstring': {
        const helper = { even: 'CrEven', odd: 'CrOdd', towords: 'CrToWords', picture: 'CrPicture', roman: 'CrRoman', extractstring: 'CrExtractString' }[key]!;
        this.helpers.add(helper);
        return `${this.inCode ? '' : 'Code.'}${helper}(${a().join(', ')})`;
      }
      case 'pi':
        return 'Math.PI';
      case 'rnd':
        return 'Rnd()';
      case 'timer':
        return 'Timer';
      case 'onfirstrecord':
        return '(RowNumber(Nothing) = 1)';
      case 'onlastrecord':
        return '(RowNumber(Nothing) = CountRows("DataSet1"))';
      case 'groupname':
        return args[0] ? this.emit(args[0]) : 'Nothing';
      case 'drilldowngrouplevel':
        this.note('uses DrillDownGroupLevel, which has no SSRS equivalent; 0 was used');
        return '0';
      case 'inrepeatedgroupheader':
        this.note('uses InRepeatedGroupHeader; SSRS repeats header rows itself, False was used');
        return 'False';
    }
    if (key === 'instr' || key === 'instrrev') return this.instr(key, args);
    const vb = SAME_ARGS[key];
    if (vb) return `${vb}(${a().join(', ')})`;
    const custom = this.ctx.customFunction?.(name);
    if (custom) return `${this.inCode ? '' : 'Code.'}${custom}(${a().join(', ')})`;
    // Left as it is, the function would not compile in SSRS (the report would not upload): nothing is shown
    // in its place until it is converted by hand.
    this.note(`uses function ${name}() which has no SSRS equivalent; Nothing was used, convert it manually`);
    return 'Nothing';
  }
}

/** Emits a program as the body of a VB function. */
class CodeWriter {
  private readonly lines: string[] = [];
  /** Declarations, hoisted to the top: Crystal variables are visible in the whole formula. */
  private readonly declarations: string[] = [];
  private readonly emitter: Emitter;

  constructor(emitter: Emitter) {
    this.emitter = emitter;
  }

  private declareVariable(name: string, vtype: string, array: boolean, scope: string, range = false): VariableInfo {
    const key = name.toLowerCase();
    const existing = this.emitter.variables.get(key);
    if (existing) return existing;
    const prefix = scope === 'global' && this.emitter.ctx.memberPrefix ? this.emitter.ctx.memberPrefix.replace(/\W/g, '_') : '';
    const vb = `v_${prefix}${name.replace(/\W/g, '_')}`;
    const info = { vb, vtype, array: array || range, range };
    this.emitter.variables.set(key, info);
    // Arrays are Object(): Split(), array literals and parameters all produce Object() values.
    array = array || range;
    const type = array ? 'Object' : VB_TYPES[vtype] ?? 'Object';
    if (scope === 'local') this.declarations.push(`    Dim ${vb}${array ? '()' : ''} As ${type}${array ? '' : type === 'String' ? ' = ""' : ''}`);
    else this.emitter.members[vb] = array ? `${type}()` : type;
    return info;
  }

  write(program: Program, name: string): string {
    const defaults: string[] = [];
    const params = (program.params ?? []).map((p) => {
      const info = { vb: `p_${p.name.replace(/\W/g, '_')}`, vtype: p.vtype, array: p.array, range: p.range };
      this.emitter.variables.set(p.name.toLowerCase(), info);
      // A Crystal range is passed as a two-element array: (0) start, (1) end.
      const type = p.range || p.array ? 'Object()' : VB_TYPES[p.vtype] ?? 'Object';
      if (!p.optional) return `ByVal ${info.vb} As ${type}`;
      const { declaration, init } = optionalParameter(info.vb, type, this.emitter.emit(p.optional));
      if (init) defaults.push(`    ${init}`);
      return declaration;
    });
    this.lines.push(...defaults);
    this.statements(program.body, '    ', true);
    return [`Public Function ${name}(${params.join(', ')}) As Object`, ...this.declarations, ...this.lines, '    Return Nothing', 'End Function'].join('\n');
  }

  private statements(stmts: Stmt[], indent: string, last: boolean): void {
    const effective = stmts.filter((s) => s.s !== 'timing');
    for (const stmt of stmts) {
      const isLast = last && stmt === effective[effective.length - 1];
      this.statement(stmt, indent, isLast);
    }
  }

  private statement(stmt: Stmt, indent: string, last: boolean): void {
    const e = (node: Node) => this.emitter.emit(node);
    switch (stmt.s) {
      case 'timing':
        this.emitter.issues.push(`uses ${stmt.word}; custom code runs as SSRS renders the report, check totals across pages`);
        return;
      case 'select': {
        this.lines.push(`${indent}Select Case ${e(stmt.value)}`);
        for (const c of stmt.cases) {
          const items = c.match.map((m) => (m.t === 'range' ? `${e(m.from)} To ${e(m.to)}` : m.t === 'binary' && m.op === '=' ? e(m.right) : e(m)));
          this.lines.push(`${indent}    Case ${items.join(', ')}`);
          this.statements(c.body, `${indent}        `, last);
        }
        if (stmt.otherwise) {
          this.lines.push(`${indent}    Case Else`);
          this.statements(stmt.otherwise, `${indent}        `, last);
        }
        this.lines.push(`${indent}End Select`);
        return;
      }
      case 'redim': {
        const info = this.emitter.variables.get(stmt.name.toLowerCase()) ?? this.declareVariable(stmt.name, 'numbervar', true, 'local');
        this.lines.push(`${indent}ReDim ${stmt.preserve ? 'Preserve ' : ''}${info.vb}(${e(stmt.size)})`);
        return;
      }
      case 'decl': {
        const info = this.declareVariable(stmt.name, stmt.vtype, stmt.array, stmt.scope, stmt.range);
        if (stmt.array && stmt.init?.t === 'array') {
          this.lines.push(`${indent}${info.vb} = New Object() {Nothing${stmt.init.items.map((x) => `, ${e(x)}`).join('')}}`);
        } else if (stmt.init) {
          this.lines.push(`${indent}${info.vb} = ${e(stmt.init)}`);
        }
        if (last && stmt.init) this.lines.push(`${indent}Return ${info.vb}`);
        return;
      }
      case 'assign': {
        const info = this.emitter.variables.get(stmt.name.toLowerCase()) ?? this.declareVariable(stmt.name, 'numbervar', false, 'global');
        const target = stmt.index ? `${info.vb}(${e(stmt.index)})` : info.vb;
        this.lines.push(`${indent}${target} = ${e(stmt.value)}`);
        if (last) this.lines.push(`${indent}Return ${info.vb}`);
        return;
      }
      case 'expr':
        if (last) this.lines.push(`${indent}Return ${e(stmt.expr)}`);
        return;
      case 'if':
        this.lines.push(`${indent}If ${e(stmt.cond)} Then`);
        this.statements(stmt.then, `${indent}    `, last);
        if (stmt.else) {
          this.lines.push(`${indent}Else`);
          this.statements(stmt.else, `${indent}    `, last);
        }
        this.lines.push(`${indent}End If`);
        return;
      case 'for': {
        const info = this.emitter.variables.get(stmt.name.toLowerCase()) ?? this.declareVariable(stmt.name, 'numbervar', false, 'local');
        this.lines.push(`${indent}For ${info.vb} = ${e(stmt.from)} To ${e(stmt.to)}${stmt.step ? ` Step ${e(stmt.step)}` : ''}`);
        this.statements(stmt.body, `${indent}    `, false);
        this.lines.push(`${indent}Next`);
        return;
      }
      case 'while':
        this.lines.push(stmt.post ? `${indent}Do` : `${indent}Do While ${e(stmt.cond)}`);
        this.statements(stmt.body, `${indent}    `, false);
        this.lines.push(stmt.post ? `${indent}Loop While ${e(stmt.cond)}` : `${indent}Loop`);
        return;
      case 'exit':
        this.lines.push(`${indent}Exit ${stmt.what === 'for' ? 'For' : 'Do'}`);
        return;
    }
  }
}

/** Whether a formula needs statements (variables, loops, several statements, custom function). */
function needsCode(tokens: Token[]): boolean {
  let depth = 0;
  let statements = 0;
  let sawContent = false;
  for (const t of tokens) {
    if (t.kind === 'op' && t.value === ':=') return true;
    if (t.kind === 'ident' && ['for', 'while', 'do', 'function', 'local', 'global', 'shared', 'redim', ...VARIABLE_TYPES].includes(KEYWORD(t.value))) return true;
    if (t.kind === 'op' && (t.value === '(' || t.value === '[')) depth++;
    if (t.kind === 'op' && (t.value === ')' || t.value === ']')) depth--;
    if (t.kind === 'op' && t.value === ';' && depth === 0) {
      if (sawContent) statements++;
      sawContent = false;
    } else if (t.kind !== 'eof' && !(t.kind === 'ident' && TIMING_WORDS.includes(KEYWORD(t.value)))) {
      sawContent = true;
    }
  }
  if (sawContent) statements++;
  return statements > 1;
}

/** Aggregate / report references that custom code cannot evaluate itself: they become arguments. */
// __CrShared_x__ is a shared variable's value, filled in later with a dataset aggregate: an argument too.
const ARGUMENT_REFERENCE = /\b(Sum|Count|Avg|Max|Min|CountDistinct|StDev|StDevP|Var|VarP|First|Last|Previous|RowNumber|RunningValue)\(|Fields!\w+\.Value|Parameters!\w+\.Value|Globals!\w+|Me\.Value|__CrShared_[a-z0-9_]+?__/g;

/** Replaces field/parameter/aggregate references in VB code with parameters; returns the argument list. */
export function extractArguments(code: string): { code: string; args: string[] } {
  const args: string[] = [];
  let out = '';
  let pos = 0;
  // Spans of VB string literals ("..." with "" as an escaped quote): references inside them are text.
  const strings: [number, number][] = [];
  for (const lit of code.matchAll(/"(?:[^"]|"")*"/g)) strings.push([lit.index!, lit.index! + lit[0].length]);
  const inString = (at: number) => strings.some(([from, to]) => at > from && at < to);
  ARGUMENT_REFERENCE.lastIndex = 0;
  for (let m = ARGUMENT_REFERENCE.exec(code); m; m = ARGUMENT_REFERENCE.exec(code)) {
    if (inString(m.index)) continue;
    let end = m.index + m[0].length;
    if (m[0].endsWith('(')) {
      // Aggregate call: take through the matching parenthesis.
      let depth = 1;
      while (end < code.length && depth > 0) {
        if (code[end] === '(') depth++;
        else if (code[end] === ')') depth--;
        else if (code[end] === '"') end = code.indexOf('"', end + 1);
        end++;
      }
    }
    const text = code.slice(m.index, end);
    let index = args.indexOf(text);
    if (index < 0) {
      args.push(text);
      index = args.length - 1;
    }
    out += code.slice(pos, m.index) + `a${index + 1}`;
    pos = end;
    ARGUMENT_REFERENCE.lastIndex = end;
  }
  return { code: out + code.slice(pos), args };
}

export interface TranslateOptions {
  /** Name for the VB function when the formula needs custom code (statements, variables, loops). */
  codeName?: string;
  /** The formula returns a colour (Font_Color, Back_Color, ...): convert Crystal colour numbers. */
  colors?: boolean;
  /** The formula returns True/False (suppress conditions): an "if" without "else" gives False, as in Crystal. */
  boolean?: boolean;
}

export function translateFormula(source: string, ctx: FormulaContext, options: TranslateOptions = {}): Translation {
  const translation = translateFormulaIn(source, ctx, options);
  // OnLastRecord counts the rows of the formula's own dataset.
  const dataset = ctx.dataset?.();
  if (!dataset || dataset === 'DataSet1') return translation;
  const own = (text: string) => text.split('CountRows("DataSet1")').join(`CountRows(${JSON.stringify(dataset)})`);
  return { ...translation, expression: own(translation.expression), ...(translation.code ? { code: own(translation.code) } : {}) };
}

function translateFormulaIn(source: string, ctx: FormulaContext, options: TranslateOptions = {}): Translation {
  const issues: string[] = [];
  if (isBasicSyntax(source)) {
    if (options.codeName) return translateBasic(source, ctx, options.codeName);
    issues.push('is written in Crystal Basic syntax, which needs custom code here; needs manual conversion');
    return { expression: '=Nothing', issues };
  }
  if (options.codeName) {
    try {
      const tokens = tokenize(source);
      if (needsCode(tokens)) return translateToCode(tokens, ctx, options.codeName);
    } catch {
      // fall through to the expression translation, which reports the problem
    }
  }
  try {
    const parser = new Parser(tokenize(source));
    const tree = parser.parseFormula();
    issues.push(...parser.issues);
    const emitter = new Emitter(ctx, issues);
    emitter.booleanResult = options.boolean ?? false;
    const expression = `=${emitter.result(tree, options.colors ?? false)}`;
    return { expression, issues, helpers: [...emitter.helpers] };
  } catch (err) {
    issues.push(`could not be parsed (${(err as Error).message}); needs manual conversion`);
    return { expression: '=Nothing', issues };
  }
}

// ---- selection formula -> SQL WHERE ---------------------------------------------------------

export interface SqlContext {
  /** Quoted column ("[Alias].[Column]") for a database field, or undefined. */
  column(table: string, field: string): string | undefined;
  /** SQL parameter name ("@Name") for a Crystal parameter. */
  parameter(name: string): string;
  /** For a range parameter: the SQL parameters holding its start and end. */
  parameterRange?(name: string): { start: string; end: string } | undefined;
  /** Whether a parameter takes several values (SSRS expands it only inside IN (...)). */
  parameterMultiple?(name: string): boolean;
  /** Value type of a database field or parameter ("date", "dateTime", "string", ...), if known. */
  columnType?(table: string, field: string): string | undefined;
  parameterType?(name: string): string | undefined;
}

/** The text of a VB string literal expression ("a" & vbCrLf & "b"), or undefined if it is something else. */
function vbLiteralText(vb: string): string | undefined {
  const piece = /"(?:[^"]|"")*"|vbCrLf/y;
  let out = '';
  let pos = 0;
  for (;;) {
    piece.lastIndex = pos;
    const m = piece.exec(vb);
    if (!m) return undefined;
    out += m[0] === 'vbCrLf' ? '\r\n' : m[0].slice(1, -1).replace(/""/g, '"');
    pos = piece.lastIndex;
    if (pos === vb.length) return out;
    if (!vb.startsWith(' & ', pos)) return undefined;
    pos += 3;
  }
}

/** A Crystal LIKE pattern (* and ?) as a T-SQL LIKE pattern, with SQL's own wildcards taken literally. */
function sqlLikePattern(pattern: string): string {
  return pattern.replace(/[[%_]/g, (c) => `[${c}]`).replace(/\*/g, '%').replace(/\?/g, '_');
}

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Translates a record selection formula into a T-SQL condition. Returns undefined when the
 * formula uses anything without an exact SQL equivalent (then an SSRS filter is used instead).
 */
export function translateToSql(source: string, ctx: SqlContext): string | undefined {
  let tree: Node;
  try {
    const tokens = tokenize(source);
    if (needsCode(tokens)) return undefined;
    const parser = new Parser(tokens);
    tree = parser.parseFormula();
    if (parser.issues.length > 0) return undefined;
  } catch {
    return undefined;
  }
  const fail = (): never => {
    throw new Error('unsupported');
  };
  const DATE_TYPES = ['date', 'dateTime'];
  const isMulti = (node: Node) => node.t === 'field' && node.ref.startsWith('?') && ctx.parameterMultiple?.(node.ref.slice(1)) === true;
  /** Whether an expression is a date (Crystal adds days to dates with + and -). */
  const isDate = (node: Node): boolean => {
    switch (node.t) {
      case 'literal':
        return node.vb.startsWith('CDate(');
      case 'name':
        return ['currentdate', 'today', 'currentdatetime'].includes(node.name.toLowerCase());
      case 'field': {
        if (node.ref.startsWith('?')) return DATE_TYPES.includes(ctx.parameterType?.(node.ref.slice(1)) ?? '');
        const dot = node.ref.lastIndexOf('.');
        return dot > 0 && DATE_TYPES.includes(ctx.columnType?.(node.ref.slice(0, dot), node.ref.slice(dot + 1)) ?? '');
      }
      case 'call':
        return ['date', 'cdate', 'datetime', 'cdatetime', 'datetimevalue'].includes(node.name.toLowerCase());
      case 'binary':
        return (node.op === '+' || node.op === '-') && isDate(node.left) !== isDate(node.right);
      default:
        return false;
    }
  };
  const value = (node: Node): string => {
    switch (node.t) {
      case 'literal': {
        if (/^-?[\d.]+$/.test(node.vb)) return node.vb;
        const text = vbLiteralText(node.vb);
        if (text !== undefined) return sqlString(text);
        const date = /^CDate\("(.*)"\)$/.exec(node.vb);
        if (date) return sqlString(date[1]);
        return fail();
      }
      case 'field': {
        if (node.ref.startsWith('?')) return ctx.parameter(node.ref.slice(1));
        const dot = node.ref.lastIndexOf('.');
        const column = dot > 0 ? ctx.column(node.ref.slice(0, dot), node.ref.slice(dot + 1)) : undefined;
        return column ?? fail();
      }
      case 'name': {
        const key = node.name.toLowerCase();
        if (key === 'currentdate' || key === 'today') return 'CAST(GETDATE() AS date)';
        if (key === 'currentdatetime') return 'GETDATE()';
        return fail();
      }
      case 'unary':
        return node.op === '-' ? `-(${value(node.arg)})` : fail();
      case 'binary': {
        const leftDate = isDate(node.left);
        const rightDate = isDate(node.right);
        if (node.op === '-' && leftDate && rightDate) return `DATEDIFF(day, ${value(node.right)}, ${value(node.left)})`;
        if ((node.op === '+' || node.op === '-') && leftDate !== rightDate) {
          // A date plus or minus a number of days.
          if (rightDate && node.op === '-') return fail();
          const [date, days] = leftDate ? [node.left, node.right] : [node.right, node.left];
          return `DATEADD(day, ${node.op === '-' ? '-' : ''}(${value(days)}), ${value(date)})`;
        }
        // Crystal divides as decimals; T-SQL would divide two integers as integers.
        if (node.op === '/') return `(${value(node.left)} * 1.0 / ${value(node.right)})`;
        const ops: Record<string, string> = { '+': '+', '-': '-', '*': '*' };
        return ops[node.op] ? `(${value(node.left)} ${ops[node.op]} ${value(node.right)})` : fail();
      }
      case 'call': {
        const key = node.name.toLowerCase();
        const args = node.args.map(value);
        if ((key === 'date' || key === 'cdate') && args.length === 3) return `DATEFROMPARTS(${args.join(', ')})`;
        if (key === 'datetime' && args.length === 6) return `DATETIMEFROMPARTS(${args.join(', ')}, 0)`;
        if ((key === 'uppercase' || key === 'ucase') && args.length === 1) return `UPPER(${args[0]})`;
        if ((key === 'lowercase' || key === 'lcase') && args.length === 1) return `LOWER(${args[0]})`;
        if (key === 'trim' && args.length === 1) return `LTRIM(RTRIM(${args[0]}))`;
        if (key === 'year' || key === 'month' || key === 'day') return `${key.toUpperCase()}(${args[0]})`;
        return fail();
      }
      default:
        return fail();
    }
  };
  const condition = (node: Node): string => {
    switch (node.t) {
      case 'binary': {
        if (node.op === 'and' || node.op === 'or') return `(${condition(node.left)} ${node.op.toUpperCase()} ${condition(node.right)})`;
        if (node.op === '=' || node.op === '<>') {
          const param = node.right.t === 'field' && node.right.ref.startsWith('?') ? node.right.ref.slice(1) : undefined;
          const range = param !== undefined ? ctx.parameterRange?.(param) : undefined;
          if (range) return `${value(node.left)} ${node.op === '=' ? '' : 'NOT '}BETWEEN ${range.start} AND ${range.end}`;
          // SSRS expands a multi-value parameter into a list only inside IN (...).
          const [one, many] = isMulti(node.right) ? [node.left, node.right] : isMulti(node.left) ? [node.right, node.left] : [];
          if (one && many) return `${value(one)} ${node.op === '=' ? 'IN' : 'NOT IN'} (${value(many)})`;
        }
        if (isMulti(node.left) || isMulti(node.right)) return fail();
        if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) return `${value(node.left)} ${node.op} ${value(node.right)}`;
        if (node.op === 'startswith') {
          const text = node.right.t === 'literal' ? vbLiteralText(node.right.vb) : undefined;
          if (text !== undefined) return `${value(node.left)} LIKE ${sqlString(`${text.replace(/[[%_]/g, (c) => `[${c}]`)}%`)}`;
          // A parameter or field: escape SQL's wildcards in its value.
          const prefix = value(node.right);
          return `${value(node.left)} LIKE REPLACE(REPLACE(REPLACE(${prefix}, '[', '[[]'), '%', '[%]'), '_', '[_]') + '%'`;
        }
        if (node.op === 'like' && node.right.t === 'literal') {
          const pattern = vbLiteralText(node.right.vb) ?? fail();
          return `${value(node.left)} LIKE ${sqlString(sqlLikePattern(pattern))}`;
        }
        return fail();
      }
      case 'unary':
        return node.op === 'not' ? `NOT (${condition(node.arg)})` : fail();
      case 'in':
        if (node.list.length === 0) return node.negate ? '1 = 1' : '1 = 0';
        return `${value(node.value)} ${node.negate ? 'NOT IN' : 'IN'} (${node.list.map(value).join(', ')})`;
      case 'range':
        return `${value(node.value)} ${node.negate ? 'NOT BETWEEN' : 'BETWEEN'} ${value(node.from)} AND ${value(node.to)}`;
      case 'call':
        if (node.name.toLowerCase() === 'isnull' && node.args.length === 1) return `${value(node.args[0])} IS NULL`;
        if (node.name === '$inRange' && node.args[1].t === 'field' && node.args[1].ref.startsWith('?')) {
          const range = ctx.parameterRange?.(node.args[1].ref.slice(1));
          if (range) return `${value(node.args[0])} BETWEEN ${range.start} AND ${range.end}`;
          if (isMulti(node.args[1])) return `${value(node.args[0])} IN (${value(node.args[1])})`;
        }
        if (node.name === '$inRange' && node.args[1].t === 'name') {
          const named = NAMED_DATE_RANGES[node.args[1].name.toLowerCase()];
          if (named) {
            const v = value(node.args[0]);
            return `(${v} >= ${named.sql[0]} AND ${v} < DATEADD(day, 1, ${named.sql[1]}))`;
          }
        }
        return fail();
      case 'literal':
        if (node.vb === 'True') return '1 = 1';
        if (node.vb === 'False') return '1 = 0';
        return fail();
      default:
        return fail();
    }
  };
  try {
    return condition(tree);
  } catch {
    return undefined;
  }
}

/** A VB constant: a number, string, date literal, True, False or Nothing. */
const VB_CONSTANT = /^(-?\d+(\.\d+)?(E[+-]?\d+)?|"(?:[^"]|"")*"|#[^#]+#|True|False|Nothing)$/i;

/**
 * An optional VB parameter. VB requires a constant default of the parameter's type; a Crystal default that is an
 * expression (Color(239, 235, 220), CurrentDate, ...) becomes Nothing, replaced by the expression at the start.
 */
export function optionalParameter(vb: string, type: string, defaultValue: string): { declaration: string; init?: string } {
  const value = defaultValue.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (VB_CONSTANT.test(value)) {
    const isString = value.startsWith('"');
    const numeric = ['Double', 'Decimal', 'Integer', 'Long'].includes(type);
    // A text default for a number parameter: the parameter takes any value.
    const finalType = (isString && numeric) || (!isString && type === 'String' && !/^Nothing$/i.test(value)) ? 'Object' : type;
    return { declaration: `Optional ByVal ${vb} As ${finalType} = ${value}` };
  }
  return {
    declaration: `Optional ByVal ${vb} As Object = Nothing`,
    init: `If ${vb} Is Nothing Then ${vb} = ${defaultValue}`,
  };
}
