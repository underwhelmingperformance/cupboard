import type { StorePathHash } from '@cupboard/nix-store/scalars';
import { type S3Committer, s3CommitterSchema } from '@cupboard/protocol/paths';
import type { S3Principal } from '@cupboard/s3/ports';

import { StoredUploadOriginInvalidError } from '../errors.ts';
import { parseStored } from '../http/parse.ts';

/**
 * Serialises the S3 credential used for a narinfo PUT. Returns undefined when
 * the principal has no credential identity.
 */
export function renderS3Committer(
	principal: S3Principal | undefined
): string | undefined {
	if (principal?.credentialId === undefined) {
		return undefined;
	}

	return JSON.stringify({
		credentialId: principal.credentialId,
		label: principal.label ?? ''
	} satisfies S3Committer);
}

/**
Parses the S3 credential stored with a narinfo.
*/
export function parseStoredS3Committer(
	storePathHash: StorePathHash,
	value: string
): S3Committer {
	return parseStored(
		s3CommitterSchema,
		value,
		(cause) => new StoredUploadOriginInvalidError(storePathHash, cause)
	);
}
