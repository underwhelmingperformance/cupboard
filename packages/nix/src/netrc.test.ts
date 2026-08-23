import { describe, expect, it } from 'vitest';

import { netrcCredentialFor } from './netrc.ts';
import { NixNetrcSyntaxError } from './nix-store.ts';

interface NetrcCase {
	readonly name: string;
	readonly source: string;
	readonly host?: string;
	readonly expected: { login: string; password: string } | undefined;
}

const cases: readonly NetrcCase[] = [
	{
		name: 'reads credentials from a matching machine entry',
		source: 'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'reads a machine entry across line breaks',
		source: 'machine cache.example\n\tlogin reader\n\tpassword secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'matches host names case-insensitively',
		source: 'machine CACHE.EXAMPLE login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'matches netrc keywords case-insensitively',
		source: 'MACHINE cache.example LOGIN reader PASSWORD secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'uses the first complete matching machine entry',
		source:
			'machine cache.example login first password one\n' +
			'machine cache.example login second password two\n',
		expected: { login: 'first', password: 'one' }
	},
	{
		name: 'returns undefined when every entry belongs to another host',
		source: 'machine other.example login reader password secret\n',
		expected: undefined
	},
	{
		name: 'uses default when no machine entry matches',
		source:
			'machine other.example login them password theirs\n' +
			'default login anyone password shared\n',
		expected: { login: 'anyone', password: 'shared' }
	},
	{
		name: 'uses an early complete default before a later matching machine',
		source:
			'default login anyone password shared\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'anyone', password: 'shared' }
	},
	{
		name: 'skips a login-only match when a later default is complete',
		source:
			'machine cache.example login reader\n' +
			'machine other.example login them password theirs\n' +
			'default login anyone password shared\n',
		expected: { login: 'anyone', password: 'shared' }
	},
	{
		name: 'supplies an empty password for a login-only entry at EOF',
		source: 'machine cache.example login reader\n',
		expected: { login: 'reader', password: '' }
	},
	{
		name: 'supplies an empty login for a password-only entry',
		source: 'machine cache.example password secret\n',
		expected: { login: '', password: 'secret' }
	},
	{
		name: 'ignores full-line comments',
		source:
			'# the reader for the shared cache\n' +
			'  # indented, and still a comment\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'keeps # inside an ordinary token',
		source: 'machine cache.example login reader password se#ret\n',
		expected: { login: 'reader', password: 'se#ret' }
	},
	{
		name: 'decodes spaces in a quoted password',
		source: 'machine cache.example login reader password "two words"\n',
		expected: { login: 'reader', password: 'two words' }
	},
	{
		name: 'decodes escaped quotes and backslashes',
		source:
			String.raw`machine cache.example login reader password "a\"b\\c"` + '\n',
		expected: { login: 'reader', password: String.raw`a"b\c` }
	},
	{
		name: 'decodes newline, tab and carriage-return escapes',
		source:
			String.raw`machine cache.example login reader password "a\nb\tc\rd"` +
			'\n',
		expected: { login: 'reader', password: 'a\nb\tc\rd' }
	},
	{
		name: 'ignores an unrecognised keyword and its value',
		source:
			'machine cache.example account books login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'skips a macdef body through its terminating blank line',
		source:
			'macdef upload\n' +
			'machine trap.example login trapped password trap\n' +
			'\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'ignores the requested machine inside a macdef body',
		source:
			'macdef upload\n' +
			'machine cache.example login trapped password trap\n' +
			'echo still inside the macro\n' +
			'\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'matches a bracketed IPv6 URL host to an unbracketed machine',
		source: 'machine ::1 login reader password secret\n',
		host: '[::1]',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'returns undefined for an empty netrc',
		source: '',
		expected: undefined
	},
	{
		name: 'returns undefined when machine has no host',
		source: 'machine\n',
		expected: undefined
	}
];

describe('netrcCredentialFor', () => {
	it.each(cases)('$name', ({ source, host, expected }) => {
		expect(netrcCredentialFor(source, host ?? 'cache.example')).toStrictEqual(
			expected
		);
	});

	it.each([
		{ name: 'a line ending in a carriage return', source: 'machine a\r\n' },
		{
			name: 'a quoted token that is never closed',
			source: 'machine cache.example login reader password "never\n'
		},
		{
			name: 'a quoted token whose last character is an escape',
			source: 'machine cache.example login reader password "never\\'
		}
	])('refuses $name', ({ source }) => {
		expect(() => netrcCredentialFor(source, 'cache.example')).toThrow(
			NixNetrcSyntaxError
		);
	});
});
