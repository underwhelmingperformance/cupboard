import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoDeletions, narInfos } from '../db/schema.ts';
import {
	bootstrap,
	currentServer,
	narBytes,
	pushPath,
	resetTestServer,
	setRoot,
	uploadMetadata
} from '../test-support.ts';

const repeated = (character: string): string => character.repeat(32);

interface GateEntry {
	readonly storedPaths: number;
	readonly queuedDeletions: number;
}

describe('garbage collection critical section', () => {
	beforeEach(resetTestServer);

	// The scan is synchronous, so the input gate never decided whether a write
	// could interleave with it; only the awaited narinfo-deletion flush needs the
	// gate. Each entry reports what the pass had already done, which is how the
	// test tells that the scan ran before the gate rather than inside it.
	it('enters the critical section once, for the narinfo-deletion flush', async () => {
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

		const entries = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const { context } = instance;
				const enterSection = context.criticalSection.bind(context);
				const observed: GateEntry[] = [];

				context.criticalSection = async <T>(
					run: () => Promise<T>
				): Promise<T> => {
					observed.push({
						storedPaths: context.db.select().from(narInfos).all().length,
						queuedDeletions: context.db.select().from(narInfoDeletions).all()
							.length
					});

					return enterSection(run);
				};

				try {
					await instance.runGarbageCollection();
				} finally {
					context.criticalSection = enterSection;
				}

				await state.storage.deleteAlarm();

				return observed;
			}
		);

		// One path was collected before the gate was entered, and its deletion was
		// waiting in the queue the flush drains.
		expect(entries).toStrictEqual([{ storedPaths: 1, queuedDeletions: 1 }]);
	});
});
