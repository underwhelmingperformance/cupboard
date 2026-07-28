import {
	DEFAULT_CACHE,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import { storedGraceDeadlines } from './grace-decision.ts';
import { RetentionService } from './retention-service.ts';

const hashAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

// Two-character prefixes from the nix base32 alphabet, repeated to a full
// 32-character store-path hash, so every generated hash is distinct and
// always parses.
function generatedHash(index: number): string {
	const prefix =
		(hashAlphabet[Math.floor(index / hashAlphabet.length)] ?? '0') +
		(hashAlphabet[index % hashAlphabet.length] ?? '0');

	return prefix.repeat(16);
}

// A full commit batch's worth: past the per-insert row bound
// (maxInClauseValues / 3 = 30) and the per-select IN-list bound
// (maxInClauseValues = 90), so a regression that binds a whole batch in one
// statement throws against the Durable Object's SQLite bind cap rather than
// silently passing at a smaller size.
const hashCount = 100;
const hashes = Array.from({ length: hashCount }, (_, index) =>
	storePathHashSchema.parse(generatedHash(index))
);
const retainUntil = isoTimestampSchema.parse('2026-06-01T00:00:00.000Z');

describe('retention grace bounds', () => {
	beforeEach(resetTestServer);

	it('extends every hash in one call, past the per-insert row bound', async () => {
		await useTestServer('grace-bounds-extend');

		await runInDurableObject(currentServer(), (instance) => {
			new RetentionService(instance.context).extendGraceDeadlines(
				DEFAULT_CACHE,
				hashes,
				retainUntil
			);
		});

		const stored = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({
					storePathHash: schema.retentionGrace.storePathHash,
					retainUntil: schema.retentionGrace.retainUntil
				})
				.from(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cache, DEFAULT_CACHE))
				.all()
		);

		expect({
			count: stored.length,
			allExtended: stored.every((row) => row.retainUntil === retainUntil)
		}).toStrictEqual({ count: hashCount, allExtended: true });
	});

	it('reads every hash back in one call, past the per-select IN-list bound', async () => {
		await useTestServer('grace-bounds-read');

		await runInDurableObject(currentServer(), (instance) => {
			new RetentionService(instance.context).extendGraceDeadlines(
				DEFAULT_CACHE,
				hashes,
				retainUntil
			);
		});

		const storedValues = await runInDurableObject(currentServer(), (instance) =>
			storedGraceDeadlines(instance.context.db, DEFAULT_CACHE, hashes)
				.values()
				.toArray()
		);

		expect({
			count: storedValues.length,
			values: [...new Set(storedValues)]
		}).toStrictEqual({ count: hashCount, values: [retainUntil] });
	});
});
