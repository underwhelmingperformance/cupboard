import {
	type UploadOrigin,
	uploadOriginSchema
} from '@cupboard/protocol/paths';
import type { S3Principal } from '@cupboard/s3/ports';

/**
 * The stored origin for an S3 principal, or undefined when the request carries
 * no credential identity, so the column is left null for a native CLI push.
 */
export function renderUploadOrigin(
	principal: S3Principal | undefined
): string | undefined {
	if (principal?.credentialId === undefined) {
		return undefined;
	}

	return JSON.stringify({
		credentialId: principal.credentialId,
		label: principal.label ?? ''
	} satisfies UploadOrigin);
}

/** Parses a stored origin column back into its descriptor, or undefined. */
export function parseUploadOrigin(
	value: string | undefined
): UploadOrigin | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = uploadOriginSchema.safeParse(safeJsonParse(value));
	return parsed.success ? parsed.data : undefined;
}

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}
