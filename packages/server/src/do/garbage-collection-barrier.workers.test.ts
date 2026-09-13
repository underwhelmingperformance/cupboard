import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GarbageCollectionBarrierMissingError } from '../errors.ts';
import {
	bootstrap,
	clearAbandonedAlarms,
	currentServer,
	narBytes,
	narInfoGeneration,
	pushPath,
	resetTestServer,
	setRoot,
	uploadMetadata,
	withoutAlarmArming
} from '../test-support.ts';

import { barrierTriggers } from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';

const repeated = (character: string): string => character.repeat(32);

async function dropTrigger(name: string): Promise<void> {
	const statement = `DROP TRIGGER \`${name}\``;

	await runInDurableObject(currentServer(), (_instance, state) => {
		state.storage.sql.exec(statement);
	});
}

async function continuation(): Promise<unknown> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get(gcContinuationKey)
	);
}

describe('garbage collection write barrier', () => {
	beforeEach(resetTestServer);
	afterEach(clearAbandonedAlarms);

	it.each(barrierTriggers)(
		'preserves narinfo rows while $name is missing',
		async ({ name }) => {
			await withoutAlarmArming(async () => {
				const { token } = await bootstrap();
				const kept = uploadMetadata({
					fileSize: narBytes.byteLength,
					storePathHash: repeated('a'),
					name: 'kept'
				});
				const collectable = uploadMetadata({
					fileSize: narBytes.byteLength,
					storePathHash: repeated('b'),
					name: 'collectable'
				});

				await pushPath(token, kept);
				await pushPath(token, collectable);
				await setRoot(token, { name: 'channel', targets: [kept.storePath] });

				const pushed = {
					kept: await narInfoGeneration(kept.storePathHash),
					collectable: await narInfoGeneration(collectable.storePathHash)
				};

				expect(pushed.collectable).toEqual(expect.any(Number));

				await dropTrigger(name);

				await expect(
					runInDurableObject(currentServer(), (instance) =>
						instance.runGarbageCollection()
					)
				).rejects.toStrictEqual(
					new GarbageCollectionBarrierMissingError([name])
				);

				expect({
					stored: {
						kept: await narInfoGeneration(kept.storePathHash),
						collectable: await narInfoGeneration(collectable.storePathHash)
					},
					continuation: await continuation()
				}).toStrictEqual({
					stored: pushed,
					continuation: [{ scope: 'tenant' }]
				});
			});
		}
	);
});
