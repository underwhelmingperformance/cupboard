import type {
	CacheGeneration,
	CacheScope,
	TenantId
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';

import {
	publicationIdSchema,
	type PushId,
	type UploadAttachRoot,
	type UploadPathNegotiation
} from './upload.ts';

export interface PublicationIdentityInput {
	readonly tenant: TenantId;
	readonly cache: CacheScope;
	readonly cacheGeneration: CacheGeneration;
	readonly pushId: PushId;
	readonly metadata: UploadPathNegotiation;
	readonly attachRoot?: UploadAttachRoot;
}

export const publicationStagingPrefix = 'staging-v2/';
export const publicationRecoveryMs = 24 * 60 * 60 * 1000;
export const publicationCleanupMarginMs = 15 * 60 * 1000;
export const publicationLifecycleSeconds = 7 * 24 * 60 * 60;
export const publicationMultipartSeconds = 48 * 60 * 60;

export const uploadConfirmPresentMaxCanonicalBytes = 2_000_000;

export interface UploadConfirmPresentCanonicalPageInput extends Omit<
	PublicationIdentityInput,
	'metadata'
> {
	readonly paths: readonly UploadPathNegotiation[];
}

/**
Encodes one publication without hashing it. Keep this encoding stable: both
publication IDs and confirmation receipts depend on its exact bytes.
*/
export function publicationCanonical(input: PublicationIdentityInput): string {
	const { metadata, attachRoot } = input;
	return JSON.stringify([
		'cupboard/publication/v1',
		input.tenant,
		input.cache.kind,
		input.cache.kind === 'named' ? input.cache.name : undefined,
		input.cacheGeneration,
		input.pushId,
		[
			metadata.storePathHash,
			metadata.storePath,
			metadata.narHash,
			metadata.narSize,
			[...new Set(metadata.references)].toSorted(byCodeUnit),
			metadata.deriver,
			metadata.ca
		],
		attachRoot === undefined
			? undefined
			: [
					attachRoot.name,
					attachRoot.retention.kind,
					attachRoot.retention.kind === 'duration'
						? attachRoot.retention.seconds
						: undefined
				]
	]);
}

/**
Preserves ConfirmationStore's ordered page domain and nested canonical strings.
*/
export function uploadConfirmPresentCanonicalPage(
	input: UploadConfirmPresentCanonicalPageInput
): string {
	const paths = input.paths.map((metadata) =>
		publicationCanonical({ ...input, metadata })
	);
	return JSON.stringify(['cupboard/confirmation/v1', paths]);
}

/**
Measures the encoded page without crypto. Clients can use any valid 63-character
ASCII tenant slug as a conservative bound without knowing the actual tenant ID.
*/
export function uploadConfirmPresentCanonicalPageByteLength(
	input: UploadConfirmPresentCanonicalPageInput
): number {
	return new TextEncoder().encode(uploadConfirmPresentCanonicalPage(input))
		.byteLength;
}

/**
Identifies one publication independently of paging and advisory cache state.
*/
export async function publicationIdentity(input: PublicationIdentityInput) {
	const canonical = publicationCanonical(input);
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical)
	);
	const id = publicationIdSchema.parse(
		Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('')
	);

	return { id, canonical };
}

/**
The private object key for one entry in a push's write namespace.
*/
export function publicationStagingKey(
	tenant: TenantId,
	pushId: PushId,
	id: string
): string {
	return `${publicationPushPrefix(tenant, pushId)}${id}.nar.zst`;
}

/**
The trailing slash restricts credentials to exactly one push.
*/
export function publicationPushPrefix(
	tenant: TenantId,
	pushId: PushId
): string {
	return `${publicationStagingPrefix}${tenant}/${pushId}/`;
}
