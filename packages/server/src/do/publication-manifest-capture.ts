import { bytesToHex } from '@cupboard/nix-store/encoding';
import type { CacheGeneration, CacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type AuthorizationDetails,
	isCoveredByToken
} from '@cupboard/protocol/grants';
import { publicationRecoveryMs } from '@cupboard/protocol/publication';
import {
	type PublicationCaptureBeginRequest,
	publicationCaptureBeginRequestSchema,
	type PublicationCaptureBeginResponse,
	type PublicationCapturePageRequest,
	publicationCapturePageRequestSchema,
	type PublicationCapturePageResponse,
	type PublicationCaptureSealRequest,
	publicationCaptureSealRequestSchema,
	type PublicationCaptureSealResponse,
	publicationCaptureSealResponseSchema,
	publicationManifestLeafIdentity,
	publicationManifestMaxMembers,
	publicationManifestMaxRequestBytes,
	publicationManifestPageMaxMembers,
	publicationManifestRootIdentity,
	publicationOperationIdSchema,
	publicationResultIdentitySchema,
	type PublicationStatusRequest,
	type PublicationStatusResponse,
	publicationStatusResponseSchema
} from '@cupboard/protocol/publication-manifests';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { ORPCError } from '@orpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { ResolvedCache } from '../db/cache.ts';
import { currentCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { TenantWritesStoppedError } from '../errors.ts';
import { assertRetentionMigrationSettled } from '../migration/cache-retention.ts';

import { CacheClosureService } from './cache-closure-service.ts';
import type { ServerContext } from './context.ts';
import { jsonValueList } from './json-list.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import {
	captureProgressJson,
	captureProgressSchema
} from './publication-manifest-capture-progress.ts';
import { PublicationManifestRepository } from './publication-manifest-repository.ts';

export type PublicationManifestCaptureStatus =
	| PublicationCaptureSealResponse
	| Extract<PublicationStatusResponse, { kind: 'failed' }>;

type CaptureOperation =
	typeof schema.publicationManifestOperations.$inferSelect;

/**
Durable private intake and one bounded seal step per continuation.
*/
export class PublicationManifestCaptureService {
	constructor(private readonly context: ServerContext) {}

	private requireCommit(scope: CacheScope, grants: AuthorizationDetails): void {
		if (!isCoveredByToken(grants, 'upload:commit', { cache: scope })) {
			throw new ORPCError('FORBIDDEN');
		}
	}

