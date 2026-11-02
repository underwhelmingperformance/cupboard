import { type CacheScope, isSameCacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type AuthorizationDetails,
	isCoveredByToken
} from '@cupboard/protocol/grants';
import { publicationRecoveryMs } from '@cupboard/protocol/publication';
import {
	isFreshPublicationRequestId,
	type PublicationEnsureRequest,
	publicationEnsureRequestSchema,
	type PublicationEnsureResponse,
	publicationEnsureResponseSchema,
	type PublicationOperationId,
	publicationOperationIdSchema,
	type PublicationResultIdentity,
	publicationResultIdentitySchema,
	type PublicationStatusRequest,
	type PublicationStatusResponse,
	publicationStatusResponseSchema
} from '@cupboard/protocol/publication-manifests';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { ORPCError } from '@orpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { ResolvedCache } from '../db/cache.ts';
import {
	currentCacheGeneration,
	pathReferenceReadability
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { TenantWritesStoppedError } from '../errors.ts';
import { assertRetentionMigrationSettled } from '../migration/cache-retention.ts';

import { CacheClosureService } from './cache-closure-service.ts';
import type { SchemaWriter, ServerContext } from './context.ts';
import { confirmGraceBatch } from './grace-decision.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import {
	PublicationManifestAuthority,
	type PublicationManifestAuthoritySnapshot
} from './publication-manifest-authority.ts';
import type { PublicationManifestPublisher } from './publication-manifest-publisher.ts';
import { PublicationManifestRepository } from './publication-manifest-repository.ts';
import { holdManifestDestinationMember } from './publication-manifest-work-holds.ts';
import { RetentionService } from './retention-service.ts';

type EnsureOperation = typeof schema.publicationManifestOperations.$inferSelect;
const ensureProgressSchema = z.discriminatedUnion('phase', [
	z.strictObject({ phase: z.literal('result') }),
	z.strictObject({ phase: z.literal('members') })
]);

/**
One exact member proof or normal publication per invocation; no remote loop under the gate.
*/
export class PublicationManifestEnsureService {
	constructor(
		private readonly context: ServerContext,
		private readonly publisher: PublicationManifestPublisher
	) {}

	private requireCommit(scope: CacheScope, grants: AuthorizationDetails): void {
		if (!isCoveredByToken(grants, 'upload:commit', { cache: scope })) {
			throw new ORPCError('FORBIDDEN');
		}
	}

