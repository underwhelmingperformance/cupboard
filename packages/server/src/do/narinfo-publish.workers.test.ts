import {
	narInfoGenerationSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentServer,
	initialise,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { NarInfoObjectsService } from './narinfo-objects-service.ts';

const cache = '';

function narInfoRowFilter(storePathHash: string): ReturnType<typeof and> {
	return and(
		eq(schema.narInfos.cache, cache),
		eq(schema.narInfos.storePathHash, storePathHashSchema.parse(storePathHash))
	);
}

async function committedRow(
	storePathHash: string
): Promise<typeof schema.narInfos.$inferSelect> {
	const filter = narInfoRowFilter(storePathHash);
	const row = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db.select().from(schema.narInfos).where(filter).get()
	);

	expect(row).toBeDefined();

	if (row === undefined) {
		throw new Error('missing committed narinfo row');
	}

	return row;
}

async function narInfoObjectText(
	storePathHash: string
): Promise<string | undefined> {
	const object = await env.BLOBS.get(
		narInfoObjectKey(
			fixtureTenant,
			storePathHashSchema.parse(storePathHash),
			cache
		)
	);

	return object === null ? undefined : object.text();
}

// The narinfo object publishes outside the critical section, so a publish can
// land after a gated delete or recommit has already decided the path's fate.
// The post-publish fence re-reads the row under the gate and rewrites the
// object from it, so a stale publish can never outlive that decision.
describe('narinfo object publish fence', () => {
	beforeEach(resetTestServer);

	it('rewrites a publish whose version the row no longer names', async () => {
		const token = await initialise();
		const nar = await verifiableNar('publish-fence');
		const metadata = uploadMetadata({
			name: 'fenced',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);

		const row = await committedRow(metadata.storePathHash);
		const current = await narInfoObjectText(metadata.storePathHash);

		// A publish carrying a version the row no longer names: the shape of a
		// put that raced the row's committed version. Its content differs from
		// the row's render, so the fence's rewrite is observable.
		await runInDurableObject(currentServer(), async (instance) => {
			const service = new NarInfoObjectsService(instance.context);
			const staleNarInfo = await service.narInfoFromRow({
				...row,
				storePath: storePathSchema.parse(
					row.storePath.replace('fenced', 'staler')
				)
			});

			expect(staleNarInfo).toBeDefined();

			if (staleNarInfo === undefined) {
				return;
			}

			await service.publishNarInfoObject(
				cache,
				row.storePathHash,
				narInfoGenerationSchema.parse(row.generation + 1),
				row.narHash,
				staleNarInfo
			);
		});

		// The fence saw the row naming a different version, so it re-rendered
		// the object from the row.
		expect(await narInfoObjectText(metadata.storePathHash)).toBe(current);
	});

	it('removes a publish whose row is gone', async () => {
		const token = await initialise();
		const nar = await verifiableNar('publish-fence-gone');
		const metadata = uploadMetadata({
			name: 'doomed',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);

		const row = await committedRow(metadata.storePathHash);

		// The row vanishes (the shape of a gated delete landing between the
		// charge and the object put), then the late publish arrives.
		const filter = narInfoRowFilter(metadata.storePathHash);
		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.db.delete(schema.narInfos).where(filter).run();

			const service = new NarInfoObjectsService(instance.context);
			const narInfo = await service.narInfoFromRow(row);

			expect(narInfo).toBeDefined();

			if (narInfo === undefined) {
				return;
			}

			await service.publishNarInfoObject(
				cache,
				row.storePathHash,
				row.generation,
				row.narHash,
				narInfo
			);
		});

		expect(await narInfoObjectText(metadata.storePathHash)).toBeUndefined();
	});
});
