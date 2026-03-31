export class TemplateError extends Error {
  offset: number;
  line: number;
  column: number;

  constructor(message: string, location: { line: number; column: number; offset: number }) {
    super(message);
    this.offset = location.offset;
    this.line = location.line;
    this.column = location.column;
  }
}

export type DataModelKind = {
  [key: string]: 'boolean' | 'string' | DataModelKind;
};

export type Expr = string | [string, string] | { literal: string } | { literal: boolean };

export type ConditionExpr = {
  expr: Expr;
  negated: boolean;
};

export type ConditionBranch = {
  condition: ConditionExpr | null; // null = else
  body: TemplateNode[];
  offset: number;
};

export type TemplateNode =
  | { type: 'text'; value: string }
  | { type: 'interpolation'; expr: Expr; offset: number }
  | { type: 'condition'; branches: ConditionBranch[]; offset: number }
  | { type: 'loop'; item: string; collection: Expr; body: TemplateNode[]; offset: number }
  | { type: 'comment'; value: string };

export type ParsedTemplate = {
  nodes: TemplateNode[];
  dataModel: DataModelKind;
  source: string;
};

type Token =
  | { type: 'text'; value: string; offset: number }
  | { type: 'interpolation'; expr: Expr; offset: number }
  | { type: 'comment'; value: string; offset: number }
  | { type: 'if_open'; expr: Expr; negated: boolean; offset: number }
  | { type: 'else'; offset: number }
  | { type: 'else_if'; expr: Expr; negated: boolean; offset: number }
  | { type: 'foreach_open'; item: string; collection: Expr; offset: number }
  | { type: 'if_close'; offset: number }
  | { type: 'foreach_close'; offset: number };

