import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix-store/scalars';

import { cachePrefixFor, CupboardClient } from '../client/client.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { tenantRpc } from '../client/orpc.ts';
import { resilientFetcher } from '../client/transport.ts';

import { credentialSession } from './credential-session.ts';
import { type PushClient } from './push.ts';
import { type BlobUploader, r2BlobUploader } from './r2-upload.ts';

export interface PushClientOptions {
	readonly cache?: string;
	readonly signal?: AbortSignal;
	/** Test hook standing in for global fetch. */
	readonly fetcher?: typeof fetch;
}

/**
 * Builds the client a push consumes: the contract-backed conversations come from
 * the derived client with the access credential and cache bound here, the blobs
 * stream to R2 with the renewing push credential, and the commit WebSocket stays
 * on the raw client.
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
		resilientFetcher(options.fetcher ?? fetch),
		cachePrefixFor(cache),
		options.signal
	);

	// One credential for the whole push, renewed as it nears expiry. It carries
	// the signed push id every negotiate names and scopes the uploader to the
	// push's staging prefix; a renewal re-issues against the same id, so a push
	// longer than a single credential's life keeps streaming under that prefix.
	const session = credentialSession((pushId) =>
		rpc.uploads.credential({ cacheName, pushId })
	);

	// The uploader binds to the push's endpoint and bucket once, then signs each
	// upload with the credential the session renews.
	let uploader: Promise<BlobUploader> | undefined;
	const buildUploader = async (): Promise<BlobUploader> => {
		const push = await session.provider();

		return r2BlobUploader({
			endpoint: push.endpoint,
			bucket: push.bucket,
			provider: session.provider
		});
	};
	const blobUploader = (): Promise<BlobUploader> =>
		(uploader ??= buildUploader());

	return {
		negotiate: async (body) =>
			rpc.uploads.negotiate({
				cacheName,
				pushId: await session.pushId(),
				...body
			}),
		uploadNar: async (r2Key, body) => (await blobUploader())(r2Key, body),
		commit: (target, commitOptions) =>
			raw.commit(credential, target, commitOptions),
		openCommitSession: (commitOptions) =>
			raw.openCommitSession(credential, commitOptions),
		negotiateAttestations: async (body) =>
			rpc.attestations.negotiate({
				cacheName,
				pushId: await session.pushId(),
				...body
			}),
		attachAttestation: (uploadId) =>
			rpc.attestations.attach({ cacheName, id: uploadId }),
		setRoot: (name, body) => rpc.roots.set({ cacheName, name, ...body })
	};
}
