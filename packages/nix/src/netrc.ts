import { NixNetrcSyntaxError } from './nix-store.ts';

export interface NetrcCredential {
	readonly login: string;
	readonly password: string;
}

/**
 * Selects HTTP Basic credentials for a host using libcurl-compatible netrc
 * parsing. Returns `undefined` when no usable entry matches.
 *
 * Nix hands the file to libcurl rather than reading it itself, so what a netrc
 * means is what libcurl makes of it: tokens separated by spaces, tabs and line
 * breaks; a line whose first non-blank character is `#` dropped whole; and
 * `machine`, `default`, `login`, `password` and `macdef` recognised whatever
 * their case. Entries can continue across lines.
 *
 * A complete early `default` entry shadows later machine entries. When another
 * machine begins, a matching entry with only a login is skipped. At the end of
 * the file, either credential field is accepted and the missing field becomes
 * an empty string.
 */
export function netrcCredentialFor(
	source: string,
	host: string
): NetrcCredential | undefined {
	const wanted = withoutBrackets(host).toLowerCase();
	const reader = new NetrcReader(withoutCommentLines(source));
	let state: LookupState = 'nothing';
	let keyword: Keyword = 'none';
	let entry: PartialCredential = {};

	for (;;) {
		const token = reader.next();

		if (token === undefined) {
			return finish(entry);
		}

		if (state === 'macdef') {
			// A macdef body ends at the next blank line. Tokens inside it do not
			// define machines or credentials.
			state = token.endsLine && token.isBlank ? 'nothing' : 'macdef';
			continue;
		}

		if (token.endsLine) {
			continue;
		}

		const { text } = token;

		if (state === 'nothing') {
			if (isKeyword(text, 'macdef')) {
				state = 'macdef';
			} else if (isKeyword(text, 'machine')) {
				state = 'host-found';
				entry = {};
			} else if (isKeyword(text, 'default')) {
				state = 'host-valid';
			}

			continue;
		}

		if (state === 'host-found') {
			state = text.toLowerCase() === wanted ? 'host-valid' : 'nothing';
			continue;
		}

		if (keyword === 'login') {
			entry = { ...entry, login: text };
			keyword = 'none';
		} else if (keyword === 'password') {
			entry = { ...entry, password: text };
			keyword = 'none';
		} else if (isKeyword(text, 'login')) {
			keyword = 'login';
		} else if (isKeyword(text, 'password')) {
			keyword = 'password';
		} else if (isKeyword(text, 'machine')) {
			// When another machine begins, return the current matching entry only if
			// it has a password. A login-only entry is discarded so scanning can
			// continue.
			if (entry.password !== undefined) {
				return finish(entry);
			}

			state = 'host-found';
			keyword = 'none';
			entry = {};
		} else if (isKeyword(text, 'default')) {
			keyword = 'none';
			entry = {};
		}

		if (entry.login !== undefined && entry.password !== undefined) {
			return finish(entry);
		}
	}
}

interface PartialCredential {
	readonly login?: string;
	readonly password?: string;
}

function finish(entry: PartialCredential): NetrcCredential | undefined {
	if (entry.login === undefined && entry.password === undefined) {
		return;
	}

	return { login: entry.login ?? '', password: entry.password ?? '' };
}

type LookupState = 'nothing' | 'host-found' | 'host-valid' | 'macdef';

type Keyword = 'none' | 'login' | 'password';

function isKeyword(token: string, keyword: string): boolean {
	return token.toLowerCase() === keyword;
}

/**
 * Removes the brackets that URLs place around IPv6 hosts before matching a
 * netrc machine, where IPv6 addresses are unbracketed.
 */
function withoutBrackets(host: string): string {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * A `#` starts a comment only when it is the first non-blank character on a
 * line. Anywhere else, it is an ordinary character in a token.
 */
function withoutCommentLines(source: string): string {
	return source
		.split('\n')
		.filter((line) => !line.replace(/^[\t ]+/u, '').startsWith('#'))
		.join('\n');
}

type NetrcToken =
	| { readonly endsLine: true; readonly isBlank: boolean }
	| { readonly endsLine: false; readonly text: string };

// Use only spaces and tabs as separators. libcurl rejects other control
// characters instead of treating them as whitespace.
const blanks = new Set([' ', '\t']);

class NetrcReader {
	private at = 0;
	private lineHasToken = false;

	constructor(private readonly source: string) {}

	private passBlanks(): void {
		while (blanks.has(this.source.charAt(this.at))) {
			this.at += 1;
		}
	}

	/**
	 * libcurl accepts every character above ASCII space in an unquoted token.
	 * Other control characters are syntax errors rather than separators. A
	 * carriage return therefore ends the token and makes the next read fail.
	 */
	private plainToken(): string {
		const start = this.at;

		while (this.source.charAt(this.at) > ' ') {
			this.at += 1;
		}

		if (this.at === start) {
			throw new NixNetrcSyntaxError(
				'a control character where a token was expected'
			);
		}

		return this.source.slice(start, this.at);
	}

	/**
	 * A token wrapped in double quotes, which is how a value containing a space
	 * or a tab is written. A backslash escapes the character after it, and
	 * `\n`, `\r` and `\t` stand for the three characters a token cannot contain
	 * literally.
	 */
	private quotedToken(): string {
		this.at += 1;

		let text = '';

		for (;;) {
			const character = this.source.charAt(this.at);

			if (character === '') {
				throw new NixNetrcSyntaxError('a quoted token that is never closed');
			}

			this.at += 1;

			if (character === '"') {
				return text;
			}

			if (character !== '\\') {
				text += character;
				continue;
			}

			const escaped = this.source.charAt(this.at);

			if (escaped === '') {
				throw new NixNetrcSyntaxError('a quoted token that is never closed');
			}

			this.at += 1;
			text += escapedCharacters.get(escaped) ?? escaped;
		}
	}

	next(): NetrcToken | undefined {
		this.passBlanks();

		const character = this.source.charAt(this.at);

		if (character === '') {
			return;
		}

		if (character === '\n') {
			this.at += 1;
			const isBlank = !this.lineHasToken;
			this.lineHasToken = false;

			return { endsLine: true, isBlank };
		}

		this.lineHasToken = true;

		return {
			endsLine: false,
			text: character === '"' ? this.quotedToken() : this.plainToken()
		};
	}
}

const escapedCharacters: ReadonlyMap<string, string> = new Map([
	['n', '\n'],
	['r', '\r'],
	['t', '\t']
]);
