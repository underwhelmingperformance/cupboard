import { NixNetrcSyntaxError } from './nix-store.ts';

/** HTTP Basic credentials selected from a netrc entry. */
export interface NetrcCredential {
	readonly login: string;
	readonly password: string;
}

/**
 * Selects credentials for a host from a netrc, or returns `undefined` when no
 * entry matches.
 *
 * Nix hands the file to libcurl rather than reading it itself, so what a netrc
 * means is what libcurl makes of it: whitespace-separated tokens, a line whose
 * first non-blank character is `#` dropped whole, and `machine`, `default`,
 * `login`, `password` and `macdef` recognised whatever their case. Tokens run
 * on across lines, so an entry is a run of tokens rather than a run of lines.
 *
 * The first matching `machine` or `default` entry wins, so an early `default`
 * shadows later machine entries. An entry with a login but no password uses an
 * empty password, and one with a password but no login uses that
 * password under an empty login.
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
			// Every token of a macro's body is passed over, up to the blank line
			// that ends the definition.
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
			// A password completes the matching entry. Otherwise continue scanning
			// for a later entry with credentials.
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

/** Credentials parsed from the current entry before defaults are applied. */
interface PartialCredential {
	readonly login?: string;
	readonly password?: string;
}

// A matched entry is usable when it specifies either credential field.
function finish(entry: PartialCredential): NetrcCredential | undefined {
	if (entry.login === undefined && entry.password === undefined) {
		return;
	}

	return { login: entry.login ?? '', password: entry.password ?? '' };
}

/** Where the reader is between the `machine` line and the credentials. */
type LookupState = 'nothing' | 'host-found' | 'host-valid' | 'macdef';

/** Which half of a credential the next token states. */
type Keyword = 'none' | 'login' | 'password';

// The keywords are matched whatever their case, as libcurl compares them.
function isKeyword(token: string, keyword: string): boolean {
	return token.toLowerCase() === keyword;
}

/**
 * The host format used by netrc. URLs enclose IPv6 addresses in brackets;
 * netrc entries do not.
 */
function withoutBrackets(host: string): string {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * The file with its comments gone. A line is a comment when its first non-blank
 * character is `#`, which is the whole of the comment syntax: a `#` anywhere
 * else is an ordinary character of the token it sits in.
 */
function withoutCommentLines(source: string): string {
	return source
		.split('\n')
		.filter((line) => !line.replace(/^[\t ]+/u, '').startsWith('#'))
		.join('\n');
}

/** One token, or the end of a line with no token on it. */
type NetrcToken =
	| { readonly endsLine: true; readonly isBlank: boolean }
	| { readonly endsLine: false; readonly text: string };

// The characters that separate one token from the next, which are the only two
// libcurl passes over between them.
const blanks = new Set([' ', '\t']);

/** Reads a netrc's tokens in order, raising over a line it cannot read. */
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
	 * A token that runs to the next character a token cannot contain: every
	 * character greater than a space belongs to the token. A carriage return
	 * terminates the token and is also treated as a line ending.
	 */
	private plainToken(): string {
		const start = this.at;

		while (this.source.charAt(this.at) > ' ') {
			this.at += 1;
		}

		if (this.at === start) {
			throw new NixNetrcSyntaxError('a token holding no characters');
		}

		return this.source.slice(start, this.at);
	}

	/**
	 * A token wrapped in double quotes, which is how a value carrying a blank is
	 * written. A backslash escapes the character after it, and `\n`, `\r` and
	 * `\t` name the three characters no token can hold directly.
	 */
	private quotedToken(): string {
		// The opening quote is not part of the value.
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

	/** The next token, or `undefined` at the end of the file. */
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
