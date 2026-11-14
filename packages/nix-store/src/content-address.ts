import { isContentAddressHash } from './hash.ts';

// `r:` and `git:` are the method prefixes that can follow `fixed:`. Nix reads
// `git:` only when its `git-hashing` experimental feature is enabled.
const methodPrefixes = ['r:', 'git:'];

/**
Returns whether the value is a content address that Nix reads:
`text:<hash>`, `fixed:<hash>`, `fixed:r:<hash>` or `fixed:git:<hash>`, where
`<hash>` is `<algorithm>:<digest>`.

Nix reads the `git` method and the `blake3` algorithm only when the
`git-hashing` and `blake3-hashes` experimental features are enabled. The
narinfo of a path records a content address that another Nix produced, and
cupboard does not interpret it, so this accepts the values that Nix accepts
with every feature enabled.
*/
export function isContentAddress(value: string): boolean {
	const separator = value.indexOf(':');

	if (separator === -1) {
		return false;
	}

	const method = value.slice(0, separator);
	const rest = value.slice(separator + 1);

	if (method === 'text') {
		return isContentAddressHash(rest);
	}

	if (method !== 'fixed') {
		return false;
	}

	const prefix = methodPrefixes.find((candidate) => rest.startsWith(candidate));

	return isContentAddressHash(
		prefix === undefined ? rest : rest.slice(prefix.length)
	);
}
