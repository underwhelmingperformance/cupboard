import { decodeNixHash } from './hash.ts';

// The prefix a `fixed` address uses when the contents are serialised as a NAR
// before hashing. Nix reads a `git:` method here as well, behind the
// git-hashing experimental feature, so the default build cannot read an address
// that specifies it.
const nixArchivePrefix = 'r:';

/**
 * Whether Nix can parse the value as a content address. Text-addressed paths
 * use `text:<algorithm>:<digest>`. Paths addressed by the contents produced by
 * a fetch use `fixed:[r:]<algorithm>:<digest>`. Nix rejects an entire narinfo
 * when it cannot parse the `CA` field, so the narinfo reader uses this
 * validation directly.
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
