import {
	type CacheGeneration,
	type CacheScope,
	isSameCacheScope,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type AuthorizationDetails,
	isCoveredByToken
} from '@cupboard/protocol/grants';
import {
	publicationLookupMaxResults,
	type PublicationLookupRequest,
	publicationLookupRequestSchema,
	type PublicationLookupResponse,
	type PublicationLookupSourceSelector,
	type PublicationLookupTarget,
	publicationManifestPageMaxMembers,
	type PublicationResultIdentity,
	publicationResultIdentitySchema,
	type PublicationSourceSelector,
	type RecordedPublication,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import { ORPCError } from '@orpc/server';
import { and, eq, getTableColumns, gt, isNull } from 'drizzle-orm';

import { cacheSelectorsCondition, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { rootLogger } from '../observability/logging.ts';

import { batchNonEmpty } from './bulk.ts';
import type { ServerContext } from './context.ts';
import { jsonRowLists } from './json-list.ts';
import {
	PublicationManifestAuthority,
	type PublicationManifestAuthoritySnapshot
} from './publication-manifest-authority.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import {
	reuseEdgeSelect,
	type ReuseViewArbitrationSnapshot,
	ReuseViewLookupService
} from './reuse-view-lookup-service.ts';
import { reuseViewSelectorsFromRows } from './reuse-view-selectors.ts';

export interface PublicationManifestAssociation {
	readonly publication: RecordedPublication;
	readonly complete: boolean;
}

export class PublicationManifestRepository {
	constructor(private readonly context: ServerContext) {}

	private selector(
		input: PublicationLookupSourceSelector,
		grants: AuthorizationDetails
	): { selector: PublicationSourceSelector; access: 'public' | 'private' } {
		const view = this.context.db
			.select()
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, input.view))
			.get();
		if (
			view === undefined ||
			(input.expectedRevision !== undefined &&
				input.expectedRevision !== view.revision)
		) {
			throw new ORPCError('PUBLICATION_SCOPE_CHANGED');
		}
		if (
			view.access === 'private' &&
			!isCoveredByToken(grants, 'view:content-read', { view: input.view })
		) {
			throw new ORPCError('FORBIDDEN');
		}
		return {
			selector: { view: input.view, expectedRevision: view.revision },
			access: view.access
		};
	}

	private async viewTarget(
		destination: CacheScope,
		grants: AuthorizationDetails,
		target: PublicationLookupTarget,
		resolved: {
			selector: PublicationSourceSelector;
			access: 'public' | 'private';
		},
		constraint?: {
			cache: CacheScope;
			expectedCacheGeneration?: CacheGeneration;
		}
	): Promise<
		| {
				snapshot?: PublicationManifestAuthoritySnapshot;
				arbitration: ReuseViewArbitrationSnapshot;
		  }
		| undefined
	> {
		const { selector, access } = resolved;
		const authority = new PublicationManifestAuthority(this.context);
		const constrained =
			constraint === undefined
				? undefined
				: await this.context.criticalSection(() =>
						Promise.resolve(
							authority.findTarget(
								destination,
								grants,
								constraint.cache,
								target,
								constraint.expectedCacheGeneration,
								selector
							)
						)
					);
		// Reuse the read service's backed semantic arbitration, never select merely
		// the first local reservation or combine disagreeing NARs from a view.
		const arbitrated = await new ReuseViewLookupService(
			this.context
		).lookupWithArbitration(
			rootLogger(),
			selector.view,
			access,
			StorePath.hash(target.storePath)
		);
		this.selector(selector, grants);
		if (arbitrated?.kind === 'changed') {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		if (constrained !== undefined) {
			authority.revalidate(constrained, grants);
		}
		if (arbitrated?.narInfo.storePath.value !== target.storePath) {
			if (target.narHash !== undefined || target.generation !== undefined) {
				throw new ORPCError('PUBLICATION_RESULT_CHANGED');
			}
			return undefined;
		}
		const selectors = reuseViewSelectorsFromRows(
			selector.view,
			this.context.db
				.select()
				.from(schema.nativeReuseViewSelectors)
				.where(eq(schema.nativeReuseViewSelectors.view, selector.view))
				.all()
		);
		const hash = StorePath.hash(target.storePath);
		const narHash = publicationResultIdentitySchema.shape.narHash.parse(
			arbitrated.narInfo.narHash.toString()
		);
		const rows = this.context.db
			.select(getTableColumns(schema.narInfos))
			.from(schema.narInfos)
			.innerJoin(
				schema.cacheIdentities,
				eq(schema.cacheIdentities.id, schema.narInfos.cacheId)
			)
			.where(
				and(
					eq(schema.narInfos.storePathHash, hash),
					eq(schema.narInfos.storePath, target.storePath),
					eq(schema.narInfos.narHash, narHash),
					eq(schema.cacheIdentities.access, access),
					isNull(schema.cacheIdentities.deletedAt),
					cacheSelectorsCondition(
						schema.cacheIdentities.kind,
						schema.cacheIdentities.name,
						selectors
					)
				)
			)
			.orderBy(schema.narInfos.cacheId)
			.all();
		// A previously unbacked sibling can commit after arbitration's edge read.
		// Pin only exact arbitrated identities before the shared-state await.
		const candidates = rows
			.filter((row) =>
				arbitrated.arbitration.candidates.some(
					(candidate) =>
						candidate.cacheId === row.cacheId &&
						candidate.storePathHash === row.storePathHash &&
						candidate.generation === row.generation &&
						candidate.narHash === row.narHash
				)
			)
			.map((row) => ({
				row,
				cache: this.context.cacheRepository.resolvedForId(row.cacheId)
			}));
		const isConstraintSatisfied = ({
			row,
			cache
		}: (typeof candidates)[number]) =>
			constraint === undefined ||
			(cache.id === constrained?.cache.id &&
				cache.generation === constrained.cache.generation &&
				row.generation === constrained.result.generation &&
				row.narHash === constrained.result.narHash);
		if (
			constraint !== undefined &&
			candidates.every((candidate) => !isConstraintSatisfied(candidate))
		) {
			if (target.narHash !== undefined || target.generation !== undefined) {
				throw new ORPCError('PUBLICATION_RESULT_CHANGED');
			}
			return { arbitration: arbitrated.arbitration };
		}
		const versions = candidates.map(({ row, cache }) => ({
			cacheKind: cache.scope.kind,
			cacheName: cache.scope.kind === 'named' ? cache.scope.name : '',
			storePathHash: row.storePathHash,
			generation: row.generation
		}));
		const edgePages = await batchNonEmpty(
			this.context.d1,
			jsonRowLists(versions).map((list) =>
				reuseEdgeSelect(
					this.context.d1,
					this.context.requireTenant(),
					access,
					list
				)
			)
		);
		const edges = edgePages.flat();
		const candidate = candidates.find((candidate) => {
			const { row, cache } = candidate;
			return (
				isConstraintSatisfied(candidate) &&
				edges.some(
					(edge) =>
						edge.cacheKind === cache.scope.kind &&
						(edge.cacheName ?? '') ===
							(cache.scope.kind === 'named' ? cache.scope.name : '') &&
						edge.storePathHash === row.storePathHash &&
						edge.generation === row.generation &&
						edge.narHash === row.narHash
				)
			);
		});
		if (
			candidate === undefined ||
			(target.narHash !== undefined &&
				target.narHash !== candidate.row.narHash) ||
			(target.generation !== undefined &&
				target.generation !== candidate.row.generation)
		) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		const { row, cache } = candidate;
		const snapshot = new PublicationManifestAuthority(
			this.context
		).resolveTarget(
			destination,
			grants,
			cache.scope,
			{
				storePath: row.storePath,
				narHash: row.narHash,
				generation: row.generation
			},
			cache.generation,
			selector
		);
		if (
			snapshot.cache.id !== cache.id ||
			snapshot.cache.access !== cache.access
		) {
			throw new ORPCError('PUBLICATION_SCOPE_CHANGED');
		}
		return { snapshot, arbitration: arbitrated.arbitration };
	}

	/**
	Temporary cache-wide barrier until bounded exact-version invalidation completes.
	*/
	requireAvailable(cache: ResolvedCache): void {
		if (
			new PublicationManifestAvailabilityStore(this.context.db).hasPending({
				cacheId: cache.id,
				cacheGeneration: cache.generation
			})
		) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
	}

	/**
	Constant-size proof check. Call inside the transaction selecting the winner,
	after current authority, destination identity and cursor checks. Intake must
	stage each exact authorised member through the normal bounded write path;
	this invariant is not a substitute for that validation or its GC barriers.
	*/
	assertCandidateComplete(operationId: string, expectedCount: number): void {
		const operations = schema.publicationManifestOperations;
		const cardinalities = schema.publicationManifestCardinalities;
		const proof = this.context.db
			.select({
				state: operations.state,
				cacheId: operations.cacheId,
				cacheGeneration: operations.cacheGeneration,
				expectedCount: operations.expectedCount,
				memberCount: cardinalities.memberCount,
				valid: cardinalities.valid
			})
			.from(operations)
			.innerJoin(
				cardinalities,
				and(
					eq(cardinalities.kind, 'candidate'),
					eq(cardinalities.id, operations.id)
				)
			)
			.where(eq(operations.id, operationId))
			.get();
		if (
			proof !== undefined &&
			new PublicationManifestAvailabilityStore(this.context.db).hasPending(
				proof
			)
		) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
		if (
			proof?.state !== 'pending' ||
			proof.expectedCount !== expectedCount ||
			proof.memberCount !== expectedCount ||
			!proof.valid
		) {
			throw new ORPCError('CONFLICT');
		}
	}

	/**
	Final capture/ensure invariant, in the same transaction as winner selection.
	Both cardinalities are maintained by migration 0083, including direct SQL
	writes. Mutation invalidity is sticky; restoring a row cannot erase it.
	*/
	assertMaterialisationComplete(
		operationId: string,
		digest: string,
		expectedCount: number
	): void {
		const operation = this.context.db
			.select({
				cacheId: schema.publicationManifestOperations.cacheId,
				cacheGeneration: schema.publicationManifestOperations.cacheGeneration
			})
			.from(schema.publicationManifestOperations)
			.where(eq(schema.publicationManifestOperations.id, operationId))
			.get();
		if (
			operation !== undefined &&
			new PublicationManifestAvailabilityStore(this.context.db).hasPending(
				operation
			)
		) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
		this.assertCandidateComplete(operationId, expectedCount);
		const headers = schema.publicationManifests;
		const operations = schema.publicationManifestOperations;
		const cardinalities = schema.publicationManifestCardinalities;
		const proof = this.context.db
			.select({
				version: headers.version,
				expectedCount: headers.memberCount,
				memberCount: cardinalities.memberCount,
				valid: cardinalities.valid
			})
			.from(headers)
			.innerJoin(
				operations,
				and(
					eq(operations.id, operationId),
					eq(operations.candidateDigest, headers.digest),
					eq(operations.cursor, expectedCount)
				)
			)
			.innerJoin(
				cardinalities,
				and(
					eq(cardinalities.kind, 'portable'),
					eq(cardinalities.id, headers.digest)
				)
			)
			.where(eq(headers.digest, digest))
			.get();
		if (
			proof?.version !== 1 ||
			proof.expectedCount !== expectedCount ||
			proof.memberCount !== expectedCount ||
			!proof.valid
		) {
			throw new ORPCError('CONFLICT');
		}
	}

	/**
	Indexed certificate read: never enumerate portable or destination members.
	*/
	association(
		cache: ResolvedCache,
		result: PublicationResultIdentity
	): PublicationManifestAssociation | undefined {
		if (
			cache.generation !== result.cacheGeneration ||
			!isSameCacheScope(cache.scope, result.cache)
		) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		const association = schema.resultPublications;
		const manifest = schema.publicationManifests;
		const hash = StorePath.hash(result.storePath);
		const row = this.context.db
			.select({
				digest: association.digest,
				origin: association.origin,
				complete: association.complete,
				memberCount: manifest.memberCount
			})
			.from(association)
			.leftJoin(manifest, eq(manifest.digest, association.digest))
			.where(
				and(
					eq(association.cacheId, cache.id),
					eq(association.cacheGeneration, result.cacheGeneration),
					eq(association.resultHash, hash),
					eq(association.resultPath, result.storePath),
					eq(association.resultGeneration, result.generation),
					eq(association.resultNarHash, result.narHash)
				)
			)
			.get();
		if (row === undefined) {
			return undefined;
		}
		if (row.memberCount === null) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
		return {
			publication: recordedPublicationSchema.parse({
				result,
				digest: row.digest,
				memberCount: row.memberCount,
				origin: row.origin
			}),
			complete:
				row.complete &&
				!new PublicationManifestAvailabilityStore(this.context.db).hasPending({
					cacheId: cache.id,
					cacheGeneration: cache.generation
				})
		};
	}

	/**
	Exact selected proof page for promotion; unselected candidates are invisible.
	*/
	selectedMembers(
		cache: ResolvedCache,
		result: PublicationResultIdentity,
		after?: StorePathHash
	):
		| {
				materialisationId: string;
				members: (typeof schema.resultPublicationMembers.$inferSelect)[];
		  }
		| undefined {
		this.association(cache, result);
		const association = schema.resultPublications;
		const hash = StorePath.hash(result.storePath);
		const selected = this.context.db
			.select()
			.from(association)
			.where(
				and(
					eq(association.cacheId, cache.id),
					eq(association.cacheGeneration, result.cacheGeneration),
					eq(association.resultHash, hash),
					eq(association.resultGeneration, result.generation),
					eq(association.resultPath, result.storePath),
					eq(association.resultNarHash, result.narHash)
				)
			)
			.get();
		if (selected === undefined) {
			return undefined;
		}
		const members = schema.resultPublicationMembers;
		return {
			materialisationId: selected.materialisationId,
			members: this.context.db
				.select()
				.from(members)
				.where(
					and(
						eq(members.cacheId, cache.id),
						eq(members.cacheGeneration, result.cacheGeneration),
						eq(members.resultHash, selected.resultHash),
						eq(members.resultGeneration, result.generation),
						eq(members.materialisationId, selected.materialisationId),
						after === undefined ? undefined : gt(members.memberHash, after)
					)
				)
				.orderBy(members.memberHash)
				.limit(publicationManifestPageMaxMembers)
				.all()
		};
	}

	async lookup(
		destination: CacheScope,
		grants: AuthorizationDetails,
		input: PublicationLookupRequest
	): Promise<PublicationLookupResponse> {
		if (!isCoveredByToken(grants, 'upload:commit', { cache: destination })) {
			throw new ORPCError('FORBIDDEN');
		}
		if (input.results.length > publicationLookupMaxResults) {
			throw new ORPCError('PUBLICATION_LIMIT_EXCEEDED', {
				data: { limit: 'lookup-results', maximum: publicationLookupMaxResults }
			});
		}
		const request = publicationLookupRequestSchema.parse(input);
		const authority = new PublicationManifestAuthority(this.context);
		const view =
			request.source.selector === undefined
				? undefined
				: this.selector(request.source.selector, grants);
		const source = request.source.cache;
		const snapshots: (
			| {
					snapshot?: PublicationManifestAuthoritySnapshot;
					arbitration?: ReuseViewArbitrationSnapshot;
					recorded: boolean;
					isAccepted: boolean;
			  }
			| undefined
		)[] = [];
		for (const target of request.results) {
			const selected =
				view === undefined
					? source === undefined
						? undefined
						: {
								snapshot: await this.context.criticalSection(() =>
									Promise.resolve(
										authority.findTarget(
											destination,
											grants,
											source,
											target,
											request.source.expectedCacheGeneration
										)
									)
								)
							}
					: await this.viewTarget(
							destination,
							grants,
							target,
							view,
							source === undefined
								? undefined
								: {
										cache: source,
										expectedCacheGeneration:
											request.source.expectedCacheGeneration
									}
						);
			const snapshot = selected?.snapshot;
			if (snapshot === undefined) {
				snapshots.push(
					selected === undefined
						? undefined
						: { ...selected, recorded: false, isAccepted: false }
				);
				continue;
			}
			if (
				request.source.expectedCacheGeneration !== undefined &&
				snapshot.cache.generation !== request.source.expectedCacheGeneration
			) {
				throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
			}
			const isRecorded =
				this.association(snapshot.cache, snapshot.result) !== undefined;
			let isAccepted = true;
			if (!isRecorded) {
				if (target.narHash === undefined && target.generation === undefined) {
					isAccepted = await authority.isServable(snapshot);
				} else {
					await authority.requireServable(snapshot);
				}
			}
			snapshots.push({
				snapshot,
				recorded: isRecorded,
				isAccepted,
				...(selected !== undefined &&
					'arbitration' in selected && { arbitration: selected.arbitration })
			});
		}
		return this.context.criticalSection(async () => {
			if (view !== undefined) {
				this.selector(view.selector, grants);
			}
			const entries: PublicationLookupResponse['entries'] = [];
			for (const [index, entry] of snapshots.entries()) {
				const target = request.results[index];
				if (target === undefined) {
					throw new ORPCError('CONFLICT');
				}
				if (entry?.snapshot === undefined) {
					// A combined floating miss may have a concrete row: its view still
					// refuses selection. Recheck authority without bypassing arbitration.
					const current =
						request.source.cache === undefined
							? undefined
							: authority.findTarget(
									destination,
									grants,
									request.source.cache,
									target,
									request.source.expectedCacheGeneration,
									view?.selector
								);
					if (view === undefined && current !== undefined) {
						throw new ORPCError('PUBLICATION_RESULT_CHANGED');
					}
				} else {
					authority.revalidate(entry.snapshot, grants);
				}
				if (
					entry?.arbitration !== undefined &&
					!(await new ReuseViewLookupService(
						this.context
					).revalidateArbitration(entry.arbitration))
				) {
					throw new ORPCError('PUBLICATION_RESULT_CHANGED');
				}
				if (entry?.snapshot === undefined || !entry.isAccepted) {
					entries.push({ kind: 'unavailable', storePath: target.storePath });
					continue;
				}
				const { snapshot, recorded } = entry;
				const association = this.association(snapshot.cache, snapshot.result);
				if (recorded && association === undefined) {
					throw new ORPCError('PUBLICATION_RESULT_CHANGED');
				}
				entries.push(
					association === undefined
						? { kind: 'missing', result: snapshot.result }
						: { kind: 'recorded', ...association }
				);
			}
			return {
				...(view !== undefined && { sourceSelector: view.selector }),
				entries
			};
		});
	}
}
