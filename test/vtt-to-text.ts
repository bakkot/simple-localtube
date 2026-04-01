import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vttToText } from '../util.ts';

test('basic cues', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello world

00:00:05.000 --> 00:00:10.000
Second line`;

  assert.equal(vttToText(vtt), 'Hello world\nSecond line');
});

test('strips inline tags', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:03.000
This is <b>bold</b> and <i>italic</i>

00:00:03.000 --> 00:00:06.000
<c.yellow>colored text</c>`;

  assert.equal(vttToText(vtt), 'This is bold and italic\ncolored text');
});

test('skips numeric cue identifiers', () => {
  const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:05.000
First

2
00:00:05.000 --> 00:00:10.000
Second`;

  assert.equal(vttToText(vtt), 'First\nSecond');
});

test('skips NOTE blocks', () => {
  const vtt = `WEBVTT

NOTE
This is a comment
that spans multiple lines

00:00:00.000 --> 00:00:05.000
Actual text

NOTE another comment

00:00:05.000 --> 00:00:10.000
More text`;

  assert.equal(vttToText(vtt), 'Actual text\nMore text');
});

test('skips STYLE blocks', () => {
  const vtt = `WEBVTT

STYLE
::cue {
  color: white;
  background: black;
}

00:00:00.000 --> 00:00:05.000
Styled text`;

  assert.equal(vttToText(vtt), 'Styled text');
});

test('skips REGION blocks', () => {
  const vtt = `WEBVTT

REGION
id:heading
width:50%
lines:3

00:00:00.000 --> 00:00:05.000
Region text`;

  assert.equal(vttToText(vtt), 'Region text');
});

test('handles multi-line cue payloads', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
Line one
Line two
Line three`;

  assert.equal(vttToText(vtt), 'Line one\nLine two\nLine three');
});

test('skips non-numeric cue identifiers', () => {
  const vtt = `WEBVTT

intro
00:00:00.000 --> 00:00:05.000
Welcome

outro
00:00:05.000 --> 00:00:10.000
Goodbye`;

  assert.equal(vttToText(vtt), 'Welcome\nGoodbye');
});

test('handles WEBVTT header with description', () => {
  const vtt = `WEBVTT - This file has cues.

00:00:00.000 --> 00:00:05.000
Hello`;

  assert.equal(vttToText(vtt), 'Hello');
});

test('empty input', () => {
  assert.equal(vttToText('WEBVTT\n'), '');
});

test('ignores cue settings on timestamp line', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000 position:10% align:start
Positioned text`;

  assert.equal(vttToText(vtt), 'Positioned text');
});
