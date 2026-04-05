/*
json-excise
https://github.com/bakkot/json-excise

Slice valid JSON out of larger strings, given the start index.

Useful for reading it out of other documents like HTML pages without a full parser.

More formally:

Given an index S into a string, finds the minimal index E with E > S such that slice(string, S, E) is valid JSON. Returns -1 if there is no such index.


LICENSE:

Copyright 2026 Kevin Gibbons

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

export function getJsonEnd(input: string, index: number): number {
  const len = input.length;
  if (index >= len) return -1;

  // skip whitespace
  let i = index;
  while (i < len && (input[i] === ' ' || input[i] === '\t' || input[i] === '\n' || input[i] === '\r')) {
    i++;
  }
  if (i >= len) return -1;

  const ch = input[i];

  if (ch === 'n') return parseKeyword(input, i, 'null');
  if (ch === 't') return parseKeyword(input, i, 'true');
  if (ch === 'f') return parseKeyword(input, i, 'false');
  if (ch === '"') return parseString(input, i);
  if (ch === '[') return parseArray(input, i);
  if (ch === '{') return parseObject(input, i);
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber(input, i);

  return -1;
}

function parseKeyword(input: string, i: number, keyword: string): number {
  if (input.startsWith(keyword, i)) {
    return i + keyword.length;
  }
  return -1;
}

function parseString(input: string, i: number): number {
  // i points at opening "
  const len = input.length;
  i++; // skip opening quote
  while (i < len) {
    const ch = input[i];
    if (ch === '\\') {
      i += 2; // skip escaped char
    } else if (ch === '"') {
      return i + 1;
    } else {
      i++;
    }
  }
  return -1;
}

function parseNumber(input: string, i: number): number {
  const len = input.length;
  const start = i;

  // optional minus
  if (i < len && input[i] === '-') i++;

  // digits
  if (i >= len || input[i] < '0' || input[i] > '9') return -1;

  if (input[i] === '0') {
    i++;
  } else {
    while (i < len && input[i] >= '0' && input[i] <= '9') i++;
  }

  // fraction
  if (i < len && input[i] === '.') {
    i++;
    if (i >= len || input[i] < '0' || input[i] > '9') return -1;
    while (i < len && input[i] >= '0' && input[i] <= '9') i++;
  }

  // exponent
  if (i < len && (input[i] === 'e' || input[i] === 'E')) {
    i++;
    if (i < len && (input[i] === '+' || input[i] === '-')) i++;
    if (i >= len || input[i] < '0' || input[i] > '9') return -1;
    while (i < len && input[i] >= '0' && input[i] <= '9') i++;
  }

  return i === start ? -1 : i;
}

function skipWhitespace(input: string, i: number): number {
  const len = input.length;
  while (i < len && (input[i] === ' ' || input[i] === '\t' || input[i] === '\n' || input[i] === '\r')) {
    i++;
  }
  return i;
}

function parseArray(input: string, i: number): number {
  const len = input.length;
  i++; // skip [
  i = skipWhitespace(input, i);

  if (i < len && input[i] === ']') return i + 1;

  while (true) {
    // parse value
    const valueEnd = getJsonEnd(input, i);
    if (valueEnd === -1) return -1;
    i = skipWhitespace(input, valueEnd);

    if (i >= len) return -1;
    if (input[i] === ']') return i + 1;
    if (input[i] !== ',') return -1;
    i++; // skip comma
    i = skipWhitespace(input, i);
  }
}

function parseObject(input: string, i: number): number {
  const len = input.length;
  i++; // skip {
  i = skipWhitespace(input, i);

  if (i < len && input[i] === '}') return i + 1;

  while (true) {
    // parse key (must be string)
    if (i >= len || input[i] !== '"') return -1;
    const keyEnd = parseString(input, i);
    if (keyEnd === -1) return -1;
    i = skipWhitespace(input, keyEnd);

    // colon
    if (i >= len || input[i] !== ':') return -1;
    i++;
    i = skipWhitespace(input, i);

    // parse value
    const valueEnd = getJsonEnd(input, i);
    if (valueEnd === -1) return -1;
    i = skipWhitespace(input, valueEnd);

    if (i >= len) return -1;
    if (input[i] === '}') return i + 1;
    if (input[i] !== ',') return -1;
    i++; // skip comma
    i = skipWhitespace(input, i);
  }
}
