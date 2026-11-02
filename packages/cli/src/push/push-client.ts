import { rootLogger } from '@cupboard/logger';
import {
	type CacheScope,
	type StorePathHash,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { tenantContract } from '@cupboard/protocol/contract';
import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';
import {
	uploadConfirmPresentCanonicalPageByteLength,
	uploadConfirmPresentMaxCanonicalBytes
} from '@cupboard/protocol/publication';
import {
	acceptCapabilitiesHeader,
	publicationCapability,
	type PublicationEntry,
	type UploadActionDecision,
	uploadAttachRootSchema,
	uploadCapabilitiesHeader,
	uploadConfirmPresentCapability,
	uploadConfirmPresentMaxPaths,
	uploadConfirmPresentMaxRequestBytes,
	type UploadConfirmPresentPath,
	type UploadConfirmPresentRequest,
	uploadConfirmPresentRequestSchema,
	uploadConfirmPresentResponseSchema,
	type UploadDecision,
	uploadGraceFactsCapability,
	type UploadId,
	uploadNegotiateMaxPaths,
	uploadPathNegotiationSchema,
	uploadRequestMaxPathsHeader
} from '@cupboard/protocol/upload';
import { bestEffort, discardResponseBody } from '@cupboard/shared/cleanup';
import {
	type DeadlineOptions,
	lookupPage,
	requestWithDeadline
} from '@cupboard/shared/paging';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { StatusCodes } from 'http-status-codes';

import { callInCache } from '../client/cache-scoped.ts';
import type { CommitTarget } from '../client/client.ts';
import { CupboardClient } from '../client/client.ts';
import type { CommitSession } from '../client/commit-socket.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { procedureDeadline, tenantRpc } from '../client/orpc.ts';
import { CupboardHttpError } from '../errors.ts';

import { credentialSession } from './credential-session.ts';
import { type PushClient } from './push.ts';
import { type BlobUploader, r2BlobUploader } from './r2-upload.ts';

// The tenant ID is not part of credential discovery. Its longest valid ASCII
// spelling conservatively bounds every canonical page in any tenant.
const maximumConfirmationTenant = tenantIdSchema.parse('x'.repeat(63));

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
Creates a push client for one tenant and cache. Administrative calls use the
contract client, blob uploads use renewable R2 credentials, and commits use
the WebSocket client.
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
	let hasCredentialPublication = false;
	let hasCredentialConfirmation = false;
	let hasConfirmation = false;
	let protocolSelection: Promise<'publication' | 'legacy'> | undefined;
	const entries = new Map<
		UploadId,
		{
			readonly pushId: Awaited<ReturnType<typeof session.pushId>>;
			readonly entry: PublicationEntry;
			readonly upload: UploadActionDecision;
		}
	>();
	const skips = new Map<StorePathHash, UploadActionDecision>();
	const rpc = tenantRpc(url, {
		credential,
		signal: options.signal,
		fetcher: async (input, init) => {
			const request = new Request(input, init);
			const headers = new Headers(request.headers);
			headers.set(
				acceptCapabilitiesHeader,
				`${publicationCapability},${uploadConfirmPresentCapability}`
			);
			const response = await baseFetcher(new Request(request, { headers }));
			if (request.url.endsWith('/uploads/credential')) {
				const capabilities = new Set(
					response.headers
						.get(uploadCapabilitiesHeader)
						?.split(',')
						.map((value) => value.trim())
				);
				hasCredentialPublication = capabilities.has(publicationCapability);
				hasCredentialConfirmation = capabilities.has(
					uploadConfirmPresentCapability
				);
			}
			return response;
		}
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
	// change. A request without paths still reaches the server for capability
	// and lifecycle information.
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

	const publicationTarget = (target: CommitTarget): CommitTarget => {
		const publication = entries.get(target.uploadId);
		return publication === undefined
			? target
			: {
					...target,
					publication: { pushId: publication.pushId, entry: publication.entry }
				};
	};
	const wrapSession = (commitSession: CommitSession): CommitSession => ({
		...commitSession,
		commit: (target) => commitSession.commit(publicationTarget(target))
	});

	const selectPublicationProtocol = async (): Promise<
		'publication' | 'legacy'
	> => {
		await session.provider();
		if (!hasCredentialPublication) {
			rootLogger().debug('publication protocol selected', {
				protocol: 'legacy',
				hasCredentialCapability: false
			});
			return 'legacy';
		}
		const ready = Promise.withResolvers<boolean>();
		const probe = await raw.openCommitSession(credential, {
			onFailure: (error) => {
				ready.reject(error);
			},
			onCapabilities: (capabilities) => {
				hasConfirmation =
					hasCredentialConfirmation &&
					capabilities.has(uploadConfirmPresentCapability);
				ready.resolve(capabilities.has(publicationCapability));
			}
		});
		try {
			const hasCapability = await requestWithDeadline(() => ready.promise, {
				target: { procedure: 'publication capability' },
				deadlineMs: probeDeadlineMs,
				signal: options.signal,
				replaySafety: 'replay-unsafe'
			});
			rootLogger().debug('publication protocol selected', {
				protocol: hasCapability ? publicationCapability : 'legacy',
				hasCredentialCapability: true,
				hasSocketCapability: hasCapability
			});
			return hasCapability ? 'publication' : 'legacy';
		} catch (error) {
			if (
				!(error instanceof CupboardHttpError) ||
				error.status !== notFoundStatus
			) {
				throw error;
			}
			rootLogger().debug('publication protocol selected', {
				protocol: 'legacy',
				reason: 'commit-probe-not-found'
			});
			return 'legacy';
		} finally {
			probe.close();
		}
	};
	const publicationProtocol = (): Promise<'publication' | 'legacy'> =>
		(protocolSelection ??= selectPublicationProtocol());

	const planDeadline = procedureDeadline(
		'uploads.plan',
		tenantContract.uploads.plan.inDefaultCache,
		{ signal: options.signal }
	);
	const plan = async (body: Parameters<PushClient['negotiate']>[0]) => {
		const pushId = await session.pushId();
		const uploads = await decisionPages(
			body.paths,
			planDeadline,
			async (paths, signal) => {
				const result = await callInCache(
					rpc.uploads.plan,
					cache,
					{
						pushId,
						paths,
						...(body.attachRoot !== undefined && {
							attachRoot: body.attachRoot
						})
					},
					{ signal }
				);
				return result.uploads.map((decision, index): UploadDecision => {
					const requested = paths[index];
					const metadata =
						requested === undefined
							? undefined
							: uploadPathNegotiationSchema.parse(requested);
					if (metadata === undefined) {
						throw new Error('The publication plan omitted path metadata.');
					}
					const entry: PublicationEntry = {
						operationId: decision.operationId,
						cacheGeneration: result.cacheGeneration,
						metadata,
						...(body.attachRoot !== undefined && {
							attachRoot: uploadAttachRootSchema.parse(body.attachRoot)
						})
					};
					const upload: UploadActionDecision = {
						action: 'upload',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash,
						uploadId: decision.operationId,
						r2Key: decision.r2Key,
						expiresAt: result.pushExpiresAt
					};
					entries.set(entry.operationId, { pushId, entry, upload });
					if (decision.action === 'skip') {
						const skip: UploadDecision = {
							action: 'skip',
							storePathHash: decision.storePathHash,
							narHash: decision.narHash
						};
						skips.set(skip.storePathHash, upload);
						return skip;
					}
					return decision.action === 'upload'
						? upload
						: {
								action: 'commit',
								storePathHash: decision.storePathHash,
								narHash: decision.narHash,
								uploadId: decision.operationId
							};
				});
			}
		);
		return { uploads, hasUploadGraceFacts: true };
	};

	const confirmationDeadline = procedureDeadline(
		'uploads.confirmPresent',
		tenantContract.uploads.confirmPresent.inDefaultCache,
		{ signal: options.signal }
	);

	return {
		confirmPresent: async (decisions) => {
			const protocol = await publicationProtocol();
			if (!hasConfirmation || protocol !== 'publication') {
				return;
			}
			const selected = decisions.map((decision) => {
				const upload = skips.get(decision.storePathHash);
				const publication =
					upload === undefined ? undefined : entries.get(upload.uploadId);
				if (publication === undefined) {
					throw new Error(
						'Cannot confirm a path without its publication plan.'
					);
				}
				return publication;
			});
			const pages: UploadConfirmPresentRequest[] = [];
			const bodyFor = (
				publication: (typeof selected)[number],
				paths: UploadConfirmPresentRequest['paths']
			): UploadConfirmPresentRequest =>
				uploadConfirmPresentRequestSchema.parse({
					pushId: publication.pushId,
					cacheGeneration: publication.entry.cacheGeneration,
					paths,
					...(publication.entry.attachRoot !== undefined && {
						attachRoot: publication.entry.attachRoot
					})
				});
			const isEligiblePage = (body: UploadConfirmPresentRequest): boolean =>
				new TextEncoder().encode(JSON.stringify(body)).byteLength <=
					uploadConfirmPresentMaxRequestBytes &&
				uploadConfirmPresentCanonicalPageByteLength({
					tenant: maximumConfirmationTenant,
					cache,
					...body
				}) <= uploadConfirmPresentMaxCanonicalBytes;
			let page: UploadConfirmPresentRequest | undefined;
			for (const publication of selected) {
				if (
					page !== undefined &&
					(page.paths.length === uploadConfirmPresentMaxPaths ||
						page.pushId !== publication.pushId ||
						page.cacheGeneration !== publication.entry.cacheGeneration ||
						JSON.stringify(page.attachRoot) !==
							JSON.stringify(publication.entry.attachRoot))
				) {
					pages.push(page);
					page = undefined;
				}
				const candidate = bodyFor(publication, [
					...(page?.paths ?? []),
					publication.entry.metadata
				]);
				if (isEligiblePage(candidate)) {
					page = candidate;
					continue;
				}
				// An individually ineligible path uses its original publication ID.
				// This is selected before sending, never after an ambiguous reply.
				if (page === undefined) {
					continue;
				}
				pages.push(page);
				page = undefined;
				const single = bodyFor(publication, [publication.entry.metadata]);
				if (isEligiblePage(single)) {
					page = single;
				}
			}
			if (page !== undefined) {
				pages.push(page);
			}
			const paths = new Map<StorePathHash, UploadConfirmPresentPath>();
			// Freeze every page boundary before the first request. Each retry sends
			// the same parsed body, with no adaptive shrinking or regrouping.
			for (const body of pages) {
				const response = await requestWithDeadline(async (signal) => {
					const result = uploadConfirmPresentResponseSchema.parse(
						await callInCache(rpc.uploads.confirmPresent, cache, body, {
							signal
						})
					);
					signal.throwIfAborted();
					if (
						result.paths.length !== body.paths.length ||
						result.paths.some(
							(path, index) =>
								path.storePathHash !== body.paths[index]?.storePathHash
						)
					) {
						throw new Error(
							'The confirmation response changed path count, order or identity.'
						);
					}
					return result;
				}, confirmationDeadline);
				for (const path of response.paths) {
					paths.set(path.storePathHash, path);
				}
			}
			return {
				paths: selected.map(
					({ entry }) =>
						paths.get(entry.metadata.storePathHash) ?? {
							storePathHash: entry.metadata.storePathHash,
							status: 'needs-publication'
						}
				)
			};
		},
		publicationFor: (decision) =>
			decision.action === 'skip'
				? skips.get(decision.storePathHash)
				: entries.get(decision.uploadId)?.upload,
		negotiate: async (body) => {
			if ((await publicationProtocol()) === 'publication') {
				return plan(body);
			}
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

			if ((await publicationProtocol()) === 'publication') {
				return true;
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
			raw.commit(credential, publicationTarget(target), commitOptions),
		openCommitSession: (commitOptions) => {
			let connection: Promise<CommitSession> | undefined;
			let isClosed = false;
			const open = async (): Promise<CommitSession> =>
				wrapSession(
					await raw.openCommitSession(credential, {
						...commitOptions,
						pushId: () => session.pushId()
					})
				);
			const get = (): Promise<CommitSession> => {
				if (isClosed) {
					throw new Error('The commit session is closed.');
				}
				connection ??= open();
				return connection;
			};
			return Promise.resolve({
				commit: async (target) => {
					const opened = await get();
					return opened.commit(target);
				},
				renewUploads: async (ids) => {
					const opened = await get();
					await opened.renewUploads?.(ids);
				},
				close: () => {
					isClosed = true;
					void bestEffort(async () => {
						const opened = await connection;
						opened?.close();
					});
				}
			});
		},
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
