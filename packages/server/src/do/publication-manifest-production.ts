import { type CacheScope, isSameCacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	publicationCleanupMarginMs,
	publicationIdentity,
	publicationRecoveryMs
} from '@cupboard/protocol/publication';
import {
	isFreshPublicationRequestId,
	type PublicationOperationId,
	publicationResultIdentitySchema
} from '@cupboard/protocol/publication-manifests';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type PublicationEntry,
	publicationIdSchema,
	type PushId,
	uploadPathNegotiationSchema
} from '@cupboard/protocol/upload';
import { ORPCError } from '@orpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { pushIdSigningKey } from '../blob/push-credential.ts';
import { createPushId } from '../blob/push-id.ts';
import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import type { ServerContext } from './context.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import type {
	PublicationManifestPublication,
	PublicationManifestPublisher
} from './publication-manifest-publisher.ts';

type Admission = typeof schema.publicationManifestAdmissions.$inferSelect;

interface ManifestPublicationCoordinator {
	admit(
		scope: CacheScope,
		pushId: PushId,
		entry: PublicationEntry,
		grants: AuthorizationDetails,
		expiresAt: IsoTimestamp,
		manifestOperationId: PublicationOperationId
	): Promise<{
		cache: ResolvedCache;
		kind: 'pending' | 'needs-upload' | 'concluded';
	}>;
	publish(
		scope: CacheScope,
		pushId: PushId,
		entry: PublicationEntry,
		grants: AuthorizationDetails,
		expiresAt: IsoTimestamp,
		manifestOperationId: PublicationOperationId
	): Promise<void>;
}

export const ensureMemberAdmissionSchema = z.strictObject({
	kind: z.literal('ensure-member-admission'),
	storePath: uploadPathNegotiationSchema.shape.storePath,
	publicationId: publicationIdSchema
});

/**
Durable intent and immutable ordinal mapping around the ordinary publication coordinator.
*/
export class ProductionPublicationManifestPublisher implements PublicationManifestPublisher {
	constructor(
		private readonly context: ServerContext,
		private readonly coordinator: ManifestPublicationCoordinator
	) {}

	private row(input: PublicationManifestPublication): Admission | undefined {
		const table = schema.publicationManifestAdmissions;
		const row = this.context.db
			.select()
			.from(table)
			.where(eq(table.operationId, input.operationId))
			.get();
		if (row === undefined) {
			return;
		}
		if (
			row.destinationKind !== input.destination.kind ||
			(row.destinationName ?? undefined) !==
				(input.destination.kind === 'named'
					? input.destination.name
					: undefined)
		) {
			throw new ORPCError('PUBLICATION_SCOPE_CHANGED');
		}
		if (
			row.canonicalJson !== JSON.stringify(input.request) ||
			row.cacheGeneration !== input.request.expectedDestinationGeneration
		) {
			throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
		}
		if (Date.parse(row.expiresAt) <= Date.now()) {
			throw new ORPCError('GONE');
		}
		const cache = this.context.cacheRepository.resolve(input.destination);
		if (
			(cache !== undefined && cache.generation !== row.cacheGeneration) ||
			(row.cacheId !== null && cache?.id !== row.cacheId)
		) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		return row;
	}

	private async pin(input: PublicationManifestPublication): Promise<Admission> {
		const now = Date.now();
		const expiresAt = isoTimestamp(
			new Date(Math.floor((now + publicationRecoveryMs) / 1000) * 1000)
		);
		const pushId = await createPushId(
			pushIdSigningKey(this.context.env),
			this.context.requireTenant(),
			Date.parse(expiresAt) / 1000
		);
		return this.context.criticalSection(() => {
			new PublicationManifestAuthority(this.context).resolveRecorded(
				input.destination,
				input.grants,
				input.request.source,
				input.request.sourceSelector
			);
			const existing = this.row(input);
			if (existing !== undefined) {
				return Promise.resolve(existing);
			}
			if (!isFreshPublicationRequestId(input.request.requestId, new Date())) {
				throw new ORPCError('GONE');
			}
			const cache = this.context.cacheRepository.resolve(input.destination);
			if (
				cache !== undefined &&
				cache.generation !== input.request.expectedDestinationGeneration
			) {
				throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
			}
			const table = schema.publicationManifestAdmissions;
			const pruneAfter = isoTimestamp(
				new Date(Date.parse(expiresAt) + publicationCleanupMarginMs)
			);
			this.context.db
				.insert(table)
				.values({
					operationId: input.operationId,
					destinationKind: input.destination.kind,
					destinationName:
						input.destination.kind === 'named'
							? input.destination.name
							: undefined,
					cacheGeneration: input.request.expectedDestinationGeneration,
					cacheId: cache?.id,
					canonicalJson: JSON.stringify(input.request),
					pushId,
					expiresAt,
					pruneAfter
				})
				.run();
			const row = this.row(input);
			if (row === undefined) {
				throw new ORPCError('CONFLICT');
			}
			return Promise.resolve(row);
		});
	}