	private localWrite(cache: ResolvedCache): void {
		if (this.context.offboarding) {
			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				'offboarding'
			);
		}
		const current = this.context.cacheRepository.resolve(cache.scope);
		if (
			current?.id !== cache.id ||
			current.generation !== cache.generation ||
			current.access !== cache.access
		) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		new CacheClosureService(this.context).assertWritable(cache);
		assertRetentionMigrationSettled(this.context.db);
	}

	private async prepare(
		scope: CacheScope,
		request: PublicationEnsureRequest
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const sourceHash = StorePath.hash(request.source.result.storePath);
		const cache = this.context.cacheRepository.resolve(scope);
		const destination =
			cache === undefined ? undefined : this.destination(cache, request);
		const account = await this.context.d1
			.select({
				generation: currentCacheGeneration(tenant, scope),
				sourceGeneration: currentCacheGeneration(
					tenant,
					request.source.result.cache
				),
				sourceReadable: pathReferenceReadability(
					tenant,
					request.source.result.cache,
					sourceHash,
					request.source.result.generation
				),
				destinationReadable:
					destination === undefined
						? sql<boolean>`true`
						: pathReferenceReadability(
								tenant,
								scope,
								sourceHash,
								destination.generation
							),
				status: d1Schema.tenant.status
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, tenant))
			.get();
		if (this.context.offboarding || account?.status !== 'active') {
			throw new TenantWritesStoppedError(
				tenant,
				this.context.offboarding ? 'offboarding' : account?.status
			);
		}
		if (
			account.generation !== request.expectedDestinationGeneration ||
			account.sourceGeneration !== request.source.result.cacheGeneration
		) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		if (!account.sourceReadable || !account.destinationReadable) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		await new PathReadAuthorityService(this.context).requireWritable();
		if (cache === undefined) {
			return;
		}

		this.localWrite(cache);
		if (cache.generation !== request.expectedDestinationGeneration) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
	}

	private root(
		cache: ResolvedCache,
		grants: AuthorizationDetails,
		request: PublicationEnsureRequest,
		tx?: SchemaWriter,
		result?: PublicationResultIdentity
	): void {
		if (request.runRoot === undefined) {
			return;
		}
		if (
			!isCoveredByToken(grants, 'root:attach', {
				cache: cache.scope,
				root: request.runRoot
			})
		) {
			throw new ORPCError('FORBIDDEN');
		}
		const database = tx ?? this.context.db;
		const roots = schema.retentionRoots;
		const root = database
			.select()
			.from(roots)
			.where(and(eq(roots.cacheId, cache.id), eq(roots.name, request.runRoot)))
			.get();
		if (
			root === undefined ||
			(root.expiresAt !== null && Date.parse(root.expiresAt) <= Date.now()) ||
			root.retentionEpoch !== new CacheClosureService(this.context).epoch(cache)
		) {
			throw new ORPCError('NOT_FOUND');
		}
		if (result !== undefined) {
			database
				.insert(schema.retentionRootTargets)
				.values({
					cacheId: cache.id,
					rootName: request.runRoot,
					storePathHash: StorePath.hash(result.storePath),
					storePath: result.storePath
				})
				.onConflictDoNothing()
				.run();
		}
	}

	private operation(
		scope: CacheScope,
		grants: AuthorizationDetails,
		id: string
	): {
		cache: ResolvedCache;
		operation: EnsureOperation;
		request: PublicationEnsureRequest;
	} {
		this.requireCommit(scope, grants);
		const cache = this.context.cacheRepository.require(scope);
		const table = schema.publicationManifestOperations;
		const operation = this.context.db
			.select()
			.from(table)
			.where(
				and(
					eq(table.id, id),
					eq(table.kind, 'ensure'),
					eq(table.cacheId, cache.id),
					eq(table.cacheGeneration, cache.generation)
				)
			)
			.get();
		if (operation === undefined) {
			throw new ORPCError('NOT_FOUND');
		}
		return {
			cache,
			operation,
			request: publicationEnsureRequestSchema.parse(
				JSON.parse(operation.sourceJson ?? 'null')
			)
		};
	}

	private live(operation: EnsureOperation): void {
		if (
			operation.state === 'expired' ||
			Date.parse(operation.expiresAt) <= Date.now()
		) {
			throw new ORPCError('GONE');
		}
		if (operation.state === 'failed') {
			throw new ORPCError('CONFLICT');
		}
	}

	private source(
		scope: CacheScope,
		grants: AuthorizationDetails,
		request: PublicationEnsureRequest
	): PublicationManifestAuthoritySnapshot {
		return new PublicationManifestAuthority(this.context).resolveRecorded(
			scope,
			grants,
			request.source,
			request.sourceSelector
		);
	}

	private destination(
		cache: ResolvedCache,
		request: PublicationEnsureRequest
	): PublicationResultIdentity | undefined {
		const hash = StorePath.hash(request.source.result.storePath);
		const rows = schema.narInfos;
		const row = this.context.db
			.select()
			.from(rows)
			.where(and(eq(rows.cacheId, cache.id), eq(rows.storePathHash, hash)))
			.get();
		if (row === undefined) {
			return undefined;
		}
		if (
			row.storePath !== request.source.result.storePath ||
			row.narHash !== request.source.result.narHash
		) {
			throw new ORPCError('PUBLICATION_DIVERGENCE');
		}
		return publicationResultIdentitySchema.parse({
			cache: cache.scope,
			cacheGeneration: cache.generation,
			storePath: row.storePath,
			narHash: row.narHash,
			generation: row.generation
		});
	}

	private certificate(
		cache: ResolvedCache,
		request: PublicationEnsureRequest
	): PublicationEnsureResponse | undefined {
		new PublicationManifestRepository(this.context).requireAvailable(cache);
		const result = this.destination(cache, request);
		if (result === undefined) {
			return undefined;
		}
		const association = new PublicationManifestRepository(
			this.context
		).association(cache, result);
		if (association === undefined) {
			return undefined;
		}
		if (
			association.publication.digest !== request.source.digest ||
			association.publication.memberCount !== request.source.memberCount
		) {
			throw new ORPCError('PUBLICATION_DIVERGENCE');
		}
		if (!association.complete) {
			return undefined;
		}
		return {
			kind: 'complete',
			association: 'existing',
			publication: { ...association.publication, materialisation: 'complete' }
		};
	}

	private completed(
		cache: ResolvedCache,
		operation: EnsureOperation,
		request: PublicationEnsureRequest
	): PublicationEnsureResponse {
		const receipt = publicationEnsureResponseSchema.parse(
			JSON.parse(operation.resultJson ?? 'null')
		);
		if (receipt.kind !== 'complete') {
			throw new ORPCError('CONFLICT');
		}
		const current = this.certificate(cache, request);
		if (
			current?.kind !== 'complete' ||
			JSON.stringify(current.publication) !==
				JSON.stringify(receipt.publication)
		) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		return receipt;
	}

	private async identity(
		scope: CacheScope,
		request: PublicationEnsureRequest
	): Promise<PublicationOperationId> {
		// Custom UUIDs bind tenant/cache/generation; request IDs are not bearer capabilities.
		const canonical = JSON.stringify([
			'cupboard/manifest-ensure/v1',
			this.context.requireTenant(),
			scope.kind,
			scope.kind === 'named' ? scope.name : undefined,
			request.expectedDestinationGeneration,
			request.requestId
		]);
		const encoded = new TextEncoder().encode(canonical);
		const bytes = new Uint8Array(
			await crypto.subtle.digest('SHA-256', encoded)
		);
		bytes[6] = ((bytes[6] ?? 0) & 15) | 128;
		bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
		const hex = Array.from(bytes.subarray(0, 16), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('');
		return publicationOperationIdSchema.parse(
			`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
		);
	}

	private finish(
		cache: ResolvedCache,
		grants: AuthorizationDetails,
		operation: EnsureOperation,
		request: PublicationEnsureRequest,
		source: PublicationManifestAuthoritySnapshot,
		winner?: PublicationEnsureResponse
	): Promise<PublicationEnsureResponse> {
		return this.context.criticalSection(() =>
			Promise.resolve(
				this.context.db.transaction((tx) => {
					this.localWrite(cache);
					new PublicationManifestAuthority(this.context).revalidate(
						source,
						grants
					);
					const current = this.operation(
						cache.scope,
						grants,
						operation.id
					).operation;
					this.live(current);
					if (current.state === 'complete') {
						return this.completed(cache, current, request);
					}
					let response = this.certificate(cache, request);
					if (winner !== undefined && response === undefined) {
						throw new ORPCError('PUBLICATION_RESULT_CHANGED');
					}
					if (response === undefined) {
						const result = publicationResultIdentitySchema.parse(
							JSON.parse(current.resultIdentityJson)
						);
						if (
							current.cursor !== current.expectedCount ||
							JSON.stringify(this.destination(cache, request)) !==
								JSON.stringify(result)
						) {
							throw new ORPCError('PUBLICATION_RESULT_CHANGED');
						}
						new PublicationManifestRepository(
							this.context
						).assertMaterialisationComplete(
							current.id,
							request.source.digest,
							current.expectedCount
						);
						const association = new PublicationManifestRepository(
							this.context
						).association(cache, result);
						if (
							association !== undefined &&
							association.publication.digest !== request.source.digest
						) {
							throw new ORPCError('PUBLICATION_DIVERGENCE');
						}
						const values = {
							cacheId: cache.id,
							cacheGeneration: cache.generation,
							resultHash: StorePath.hash(result.storePath),
							resultPath: result.storePath,
							resultGeneration: result.generation,
							resultNarHash: result.narHash,
							digest: request.source.digest,
							origin: association?.publication.origin ?? request.source.origin,
							materialisationId: current.id,
							complete: true
						};
						tx.insert(schema.resultPublications)
							.values(values)
							.onConflictDoUpdate({
								target: [
									schema.resultPublications.cacheId,
									schema.resultPublications.cacheGeneration,
									schema.resultPublications.resultHash,
									schema.resultPublications.resultGeneration
								],
								set: { materialisationId: current.id, complete: true }
							})
							.run();
						response = {
							kind: 'complete',
							association: association === undefined ? 'created' : 'existing',
							publication: {
								result,
								digest: request.source.digest,
								memberCount: request.source.memberCount,
								origin: values.origin,
								materialisation: 'complete'
							}
						};
					}
					if (response.kind !== 'complete') {
						throw new ORPCError('CONFLICT');
					}
					this.root(cache, grants, request, tx, response.publication.result);
					const completed = tx
						.update(schema.publicationManifestOperations)
						.set({ state: 'complete', resultJson: JSON.stringify(response) })
						.where(
							and(
								eq(schema.publicationManifestOperations.id, current.id),
								eq(schema.publicationManifestOperations.state, 'pending')
							)
						)
						.returning({
							cacheId: schema.publicationManifestOperations.cacheId
						})
						.all()
						.at(0);
					if (completed !== undefined) {
						// Completion releases temporary holds even when another operation won.
						tx.update(schema.garbageCollectionInputs)
							.set({ inputsChanged: true })
							.where(
								eq(schema.garbageCollectionInputs.cacheId, completed.cacheId)
							)
							.run();
					}
					return response;
				})
			)
		);
	}

	private failure(
		error: unknown
	): Extract<PublicationStatusResponse, { kind: 'failed' }> | undefined {
		if (!(error instanceof ORPCError)) {
			return undefined;
		}
		switch (error.code) {
			case 'PUBLICATION_RESULT_CHANGED': {
				return { kind: 'failed', reason: 'result-changed' };
			}
			case 'PUBLICATION_SCOPE_CHANGED': {
				return { kind: 'failed', reason: 'scope-changed' };
			}
			case 'PUBLICATION_GENERATION_CONFLICT': {
				return { kind: 'failed', reason: 'generation-conflict' };
			}
			case 'PUBLICATION_DIVERGENCE': {
				return { kind: 'failed', reason: 'divergence' };
			}
			default: {
				return undefined;
			}
		}
	}

	private async advance(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationStatusRequest
	): Promise<PublicationEnsureResponse> {
		const { cache, operation, request } = this.operation(
			scope,
			grants,
			input.operationId
		);
		this.live(operation);
		await this.prepare(scope, request);
		const authority = new PublicationManifestAuthority(this.context);
		const source = this.source(scope, grants, request);
		if (operation.state === 'complete') {
			return this.completed(cache, operation, request);
		}
		this.root(cache, grants, request);
		const progress = ensureProgressSchema.parse(
			JSON.parse(operation.progressJson ?? 'null')
		);
		const result =
			operation.resultIdentityJson === 'null'
				? undefined
				: publicationResultIdentitySchema.parse(
						JSON.parse(operation.resultIdentityJson)
					);
		// First authorised complete association wins, even while another operation is paging.
		const winner = this.certificate(cache, request);
		if (winner !== undefined) {
			return this.finish(cache, grants, operation, request, source, winner);
		}
		await authority.requireServable(source);
		if (result === undefined && progress.phase === 'members') {
			throw new ORPCError('CONFLICT');
		}
		if (
			result !== undefined &&
			JSON.stringify(this.destination(cache, request)) !==
				JSON.stringify(result)
		) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		if (
			operation.cursor === operation.expectedCount &&
			progress.phase === 'members'
		) {
			return this.finish(cache, grants, operation, request, source);
		}
		const portable = schema.publicationManifestMembers;
		const member = this.context.db
			.select()
			.from(portable)
			.where(
				and(
					eq(portable.digest, request.source.digest),
					progress.phase === 'result'
						? eq(portable.storePath, request.source.result.storePath)
						: eq(portable.ordinal, operation.cursor)
				)
			)
			.get();
		if (member === undefined) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
		const memberHash = StorePath.hash(member.storePath);
		const destinationMember = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, memberHash)
				)
			)
			.get();
		if (
			destinationMember !== undefined &&
			(destinationMember.storePath !== member.storePath ||
				destinationMember.narHash !== member.narHash)
		) {
			throw new ORPCError('PUBLICATION_DIVERGENCE');
		}
		const healthyDestination =
			destinationMember === undefined
				? undefined
				: authority.resolveTarget(
						scope,
						grants,
						scope,
						{ storePath: member.storePath, narHash: member.narHash },
						cache.generation
					);
		const isReuseDestination =
			healthyDestination !== undefined &&
			(await authority.isServable(healthyDestination));
		// Source membership may have disappeared since capture. Current authority
		// over the recorded result is independent of a healthy destination proof.
		const snapshot = isReuseDestination
			? undefined
			: authority.resolveTarget(
					scope,
					grants,
					source.cache.scope,
					{ storePath: member.storePath, narHash: member.narHash },
					source.cache.generation,
					request.sourceSelector
				);
		if (snapshot !== undefined) {
			await authority.requireServable(snapshot);
		}
		let acceptedResult: PublicationResultIdentity;
		if (isReuseDestination) {
			acceptedResult = healthyDestination.result;
		} else {
			if (snapshot === undefined) {
				throw new ORPCError('CONFLICT');
			}
			const accepted = await this.publisher.publish({
				operationId: publicationOperationIdSchema.parse(operation.id),
				destination: scope,
				request,
				grants,
				source: snapshot,
				expiresAt: operation.expiresAt
			});
			if (accepted.kind === 'pending') {
				return { kind: 'pending', operationId: input.operationId };
			}
			acceptedResult = publicationResultIdentitySchema.parse(accepted.result);
		}
		if (
			!isSameCacheScope(acceptedResult.cache, scope) ||
			acceptedResult.cacheGeneration !== cache.generation ||
			acceptedResult.storePath !== member.storePath ||
			acceptedResult.narHash !== member.narHash
		) {
			throw new ORPCError('PUBLICATION_DIVERGENCE');
		}
		const destinationSnapshot = authority.resolveExact(
			scope,
			grants,
			acceptedResult
		);
		await authority.requireServable(destinationSnapshot);
		return this.context.criticalSection(() =>
			Promise.resolve(
				this.context.db.transaction((tx) => {
					this.localWrite(cache);
					authority.revalidate(source, grants);
					if (isReuseDestination) {
						authority.revalidate(healthyDestination, grants);
					}
					if (snapshot !== undefined) {
						authority.revalidate(snapshot, grants);
					}
					authority.revalidate(destinationSnapshot, grants);
					const current = this.operation(scope, grants, operation.id).operation;
					this.live(current);
					if (current.state === 'complete') {
						return this.completed(cache, current, request);
					}
					if (
						current.cursor !== operation.cursor ||
						current.progressJson !== operation.progressJson ||
						current.resultIdentityJson !== operation.resultIdentityJson
					) {
						return { kind: 'pending' as const, operationId: input.operationId };
					}
					const owner = result ?? acceptedResult;
					if (
						result !== undefined &&
						JSON.stringify(this.destination(cache, request)) !==
							JSON.stringify(result)
					) {
						throw new ORPCError('PUBLICATION_RESULT_CHANGED');
					}
					if (isReuseDestination) {
						holdManifestDestinationMember(
							tx,
							operation.id,
							cache,
							acceptedResult
						);
					}
					// Revisit the result at its portable ordinal without replacing its
					// immutable observation stamp after unrelated availability changes.
					const proof = tx
						.select()
						.from(schema.resultPublicationMembers)
						.where(
							and(
								eq(
									schema.resultPublicationMembers.materialisationId,
									operation.id
								),
								eq(
									schema.resultPublicationMembers.memberPath,
									acceptedResult.storePath
								)
							)
						)
						.get();
					if (
						proof !== undefined &&
						(proof.cacheId !== cache.id ||
							proof.cacheGeneration !== cache.generation ||
							proof.resultHash !== StorePath.hash(owner.storePath) ||
							proof.resultGeneration !== owner.generation ||
							proof.materialisationId !== operation.id ||
							proof.memberHash !== StorePath.hash(acceptedResult.storePath) ||
							proof.memberPath !== acceptedResult.storePath ||
							proof.memberNarHash !== acceptedResult.narHash ||
							proof.memberGeneration !== acceptedResult.generation)
					) {
						throw new ORPCError('PUBLICATION_RESULT_CHANGED');
					}
					if (proof === undefined) {
						tx.insert(schema.resultPublicationMembers)
							.values({
								cacheId: cache.id,
								cacheGeneration: cache.generation,
								resultHash: StorePath.hash(owner.storePath),
								resultGeneration: owner.generation,
								materialisationId: operation.id,
								memberHash: StorePath.hash(acceptedResult.storePath),
								memberPath: acceptedResult.storePath,
								memberNarHash: acceptedResult.narHash,
								memberGeneration: acceptedResult.generation,
								availabilityRevision: destinationSnapshot.availability.revision
							})
							.run();
					}
					tx.update(schema.publicationManifestOperations)
						.set({
							resultIdentityJson: JSON.stringify(owner),
							progressJson: JSON.stringify({ phase: 'members' }),
							cursor: progress.phase === 'result' ? 0 : operation.cursor + 1
						})
						.where(eq(schema.publicationManifestOperations.id, operation.id))
						.run();
					return { kind: 'pending' as const, operationId: input.operationId };
				})
			)
		);
	}

	async ensure(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationEnsureRequest
	): Promise<PublicationEnsureResponse> {
		this.requireCommit(scope, grants);
		const request = publicationEnsureRequestSchema.parse(input);
		const id = await this.identity(scope, request);
		const canonicalJson = JSON.stringify(request);
		const admission = this.context.db
			.select()
			.from(schema.publicationManifestAdmissions)
			.where(eq(schema.publicationManifestAdmissions.operationId, id))
			.get();
		if (admission !== undefined) {
			if (admission.canonicalJson !== canonicalJson) {
				throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
			}
			if (Date.parse(admission.expiresAt) <= Date.now()) {
				throw new ORPCError('GONE');
			}
		}
		const authority = new PublicationManifestAuthority(this.context);
		const existing = this.context.db
			.select()
			.from(schema.publicationManifestOperations)
			.where(eq(schema.publicationManifestOperations.id, id))
			.get();
		if (existing !== undefined) {
			if (existing.canonicalJson !== canonicalJson) {
				throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
			}
			return this.continue(scope, grants, { operationId: id });
		}
		if (
			admission === undefined &&
			!isFreshPublicationRequestId(request.requestId, new Date())
		) {
			throw new ORPCError('GONE');
		}
		await this.prepare(scope, request);
		if (
			request.runRoot !== undefined &&
			!isCoveredByToken(grants, 'root:attach', {
				cache: scope,
				root: request.runRoot
			})
		) {
			throw new ORPCError('FORBIDDEN');
		}
		const initial = this.source(scope, grants, request);
		if (
			initial.destination !== undefined &&
			initial.destination.generation !== request.expectedDestinationGeneration
		) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		if (initial.destination === undefined && request.runRoot !== undefined) {
			throw new ORPCError('NOT_FOUND');
		}
		let hasPinnedAdmission = admission !== undefined;
		let cache = initial.destination;
		let expiresAt =
			admission?.expiresAt ??
			isoTimestamp(new Date(Date.now() + publicationRecoveryMs));
		let warm =
			cache === undefined ? undefined : this.certificate(cache, request);
		let confirmationSnapshot: PublicationManifestAuthoritySnapshot | undefined;
		let confirmationResult =
			admission === undefined && warm?.kind === 'complete'
				? warm.publication.result
				: undefined;
		// A warm certificate does not replay an admission's captured retention.
		if (admission !== undefined || warm === undefined) {
			await authority.requireServable(initial);
			if (cache !== undefined) {
				this.root(cache, grants, request);
			}
			// Pin healthy destination work, or admit a real ordinary publication.
			// Only the latter may register an absent destination.
			const admitted = await this.publisher.admit({
				operationId: id,
				destination: scope,
				request,
				grants,
				source: initial
			});
			confirmationSnapshot = admitted.confirmation;
			confirmationResult = confirmationSnapshot?.result;
			hasPinnedAdmission = true;
			cache = admitted.cache;
			expiresAt = admitted.expiresAt;
			if (
				!isSameCacheScope(cache.scope, scope) ||
				cache.generation !== request.expectedDestinationGeneration ||
				Date.parse(expiresAt) <= Date.now() ||
				Date.parse(expiresAt) > Date.now() + publicationRecoveryMs
			) {
				throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
			}
		}
		if (cache === undefined) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		const destination = cache;
		return this.context.criticalSection(() =>
			Promise.resolve(
				this.context.db.transaction((tx) => {
					this.localWrite(destination);
					// The only allowed absence-to-registration transition is the normal admission above.
					const currentSource = this.source(scope, grants, request);
					if (
						currentSource.cache.id !== initial.cache.id ||
						currentSource.cache.access !== initial.cache.access
					) {
						throw new ORPCError('PUBLICATION_SCOPE_CHANGED');
					}
					authority.requireCurrentAvailability(initial);
					if (initial.destination !== undefined) {
						authority.revalidate(initial, grants);
					}
					this.root(destination, grants, request);
					const table = schema.publicationManifestOperations;
					const raced = tx.select().from(table).where(eq(table.id, id)).get();
					if (raced !== undefined) {
						if (raced.canonicalJson !== canonicalJson) {
							throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
						}
						this.live(raced);
						return raced.state === 'complete'
							? this.completed(destination, raced, request)
							: { kind: 'pending' as const, operationId: id };
					}
					if (
						!hasPinnedAdmission &&
						!isFreshPublicationRequestId(request.requestId, new Date())
					) {
						throw new ORPCError('GONE');
					}
					warm = this.certificate(destination, request);
					if (confirmationSnapshot !== undefined) {
						authority.revalidate(confirmationSnapshot, grants);
					}
					if (confirmationResult !== undefined) {
						const result = authority.resolveExact(
							scope,
							grants,
							confirmationResult
						).result;
						const retention = new RetentionService(this.context);
						const hash = StorePath.hash(result.storePath);
						const facts = confirmGraceBatch(
							this.context,
							retention,
							destination,
							[
								{
									storePathHash: hash,
									generation: result.generation,
									narHash: result.narHash
								}
							],
							{
								reportsGrace: true,
								graceSeconds: retention.resolveGraceSeconds(destination),
								retentionEpoch: new CacheClosureService(this.context).epoch(
									destination
								)
							},
							{ database: tx }
						);
						if (!facts.has(hash)) {
							throw new ORPCError('PUBLICATION_RESULT_CHANGED');
						}
					}
					if (warm?.kind === 'complete') {
						this.root(
							destination,
							grants,
							request,
							tx,
							warm.publication.result
						);
					}
					if (confirmationResult !== undefined && warm === undefined) {
						holdManifestDestinationMember(
							tx,
							id,
							destination,
							confirmationResult
						);
					}
					tx.insert(table)
						.values({
							id,
							requestId: request.requestId,
							kind: 'ensure',
							cacheId: destination.id,
							cacheGeneration: destination.generation,
							canonicalJson,
							sourceJson: canonicalJson,
							resultIdentityJson:
								warm?.kind === 'complete'
									? JSON.stringify(warm.publication.result)
									: 'null',
							origin: request.source.origin,
							expectedCount: request.source.memberCount,
							candidateDigest: request.source.digest,
							phase: 'publishing',
							progressJson: JSON.stringify({ phase: 'result' }),
							expiresAt,
							state: warm === undefined ? 'pending' : 'complete',
							resultJson: warm === undefined ? undefined : JSON.stringify(warm)
						})
						.run();
					if (hasPinnedAdmission && warm?.kind === 'complete') {
						// Direct completion also releases pre-operation admission holds.
						tx.update(schema.garbageCollectionInputs)
							.set({ inputsChanged: true })
							.where(eq(schema.garbageCollectionInputs.cacheId, destination.id))
							.run();
					}
					return warm ?? { kind: 'pending' as const, operationId: id };
				})
			)
		);
	}

	async continue(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationStatusRequest
	): Promise<PublicationEnsureResponse> {
		try {
			return await this.advance(scope, grants, input);
		} catch (error) {
			const failure = this.failure(error);
			const cache = this.context.cacheRepository.resolve(scope);
			if (failure !== undefined && cache !== undefined) {
				await this.context.criticalSection(() => {
					const operations = schema.publicationManifestOperations;
					this.context.db
						.update(schema.garbageCollectionInputs)
						.set({ inputsChanged: true })
						.where(eq(schema.garbageCollectionInputs.cacheId, cache.id))
						.run();
					this.context.db
						.update(operations)
						.set({ state: 'failed', failureJson: JSON.stringify(failure) })
						.where(
							and(
								eq(operations.id, input.operationId),
								eq(operations.kind, 'ensure'),
								eq(operations.cacheId, cache.id),
								eq(operations.state, 'pending')
							)
						)
						.run();
					return Promise.resolve();
				});
			}
			throw error;
		}
	}

	/**
	Observation only: no publisher, availability probes, retention writes or preparation.
	*/
	async status(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationStatusRequest
	): Promise<PublicationStatusResponse> {
		const { cache, operation, request } = this.operation(
			scope,
			grants,
			input.operationId
		);
		if (
			Date.parse(operation.expiresAt) <= Date.now() ||
			operation.state === 'expired'
		) {
			return { kind: 'failed', reason: 'expired' };
		}
		if (operation.state === 'failed') {
			const failure = publicationStatusResponseSchema.parse(
				JSON.parse(
					operation.failureJson ?? '{"kind":"failed","reason":"result-changed"}'
				)
			);
			if (failure.kind !== 'failed') {
				throw new ORPCError('CONFLICT');
			}
			return failure;
		}
		try {
			const tenant = this.context.requireTenant();
			const sourceHash = StorePath.hash(request.source.result.storePath);
			const observedDestination = this.destination(cache, request);
			const lifecycle = await this.context.d1
				.select({
					destination: currentCacheGeneration(tenant, scope),
					source: currentCacheGeneration(tenant, request.source.result.cache),
					status: d1Schema.tenant.status,
					destinationReadable:
						observedDestination === undefined
							? sql<boolean>`true`
							: pathReferenceReadability(
									tenant,
									scope,
									sourceHash,
									observedDestination.generation
								),
					sourceReadable: pathReferenceReadability(
						tenant,
						request.source.result.cache,
						sourceHash,
						request.source.result.generation
					)
				})
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, tenant))
				.get();
			if (this.context.offboarding || lifecycle?.status !== 'active') {
				return { kind: 'failed', reason: 'scope-changed' };
			}
			if (
				lifecycle.destination !== cache.generation ||
				lifecycle.source !== request.source.result.cacheGeneration
			) {
				return { kind: 'failed', reason: 'generation-conflict' };
			}
			if (!lifecycle.sourceReadable || !lifecycle.destinationReadable) {
				return { kind: 'failed', reason: 'result-changed' };
			}
			this.source(scope, grants, request);
			const destination = this.destination(cache, request);
			if (
				operation.resultIdentityJson !== 'null' &&
				JSON.stringify(destination) !== operation.resultIdentityJson
			) {
				throw new ORPCError('PUBLICATION_RESULT_CHANGED');
			}
			return operation.state === 'complete'
				? this.completed(cache, operation, request)
				: { kind: 'pending', operationId: input.operationId };
		} catch (error) {
			const failure = this.failure(error);
			if (error instanceof ORPCError && error.code === 'SERVICE_UNAVAILABLE') {
				return { kind: 'pending', operationId: input.operationId };
			}
			if (failure !== undefined) {
				return failure;
			}
			throw error;
		}
	}
}