function locate(template: string, offset: number): { line: number; column: number; offset: number } {
  const lines = template.slice(0, offset).split('\n');
  return { offset, line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function parseExpr(raw: string, template: string, offset: number): Expr {
  const parts = raw.split('.');
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return [parts[0], parts[1]];
  throw new TemplateError(
    `Invalid expression "${raw}": only "name" or "name.property" are supported, not deeper paths`,
    locate(template, offset),
  );
}

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;

  function fail(message: string, offset: number): never {
    throw new TemplateError(message, locate(template, offset));
  }

  function flushText() {
    if (i > textStart) {
      tokens.push({ type: 'text', value: template.slice(textStart, i), offset: textStart });
    }
  }

  while (i < template.length) {
    if (template.startsWith('${', i)) {
      flushText();
      const start = i;
      let j = i + 2;
      // skip whitespace
      while (j < template.length && template[j] === ' ') j++;
      const quote = template[j];
      if (quote === '"' || quote === "'") {
        const strStart = j;
        j++; // skip opening quote
        let value = '';
        while (j < template.length) {
          const ch = template[j];
          if (ch === '\n') fail('Newline in string literal', strStart);
          if (ch === '\\') {
            j++;
            if (j >= template.length) fail('Unterminated string literal', strStart);
            const next = template[j];
            if (next === quote || next === '\\') {
              value += next;
            } else {
              fail(`Invalid escape sequence "\\${next}" in string literal`, strStart);
            }
          } else if (ch === quote) {
            break;
          } else {
            value += ch;
          }
          j++;
        }
        if (j >= template.length || template[j] !== quote) fail('Unterminated string literal', strStart);
        j++; // skip closing quote
        // skip whitespace then expect }
        while (j < template.length && template[j] === ' ') j++;
        if (j >= template.length || template[j] !== '}') fail('Unterminated interpolation', start);
        tokens.push({ type: 'interpolation', expr: { literal: value }, offset: start });
        i = j + 1;
        textStart = i;
      } else {
        const end = template.indexOf('}', i + 2);
        if (end === -1) fail('Unterminated interpolation', start);
        const raw = template.slice(i + 2, end).trim();
        if (raw === 'true' || raw === 'false') fail('Cannot use boolean literal in interpolation', start);
        tokens.push({ type: 'interpolation', expr: parseExpr(raw, template, start), offset: start });
        i = end + 1;
        textStart = i;
      }
    } else if (template.startsWith('<#--', i)) {
      flushText();
      const start = i;
      const end = template.indexOf('-->', i + 4);
      if (end === -1) fail('Unterminated comment', start);
      tokens.push({ type: 'comment', value: template.slice(i + 4, end), offset: start });
      i = end + 3;
      textStart = i;
    } else if (template.startsWith('</#', i)) {
      flushText();
      const start = i;
      const end = template.indexOf('>', i + 3);
      if (end === -1) fail('Unterminated close tag', start);
      const tag = template.slice(i + 3, end).trim();
      if (tag === 'if') {
        tokens.push({ type: 'if_close', offset: start });
      } else if (tag === 'foreach') {
        tokens.push({ type: 'foreach_close', offset: start });
      } else {
        fail(`Unknown close tag: </#${tag}>`, start);
      }
      i = end + 1;
      textStart = i;
    } else if (template.startsWith('<#', i)) {
      flushText();
      const start = i;
      const end = template.indexOf('>', i + 2);
      if (end === -1) fail('Unterminated tag', start);
      const content = template.slice(i + 2, end).trim();

      if (content.startsWith('if ')) {
        const { expr, negated } = parseConditionTokenExpr(content.slice(3), template, start);
        tokens.push({ type: 'if_open', expr, negated, offset: start });
      } else if (content.startsWith('else if ')) {
        const { expr, negated } = parseConditionTokenExpr(content.slice(8), template, start);
        tokens.push({ type: 'else_if', expr, negated, offset: start });
      } else if (content === 'else') {
        tokens.push({ type: 'else', offset: start });
      } else if (content.startsWith('foreach ')) {
        const match = content.match(/^foreach\s+(\w+)\s+of\s+(.+)$/);
        if (!match) fail(`Invalid foreach syntax: <#${content}>`, start);
        const collectionRaw = match[2].trim();
        if (collectionRaw === 'true' || collectionRaw === 'false') fail('Cannot use boolean literal as a collection', start);
        if (collectionRaw.startsWith('"') || collectionRaw.startsWith("'")) fail('Cannot use string literal as a collection', start);
        if (!/^[\w.]+$/.test(collectionRaw)) fail(`Invalid foreach syntax: <#${content}>`, start);
        tokens.push({ type: 'foreach_open', item: match[1], collection: parseExpr(collectionRaw, template, start), offset: start });
      } else {
        fail(`Unknown directive: <#${content}>`, start);
      }

      i = end + 1;
      textStart = i;
    } else {
      i++;
    }
  }

  flushText();
  return tokens;
}

function parseConditionTokenExpr(raw: string, template: string, offset: number): { expr: Expr; negated: boolean } {
  let trimmed = raw.trim();
  let negated = false;
  if (trimmed.startsWith('not ')) {
    negated = true;
    trimmed = trimmed.slice(4).trim();
  }
  if (trimmed === 'true') return { expr: { literal: true }, negated };
  if (trimmed === 'false') return { expr: { literal: false }, negated };
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    throw new TemplateError('Cannot use string literal in condition', locate(template, offset));
  }
  return { expr: parseExpr(trimmed, template, offset), negated };
}

type IfFrame = {
  kind: 'if';
  parentNodes: TemplateNode[];
  branches: ConditionBranch[];
  currentCondition: ConditionExpr | null;
  currentBranchOffset: number;
  hasElse: boolean;
  offset: number;
};

type ForeachFrame = {
  kind: 'foreach';
  parentNodes: TemplateNode[];
  item: string;
  collection: Expr;
  offset: number;
};

type Frame = IfFrame | ForeachFrame;