	private async entry(
		input: PublicationManifestPublication,
		admission: Admission
	): Promise<PublicationEntry> {
		const authority = new PublicationManifestAuthority(this.context);
		// Destination registration may have happened since the caller's snapshot.
		const source = authority.resolveExact(
			input.destination,
			input.grants,
			input.source.result,
			input.request.sourceSelector
		);
		await authority.requireServable(source);
		const hash = StorePath.hash(source.result.storePath);
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, source.cache.id),
					eq(schema.narInfos.storePathHash, hash)
				)
			)
			.get();
		if (row === undefined) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		const metadata = uploadPathNegotiationSchema.parse({
			storePathHash: row.storePathHash,
			storePath: row.storePath,
			narHash: row.narHash,
			narSize: row.narSize,
			references: z.array(z.string()).parse(JSON.parse(row.referencesJson)),
			...(row.deriver !== null && { deriver: row.deriver }),
			...(row.ca !== null && { ca: row.ca })
		});
		const identity = await publicationIdentity({
			tenant: this.context.requireTenant(),
			cache: input.destination,
			cacheGeneration: admission.cacheGeneration,
			pushId: admission.pushId,
			metadata
		});
		return this.context.criticalSection(() => {
			authority.revalidate(source, input.grants);
			this.row(input);
			const members = schema.publicationManifestMembers;
			const member = this.context.db
				.select()
				.from(members)
				.where(
					and(
						eq(members.digest, input.request.source.digest),
						eq(members.storePath, metadata.storePath)
					)
				)
				.get();
			if (member?.narHash !== metadata.narHash) {
				throw new ORPCError('PUBLICATION_RESULT_CHANGED');
			}
			const destination = this.context.cacheRepository.resolve(
				input.destination
			);
			if (destination !== undefined) {
				const existing = this.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, destination.id),
							eq(schema.narInfos.storePathHash, metadata.storePathHash)
						)
					)
					.get();
				if (
					existing !== undefined &&
					(existing.storePath !== metadata.storePath ||
						existing.narHash !== metadata.narHash)
				) {
					throw new ORPCError('PUBLICATION_DIVERGENCE');
				}
			}
			const pages = schema.publicationManifestOperationPages;
			const previous = this.context.db
				.select()
				.from(pages)
				.where(
					and(
						eq(pages.operationId, input.operationId),
						eq(pages.page, member.ordinal)
					)
				)
				.get();
			const payload = {
				kind: 'ensure-member-admission' as const,
				storePath: metadata.storePath,
				publicationId: identity.id
			};
			const payloadJson = JSON.stringify(payload);
			if (
				previous !== undefined &&
				(JSON.stringify(
					ensureMemberAdmissionSchema.parse(JSON.parse(previous.payloadJson))
				) !== payloadJson ||
					previous.payloadDigest !== identity.id)
			) {
				throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
			}
			if (previous === undefined) {
				this.context.db
					.insert(pages)
					.values({
						operationId: input.operationId,
						page: member.ordinal,
						payloadDigest: identity.id,
						payloadJson
					})
					.run();
			}
			return Promise.resolve({
				operationId: identity.id,
				cacheGeneration: admission.cacheGeneration,
				metadata
			});
		});
	}

	private async bind(
		input: PublicationManifestPublication,
		cache: ResolvedCache
	): Promise<void> {
		await this.context.criticalSection(() => {
			const row = this.row(input);
			if (
				row === undefined ||
				!isSameCacheScope(cache.scope, input.destination) ||
				cache.generation !== row.cacheGeneration ||
				(row.cacheId !== null && row.cacheId !== cache.id)
			) {
				throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
			}
			this.context.db
				.update(schema.publicationManifestAdmissions)
				.set({ cacheId: cache.id })
				.where(
					eq(
						schema.publicationManifestAdmissions.operationId,
						input.operationId
					)
				)
				.run();
			return Promise.resolve();
		});
	}

	async admit(input: PublicationManifestPublication) {
		const admission = await this.pin(input);
		const authority = new PublicationManifestAuthority(this.context);
		const cache = this.context.cacheRepository.resolve(input.destination);
		const member = this.context.db
			.select()
			.from(schema.publicationManifestMembers)
			.where(
				and(
					eq(
						schema.publicationManifestMembers.digest,
						input.request.source.digest
					),
					eq(
						schema.publicationManifestMembers.storePath,
						input.source.result.storePath
					)
				)
			)
			.get();
		const mapping =
			member === undefined
				? undefined
				: this.context.db
						.select()
						.from(schema.publicationManifestOperationPages)
						.where(
							and(
								eq(
									schema.publicationManifestOperationPages.operationId,
									input.operationId
								),
								eq(
									schema.publicationManifestOperationPages.page,
									member.ordinal
								)
							)
						)
						.get();
		if (cache !== undefined && mapping === undefined) {
			const hash = StorePath.hash(input.source.result.storePath);
			const row = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, hash)
					)
				)
				.get();
			if (
				row !== undefined &&
				(row.storePath !== input.source.result.storePath ||
					row.narHash !== input.source.result.narHash)
			) {
				throw new ORPCError('PUBLICATION_DIVERGENCE');
			}
			if (row !== undefined) {
				const snapshot = authority.resolveTarget(
					input.destination,
					input.grants,
					input.destination,
					{
						storePath: row.storePath,
						narHash: row.narHash,
						generation: row.generation
					},
					cache.generation
				);
				if (await authority.isServable(snapshot)) {
					await this.bind(input, cache);
					return {
						cache,
						expiresAt: admission.expiresAt,
						confirmation: snapshot
					};
				}
			}
		}
		const entry = await this.entry(input, admission);
		const outcome = await this.coordinator.admit(
			input.destination,
			admission.pushId,
			entry,
			input.grants,
			admission.expiresAt,
			input.operationId
		);
		await this.bind(input, outcome.cache);
		if (outcome.kind === 'needs-upload') {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
		// Start the ordinary result commit before recording an ensure receipt.
		// Even a concurrent warm winner must not discard this intent's captured
		// retention event. Deferred work stays on normal verified maintenance.
		await this.coordinator.publish(
			input.destination,
			admission.pushId,
			entry,
			input.grants,
			admission.expiresAt,
			input.operationId
		);
		return { cache: outcome.cache, expiresAt: admission.expiresAt };
	}

	async publish(
		input: PublicationManifestPublication & { readonly expiresAt: IsoTimestamp }
	) {
		const admission = this.row(input);
		if (admission?.expiresAt !== input.expiresAt) {
			throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
		}
		const entry = await this.entry(input, admission);
		await this.coordinator.publish(
			input.destination,
			admission.pushId,
			entry,
			input.grants,
			admission.expiresAt,
			input.operationId
		);
		const authority = new PublicationManifestAuthority(this.context);
		const cache = this.context.cacheRepository.require(input.destination);
		await this.bind(input, cache);
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, entry.metadata.storePathHash)
				)
			)
			.get();
		if (row === undefined) {
			return { kind: 'pending' as const };
		}
		if (
			row.storePath !== entry.metadata.storePath ||
			row.narHash !== entry.metadata.narHash
		) {
			throw new ORPCError('PUBLICATION_DIVERGENCE');
		}
		const result = publicationResultIdentitySchema.parse({
			cache: cache.scope,
			cacheGeneration: cache.generation,
			storePath: row.storePath,
			narHash: row.narHash,
			generation: row.generation
		});
		const snapshot = authority.resolveExact(
			input.destination,
			input.grants,
			result
		);
		if (!(await authority.isServable(snapshot))) {
			return { kind: 'pending' as const };
		}
		authority.resolveExact(
			input.destination,
			input.grants,
			input.source.result,
			input.request.sourceSelector
		);
		return { kind: 'accepted' as const, result };
	}
}
