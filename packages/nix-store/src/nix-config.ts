import { NetrcControlCharacterError } from './errors.ts';
import { hasControlCharacter } from './scalars.ts';
import { canonicalHref } from './url.ts';

export interface NixConfigOptions {
	readonly netrcFile?: string;
}

export class NixConfig {
	readonly substituters: readonly URL[];

	constructor(
		substituters: URL | readonly URL[],
		public readonly publicKey: string,
		private readonly options: NixConfigOptions = {}
	) {
		this.substituters =
			substituters instanceof URL ? [substituters] : substituters;
	}

	render(): string {
		// During a key rotation `/pubkey` returns several keys, newline-separated,
		// but `trusted-public-keys` is a single space-separated line. Collapse any
		// whitespace so every published key lands in the setting.
		const trustedPublicKeys = this.publicKey.split(/\s+/).filter(Boolean);
		// Nix matches a substituter by exact string, so each URL is rendered in
		// its one canonical form.
		const substituters = this.substituters.map((url) => canonicalHref(url));

		const lines = [
			`extra-substituters = ${substituters.join(' ')}`,
			`extra-trusted-public-keys = ${trustedPublicKeys.join(' ')}`
		];

		if (this.options.netrcFile !== undefined) {
			lines.push(`netrc-file = ${this.options.netrcFile}`);
		}

		lines.push('');

		return lines.join('\n');
	}
}

/**
 * The netrc line Nix needs to read a private cache. A netrc entry is keyed by
 * machine host alone, so the machine name comes from the substituter URL: the
 * hostname without its port and, for an IPv6 literal, without the surrounding
 * brackets. Credentials that cannot sit unquoted in a netrc token are wrapped
 * in the quoted-token grammar; a control character, which no quoting can
 * encode, is refused.
 */
export function renderNetrc(url: URL, user: string, password: string): string {
	return `machine ${netrcMachine(url)} login ${netrcToken(user)} password ${netrcToken(password)}\n`;
}

function netrcMachine(url: URL): string {
	const { hostname } = url;

	return hostname.startsWith('[') && hostname.endsWith(']')
		? hostname.slice(1, -1)
		: hostname;
}

// A netrc token is whitespace-delimited, so a value carrying whitespace or the
// quoting metacharacters is emitted in libcurl's quoted-token grammar: wrapped
// in double quotes with backslash and double quote backslash-escaped. Values
// without those characters stay bare, matching a hand-written netrc.
function netrcToken(value: string): string {
	if (hasControlCharacter(value)) {
		throw new NetrcControlCharacterError();
	}

	if (!/[\s"\\#]/u.test(value)) {
		return value;
	}

	const escaped = value
		.replaceAll('\\', '\\\\')
		.replaceAll('"', String.raw`\"`);

	return `"${escaped}"`;
}
