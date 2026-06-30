import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix-store/scalars';
import { type PushCredential } from '@cupboard/protocol/upload';

import { cachePrefixFor, CupboardClient } from '../client/client.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { tenantRpc } from '../client/orpc.ts';

import { type PushClient } from './push.ts';
import { type BlobUploader, r2BlobUploader } from './r2-upload.ts';

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

	// One credential per push, fetched on first use and reused. It carries the
	// signed push id every negotiate names, and scopes the uploader to the push's
	// staging prefix; a re-negotiated slot stays under that same prefix.
	let session: Promise<PushCredential> | undefined;
	const pushSession = (): Promise<PushCredential> =>
		(session ??= rpc.uploads.credential({ cacheName }));

	// The uploader is built once from the push's endpoint and bucket and renews
	// its credential through the session as it expires.
	let uploader: Promise<BlobUploader> | undefined;
	const buildUploader = async (): Promise<BlobUploader> => {
		const push = await pushSession();

		return r2BlobUploader({
			endpoint: push.endpoint,
			bucket: push.bucket,
			provider: pushSession
		});
	};
	const blobUploader = (): Promise<BlobUploader> =>
		(uploader ??= buildUploader());

	return {
		negotiate: async (body) => {
			const { pushId } = await pushSession();

			return rpc.uploads.negotiate({ cacheName, pushId, ...body });
		},
		uploadNar: async (r2Key, body) => (await blobUploader())(r2Key, body),
		commit: (target, commitOptions) =>
			raw.commit(credential, target, commitOptions),
		openCommitSession: (commitOptions) =>
			raw.openCommitSession(credential, commitOptions),
		negotiateAttestations: async (body) => {
			const { pushId } = await pushSession();

			return rpc.attestations.negotiate({ cacheName, pushId, ...body });
		},
		attachAttestation: (uploadId) =>
			rpc.attestations.attach({ cacheName, id: uploadId }),
		setRoot: (name, body) => rpc.roots.set({ cacheName, name, ...body })
	};
}