export function parse(template: string): ParsedTemplate {
  const tokens = tokenize(template);
  const dataModel: DataModelKind = {};
  const stack: Frame[] = [];
  const loopVars = new Map<string, DataModelKind>();
  let currentNodes: TemplateNode[] = [];

  function fail(message: string, offset: number): never {
    throw new TemplateError(message, locate(template, offset));
  }

  function validateExpr(expr: Expr, kind: 'string' | 'boolean', offset: number) {
    if (typeof expr === 'object' && !Array.isArray(expr) && 'literal' in expr) return;
    if (typeof expr === 'string') {
      if (loopVars.has(expr)) {
        fail(`Cannot use loop variable "${expr}" as a standalone value`, offset);
      }
      dataModel[expr] = kind;
    } else {
      const [base, prop] = expr;
      if (!loopVars.has(base)) {
        fail(`"${base}" is not a loop variable`, offset);
      }
      const model = loopVars.get(base)!;
      model[prop] = kind;
    }
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        currentNodes.push({ type: 'text', value: token.value });
        break;

      case 'interpolation':
        validateExpr(token.expr, 'string', token.offset);
        currentNodes.push({ type: 'interpolation', expr: token.expr, offset: token.offset });
        break;

      case 'comment':
        currentNodes.push({ type: 'comment', value: token.value });
        break;

      case 'if_open':
        validateExpr(token.expr, 'boolean', token.offset);
        stack.push({
          kind: 'if',
          parentNodes: currentNodes,
          branches: [],
          currentCondition: { expr: token.expr, negated: token.negated },
          currentBranchOffset: token.offset,
          hasElse: false,
          offset: token.offset,
        });
        currentNodes = [];
        break;

      case 'else_if': {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'if') {
          fail('Unexpected <#else if> outside of <#if>', token.offset);
        }
        if (top.hasElse) {
          fail('Multiple <#else> branches in the same <#if>', token.offset);
        }
        top.branches.push({ condition: top.currentCondition, body: currentNodes, offset: top.currentBranchOffset });
        validateExpr(token.expr, 'boolean', token.offset);
        top.currentCondition = { expr: token.expr, negated: token.negated };
        top.currentBranchOffset = token.offset;
        currentNodes = [];
        break;
      }

      case 'else': {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'if') {
          fail('Unexpected <#else> outside of <#if>', token.offset);
        }
        if (top.hasElse) {
          fail('Multiple <#else> branches in the same <#if>', token.offset);
        }
        top.branches.push({ condition: top.currentCondition, body: currentNodes, offset: top.currentBranchOffset });
        top.currentCondition = null;
        top.currentBranchOffset = token.offset;
        top.hasElse = true;
        currentNodes = [];
        break;
      }

      case 'if_close': {
        const top = stack[stack.length - 1];
        if (!top) {
          fail('Unexpected </#if> without matching <#if>', token.offset);
        }
        if (top.kind !== 'if') {
          fail('Mismatched tags: expected </#foreach> but got </#if>', token.offset);
        }
        stack.pop();
        top.branches.push({ condition: top.currentCondition, body: currentNodes, offset: top.currentBranchOffset });
        currentNodes = top.parentNodes;
        currentNodes.push({ type: 'condition', branches: top.branches, offset: top.offset });
        break;
      }

      case 'foreach_open': {
        const col = token.collection;
        let parent: DataModelKind;
        let key: string;
        if (typeof col === 'string') {
          parent = dataModel;
          key = col;
        } else if (Array.isArray(col)) {
          const [base, prop] = col;
          if (!loopVars.has(base)) {
            fail(`"${base}" is not a loop variable`, token.offset);
          }
          parent = loopVars.get(base)!;
          key = prop;
        } else {
          throw new Error('unreachable');
        }
        let model = parent[key];
        if (typeof model !== 'object') {
          model = {};
          parent[key] = model;
        }
        loopVars.set(token.item, model);
        stack.push({
          kind: 'foreach',
          parentNodes: currentNodes,
          item: token.item,
          collection: col,
          offset: token.offset,
        });
        currentNodes = [];
        break;
      }

      case 'foreach_close': {
        const top = stack[stack.length - 1];
        if (!top) {
          fail('Unexpected </#foreach> without matching <#foreach>', token.offset);
        }
        if (top.kind !== 'foreach') {
          fail('Mismatched tags: expected </#if> but got </#foreach>', token.offset);
        }
        stack.pop();
        loopVars.delete(top.item);
        const body = currentNodes;
        currentNodes = top.parentNodes;
        currentNodes.push({
          type: 'loop',
          item: top.item,
          collection: top.collection,
          body,
          offset: top.offset,
        });
        break;
      }

      default: {
        token satisfies never;
        // @ts-expect-error
        throw new Error(`unknown token type ${token.type}`);
      }
    }
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    const tag = top.kind === 'if' ? 'if' : 'foreach';
    fail(`Unclosed <#${tag}>`, top.offset);
  }

  return { nodes: currentNodes, dataModel, source: template };
}

