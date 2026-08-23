import { decodeNixHash } from './hash.ts';

// In the default grammar, `r:` is the only optional method prefix after
// `fixed:`. The `git:` method requires Nix's `git-hashing` experimental feature
// and is outside this parser's grammar.
const nixArchivePrefix = 'r:';

/**
 * Returns whether the value uses a default Nix content-address form supported
 * by this parser: `text:<algorithm>:<digest>` or
 * `fixed:[r:]<algorithm>:<digest>`.
 */
export function isContentAddress(value: string): boolean {
	const separator = value.indexOf(':');

	if (separator === -1) {
		return false;
	}

	const method = value.slice(0, separator);
	const rest = value.slice(separator + 1);

	if (method === 'text') {
		return decodeNixHash(rest) !== undefined;
	}

	if (method !== 'fixed') {
		return false;
	}

	return (
		decodeNixHash(
			rest.startsWith(nixArchivePrefix)
				? rest.slice(nixArchivePrefix.length)
				: rest
		) !== undefined
	);
}
