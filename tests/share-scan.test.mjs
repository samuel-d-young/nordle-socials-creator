// The share gate's allow-list: hits the owner kept on purpose are counted, not listed, so a new hit stands out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseAllow, readTerms } from '../tools/share-scan.mjs';

test('term lists skip blank lines and comments', () => {
  assert.deepEqual(readTerms('# names\nAcme Dental\r\n\n  Bob  \n'), ['Acme Dental', 'Bob']);
});

test('an allowed hit is matched by file and term, in any letter case', () => {
  const { rules, bad } = parseAllow('README.md | Acme Dental\n# a comment\n');
  assert.deepEqual(bad, []);
  assert.ok(isAllowed(rules, { f: 'README.md', term: 'acme dental' }));
  assert.ok(isAllowed(rules, { f: 'readme.md', term: 'ACME DENTAL' }));
  assert.ok(!isAllowed(rules, { f: 'docs/README.md', term: 'acme dental' }), 'another file with the same name is not allowed');
  assert.ok(!isAllowed(rules, { f: 'README.md', term: 'bob' }), 'another term in the same file is not allowed');
});

test('a star matches any run of characters, and backslashes are read as slashes', () => {
  const { rules } = parseAllow('brand\\* | Acme\ndocs/*.md | Bob');
  assert.ok(isAllowed(rules, { f: 'brand/guide.html', term: 'acme' }));
  assert.ok(isAllowed(rules, { f: 'docs/UI.md', term: 'bob' }));
  assert.ok(!isAllowed(rules, { f: 'docs/UI.mdx', term: 'bob' }));
  assert.ok(!isAllowed(rules, { f: 'app/x.js', term: 'acme' }));
});

test('dots and brackets in a file name are literal', () => {
  const { rules } = parseAllow('a.b(1).md | x');
  assert.ok(isAllowed(rules, { f: 'a.b(1).md', term: 'x' }));
  assert.ok(!isAllowed(rules, { f: 'aXb(1)Xmd', term: 'x' }));
});

test('lines it cannot read are reported, and a key or token hit is never allowed', () => {
  const { rules, bad } = parseAllow('README.md\n | term\nREADME.md | \n* | token');
  assert.deepEqual(bad, ['README.md', '| term', 'README.md |']);
  assert.ok(!isAllowed(rules, { f: 'anything.js' }), 'a hit with no term is a key or token');
});
