import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	initialise,
	resetTestServer,
	testPushId
} from '../test-support.ts';

import { PublicationStore } from './publication-store.ts';

it('prunes terminal records only after their cleanup margin and retains active records', async () => {
	await resetTestServer();
	await initialise();
	const rows = await runInDurableObject(currentServer(), (instance) => {
		const now = new Date().toISOString();
		const cache = instance.context.db
			.select()
			.from(schema.cacheIdentities)
			.get();
		if (cache === undefined) {
			throw new Error('Expected the default cache');
		}
		const records = [
			{ character: 'a', state: 'accepted', pruneAfter: now },
			{ character: 'b', state: 'servable', pruneAfter: now },
			{ character: 'c', state: 'failed', pruneAfter: now },
			{ character: 'd', state: 'expired', pruneAfter: now },
			{
				character: 'e',
				state: 'expired',
				pruneAfter: new Date(Date.now() + 1).toISOString()
			}
		] as const;
		for (const record of records) {
			instance.context.db
				.insert(schema.publicationOperations)
				.values({
					id: uploadIdSchema.parse(record.character.repeat(64)),
					cacheId: cache.id,
					cacheGeneration: cache.generation,
					pushId: testPushId,
					canonicalJson: '[]',
					acceptedAt: now,
					pushExpiresAt: now,
					recoveryDeadline: now,
					pruneAfter: record.pruneAfter,
					graceDecisionJson: '{"reportsGrace":true}',
					state: record.state
				})
				.run();
		}
		new PublicationStore(instance.context).prune(now);
		return Promise.resolve(
			instance.context.db
				.select({
					id: schema.publicationOperations.id,
					state: schema.publicationOperations.state
				})
				.from(schema.publicationOperations)
				.orderBy(schema.publicationOperations.id)
				.all()
		);
	});
	expect(rows).toStrictEqual([
		{ id: 'a'.repeat(64), state: 'accepted' },
		{ id: 'e'.repeat(64), state: 'expired' }
	]);
});
