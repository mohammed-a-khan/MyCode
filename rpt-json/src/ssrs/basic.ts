/**
 * Crystal Basic syntax formulas -> VB functions for the report's custom code.
 *
 * Basic syntax is already close to VB: statements, If/Select/For/Do blocks and operators carry over.
 * What changes: the result is assigned to "formula" (or the function's name), variable types have
 * Crystal names (Number, Currency, ...), fields are written {Table.Field}, arrays start at 1, and
 * Crystal functions need their SSRS equivalents. Fields, parameters and aggregates become arguments
 * of the generated function, as for Crystal syntax formulas.
 */

import { customCodeNote, Emitter, extractArguments, NAMES, vbString, type FormulaContext, type Node, type Translation } from './formula.ts';

type BasicToken =
  | { k: 'nl' }
  | { k: 'str'; v: string }
  | { k: 'num'; v: string }
  | { k: 'date'; v: string }
  | { k: 'field'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string };

const OPERATORS = ['<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '\\', '^', '&', '(', ')', ','];

const BASIC_TYPES: Record<string, string> = {
  number: 'Double', currency: 'Decimal', string: 'String', boolean: 'Boolean',
  date: 'Date', time: 'Date', datetime: 'Date',
  numberrange: 'Object', currencyrange: 'Object', daterange: 'Object', timerange: 'Object', datetimerange: 'Object', stringrange: 'Object',
};

/** VB keywords, written in their usual casing. */
const KEYWORDS: Record<string, string> = Object.fromEntries(
  ['If', 'Then', 'Else', 'ElseIf', 'End', 'For', 'To', 'Step', 'Next', 'Do', 'Loop', 'While', 'Until', 'Select', 'Case',
    'Exit', 'And', 'Or', 'Not', 'Xor', 'Mod', 'Is', 'ReDim', 'Preserve', 'Each', 'In', 'AndAlso', 'OrElse']
    .map((k) => [k.toLowerCase(), k]),
);

/** VB functions Crystal Basic shares by name; kept as they are when no other mapping applies. */
const VB_FUNCTIONS = new Set([
  'split', 'join', 'ubound', 'lbound', 'instr', 'instrrev', 'mid', 'left', 'right', 'len', 'trim', 'ltrim', 'rtrim',
  'ucase', 'lcase', 'replace', 'cstr', 'cdbl', 'cint', 'clng', 'cdate', 'cbool', 'cdec', 'int', 'fix', 'abs', 'sqr',
  'round', 'iif', 'chr', 'chrw', 'asc', 'ascw', 'space', 'strreverse', 'isnumeric', 'isdate', 'year', 'month', 'day',
  'hour', 'minute', 'second', 'weekday', 'dateadd', 'datediff', 'datepart', 'dateserial', 'timeserial', 'format',
  'val', 'sgn', 'exp', 'log', 'sin', 'cos', 'tan', 'atn', 'monthname', 'weekdayname', 'strcomp', 'strconv', 'string',
]);

/** Whether a formula is written in Crystal Basic syntax rather than Crystal syntax. */
export function isBasicSyntax(source: string): boolean {
  const code = source.replace(/^\s*(?:'|rem\b).*$/gim, '');
  return /^\s*formula\s*=/im.test(code)
    || /\b(?:then|else)\s+formula\s*=/i.test(code)
    || /^\s*(?:dim|global|shared|local)\s+\w+\s*(?:\(\s*\))?\s+as\s+\w+/im.test(code)
    || /^\s*function\s+\w+\s*\(/im.test(code)
    || /^\s*end\s+(?:if|select|function)\b/im.test(code);
}

function tokenizeBasic(source: string): BasicToken[] {
  const tokens: BasicToken[] = [];
  const atStatementStart = () => tokens.length === 0 || tokens[tokens.length - 1].k === 'nl';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\n' || c === ':') {
      if (!atStatementStart()) tokens.push({ k: 'nl' });
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '_' && /^_[ \t]*\r?\n/.test(source.slice(i))) {
      // Line continuation.
      i = source.indexOf('\n', i) + 1;
    } else if (c === "'" || (/^rem\b/i.test(source.slice(i)) && atStatementStart())) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '"') {
      let value = '';
      i++;
      while (i < source.length) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          break;
        }
        value += source[i++];
      }
      i++;
      tokens.push({ k: 'str', v: value });
    } else if (c === '#') {
      const end = source.indexOf('#', i + 1);
      if (end < 0) throw new Error('unterminated date literal');
      tokens.push({ k: 'date', v: source.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '{') {
      const end = source.indexOf('}', i);
      if (end < 0) throw new Error('unterminated field reference');
      tokens.push({ k: 'field', v: source.slice(i + 1, end) });
      i = end + 1;
    } else if (/[0-9.]/.test(c) && /^\.?\d/.test(source.slice(i))) {
      const m = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(source.slice(i))!;
      tokens.push({ k: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))!;
      tokens.push({ k: 'id', v: m[0] });
      i += m[0].length;
    } else {
      const op = OPERATORS.find((o) => source.startsWith(o, i));
      if (!op) throw new Error(`unexpected "${c}"`);
      tokens.push({ k: 'op', v: op });
      i += op.length;
    }
  }
  if (!atStatementStart()) tokens.push({ k: 'nl' });
  return tokens;
}

const isOp = (t: BasicToken | undefined, v: string) => t?.k === 'op' && t.v === v;
const isId = (t: BasicToken | undefined, ...names: string[]) => t?.k === 'id' && names.includes(t.v.toLowerCase());

interface Variable {
  vb: string;
  array: boolean;
}

class BasicTranslator {
  private readonly emitter: Emitter;
  private readonly variables = new Map<string, Variable>();
  private readonly declarations: string[] = [];
  private readonly lines: string[] = [];
  private readonly params: string[] = [];
  /** Name the result is assigned to besides "formula" (a custom function's own name). */
  private resultName = 'formula';
  private depth = 1;
  private readonly issues: string[];

  constructor(ctx: FormulaContext, issues: string[]) {
    this.issues = issues;
    this.emitter = new Emitter(ctx, issues);
    this.emitter.inCode = true;
  }

  get members(): Record<string, string> {
    return this.emitter.members;
  }

  get helpers(): Set<string> {
    return this.emitter.helpers;
  }

  private note(message: string): void {
    if (!this.issues.includes(message)) this.issues.push(message);
  }

  private variableName(name: string, prefix: string): string {
    return `${prefix}${name.replace(/\W/g, '_')}`;
  }

  /** Translates the program; returns the VB function text and whether it is a custom function. */
  translate(tokens: BasicToken[], name: string): { code: string; customFunction: boolean } {
    const statements: BasicToken[][] = [];
    let current: BasicToken[] = [];
    for (const t of tokens) {
      if (t.k === 'nl') {
        if (current.length) statements.push(current);
        current = [];
      } else {
        current.push(t);
      }
    }
    let customFunction = false;
    for (const st of statements) {
      if (isId(st[0], 'function')) {
        customFunction = true;
        this.functionHeader(st);
      } else if (isId(st[0], 'end') && isId(st[1], 'function')) {
        // closes the custom function
      } else {
        this.statement(st);
      }
    }
    const signature = this.params.join(', ');
    const code = [
      `Public Function ${name}(${signature}) As Object`,
      '    Dim result As Object = Nothing',
      ...this.declarations,
      ...this.lines,
      '    Return result',
      'End Function',
    ].join('\n');
    return { code, customFunction };
  }

  private functionHeader(st: BasicToken[]): void {
    // Function name (p1 As Type, Optional ByRef p2 As Type = value, ...) As Type
    if (st[1]?.k === 'id') this.resultName = st[1].v.toLowerCase();
    const open = st.findIndex((t) => isOp(t, '('));
    if (open < 0) return;
    let i = open + 1;
    while (i < st.length && !isOp(st[i], ')')) {
      let optional = false;
      let byRef = false;
      while (isId(st[i], 'optional', 'byval', 'byref')) {
        if (isId(st[i], 'optional')) optional = true;
        if (isId(st[i], 'byref')) byRef = true;
        i++;
      }
      const token = st[i++];
      if (token?.k !== 'id') throw new Error('expected a parameter name');
      let array = false;
      if (isOp(st[i], '(') && isOp(st[i + 1], ')')) {
        array = true;
        i += 2;
      }
      let type = 'Object';
      if (isId(st[i], 'as')) {
        type = BASIC_TYPES[(st[i + 1] as { v: string }).v.toLowerCase()] ?? 'Object';
        i += 2;
        if (isOp(st[i], '(') && isOp(st[i + 1], ')')) {
          array = true;
          i += 2;
        }
      }
      let defaultValue = '';
      if (isOp(st[i], '=')) {
        const end = this.findTopLevel(st, i + 1, [',', ')']);
        defaultValue = ` = ${this.expression(st.slice(i + 1, end))}`;
        i = end;
      }
      const vb = this.variableName(token.v, 'p_');
      this.variables.set(token.v.toLowerCase(), { vb, array });
      this.params.push(`${optional ? 'Optional ' : ''}${byRef ? 'ByRef' : 'ByVal'} ${vb}${array ? '()' : ''} As ${array ? 'Object' : type}${defaultValue}`);
      if (isOp(st[i], ',')) i++;
    }
  }

  /** Index of the first token at depth 0 that is one of the given operators (or the end). */
  private findTopLevel(st: BasicToken[], from: number, ops: string[]): number {
    let depth = 0;
    for (let i = from; i < st.length; i++) {
      const t = st[i];
      if (t.k === 'op') {
        if (depth === 0 && ops.includes(t.v)) return i;
        if (t.v === '(') depth++;
        if (t.v === ')') depth--;
      }
    }
    return st.length;
  }

  private emitLine(text: string, depthChange = 0): void {
    if (depthChange < 0) this.depth += depthChange;
    this.lines.push(`${'    '.repeat(Math.max(1, this.depth))}${text}`);
    if (depthChange > 0) this.depth += depthChange;
  }

  private statement(st: BasicToken[]): void {
    const first = st[0].k === 'id' ? st[0].v.toLowerCase() : '';
    switch (first) {
      case 'dim':
      case 'local':
      case 'global':
      case 'shared':
        this.declaration(st, first === 'global' || first === 'shared');
        return;
      case 'option':
        return;
      case 'whileprintingrecords':
      case 'whilereadingrecords':
      case 'beforereadingrecords':
        if (first === 'whileprintingrecords') this.note('uses whileprintingrecords; custom code runs as SSRS renders the report, check totals across pages');
        return;
      case 'evaluateafter':
        return;
      case 'redim': {
        const preserve = isId(st[1], 'preserve');
        const rest = st.slice(preserve ? 2 : 1);
        this.emitLine(`ReDim ${preserve ? 'Preserve ' : ''}${this.expression(rest)}`);
        return;
      }
      case 'if': {
        const multiLine = isId(st[st.length - 1], 'then');
        this.emitLine(this.expression(st), multiLine ? 1 : 0);
        return;
      }
      case 'elseif':
        this.emitLine(this.expression(st), -1);
        this.depth++;
        return;
      case 'else':
        if (st.length === 1) {
          this.emitLine('Else', -1);
          this.depth++;
        } else {
          this.emitLine(this.expression(st));
        }
        return;
      case 'end': {
        const what = st[1]?.k === 'id' ? st[1].v.toLowerCase() : '';
        this.emitLine(`End ${KEYWORDS[what] ?? what}`, what === 'select' ? -2 : -1);
        return;
      }
      case 'select':
        this.emitLine(this.expression(st), 2);
        return;
      case 'case':
        this.depth--;
        this.emitLine(this.expression(st));
        this.depth++;
        return;
      case 'for':
      case 'while':
        this.emitLine(this.expression(st), 1);
        return;
      case 'do':
        this.emitLine(this.expression(st), 1);
        return;
      case 'next':
        this.emitLine('Next', -1);
        return;
      case 'loop':
        this.emitLine(this.expression(st), -1);
        return;
      case 'wend':
        this.emitLine('End While', -1);
        return;
      case 'exit':
        // Exit Function would skip the final Return.
        this.emitLine(isId(st[1], 'function') ? 'Return result' : this.expression(st));
        return;
      default:
        this.emitLine(this.expression(st));
    }
  }

  private declaration(st: BasicToken[], shared: boolean): void {
    let i = 1;
    while (i < st.length) {
      const token = st[i++];
      if (token?.k !== 'id') throw new Error('expected a variable name');
      let array = false;
      let size: BasicToken[] | undefined;
      if (isOp(st[i], '(') && isOp(st[i + 1], ')')) {
        array = true;
        i += 2;
      } else if (isOp(st[i], '(')) {
        // Dim a(5): an array with that upper bound.
        const close = this.matchingParen(st, i);
        size = st.slice(i + 1, close);
        array = true;
        i = close + 1;
      }
      let type = 'Object';
      if (isId(st[i], 'as')) {
        const typeName = (st[i + 1] as { v: string } | undefined)?.v.toLowerCase() ?? '';
        type = BASIC_TYPES[typeName] ?? 'Object';
        i += 2;
        if (isOp(st[i], '(') && isOp(st[i + 1], ')')) {
          array = true;
          i += 2;
        }
      }
      const key = token.v.toLowerCase();
      const vb = this.variableName(token.v, 'v_');
      if (!this.variables.has(key)) {
        this.variables.set(key, { vb, array });
        const vbType = array ? 'Object()' : type;
        if (shared) this.emitter.members[vb] = vbType;
        else this.declarations.push(`    Dim ${vb}${array ? '()' : ''} As ${array ? 'Object' : type}${!array && type === 'String' ? ' = ""' : ''}`);
      }
      if (size) this.emitLine(`ReDim ${vb}(${this.expression(size)})`);
      if (isOp(st[i], '=')) {
        const end = this.findTopLevel(st, i + 1, [',']);
        this.emitLine(`${vb} = ${this.expression(st.slice(i + 1, end))}`);
        i = end;
      }
      if (isOp(st[i], ',')) i++;
    }
  }

  /** Translates a run of tokens (a statement or an expression) to VB text. */
  expression(tokens: BasicToken[]): string {
    const parts: string[] = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      let text: string;
      if (t.k === 'str') {
        text = vbString(t.v);
      } else if (t.k === 'num') {
        text = t.v;
      } else if (t.k === 'date') {
        text = `CDate("${t.v}")`;
      } else if (t.k === 'field') {
        text = this.emitter.emit({ t: 'field', ref: t.v });
      } else if (t.k === 'op') {
        text = t.v;
      } else if (t.k === 'id') {
        const key = t.v.toLowerCase();
        const variable = this.variables.get(key);
        if (isOp(tokens[i + 1], '(') && !variable) {
          const close = this.matchingParen(tokens, i + 1);
          text = this.call(t.v, tokens.slice(i + 2, close));
          i = close + 1;
          parts.push(text);
          continue;
        }
        if (key === 'formula' || key === this.resultName) text = 'result';
        else if (variable) text = variable.vb;
        else if (key === 'wend') text = 'End While';
        else if (KEYWORDS[key]) text = KEYWORDS[key];
        else if (key === 'true' || key === 'false') text = key === 'true' ? 'True' : 'False';
        else text = this.bareName(t.v);
      } else {
        text = '';
      }
      parts.push(text);
      i++;
    }
    return this.join(parts);
  }

  private matchingParen(tokens: BasicToken[], open: number): number {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
      if (isOp(tokens[i], '(')) depth++;
      if (isOp(tokens[i], ')') && --depth === 0) return i;
    }
    throw new Error('unbalanced parentheses');
  }

  /** A name that is neither a variable nor a keyword: a Crystal constant or special field. */
  private bareName(name: string): string {
    const key = name.toLowerCase();
    if (NAMES[key]) return NAMES[key];
    return this.call(name, []);
  }

  private call(name: string, argTokens: BasicToken[]): string {
    const args: BasicToken[][] = [];
    if (argTokens.length) {
      let start = 0;
      for (;;) {
        const end = this.findTopLevel(argTokens, start, [',']);
        args.push(argTokens.slice(start, end));
        if (end >= argTokens.length) break;
        start = end + 1;
      }
    }
    const key = name.toLowerCase();
    if (args.length === 0 && NAMES[key]) return NAMES[key];
    const literals: Node[] = args.map((a) => ({ t: 'literal', vb: this.expression(a) }));
    const before = this.issues.length;
    const vb = this.emitter.emit({ t: 'call', name, args: literals });
    const unmapped = this.issues.length > before && this.issues[this.issues.length - 1].includes(`function ${name}() which has no mapping`);
    if (unmapped && VB_FUNCTIONS.has(key)) {
      this.issues.pop();
      return `${name}(${literals.map((l) => (l as { vb: string }).vb).join(', ')})`;
    }
    return vb;
  }

  /** Joins translated tokens with VB spacing. */
  private join(parts: string[]): string {
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const prev = parts[i - 1];
      const noSpace = i === 0 || prev === '(' || part === ')' || part === ',' || (part === '(' && prev !== undefined && /[\w)]$/.test(prev) && !KEYWORDS[prev.toLowerCase()]);
      out += (noSpace ? '' : ' ') + part;
    }
    return out;
  }
}

/** Translates a Crystal Basic syntax formula or custom function into a VB function. */
export function translateBasic(source: string, ctx: FormulaContext, name: string): Translation {
  const issues: string[] = [];
  try {
    const translator = new BasicTranslator(ctx, issues);
    const { code, customFunction } = translator.translate(tokenizeBasic(source), name);
    const members = translator.members;
    const helpers = [...translator.helpers];
    if (customFunction) return { expression: `=Code.${name}()`, issues, code, members, helpers };
    const { code: body, args } = extractArguments(code);
    const signature = args.map((_, i) => `ByVal a${i + 1} As Object`).join(', ');
    const finalCode = body.replace(`Public Function ${name}() As Object`, `Public Function ${name}(${signature}) As Object`);
    issues.push(customCodeNote(issues, name, ' from Crystal Basic syntax'));
    return { expression: `=Code.${name}(${args.join(', ')})`, issues, code: finalCode, members, helpers };
  } catch (err) {
    issues.push(`could not be parsed as Basic syntax (${(err as Error).message}); needs manual conversion`);
    return { expression: '=Nothing', issues };
  }
}
