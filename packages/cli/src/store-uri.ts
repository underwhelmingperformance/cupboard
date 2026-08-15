import { parseSshNgStoreUri } from '@cupboard/nix';

import { InvalidStoreUriError } from './errors.ts';

/**
 * The `--store` option parser: the remote store a command queries for path
 * metadata and NAR bytes. The remote store modes are built on `ssh-ng`, so only
 * an `ssh-ng://` URI with an SSH destination in its authority is accepted;
 * anything else is refused with a typed error at the command boundary.
 */
export function parseStoreUri(value: string): string {
	let parsed: ReturnType<typeof parseSshNgStoreUri>;

	try {
		parsed = parseSshNgStoreUri(value);
	} catch (error) {
		throw new InvalidStoreUriError(value, { cause: error });
	}

	if (parsed === undefined) {
		throw new InvalidStoreUriError(value);
	}

	return value;
}
