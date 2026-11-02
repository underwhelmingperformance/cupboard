import { type CacheScope, isSameCacheScope } from '@cupboard/nix-store/scalars';
import {
	type CompactPublicationSet,
	createPublicationRequestId,
	type PublicationCaptureBeginRequest,
	publicationCaptureBeginResponseSchema,
	type PublicationCapturePageRequest,
	publicationCapturePageResponseSchema,
	type PublicationCaptureSealRequest,
	publicationCaptureSealResponseSchema,
	type PublicationEnsureRequest,
	publicationEnsureResponseSchema,
	publicationLookupMaxResults,
	type PublicationLookupRequest,
	publicationLookupRequestSchema,
	type PublicationLookupResponse,
	publicationLookupResponseSchema,
	type PublicationLookupTarget,
	publicationManifestMaxMembers,
	publicationManifestMaxRequestBytes,
	publicationManifestPageMaxMembers,
	type PublicationOperationId,
	type PublicationPathVersion,
	type PublicationResultIdentity,
	type PublicationStatusRequest,
	publicationStatusResponseSchema,
	type RecordedPublication
} from '@cupboard/protocol/publication-manifests';
import {
	publicationCaptureBindingSchema,
	type PublicationCaptureCheckpoint,
	publicationCaptureCheckpointSchema,
	publicationCaptureCheckpointUpdateSchema,
	type PublicationCaptureState,
	publicationCaptureStateSchema,
	type PublicationWorkflowCaptureInput,
	publicationWorkflowCaptureInputSchema,
	type PublicationWorkflowEnsureInput,
	publicationWorkflowEnsureInputSchema,
	type PublicationWorkflowExecutionContext
} from '@cupboard/protocol/publication-workflow';
import {
	type PushId,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { CodedError, transientExitCode } from '@cupboard/shared/errors';
import { requestWithDeadline } from '@cupboard/shared/paging';
import { abortableSleep } from '@cupboard/shared/retry';
import { attemptWithDeadline } from '@cupboard/shared/timeout';

import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';

/**
All production procedures come from tenantRpc; unknown outputs are parsed even with injected clients.
*/
export interface PublicationWorkflowClient {
	readonly publication: {
		readonly lookup: CacheScopedClient<PublicationLookupRequest, unknown>;
		readonly captureBegin: CacheScopedClient<
			PublicationCaptureBeginRequest,
			unknown
		>;
		readonly capturePage: CacheScopedClient<
			PublicationCapturePageRequest,
			unknown
		>;
		readonly captureSeal: CacheScopedClient<
			PublicationCaptureSealRequest,
			unknown
		>;
		readonly ensure: CacheScopedClient<PublicationEnsureRequest, unknown>;
		readonly status: CacheScopedClient<PublicationStatusRequest, unknown>;
	};
	readonly plan: CacheScopedClient<{ pushId: PushId; paths: [] }, unknown>;
}

export interface PublicationWorkflowOptions {
	readonly pushId: () => Promise<PushId>;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly requestDeadlineMs?: number;
	readonly sleep?: (
		milliseconds: number,
		signal?: AbortSignal
	) => Promise<void>;
}

export class PublicationWorkflowError extends CodedError {
	constructor(message: string) {
		super(message);
		this.name = 'PublicationWorkflowError';
	}
}

export class PublicationWorkflowTimeoutError extends CodedError {
	constructor() {
		super(
			'The recorded publication did not finish before its deadline. Retry the same request ID.'
		);
		this.name = 'PublicationWorkflowTimeoutError';
	}
	override get exitCode(): number {
		return transientExitCode;
	}
}

/**
Packs the actual serialised UTF-8 request, not an estimated per-member size.
*/
export function packPublicationRequests<T>(
	values: readonly T[],
	maximumCount: number,
	body: (page: readonly T[]) => object,
	maximumBytes = publicationManifestMaxRequestBytes
): T[][] {
	const pages: T[][] = [];
	let page: T[] = [];
	for (const value of values) {
		const candidate = [...page, value];
		if (
			candidate.length <= maximumCount &&
			Buffer.byteLength(JSON.stringify(body(candidate))) <= maximumBytes
		) {
			page = candidate;
			continue;
		}
		if (page.length === 0) {
			throw new PublicationWorkflowError(
				'One publication request exceeds its raw bytes limit.'
			);
		}
		pages.push(page);
		page = [value];
		if (Buffer.byteLength(JSON.stringify(body(page))) > maximumBytes) {
			throw new PublicationWorkflowError(
				'One publication request exceeds its raw bytes limit.'
			);
		}
	}
	if (page.length > 0) {
		pages.push(page);
	}
	return pages;
}

function isMatchingTarget(
	actual: PublicationResultIdentity,
	target: PublicationLookupTarget
): boolean {
	return (
		actual.storePath === target.storePath &&
		(target.narHash === undefined || actual.narHash === target.narHash) &&
		(target.generation === undefined || actual.generation === target.generation)
	);
}

function isSameResult(
	left: PublicationResultIdentity,
	right: PublicationResultIdentity
): boolean {
	return (
		isMatchingTarget(left, right) &&
		isSameCacheScope(left.cache, right.cache) &&
		left.cacheGeneration === right.cacheGeneration
	);
}

function requireIdentity(isValid: boolean): asserts isValid {
	if (!isValid) {
		throw new PublicationWorkflowError(
			'The publication response does not match the requested identity.'
		);
	}
}

function entryResult(
	entry: PublicationLookupResponse['entries'][number]
): PublicationResultIdentity {
	if (entry.kind === 'unavailable') {
		throw new PublicationWorkflowError(
			`The publication member is unavailable: ${entry.storePath}.`
		);
	}
	return entry.kind === 'missing' ? entry.result : entry.publication.result;
}

export function createPublicationWorkflow(
	cache: CacheScope,
	client: PublicationWorkflowClient,
	options: PublicationWorkflowOptions
) {
	cache = structuredClone(cache);
	const bounded = <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> =>
		attemptWithDeadline(
			work,
			options.timeoutMs ?? 10 * 60 * 1000,
			() => new PublicationWorkflowTimeoutError(),
			options.signal
		);
	const call = <I extends object>(
		name: string,
		procedure: CacheScopedClient<I, unknown>,
		input: I,
		signal: AbortSignal
	): Promise<unknown> => {
		// Retries share this immutable snapshot, including all replay identifiers.
		const snapshot = structuredClone(input);
		return requestWithDeadline(
			async (attemptSignal) => {
				const answer = await callInCache(
					procedure,
					cache,
					structuredClone(snapshot),
					{
						signal: attemptSignal
					}
				);
				attemptSignal.throwIfAborted();
				return answer;
			},
			{
				target: { procedure: name },
				replaySafety: 'replay-safe',
				signal,
				...(options.requestDeadlineMs !== undefined && {
					deadlineMs: options.requestDeadlineMs
				})
			}
		);
	};
	const pause = (attempt: number, signal: AbortSignal): Promise<void> =>
		(options.sleep ?? abortableSleep)(
			Math.min(250 * 2 ** Math.min(attempt, 5), 5000),
			signal
		);
	const lookup = async (
		input: PublicationLookupRequest,
		signal: AbortSignal
	): Promise<PublicationLookupResponse> => {
		const keys = input.results.map((target) =>
			JSON.stringify([target.storePath, target.narHash, target.generation])
		);
		requireIdentity(new Set(keys).size === keys.length);
		const entries: PublicationLookupResponse['entries'] = [];
		let sourceSelector: PublicationLookupResponse['sourceSelector'];
		let source = input.source;
		const pages = packPublicationRequests(
			input.results,
			publicationLookupMaxResults,
			(results) => ({
				source,
				results,
				...(cache.kind === 'named' && { cacheName: cache.name })
			})
		);
		requireIdentity(pages.length > 0);
		for (let page = 0; page < pages.length; page += 1) {
			const remaining = pages[page];
			requireIdentity(remaining !== undefined);
			const repacked = packPublicationRequests(
				remaining,
				publicationLookupMaxResults,
				(results) => ({
					source,
					results,
					...(cache.kind === 'named' && { cacheName: cache.name })
				})
			);
			const results = repacked[0];
			requireIdentity(results !== undefined);
			pages.splice(page, 1, ...repacked);
			const request = publicationLookupRequestSchema.parse({ source, results });
			const response = publicationLookupResponseSchema.parse(
				await call(
					'publication.lookup',
					client.publication.lookup,
					request,
					signal
				)
			);
			requireIdentity(response.entries.length === results.length);
			for (const [index, entry] of response.entries.entries()) {
				const target = results[index];
				if (entry.kind === 'unavailable') {
					requireIdentity(
						entry.storePath === target?.storePath &&
							target.narHash === undefined &&
							target.generation === undefined
					);
					continue;
				}
				const actual = entryResult(entry);
				requireIdentity(
					target !== undefined && isMatchingTarget(actual, target)
				);
				if (source.cache !== undefined) {
					requireIdentity(isSameCacheScope(actual.cache, source.cache));
				}
				if (source.expectedCacheGeneration !== undefined) {
					requireIdentity(
						actual.cacheGeneration === source.expectedCacheGeneration
					);
				}
				if (source.cache !== undefined) {
					source = {
						...source,
						expectedCacheGeneration: actual.cacheGeneration
					};
				}
			}
			if (source.selector !== undefined) {
				requireIdentity(
					response.sourceSelector?.view === source.selector.view &&
						(source.selector.expectedRevision === undefined ||
							response.sourceSelector.expectedRevision ===
								source.selector.expectedRevision)
				);
				sourceSelector = response.sourceSelector;
				// Fence subsequent pages to the authoritative revision from the first.
				source = { ...source, selector: sourceSelector };
			}
			entries.push(...response.entries);
		}
		return { entries, ...(sourceSelector !== undefined && { sourceSelector }) };
	};
	// Instance-owned replay only. A new adapter without its durable context is not recovery.
	const localCaptures = new Map<
		string,
		{ input: PublicationWorkflowCaptureInput; state: PublicationCaptureState }
	>();
	const capture = async (
		input: PublicationWorkflowCaptureInput,
		signal: AbortSignal,
		context?: PublicationWorkflowExecutionContext
	): Promise<RecordedPublication> => {
		const requestId = input.requestId ?? createPublicationRequestId();
		input = { ...input, requestId };
		const recovery = context?.capture;
		let checkpoint: PublicationCaptureCheckpoint | undefined;
		let state: PublicationCaptureState;
		if (recovery === undefined) {
			const previous = localCaptures.get(requestId);
			requireIdentity(
				previous === undefined ||
					JSON.stringify(previous.input) === JSON.stringify(input)
			);
			state = previous?.state ?? { phase: 'unresolved' };
			localCaptures.set(requestId, { input, state });
		} else {
			const binding = publicationCaptureBindingSchema.parse(recovery.binding);
			requireIdentity(
				isSameCacheScope(binding.cache, cache) &&
					JSON.stringify(binding.input) === JSON.stringify(input)
			);
			checkpoint = publicationCaptureCheckpointSchema.parse(
				await recovery.store.load()
			);
			requireIdentity(
				JSON.stringify(checkpoint.binding) === JSON.stringify(binding)
			);
			state = checkpoint.state;
		}
		if (state.phase === 'shortcut') {
			const answer = await lookup(
				{
					source: {
						cache,
						expectedCacheGeneration: state.publication.result.cacheGeneration
					},
					results: [
						{
							storePath: state.publication.result.storePath,
							narHash: state.publication.result.narHash,
							generation: state.publication.result.generation
						}
					]
				},
				signal
			);
			const entry = answer.entries[0];
			requireIdentity(
				entry?.kind === 'recorded' &&
					JSON.stringify(entry.publication) ===
						JSON.stringify(state.publication)
			);
			return entry.publication;
		}
		const save = async (next: PublicationCaptureState) => {
			signal.throwIfAborted();
			if (recovery === undefined) {
				requireIdentity(
					JSON.stringify(localCaptures.get(requestId)?.state) ===
						JSON.stringify(state)
				);
				next = publicationCaptureStateSchema.parse(next);
				localCaptures.set(requestId, { input, state: next });
			} else {
				requireIdentity(checkpoint !== undefined);
				const update = publicationCaptureCheckpointUpdateSchema.parse({
					previous: checkpoint,
					next: { ...checkpoint, state: next }
				});
				await recovery.store.save(
					structuredClone(update.previous),
					structuredClone(update.next)
				);
				checkpoint = update.next;
				next = checkpoint.state;
			}
			state = next;
			signal.throwIfAborted();
		};
		if (state.phase === 'unresolved') {
			const unique = new Map<string, PublicationLookupTarget>();
			for (const member of input.members) {
				const previous = unique.get(member.storePath);
				if (previous !== undefined) {
					requireIdentity(
						(previous.narHash === undefined ||
							member.narHash === undefined ||
							previous.narHash === member.narHash) &&
							(previous.generation === undefined ||
								member.generation === undefined ||
								previous.generation === member.generation)
					);
				}
				unique.set(member.storePath, {
					storePath: member.storePath,
					...((previous?.narHash ?? member.narHash) !== undefined && {
						narHash: previous?.narHash ?? member.narHash
					}),
					...((previous?.generation ?? member.generation) !== undefined && {
						generation: previous?.generation ?? member.generation
					})
				});
			}
			requireIdentity(
				unique.size > 0 &&
					unique.size <= publicationManifestMaxMembers &&
					unique.has(input.result.storePath)
			);
			const resultLookup = await lookup(
				{ source: { cache }, results: [input.result] },
				signal
			);
			const first = resultLookup.entries[0];
			requireIdentity(first !== undefined);
			const result = entryResult(first);
			const resultTarget = unique.get(result.storePath);
			requireIdentity(
				resultTarget !== undefined && isMatchingTarget(result, resultTarget)
			);
			if (first.kind === 'recorded') {
				await save({ phase: 'shortcut', publication: first.publication });
				return first.publication;
			}
			const membersLookup = await lookup(
				{
					source: { cache, expectedCacheGeneration: result.cacheGeneration },
					results: unique.values().toArray()
				},
				signal
			);
			const members: PublicationPathVersion[] = membersLookup.entries.map(
				(entry) => {
					const member = entryResult(entry);
					if (member.storePath === result.storePath) {
						requireIdentity(isSameResult(member, result));
					}
					return {
						storePath: member.storePath,
						narHash: member.narHash,
						generation: member.generation
					};
				}
			);
			const pages = packPublicationRequests(
				members,
				publicationManifestPageMaxMembers,
				(page) => ({
					operationId: '00000000-0000-4000-8000-000000000000',
					page: publicationManifestMaxMembers - 1,
					members: page,
					...(cache.kind === 'named' && { cacheName: cache.name })
				})
			);
			await save({
				phase: 'resolved',
				capture: {
					result,
					begin: {
						result: {
							storePath: result.storePath,
							narHash: result.narHash,
							generation: result.generation
						},
						expectedCacheGeneration: result.cacheGeneration,
						requestId,
						origin: input.origin,
						memberCount: members.length
					},
					pages
				}
			});
		}
		requireIdentity('capture' in state);
		const resolved = state.capture;
		const finish = async (publication: RecordedPublication) => {
			requireIdentity(isSameResult(publication.result, resolved.result));
			if (state.phase === 'captured') {
				requireIdentity(
					JSON.stringify(state.publication) === JSON.stringify(publication)
				);
				return publication;
			}
			await save({
				phase: 'captured',
				capture: resolved,
				...('operationId' in state && { operationId: state.operationId }),
				publication
			});
			return publication;
		};
		// Even a locally completed capture replays begin: receipts are not authority.
		const begin = publicationCaptureBeginResponseSchema.parse(
			await call(
				'publication.captureBegin',
				client.publication.captureBegin,
				resolved.begin,
				signal
			)
		);
		if (begin.kind === 'existing') {
			return finish(begin.publication);
		}
		const operationId = begin.operationId;
		if ('operationId' in state) {
			requireIdentity(state.operationId === operationId);
		}
		if (state.phase === 'resolved') {
			await save({ phase: 'begun', capture: resolved, operationId });
		} else {
			requireIdentity(
				'operationId' in state && state.operationId !== undefined
			);
		}
		const pages = resolved.pages;
		for (const [page, items] of pages.entries()) {
			const answer = publicationCapturePageResponseSchema.parse(
				await call(
					'publication.capturePage',
					client.publication.capturePage,
					{ operationId, page, members: items },
					signal
				)
			);
			requireIdentity(
				answer.operationId === operationId &&
					answer.page === page &&
					answer.acceptedCount === items.length
			);
		}
		for (let attempt = 0; ; attempt += 1) {
			const answer = publicationCaptureSealResponseSchema.parse(
				await call(
					'publication.captureSeal',
					client.publication.captureSeal,
					{ operationId },
					signal
				)
			);
			if (answer.kind === 'captured') {
				return finish(answer.publication);
			}
			requireIdentity(answer.operationId === operationId);
			await pause(attempt, signal);
		}
	};
	const ensure = async (
		input: PublicationWorkflowEnsureInput,
		signal: AbortSignal
	): Promise<CompactPublicationSet> => {
		const requestId = input.requestId ?? createPublicationRequestId();
		const pushId = await options.pushId();
		signal.throwIfAborted();
		const plan = uploadPlanResponseSchema.parse(
			await call('uploads.plan', client.plan, { pushId, paths: [] }, signal)
		);
		requireIdentity(plan.uploads.length === 0);
		const request: PublicationEnsureRequest = {
			...input,
			requestId,
			expectedDestinationGeneration: plan.cacheGeneration
		};
		const advance = async () =>
			publicationEnsureResponseSchema.parse(
				await call(
					'publication.ensure',
					client.publication.ensure,
					request,
					signal
				)
			);
		let answer = await advance();
		let operationId: PublicationOperationId | undefined;
		for (;;) {
			if (answer.kind === 'complete') {
				const publication = answer.publication;
				requireIdentity(
					isSameCacheScope(publication.result.cache, cache) &&
						publication.result.cacheGeneration === plan.cacheGeneration &&
						publication.result.storePath === input.source.result.storePath &&
						publication.result.narHash === input.source.result.narHash &&
						publication.digest === input.source.digest &&
						publication.memberCount === input.source.memberCount
				);
				return publication;
			}
			if (operationId !== undefined) {
				requireIdentity(answer.operationId === operationId);
			}
			operationId = answer.operationId;
			const status = publicationStatusResponseSchema.parse(
				await call(
					'publication.status',
					client.publication.status,
					{ operationId },
					signal
				)
			);
			if (status.kind === 'failed') {
				throw new PublicationWorkflowError(
					`Recorded publication ensure failed: ${status.reason}.`
				);
			}
			if (status.kind === 'captured') {
				throw new PublicationWorkflowError(
					'A captured publication is not a complete materialisation.'
				);
			}
			if (status.kind === 'complete') {
				answer = status;
				continue;
			}
			requireIdentity(status.operationId === operationId);
			// Status observes terminal failures/completion only. Resend the same
			// ensure request to advance work, without exponential per-batch delays.
			await pause(0, signal);
			answer = await advance();
		}
	};
	return {
		lookup: (input: PublicationLookupRequest) => {
			const snapshot = structuredClone(input);
			return bounded((signal) => lookup(snapshot, signal));
		},
		capture: (
			input: PublicationWorkflowCaptureInput,
			context?: PublicationWorkflowExecutionContext
		) => {
			const checked = publicationWorkflowCaptureInputSchema.parse(input);
			return bounded((signal) => capture(checked, signal, context));
		},
		ensure: (input: PublicationWorkflowEnsureInput) => {
			const checked = publicationWorkflowEnsureInputSchema.parse(input);
			return bounded((signal) => ensure(checked, signal));
		}
	};
}

export type PublicationWorkflow = ReturnType<typeof createPublicationWorkflow>;
