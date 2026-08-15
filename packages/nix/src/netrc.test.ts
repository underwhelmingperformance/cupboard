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
		name: 'an entry naming the host',
		source: 'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'an entry written over several lines',
		source: 'machine cache.example\n\tlogin reader\n\tpassword secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'a host named in another case',
		source: 'machine CACHE.EXAMPLE login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'keywords written in another case',
		source: 'MACHINE cache.example LOGIN reader PASSWORD secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'the first of two entries naming the host',
		source:
			'machine cache.example login first password one\n' +
			'machine cache.example login second password two\n',
		expected: { login: 'first', password: 'one' }
	},
	{
		name: 'an entry for another host alone',
		source: 'machine other.example login reader password secret\n',
		expected: undefined
	},
	{
		name: 'a default entry, for a host nothing else names',
		source:
			'machine other.example login them password theirs\n' +
			'default login anyone password shared\n',
		expected: { login: 'anyone', password: 'shared' }
	},
	{
		// A default entry answers for every host, so one written ahead of the
		// machine entries answers ahead of all of them.
		name: 'a default entry written before the entry naming the host',
		source:
			'default login anyone password shared\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'anyone', password: 'shared' }
	},
	{
		// An entry naming no password is left behind when the next one starts,
		// so what the rest of the file names answers instead.
		name: 'a matching entry naming no password, before a default',
		source:
			'machine cache.example login reader\n' +
			'machine other.example login them password theirs\n' +
			'default login anyone password shared\n',
		expected: { login: 'anyone', password: 'shared' }
	},
	{
		name: 'a matching entry naming a login and no password, at the end',
		source: 'machine cache.example login reader\n',
		expected: { login: 'reader', password: '' }
	},
	{
		name: 'a matching entry naming a password and no login',
		source: 'machine cache.example password secret\n',
		expected: { login: '', password: 'secret' }
	},
	{
		name: 'a comment line',
		source:
			'# the reader for the shared cache\n' +
			'  # indented, and still a comment\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		// A `#` is a comment only where a line starts, so one inside a value is
		// an ordinary character of it.
		name: 'a password holding a hash',
		source: 'machine cache.example login reader password se#ret\n',
		expected: { login: 'reader', password: 'se#ret' }
	},
	{
		name: 'a quoted password holding spaces',
		source: 'machine cache.example login reader password "two words"\n',
		expected: { login: 'reader', password: 'two words' }
	},
	{
		name: 'a quoted password holding a quote and a backslash',
		source:
			String.raw`machine cache.example login reader password "a\"b\\c"` + '\n',
		expected: { login: 'reader', password: String.raw`a"b\c` }
	},
	{
		name: 'a quoted password holding the escapes for the characters no token holds',
		source:
			String.raw`machine cache.example login reader password "a\nb\tc\rd"` +
			'\n',
		expected: { login: 'reader', password: 'a\nb\tc\rd' }
	},
	{
		name: 'a keyword neither side reads, and the value after it',
		source:
			'machine cache.example account books login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		// A macro definition runs to the blank line that ends it, and nothing
		// inside it names a machine.
		name: 'a macro definition naming another machine',
		source:
			'macdef upload\n' +
			'machine trap.example login trapped password trap\n' +
			'\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'a macro body naming the requested machine',
		source:
			'macdef upload\n' +
			'machine cache.example login trapped password trap\n' +
			'echo still inside the macro\n' +
			'\n' +
			'machine cache.example login reader password secret\n',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'an entry naming an address a URL states in brackets',
		source: 'machine ::1 login reader password secret\n',
		host: '[::1]',
		expected: { login: 'reader', password: 'secret' }
	},
	{
		name: 'nothing at all',
		source: '',
		expected: undefined
	},
	{
		name: 'a machine keyword naming nothing after it',
		source: 'machine\n',
		expected: undefined
	}
];

describe('netrcCredentialFor', () => {
	it.each(cases)('reads $name', ({ source, host, expected }) => {
		expect(netrcCredentialFor(source, host ?? 'cache.example')).toStrictEqual(
			expected
		);
	});

	// libcurl reads a token as every character above a space, so a carriage
	// return sits where a token was expected. Each of these sources leaves the
	// reader part-way through a token, which is a syntax error rather than a
	// file that supplies no credentials.
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
