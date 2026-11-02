import {
	cacheGenerationSchema,
	type CacheScope,
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	publicationEnsureRequestSchema,
	type PublicationOperationId
} from '@cupboard/protocol/publication-manifests';
import {
	type PublicationEntry,
	publicationIdSchema,
	type PushId,
	pushIdSchema,
	type UploadId,
	type UploadPathNegotiation
} from '@cupboard/protocol/upload';
import { ORPCError } from '@orpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import type { ServerContext } from './context.ts';

const pathDeclarationSchema = z.tuple([
	storePathHashSchema,
	storePathSchema,
	nixSha256HashSchema,
	z.number(),
	z.array(z.string()),
	z.string().nullable(),
	z.string().nullable()
]);

const declarationSchema = z.tuple([
	z.literal('cupboard/publication/v1'),
	z.string(),
	z.enum(['default', 'named']),
	z.string().nullable(),
	cacheGenerationSchema,
	pushIdSchema,
	pathDeclarationSchema,
	z.unknown()
]);

export function requireManifestPublicationOrigin(
	context: ServerContext,
	scope: CacheScope,
	pushId: PushId,
	entry: PublicationEntry,
	manifestOperationId: PublicationOperationId | undefined
): typeof schema.publicationManifestAdmissions.$inferSelect | undefined {
	const admission = context.db
		.select()
		.from(schema.publicationManifestAdmissions)
		.where(eq(schema.publicationManifestAdmissions.pushId, pushId))
		.get();
	if (admission === undefined && manifestOperationId === undefined) {
		return;
	}
	if (
		admission === undefined ||
		admission.operationId !== manifestOperationId ||
		admission.destinationKind !== scope.kind ||
		(admission.destinationName ?? undefined) !==
			(scope.kind === 'named' ? scope.name : undefined) ||
		admission.cacheGeneration !== entry.cacheGeneration ||
		Date.parse(admission.expiresAt) <= Date.now()
	) {
		throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
	}
	const request = publicationEnsureRequestSchema.parse(
		JSON.parse(admission.canonicalJson)
	);
	if (request.expectedDestinationGeneration !== entry.cacheGeneration) {
		throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
	}
	const member = context.db
		.select()
		.from(schema.publicationManifestMembers)
		.where(
			and(
				eq(schema.publicationManifestMembers.digest, request.source.digest),
				eq(
					schema.publicationManifestMembers.storePath,
					entry.metadata.storePath
				)
			)
		)
		.get();
	if (member?.narHash !== entry.metadata.narHash) {
		throw new ORPCError('PUBLICATION_RESULT_CHANGED');
	}
	const page = context.db
		.select()
		.from(schema.publicationManifestOperationPages)
		.where(
			and(
				eq(
					schema.publicationManifestOperationPages.operationId,
					admission.operationId
				),
				eq(schema.publicationManifestOperationPages.page, member.ordinal)
			)
		)
		.get();
	if (
		page?.payloadDigest !== entry.operationId ||
		page.payloadJson !==
			JSON.stringify({
				kind: 'ensure-member-admission',
				storePath: entry.metadata.storePath,
				publicationId: entry.operationId
			})
	) {
		throw new ORPCError('PUBLICATION_IDEMPOTENCY_CONFLICT');
	}
	const cache = context.cacheRepository.require(scope);
	if (admission.cacheId !== null && admission.cacheId !== cache.id) {
		throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
	}
	return admission;
}

/** Manifest receipts can be pruned before ordinary work finishes.
A publication-shaped orphan must not become an unrestricted legacy upload. */
export function isManifestPublicationCompatible(
	context: ServerContext,
	id: UploadId | undefined,
	cache: ResolvedCache,
	metadata: Pick<
		UploadPathNegotiation,
		'storePathHash' | 'storePath' | 'narHash'
	>,
	winner?: Pick<typeof schema.narInfos.$inferSelect, 'storePath' | 'narHash'>
): boolean {
	if (id === undefined || !publicationIdSchema.safeParse(id).success) {
		return true;
	}
	const operation = context.db
		.select()
		.from(schema.publicationOperations)
		.where(eq(schema.publicationOperations.id, id))
		.get();
	if (
		operation?.cacheId !== cache.id ||
		operation.cacheGeneration !== cache.generation
	) {
		return false;
	}
	if (operation.manifestOperationId === null) {
		return true;
	}
	let declaration: unknown;
	try {
		declaration = JSON.parse(operation.canonicalJson);
	} catch {
		return false;
	}
	const parsed = declarationSchema.safeParse(declaration);
	if (!parsed.success) {
		return false;
	}
	const [, tenant, kind, name, generation, pushId, path] = parsed.data;
	const current =
		winner ??
		context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, metadata.storePathHash)
				)
			)
			.get();
	return (
		tenant === context.requireTenant() &&
		kind === cache.scope.kind &&
		(name ?? undefined) ===
			(cache.scope.kind === 'named' ? cache.scope.name : undefined) &&
		generation === cache.generation &&
		pushId === operation.pushId &&
		path[0] === metadata.storePathHash &&
		path[1] === metadata.storePath &&
		path[2] === metadata.narHash &&
		(current === undefined ||
			(current.storePath === path[1] && current.narHash === path[2]))
	);
}

export function requireManifestPublication(
	...arguments_: Parameters<typeof isManifestPublicationCompatible>
): void {
	if (!isManifestPublicationCompatible(...arguments_)) {
		throw new ORPCError('PUBLICATION_DIVERGENCE');
	}
}
