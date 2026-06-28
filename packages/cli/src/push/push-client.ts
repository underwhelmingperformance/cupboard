import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix-store/scalars';

import { cachePrefixFor, CupboardClient } from '../client/client.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { tenantRpc } from '../client/orpc.ts';

import { type PushClient } from './push.ts';

export interface PushClientOptions {
	readonly cache?: string;
	readonly signal?: AbortSignal;
	/** Test hook standing in for global fetch. */
	readonly fetcher?: typeof fetch;
}

/**
 * Builds the client a push consumes: the contract-backed conversations come
 * from the derived client with the credential and cache bound here, while the
 * presigned blob PUT and the commit WebSocket stay on the raw client.
 */
export function pushClientFor(
	url: string | URL,
	credential: AccessCredential,
	options: PushClientOptions = {}
): PushClient {
	const cache = options.cache ?? DEFAULT_CACHE;
	const cacheName = selectorForCache(cache);
	const rpc = tenantRpc(url, {
		credential,
		signal: options.signal,
		fetcher: options.fetcher
	});
	const raw = new CupboardClient(
		new URL(url),
		options.fetcher ?? fetch,
		cachePrefixFor(cache),
		options.signal
	);

	return {
		negotiate: (body) => rpc.uploads.negotiate({ cacheName, ...body }),
		prepareUpload: (uploadId, body) =>
			rpc.uploads.prepare({ cacheName, id: uploadId, ...body }),
		prepareUploads: (items) =>
			rpc.uploads.prepareBatch({ cacheName, items: [...items] }),
		uploadBlob: (upload) => raw.uploadBlob(upload),
		commit: (target, commitOptions) =>
			raw.commit(credential, target, commitOptions),
		negotiateAttestations: (body) =>
			rpc.attestations.negotiate({ cacheName, ...body }),
		prepareAttestation: (uploadId) =>
			rpc.attestations.prepare({ cacheName, id: uploadId }),
		attachAttestation: (uploadId) =>
			rpc.attestations.attach({ cacheName, id: uploadId }),
		setRoot: (name, body) => rpc.roots.set({ cacheName, name, ...body })
	};
}
