// SPDX-License-Identifier: Apache-2.0
// LinkedIn's `little` text format (learn.microsoft.com/linkedin/marketing/community-management/shares/little-text-format,
// read 2026-11-12): every reserved character is escaped with a backslash, and a hashtag is sent as `#word`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLittle } from '../src/publish.ts';

test('plain text passes through unchanged, line breaks and emoji included', () => {
  const text = 'Hello World.\n\nSecond line: 100% done, 2 + 2 = 4, "quoted" & café 🚀';
  assert.equal(escapeLittle(text), text);
});

test('each of the 15 reserved characters gets one backslash', () => {
  // The Text rule of the format's grammar lists exactly these.
  const reserved = ['|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '#', '\\', '*', '_', '~'];
  for (const char of reserved) {
    assert.equal(escapeLittle(`a ${char} b`), `a \\${char} b`, `reserved character ${char}`);
  }
  assert.equal(escapeLittle(reserved.join('')), reserved.map((char) => `\\${char}`).join(''));
});

test("the documentation's bullet sample: an asterisk at the start of a line is escaped", () => {
  assert.equal(
    escapeLittle('Hello, these are some bullet points:\n\n* Point 1\n* Point 2\n* Point 3'),
    'Hello, these are some bullet points:\n\n\\* Point 1\n\\* Point 2\n\\* Point 3',
  );
});

test('a backslash is escaped once, and text that already looks escaped is not trusted', () => {
  assert.equal(escapeLittle('C:\\temp'), 'C:\\\\temp');
  assert.equal(escapeLittle('\\*'), '\\\\\\*');
});

test('parentheses, brackets and an at sign cannot form a mention', () => {
  assert.equal(
    escapeLittle('Thanks @[Devtestco](urn:li:organization:2414183) (really)'),
    'Thanks \\@\\[Devtestco\\]\\(urn:li:organization:2414183\\) \\(really\\)',
  );
});

test('a hashtag template typed as text is escaped, so it shows as typed', () => {
  assert.equal(escapeLittle('{hashtag|#|tag}'), '\\{hashtag\\|\\#\\|tag\\}');
});

test('a word that starts with # is sent as a hashtag, unescaped', () => {
  assert.equal(escapeLittle('Follow best practices #coding'), 'Follow best practices #coding');
  assert.equal(escapeLittle('#first word'), '#first word');
  assert.equal(escapeLittle('line one\n#second #third\t#fourth'), 'line one\n#second #third\t#fourth');
  assert.equal(escapeLittle('#2026goals #résumé #日本語'), '#2026goals #résumé #日本語');
});

test('a # that does not start a word with a letter is escaped', () => {
  assert.equal(escapeLittle('We are #1'), 'We are \\#1');
  assert.equal(escapeLittle('C# and F#'), 'C\\# and F\\#');
  assert.equal(escapeLittle('# heading'), '\\# heading');
  assert.equal(escapeLittle('issue#12 and a#b'), 'issue\\#12 and a\\#b');
  assert.equal(escapeLittle('(#aside)'), '\\(\\#aside\\)');
  assert.equal(escapeLittle('https://example.com/#top'), 'https://example.com/\\#top');
});

test('a hashtag ends at a reserved character, which is still escaped', () => {
  assert.equal(escapeLittle('#open_source'), '#open\\_source');
  assert.equal(escapeLittle('#tag) #tag* ##double'), '#tag\\) #tag\\* \\#\\#double');
});
