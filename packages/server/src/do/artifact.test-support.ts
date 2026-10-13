import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import {
	artifactGenerationSchema,
	artifactIdSchema,
	type ArtifactKind
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { defaultCache, tenantUsageRow } from '../test-support.ts';

import type { ServerContext } from './context.ts';

export const artifactFixtureId = artifactIdSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
export const artifactFixtureGeneration = artifactGenerationSchema.parse(1);

export async function createArtifact(
	context: ServerContext,
	kind: ArtifactKind = 'listing'
) {
	const bytes = new TextEncoder().encode('native artifact');
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
	const incarnation = await new CasObjectStore(
		context.d1,
		context.env.BLOBS
	).promote({ digest, size: bytes.byteLength, bytes });
	const cache = context.cacheRepository.require(defaultCache());
	const createdAt = isoTimestamp(new Date());
	const expiresAt = isoTimestamp(new Date(Date.now() + 30 * 86_400_000));
	context.db
		.insert(schema.artifacts)
		.values({
			id: artifactFixtureId,
			generation: artifactFixtureGeneration,
			cacheId: cache.id,
			kind,
			digest,
			publicationIncarnation: incarnation,
			state: 'pending',
			createdAt,
			expiresAt: kind === 'build-log' ? expiresAt : undefined
		})
		.run();
	await context.d1
		.update(d1Schema.casObject)
		.set({ deleteAfter: createdAt })
		.where(eq(d1Schema.casObject.digest, digest));
	return { digest, size: bytes.byteLength, incarnation, cache, createdAt };
}

export async function reservationState(context: ServerContext) {
	const [presence, references, objects] = await context.d1.batch([
		context.d1.select().from(d1Schema.tenantCasBlob),
		context.d1.select().from(d1Schema.artifactReference),
		context.d1.select().from(d1Schema.casObject)
	]);
	return {
		usage: await tenantUsageRow(),
		presence,
		references: references.map((row) => ({
			...row,
			cacheName: row.cacheName ?? undefined
		})),
		objects: objects.map((row) => ({
			...row,
			deleteAfter: row.deleteAfter ?? undefined
		}))
	};
}
