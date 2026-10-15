import { type CacheScope } from '@cupboard/nix-store/scalars';
import { tenantContract } from '@cupboard/protocol/contract';
import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadGraceFactsCapability,
	uploadNegotiateMaxPaths,
	uploadRequestMaxPathsHeader
} from '@cupboard/protocol/upload';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import {
	type DeadlineOptions,
	lookupPage,
	requestWithDeadline
} from '@cupboard/shared/paging';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { StatusCodes } from 'http-status-codes';

import { callInCache } from '../client/cache-scoped.ts';
import { CupboardClient } from '../client/client.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { procedureDeadline, tenantRpc } from '../client/orpc.ts';

import { credentialSession } from './credential-session.ts';
import { type PushClient } from './push.ts';
import { type BlobUploader, r2BlobUploader } from './r2-upload.ts';

const notFoundStatus: number = StatusCodes.NOT_FOUND;
// A missing canonical NAR also retires its old narinfo and reference. Leave
// nine D1/R2 calls per path for that cleanup and the R2 presence probe.
const negotiationSubrequestsPerPath = 9;
const negotiationPageSize = Math.floor(
	(workersInvocationAllowances.free.subrequests - subrequestSafetyReserve) /
		negotiationSubrequestsPerPath
);
// The server creates a pending upload with a fresh identifier for each path
// on a negotiation page, so a page whose deadline expires is not sent again,
// and the push fails. No retry can rescue a slow but healthy page, so its
// single attempt gets a longer deadline than a replay-safe request.
const negotiationPageDeadlineMs = 4 * probeDeadlineMs;

