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

/**
Identifies one publication independently of paging and advisory cache state.
*/
export async function publicationIdentity(input: PublicationIdentityInput) {
	const { metadata, attachRoot } = input;
	const canonical = JSON.stringify([
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