	private requireLocalWrite(cache: ResolvedCache): void {
		if (this.context.offboarding) {
			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				'offboarding'
			);
		}
		const current = this.context.cacheRepository.resolve(cache.scope);
		if (current?.id !== cache.id || current.generation !== cache.generation) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		new CacheClosureService(this.context).assertWritable(cache);
		assertRetentionMigrationSettled(this.context.db);
	}

	private async prepareWrite(
		scope: CacheScope,
		expectedGeneration?: CacheGeneration
	): Promise<ResolvedCache> {
		const tenant = this.context.requireTenant();
		const account = await this.context.d1
			.select({
				generation: currentCacheGeneration(tenant, scope),
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
		const cache = this.context.cacheRepository.resolve(scope);
		if (
			cache?.generation !== account.generation ||
			(expectedGeneration !== undefined &&
				cache.generation !== expectedGeneration)
		) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		await new PathReadAuthorityService(this.context).requireWritable();
		this.requireLocalWrite(cache);
		return cache;
	}

	private requireUnexpired(operation: CaptureOperation): void {
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

	private operation(cache: ResolvedCache, id: string): CaptureOperation {
		const table = schema.publicationManifestOperations;
		const operation = this.context.db
			.select()
			.from(table)
			.where(
				and(
					eq(table.id, id),
					eq(table.kind, 'capture'),
					eq(table.cacheId, cache.id),
					eq(table.cacheGeneration, cache.generation)
				)
			)
			.get();
		if (operation === undefined) {
			throw new ORPCError('NOT_FOUND');
		}
		this.requireUnexpired(operation);
		return operation;
	}

	private completed(
		cache: ResolvedCache,
		operation: CaptureOperation,
		grants: AuthorizationDetails
	): Extract<PublicationCaptureSealResponse, { readonly kind: 'captured' }> {
		const response = publicationCaptureSealResponseSchema.parse(
			JSON.parse(operation.resultJson ?? 'null')
		);
		if (response.kind !== 'captured') {
			throw new ORPCError('CONFLICT');
		}
		new PublicationManifestAuthority(this.context).resolveRecorded(
			cache.scope,
			grants,
			response.publication
		);
		return response;
	}

	async captureBegin(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationCaptureBeginRequest
	): Promise<PublicationCaptureBeginResponse> {
		this.requireCommit(scope, grants);
		if (input.memberCount > publicationManifestMaxMembers) {
			throw new ORPCError('PUBLICATION_LIMIT_EXCEEDED', {
				data: { limit: 'total-members', maximum: publicationManifestMaxMembers }
			});
		}
		const request = publicationCaptureBeginRequestSchema.parse(input);
		const cache = await this.prepareWrite(
			scope,
			request.expectedCacheGeneration
		);
		const authority = new PublicationManifestAuthority(this.context);
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(
				authority.resolveExact(scope, grants, {
					...request.result,
					cache: scope,
					cacheGeneration: cache.generation
				})
			)
		);
		await authority.requireServable(snapshot);
		const canonicalJson = JSON.stringify(request);
		return this.context.criticalSection(() => {
			this.requireLocalWrite(cache);
			authority.revalidate(snapshot, grants);
			return Promise.resolve(
				this.context.db.transaction((tx) => {
					const table = schema.publicationManifestOperations;
					const existing = tx
						.select()
						.from(table)
						.where(
							and(
								eq(table.cacheId, cache.id),
								eq(table.cacheGeneration, cache.generation),
								eq(table.kind, 'capture'),
								eq(table.requestId, request.requestId)
							)
						)
						.get();
					if (existing !== undefined) {
						if (existing.canonicalJson !== canonicalJson) {
							throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
						}
						this.requireUnexpired(existing);
					}
					const winner = new PublicationManifestRepository(
						this.context
					).association(cache, snapshot.result);
					if (winner !== undefined) {
						new PublicationManifestRepository(this.context).requireAvailable(
							cache
						);
					}
					if (existing !== undefined) {
						if (existing.state === 'complete') {
							const receipt = this.completed(cache, existing, grants);
							return {
								kind: 'existing' as const,
								publication: receipt.publication
							};
						}
						if (existing.state !== 'pending') {
							throw new ORPCError('CONFLICT');
						}
						if (winner !== undefined) {
							tx.update(table)
								.set({
									state: 'complete',
									resultJson: JSON.stringify({
										kind: 'captured',
										association: 'existing',
										publication: winner.publication
									})
								})
								.where(eq(table.id, existing.id))
								.run();
							return {
								kind: 'existing' as const,
								publication: winner.publication
							};
						}
						return {
							kind: 'staging' as const,
							operationId: publicationOperationIdSchema.parse(existing.id),
							expiresAt: existing.expiresAt
						};
					}
					const operationId = publicationOperationIdSchema.parse(
						crypto.randomUUID()
					);
					const expiresAt = isoTimestamp(
						new Date(Date.now() + publicationRecoveryMs)
					);
					tx.insert(table)
						.values({
							id: operationId,
							requestId: request.requestId,
							kind: 'capture',
							cacheId: cache.id,
							cacheGeneration: cache.generation,
							canonicalJson,
							resultIdentityJson: JSON.stringify(snapshot.result),
							origin: request.origin,
							expectedCount: request.memberCount,
							state: winner === undefined ? 'pending' : 'complete',
							resultJson:
								winner === undefined
									? undefined
									: JSON.stringify({
											kind: 'captured',
											association: 'existing',
											publication: winner.publication
										}),
							expiresAt
						})
						.run();
					if (winner !== undefined) {
						return {
							kind: 'existing' as const,
							publication: winner.publication
						};
					}
					return { kind: 'staging' as const, operationId, expiresAt };
				})
			);
		});
	}

	async capturePage(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationCapturePageRequest
	): Promise<PublicationCapturePageResponse> {
		this.requireCommit(scope, grants);
		if (input.members.length > publicationManifestPageMaxMembers) {
			throw new ORPCError('PUBLICATION_LIMIT_EXCEEDED', {
				data: {
					limit: 'page-members',
					maximum: publicationManifestPageMaxMembers
				}
			});
		}
		const request = publicationCapturePageRequestSchema.parse(input);
		const payloadJson = JSON.stringify(request);
		// The route still must check RAW bytes, including whitespace, before parsing.
		if (
			new TextEncoder().encode(payloadJson).byteLength >
			publicationManifestMaxRequestBytes
		) {
			throw new ORPCError('PUBLICATION_LIMIT_EXCEEDED', {
				data: {
					limit: 'request-bytes',
					maximum: publicationManifestMaxRequestBytes
				}
			});
		}
		const cache = await this.prepareWrite(scope);
		const operation = this.operation(cache, request.operationId);
		const stagedPage = this.context.db
			.select()
			.from(schema.publicationManifestOperationPages)
			.where(
				and(
					eq(
						schema.publicationManifestOperationPages.operationId,
						request.operationId
					),
					eq(schema.publicationManifestOperationPages.page, request.page)
				)
			)
			.get();
		if (stagedPage !== undefined && stagedPage.payloadJson !== payloadJson) {
			throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
		}
		const result = publicationResultIdentitySchema.parse(
			JSON.parse(operation.resultIdentityJson)
		);
		const authority = new PublicationManifestAuthority(this.context);
		const snapshots = await this.context.criticalSection(() =>
			Promise.resolve(
				[
					result,
					...request.members.map((member) => ({
						...member,
						cache: scope,
						cacheGeneration: cache.generation
					}))
				].map((version) => authority.resolveExact(scope, grants, version))
			)
		);
		for (const snapshot of snapshots) {
			await authority.requireServable(snapshot);
		}
		// Unlike the portable manifest digest, this binds generations and immutable intent.
		const fingerprint = JSON.stringify({
			intent: operation.canonicalJson,
			result: operation.resultIdentityJson,
			cacheId: cache.id,
			cacheGeneration: cache.generation,
			page: request
		});
		const fingerprintBytes = new TextEncoder().encode(fingerprint);
		const fingerprintHash = await crypto.subtle.digest(
			'SHA-256',
			fingerprintBytes
		);
		const payloadDigest = bytesToHex(new Uint8Array(fingerprintHash));
		return this.context.criticalSection(() => {
			this.requireLocalWrite(cache);
			for (const snapshot of snapshots) {
				authority.revalidate(snapshot, grants);
			}
			return Promise.resolve(
				this.context.db.transaction((tx) => {
					const current = this.operation(cache, request.operationId);
					if (
						current.canonicalJson !== operation.canonicalJson ||
						current.resultIdentityJson !== operation.resultIdentityJson
					) {
						throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
					}
					const pages = schema.publicationManifestOperationPages;
					const replay = tx
						.select()
						.from(pages)
						.where(
							and(
								eq(pages.operationId, request.operationId),
								eq(pages.page, request.page)
							)
						)
						.get();
					if (replay !== undefined) {
						if (
							replay.payloadDigest !== payloadDigest ||
							replay.payloadJson !== payloadJson
						) {
							throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
						}
						return {
							operationId: request.operationId,
							page: request.page,
							acceptedCount: request.members.length
						};
					}
					if (
						current.state !== 'pending' ||
						current.phase !== 'intake' ||
						current.nextPage !== request.page ||
						current.cursor + request.members.length > current.expectedCount
					) {
						throw new ORPCError('PUBLICATION_INVALID_PAGE');
					}
					const members = schema.resultPublicationMembers;
					const paths = request.members.map((member) => member.storePath);
					const pathList = jsonValueList(paths);
					if (
						tx
							.select({ path: members.memberPath })
							.from(members)
							.where(
								and(
									eq(members.materialisationId, current.id),
									inArray(members.memberPath, pathList)
								)
							)
							.limit(1)
							.get() !== undefined
					) {
						throw new ORPCError('PUBLICATION_INVALID_PAGE');
					}
					for (const [index, member] of request.members.entries()) {
						const observed = snapshots[index + 1];
						if (observed === undefined) {
							throw new ORPCError('CONFLICT');
						}
						tx.insert(members)
							.values({
								cacheId: cache.id,
								cacheGeneration: cache.generation,
								resultHash: StorePath.hash(result.storePath),
								resultGeneration: result.generation,
								materialisationId: current.id,
								memberHash: StorePath.hash(member.storePath),
								memberPath: member.storePath,
								memberNarHash: member.narHash,
								memberGeneration: member.generation,
								availabilityRevision: observed.availability.revision
							})
							.run();
					}
					tx.insert(pages)
						.values({
							operationId: request.operationId,
							page: request.page,
							payloadDigest,
							payloadJson
						})
						.run();
					tx.update(schema.publicationManifestOperations)
						.set({
							nextPage: current.nextPage + 1,
							cursor: current.cursor + request.members.length
						})
						.where(
							eq(schema.publicationManifestOperations.id, request.operationId)
						)
						.run();
					return {
						operationId: request.operationId,
						page: request.page,
						acceptedCount: request.members.length
					};
				})
			);
		});
	}

	/**
	Observation only: does not advance, probe, or renew the fixed deadline.
	*/
	async captureStatus(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationStatusRequest
	): Promise<PublicationManifestCaptureStatus> {
		this.requireCommit(scope, grants);
		const request = publicationCaptureSealRequestSchema.parse(input);
		return this.context.criticalSection<PublicationManifestCaptureStatus>(
			() => {
				const cache = this.context.cacheRepository.resolve(scope);
				if (cache === undefined) {
					throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
				}
				const table = schema.publicationManifestOperations;
				const operation = this.context.db
					.select()
					.from(table)
					.where(
						and(
							eq(table.id, request.operationId),
							eq(table.kind, 'capture'),
							eq(table.cacheId, cache.id),
							eq(table.cacheGeneration, cache.generation)
						)
					)
					.get();
				if (operation === undefined) {
					throw new ORPCError('NOT_FOUND');
				}
				if (
					Date.parse(operation.expiresAt) <= Date.now() ||
					operation.state === 'expired'
				) {
					return Promise.resolve({
						kind: 'failed' as const,
						reason: 'expired' as const
					});
				}
				if (operation.state === 'failed') {
					const failure = publicationStatusResponseSchema.parse(
						JSON.parse(operation.failureJson ?? 'null')
					);
					if (failure.kind !== 'failed') {
						throw new ORPCError('CONFLICT');
					}
					return Promise.resolve(failure);
				}
				const result = publicationResultIdentitySchema.parse(
					JSON.parse(operation.resultIdentityJson)
				);
				new PublicationManifestAuthority(this.context).resolveExact(
					scope,
					grants,
					result
				);
				return Promise.resolve(
					operation.state === 'complete'
						? this.completed(cache, operation, grants)
						: { kind: 'pending' as const, operationId: request.operationId }
				);
			}
		);
	}

	/**
	Also the parent alarm's continuation seam; no scheduling or cleanup here.
	*/
	async captureSeal(
		scope: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationCaptureSealRequest
	): Promise<PublicationCaptureSealResponse> {
		this.requireCommit(scope, grants);
		const request = publicationCaptureSealRequestSchema.parse(input);
		const cache = await this.prepareWrite(scope);
		const authority = new PublicationManifestAuthority(this.context);
		const { operation, snapshot, progress, rows } =
			await this.context.criticalSection(() => {
				const operation = this.operation(cache, request.operationId);
				const result = publicationResultIdentitySchema.parse(
					JSON.parse(operation.resultIdentityJson)
				);
				const snapshot = authority.resolveExact(scope, grants, result);
				const progress =
					operation.progressJson === null
						? undefined
						: captureProgressSchema.parse(JSON.parse(operation.progressJson));
				if (progress !== undefined && progress.phase !== operation.phase) {
					throw new ORPCError('CONFLICT');
				}
				const members = schema.resultPublicationMembers;
				const rows =
					progress !== undefined &&
					operation.state === 'pending' &&
					operation.cursor < operation.expectedCount
						? this.context.db
								.select()
								.from(members)
								.where(
									and(
										eq(members.materialisationId, operation.id),
										sql`${members.memberPath} > ${progress.lastPath}`
									)
								)
								.orderBy(members.memberPath)
								.limit(publicationManifestPageMaxMembers)
								.all()
						: [];
				return Promise.resolve({ operation, snapshot, progress, rows });
			});
		if (operation.state === 'complete') {
			return this.context.criticalSection(() =>
				Promise.resolve(
					this.completed(
						cache,
						this.operation(cache, request.operationId),
						grants
					)
				)
			);
		}
		// Each request hashes at most one fixed leaf or one bounded root, outside the gate.
		const leaf =
			progress?.phase === 'sealing' && rows.length > 0
				? await publicationManifestLeafIdentity(
						rows.map((row) => ({
							storePath: row.memberPath,
							narHash: row.memberNarHash
						}))
					)
				: undefined;
		const root =
			progress?.phase === 'sealing' &&
			operation.cursor === operation.expectedCount
				? await publicationManifestRootIdentity({
						memberCount: operation.expectedCount,
						pageDigests: progress.pageDigests
					})
				: undefined;
		return this.context.criticalSection(() => {
			this.requireLocalWrite(cache);
			authority.revalidate(snapshot, grants);
			return Promise.resolve(
				this.context.db.transaction((tx) => {
					const current = this.operation(cache, request.operationId);
					if (current.state === 'complete') {
						return this.completed(cache, current, grants);
					}
					const pending = {
						kind: 'pending' as const,
						operationId: request.operationId
					};
					// Another continuation advanced while hashing. Never apply stale progress twice.
					if (
						current.phase !== operation.phase ||
						current.cursor !== operation.cursor ||
						current.progressJson !== operation.progressJson
					) {
						return pending;
					}
					const repository = new PublicationManifestRepository(this.context);
					const operations = schema.publicationManifestOperations;
					const members = schema.resultPublicationMembers;
					const portable = schema.publicationManifestMembers;
					const headers = schema.publicationManifests;
					const result = snapshot.result;
					const save = (values: Partial<typeof operations.$inferInsert>) =>
						tx
							.update(operations)
							.set(values)
							.where(eq(operations.id, current.id))
							.run();
					if (current.phase === 'intake') {
						const included = tx
							.select()
							.from(members)
							.where(
								and(
									eq(members.materialisationId, current.id),
									eq(members.memberPath, result.storePath),
									eq(members.memberNarHash, result.narHash),
									eq(members.memberGeneration, result.generation)
								)
							)
							.get();
						if (
							included === undefined ||
							current.cursor !== current.expectedCount
						) {
							throw new ORPCError('PUBLICATION_INVALID_PAGE');
						}
						repository.assertCandidateComplete(
							current.id,
							current.expectedCount
						);
						save({
							phase: 'sealing',
							cursor: 0,
							progressJson: captureProgressJson({
								phase: 'sealing',
								lastPath: '',
								pageDigests: []
							})
						});
						return pending;
					}
					if (progress === undefined) {
						throw new ORPCError('CONFLICT');
					}
					if (current.phase === 'sealing') {
						if (progress.phase !== 'sealing') {
							throw new ORPCError('CONFLICT');
						}
						if (leaf !== undefined) {
							if (
								rows.length !==
								Math.min(
									publicationManifestPageMaxMembers,
									current.expectedCount - current.cursor
								)
							) {
								throw new ORPCError('CONFLICT');
							}
							save({
								cursor: current.cursor + rows.length,
								progressJson: captureProgressJson({
									phase: 'sealing',
									lastPath: rows.at(-1)?.memberPath ?? '',
									pageDigests: [...progress.pageDigests, leaf.digest]
								})
							});
							return pending;
						}
						if (root === undefined) {
							throw new ORPCError('CONFLICT');
						}
						repository.assertCandidateComplete(
							current.id,
							current.expectedCount
						);
						tx.insert(headers)
							.values({
								digest: root.digest,
								version: 1,
								memberCount: current.expectedCount
							})
							.onConflictDoNothing()
							.run();
						const header = tx
							.select()
							.from(headers)
							.where(eq(headers.digest, root.digest))
							.get();
						if (
							header?.version !== 1 ||
							header.memberCount !== current.expectedCount
						) {
							throw new ORPCError('CONFLICT');
						}
						const cardinalities = schema.publicationManifestCardinalities;
						const cardinality = tx
							.select()
							.from(cardinalities)
							.where(
								and(
									eq(cardinalities.kind, 'portable'),
									eq(cardinalities.id, root.digest)
								)
							)
							.get();
						// Deletions make validity sticky. Do not pin a retiring digest:
						// bounded cleanup must be free to finish before a fresh header exists.
						if (!cardinality?.valid) {
							throw new ORPCError('SERVICE_UNAVAILABLE');
						}
						save({
							phase: 'publishing',
							candidateDigest: root.digest,
							cursor: 0,
							progressJson: captureProgressJson({
								phase: 'publishing',
								lastPath: ''
							})
						});
						return pending;
					}
					if (
						progress.phase !== 'publishing' ||
						current.candidateDigest === null
					) {
						throw new ORPCError('CONFLICT');
					}
					if (current.cursor < current.expectedCount) {
						if (
							rows.length !==
							Math.min(
								publicationManifestPageMaxMembers,
								current.expectedCount - current.cursor
							)
						) {
							throw new ORPCError('CONFLICT');
						}
						for (const [offset, row] of rows.entries()) {
							const value = {
								digest: current.candidateDigest,
								ordinal: current.cursor + offset,
								storePath: row.memberPath,
								storePathHash: row.memberHash,
								narHash: row.memberNarHash
							};
							tx.insert(portable).values(value).onConflictDoNothing().run();
							const saved = tx
								.select()
								.from(portable)
								.where(
									and(
										eq(portable.digest, value.digest),
										eq(portable.ordinal, value.ordinal)
									)
								)
								.get();
							if (
								saved?.storePath !== value.storePath ||
								saved.storePathHash !== value.storePathHash ||
								saved.narHash !== value.narHash
							) {
								throw new ORPCError('CONFLICT');
							}
						}
						save({
							cursor: current.cursor + rows.length,
							progressJson: captureProgressJson({
								phase: 'publishing',
								lastPath: rows.at(-1)?.memberPath ?? ''
							})
						});
						return pending;
					}
					repository.assertMaterialisationComplete(
						current.id,
						current.candidateDigest,
						current.expectedCount
					);
					const associations = schema.resultPublications;
					const inserted = tx
						.insert(associations)
						.values({
							cacheId: cache.id,
							cacheGeneration: cache.generation,
							resultHash: StorePath.hash(result.storePath),
							resultPath: result.storePath,
							resultGeneration: result.generation,
							resultNarHash: result.narHash,
							digest: current.candidateDigest,
							materialisationId: current.id,
							origin: current.origin,
							complete: true
						})
						.onConflictDoNothing()
						.returning()
						.all();
					const winner = new PublicationManifestRepository(
						this.context
					).association(cache, result);
					if (winner === undefined) {
						throw new ORPCError('CONFLICT');
					}
					const response = publicationCaptureSealResponseSchema.parse({
						kind: 'captured',
						association: inserted.length === 0 ? 'existing' : 'created',
						publication: winner.publication
					});
					save({ state: 'complete', resultJson: JSON.stringify(response) });
					return response;
				})
			);
		});
	}
}
