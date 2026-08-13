import { decodeNixHash } from './hash.ts';

// What a `fixed` address serialises before hashing it. Nix reads a `git:`
// method here as well, behind the git-hashing experimental feature, so an
// address naming it states a method a stock Nix has no reading of.
const nixArchivePrefix = 'r:';

/**
 * Whether the value is a content address Nix reads: `text:<algorithm>:<digest>`
 * for a path addressed by its own contents, or `fixed:[r:]<algorithm>:<digest>`
 * for one addressed by the contents a fetch would produce. The digest is one
 * the algorithm writes. A narinfo carrying a `CA` field Nix cannot read is a
 * document Nix refuses entire, so a reader has to decide this the same way.
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