export type DataModel = {
  [key: string]: string | boolean | null | undefined | DataModel[];
};

export function apply(parsedTemplate: ParsedTemplate, data: DataModel): string {
  validateData(parsedTemplate.dataModel, data, '');

  function fail(message: string, offset: number): never {
    throw new TemplateError(message, locate(parsedTemplate.source, offset));
  }

  function requireExpr(expr: Expr, offset: number): string | boolean | DataModel[] {
    if (typeof expr === 'object' && !Array.isArray(expr) && 'literal' in expr) {
      return expr.literal;
    }
    let value: DataModel[string];
    if (typeof expr === 'string') {
      value = data[expr];
    } else {
      const [base, prop] = expr;
      value = loopVars.get(base)![prop];
    }
    if (value == null) {
      const name = typeof expr === 'string' ? expr : expr.join('.');
      fail(`Missing value for "${name}"`, offset);
    }
    return value;
  }

  const loopVars = new Map<string, DataModel>();

  function renderNodes(nodes: TemplateNode[]): string {
    let result = '';
    for (const node of nodes) {
      switch (node.type) {
        case 'text': {
          result += node.value;
          break;
        }
        case 'comment': {
          break;
        }
        case 'interpolation': {
          const value = requireExpr(node.expr, node.offset);
          if (typeof value !== 'string') throw new Error('unreachable');
          result += value;
          break;
        }
        case 'condition': {
          for (const branch of node.branches) {
            if (branch.condition === null) {
              result += renderNodes(branch.body);
              break;
            }
            const raw = requireExpr(branch.condition.expr, branch.offset);
            if (typeof raw !== 'boolean') throw new Error('unreachable');
            let value = raw;
            if (branch.condition.negated) value = !value;
            if (value) {
              result += renderNodes(branch.body);
              break;
            }
          }
          break;
        }
        case 'loop': {
          const raw = requireExpr(node.collection, node.offset);
          if (!Array.isArray(raw)) throw new Error('unreachable');
          const items = raw;
          for (const item of items) {
            loopVars.set(node.item, item);
            result += renderNodes(node.body);
          }
          loopVars.delete(node.item);
          break;
        }
        default: {
          node satisfies never;
          // @ts-expect-error
          throw new Error(`unknown type ${node.type}`);
        }
      }
    }
    return result;
  }

  return renderNodes(parsedTemplate.nodes);
}

function validateData(schema: DataModelKind, data: DataModel, path: string) {
  for (const key of Object.keys(data)) {
    if (!(key in schema)) {
      const fullPath = path ? `${path}.${key}` : key;
      throw new Error(`Unexpected key "${fullPath}" not in template data model`);
    }
  }
  for (const [key, expectedType] of Object.entries(schema)) {
    if (!(key in data)) continue;
    const value = data[key];
    if (value == null) continue;
    const fullPath = path ? `${path}.${key}` : key;
    if (typeof expectedType === 'string') {
      if (typeof value !== expectedType) {
        throw new Error(`Expected ${expectedType} for "${fullPath}", got ${typeof value}`);
      }
    } else {
      if (!Array.isArray(value)) {
        throw new Error(`Expected array for "${fullPath}", got ${typeof value}`);
      }
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          throw new Error(`Expected object for "${fullPath}[${i}]", got ${Array.isArray(item) ? 'array' : typeof item}`);
        }
        validateData(expectedType, item, `${fullPath}[${i}]`);
      }
    }
  }
}

export function parseAndApply(templateSource: string, data: DataModel): string {
  return apply(parse(templateSource), data);
}