export interface PushClientOptions {
	readonly cache: CacheScope;
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
	options: PushClientOptions
): PushClient {
	const cache = options.cache;
	const baseFetcher = options.fetcher ?? fetch;
	let pageSize = negotiationPageSize;
	// Each attempt gets its own client, so a concurrent call or an attempt that
	// missed its deadline cannot overwrite the capabilities of the answer that
	// is used.
	const acknowledged = async <Result>(
		signal: AbortSignal,
		call: (rpc: ReturnType<typeof tenantRpc>) => Promise<Result>
	): Promise<{
		readonly result: Result;
		readonly hasUploadGraceFacts: boolean;
	}> => {
		let hasUploadGraceFacts = false;
		let advertisedPageSize: number | undefined;
		const fetcher: typeof fetch = async (input, init) => {
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

			const advertised = Number(
				response.headers.get(uploadRequestMaxPathsHeader)
			);
			if (response.ok && Number.isSafeInteger(advertised) && advertised > 0) {
				advertisedPageSize = Math.min(advertised, uploadNegotiateMaxPaths);
			}

			return response;
		};
		const result = await call(
			tenantRpc(url, { credential, signal: options.signal, fetcher })
		);

		// An attempt can answer after its deadline has aborted its signal.
		// Discard that answer.
		signal.throwIfAborted();
		pageSize = advertisedPageSize ?? pageSize;

		return { result, hasUploadGraceFacts };
	};
	const rpc = tenantRpc(url, {
		credential,
		signal: options.signal,
		fetcher: options.fetcher
	});
	const raw = new CupboardClient(
		new URL(url),
		options.fetcher ?? fetch,
		cache,
		options.signal
	);

	const session = credentialSession((pushId) =>
		callInCache(rpc.uploads.credential, cache, { pushId })
	);

	let uploader: Promise<BlobUploader> | undefined;
	const buildUploader = async (): Promise<BlobUploader> => {
		const push = await session.provider();

		return r2BlobUploader({
			endpoint: push.endpoint,
			bucket: push.bucket,
			provider: session.provider,
			...(options.signal !== undefined && { signal: options.signal })
		});
	};
	const blobUploader = (): Promise<BlobUploader> =>
		(uploader ??= buildUploader());

	const negotiationDeadline = procedureDeadline(
		'uploads.negotiate',
		tenantContract.uploads.negotiate.inDefaultCache,
		{ signal: options.signal, deadlineMs: negotiationPageDeadlineMs }
	);
	const previewDeadline = procedureDeadline(
		'uploads.preview',
		tenantContract.uploads.preview.inDefaultCache,
		{ signal: options.signal }
	);
	// Sends the paths in pages of at most `pageSize`, which a response can
	// change. A request without paths still reaches the server: it can bind a
	// run root, and its response shows whether the server acknowledges grace
	// facts.
	const decisionPages = async <Path, Decision>(
		paths: readonly Path[],
		deadline: DeadlineOptions,
		send: (paths: Path[], signal: AbortSignal) => Promise<Decision[]>
	): Promise<Decision[]> => {
		if (paths.length === 0) {
			return requestWithDeadline((signal) => send([], signal), deadline);
		}

		return lookupPage(paths, {
			deadline,
			requestSize: () => pageSize,
			request: (page, signal) => send([...page], signal)
		});
	};

	return {
		negotiate: async (body) => {
			const pushId = await session.pushId();
			let hasGraceFactsForEveryPage = true;

			const uploads = await decisionPages(
				body.paths,
				negotiationDeadline,
				async (paths, signal) => {
					const page = await acknowledged(signal, (rpc) =>
						callInCache(
							rpc.uploads.negotiate,
							cache,
							{
								pushId,
								paths,
								...(body.attachRoot !== undefined && {
									attachRoot: body.attachRoot
								})
							},
							{ signal }
						)
					);
					hasGraceFactsForEveryPage &&= page.hasUploadGraceFacts;

					return page.result.uploads;
				}
			);

			return { uploads, hasUploadGraceFacts: hasGraceFactsForEveryPage };
		},
		// Never touches the credential session: a dry run requests no upload
		// credential, so preview must not negotiate a pushId to get one.
		preview: async (body) => {
			let hasGraceFactsForEveryPage = true;

			const uploads = await decisionPages(
				body.paths,
				previewDeadline,
				async (paths, signal) => {
					const page = await acknowledged(signal, (rpc) =>
						callInCache(rpc.uploads.preview, cache, { paths }, { signal })
					);
					hasGraceFactsForEveryPage &&= page.hasUploadGraceFacts;

					return page.result.uploads;
				}
			);

			return { uploads, hasUploadGraceFacts: hasGraceFactsForEveryPage };
		},
		probeUploadGraceFacts: async (kind) => {
			if (kind === 'preview') {
				const probe = await requestWithDeadline(
					(signal) =>
						acknowledged(signal, (rpc) =>
							callInCache(rpc.uploads.preview, cache, { paths: [] }, { signal })
						),
					previewDeadline
				);

				return probe.hasUploadGraceFacts;
			}

			const pushId = await session.pushId();
			const probe = await requestWithDeadline(
				(signal) =>
					acknowledged(signal, (rpc) =>
						callInCache(
							rpc.uploads.negotiate,
							cache,
							{ pushId, paths: [] },
							{ signal }
						)
					),
				negotiationDeadline
			);

			return probe.hasUploadGraceFacts;
		},
		// Every server version implements nix-cache-info. A private default cache
		// returns 401, so only a routing 404 means that the tenant does not exist.
		tenantServes: async () => {
			const target = new URL(url);
			target.pathname = `${target.pathname.replace(/\/+$/u, '')}/nix-cache-info`;
			const response = await (options.fetcher ?? fetch)(target, {
				signal: options.signal
			});
			await discardResponseBody(response);

			return response.status !== notFoundStatus;
		},
		uploadNar: async (r2Key, body) => {
			const uploader = await blobUploader();

			await uploader.uploadBytes(r2Key, body);
		},
		uploadCompressedNar: async (r2Key, source, narSize, observer) => {
			const uploader = await blobUploader();

			return uploader.uploadNar(r2Key, source, narSize, observer);
		},
		commit: (target, commitOptions) =>
			raw.commit(credential, target, commitOptions),
		openCommitSession: (commitOptions) =>
			raw.openCommitSession(credential, {
				...commitOptions,
				pushId: () => session.pushId()
			}),
		negotiateAttestations: async (body) =>
			callInCache(rpc.attestations.negotiate, cache, {
				pushId: await session.pushId(),
				...body
			}),
		attachAttestation: (uploadId) =>
			callInCache(rpc.attestations.attach, cache, { id: uploadId }),
		negotiateAttestationBundles: async (body) =>
			callInCache(rpc.attestations.negotiateBundles, cache, {
				pushId: await session.pushId(),
				...body
			}),
		attachAttestationPaths: (uploadId, body) =>
			callInCache(rpc.attestations.attachPaths, cache, {
				id: uploadId,
				storePathHashes: [...body.storePathHashes]
			}),
		setRoot: (name, body) =>
			callInCache(rpc.roots.set, cache, { name, ...body })
	};
}
