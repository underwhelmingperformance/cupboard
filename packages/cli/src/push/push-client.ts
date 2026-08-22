import { selectorForCache } from '@cupboard/nix-store/scalars';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadGraceFactsCapability
} from '@cupboard/protocol/upload';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { StatusCodes } from 'http-status-codes';

import {
	cachePrefixFor,
	CupboardClient,
	storedCacheFor
} from '../client/client.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { tenantRpc } from '../client/orpc.ts';
import { resilientFetcher } from '../client/transport.ts';

import { credentialSession } from './credential-session.ts';
import { type PushClient } from './push.ts';
import { type BlobUploader, r2BlobUploader } from './r2-upload.ts';

const notFoundStatus: number = StatusCodes.NOT_FOUND;

export interface PushClientOptions {
	readonly cache?: string;
	readonly signal?: AbortSignal;
	readonly fetcher?: typeof fetch;
}

/**
 * Creates a push client for one tenant and cache. Administrative calls use the
 * contract client, blob uploads use renewable R2 credentials, and commits use
 * the WebSocket client.
 */
export function pushClientFor(
	url: URL,
	credential: AccessCredential,
	options: PushClientOptions = {}
): PushClient {
	const cache = storedCacheFor(options.cache);
	const cacheName = selectorForCache(cache);
	const baseFetcher = options.fetcher ?? fetch;
	let hasUploadGraceFacts = false;
	const uploadFetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.set(acceptCapabilitiesHeader, uploadGraceFactsCapability);
		const response = await baseFetcher(new Request(request, { headers }));
		hasUploadGraceFacts =
			response.headers
				.get(uploadCapabilitiesHeader)
				?.split(',')
				.some(
					(capability) => capability.trim() === uploadGraceFactsCapability
				) ?? false;

		return response;
	};
	const rpc = tenantRpc(url, {
		credential,
		signal: options.signal,
		fetcher: options.fetcher
	});
	const uploadRpc = tenantRpc(url, {
		credential,
		signal: options.signal,
		fetcher: uploadFetcher
	});
	const raw = new CupboardClient(
		new URL(url),
		resilientFetcher(options.fetcher ?? fetch),
		cachePrefixFor(cache),
		options.signal
	);

	const session = credentialSession((pushId) =>
		rpc.uploads.credential({ cacheName, pushId })
	);

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
		negotiate: async (body) => {
			hasUploadGraceFacts = false;

			return uploadRpc.uploads.negotiate({
				cacheName,
				pushId: await session.pushId(),
				...body
			});
		},
		// Never touches the credential session: a dry run requests no upload
		// credential, so preview must not negotiate a pushId to get one.
		preview: async (body) => {
			hasUploadGraceFacts = false;

			return uploadRpc.uploads.preview({ cacheName, ...body });
		},
		probeUploadGraceFacts: async (kind) => {
			hasUploadGraceFacts = false;

			if (kind === 'preview') {
				await uploadRpc.uploads.preview({ cacheName, paths: [] });
			} else {
				await uploadRpc.uploads.negotiate({
					cacheName,
					pushId: await session.pushId(),
					paths: []
				});
			}

			return hasUploadGraceFacts;
		},
		hasUploadGraceFacts: () => hasUploadGraceFacts,
		// Every server version implements nix-cache-info. A private tenant returns
		// 401, so only a routing 404 means that the tenant does not exist.
		tenantServes: async () => {
			const target = new URL(url);
			target.pathname = `${target.pathname.replace(/\/+$/u, '')}/nix-cache-info`;
			const response = await (options.fetcher ?? fetch)(target, {
				signal: options.signal
			});
			await discardResponseBody(response);

			return response.status !== notFoundStatus;
		},
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
