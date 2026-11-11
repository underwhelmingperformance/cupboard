import { describe, expect, it } from 'vitest';

import {
	hasControlCharacter,
	trimSlashes,
	trimTrailingSlashes
} from './text.ts';

describe('hasControlCharacter', () => {
	it.each([
		['printable ASCII', 'abc ~', false],
		['non-ASCII text', 'café', false],
		['a NUL', 'a\u{0}b', true],
		['a line break', 'a\nb', true],
		['the last C0 character', 'a\u{1F}', true],
		['a delete character', 'a\u{7F}', true],
		['a C1 control character', 'a\u{85}', true],
		['the last C1 character', 'a\u{9F}', true],
		['the first character after C1', 'a\u{A0}', false]
	])('%s', (_name, value, expected) => {
		expect(hasControlCharacter(value)).toBe(expected);
	});
});

const longSlashRun = '/'.repeat(50_000);

describe('trimSlashes', () => {
	it.each([
		['an empty string', '', ''],
		['only slashes', '///', ''],
		['no slashes', 'app', 'app'],
		['leading and trailing slashes', '//app/x//', 'app/x'],
		['interior slashes', 'a//b', 'a//b'],
		['a long slash run before a character', `${longSlashRun}a`, 'a'],
		['a long slash run after a character', `a${longSlashRun}`, 'a']
	])('%s', (_name, value, expected) => {
		expect(trimSlashes(value)).toBe(expected);
	});
});

describe('trimTrailingSlashes', () => {
	it.each([
		['an empty string', '', ''],
		['only slashes', '///', ''],
		['leading and trailing slashes', '//app/x//', '//app/x'],
		['interior slashes', 'a//b', 'a//b'],
		[
			'a long slash run before a character',
			`${longSlashRun}a`,
			`${longSlashRun}a`
		],
		['a long slash run after a character', `a${longSlashRun}`, 'a']
	])('%s', (_name, value, expected) => {
		expect(trimTrailingSlashes(value)).toBe(expected);
	});
});
