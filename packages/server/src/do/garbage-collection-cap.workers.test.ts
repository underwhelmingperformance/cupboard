import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	bootstrap,
	currentServer,
	narBytes,
	narInfoGeneration,
	pushPath,
	resetTestServer,
	setRoot,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { gcContinuationKey } from './server.ts';

const repeated = (character: string): string => character.repeat(32);

async function continuationLimit(): Promise<number | undefined> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get<number>(gcContinuationKey)
	);
}

async function fireAlarm(): Promise<void> {
	// The handler is invoked directly: the continuation relies on the same entry
	// point in production, and the test pool's alarm delivery is racy to observe.
	await runInDurableObject(currentServer(), (instance) => instance.alarm());
}

describe('garbage collection sweep cap', () => {
	beforeEach(resetTestServer);

	it('caps each sweep and drains the remainder across alarm firings', async () => {
		await useTestServer('gc-cap');
		const { token } = await bootstrap();

		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'kept'
		});
		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'first'
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'second'
		});

		await pushPath(token, kept);
		await pushPath(token, first);
		await pushPath(token, second);

		// Retaining `kept` makes the other two collectable while keeping the cache
		// off the empty-cache skip guard.
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		const collectableRemaining = async (): Promise<number> => {
			const generations = await Promise.all([
				narInfoGeneration(first.storePathHash),
				narInfoGeneration(second.storePathHash)
			]);

			return generations.filter((generation) => generation !== undefined)
				.length;
		};

		expect(await collectableRemaining()).toBe(2);

		// A cap of one path per sweep records a continuation.
		await currentServer().runGarbageCollection(1);

		// The continuation drains the remaining collectable paths a chunk at a time
		// and clears itself, so the bounded sweep still collects everything. The
		// alarm is driven here because the test pool's delivery is racy to observe.
		await vi.waitFor(async () => {
			await fireAlarm();
			expect(await collectableRemaining()).toBe(0);
			expect(await continuationLimit()).toBeUndefined();
		});

		// The retained path is never swept.
		expect(await narInfoGeneration(kept.storePathHash)).not.toBeUndefined();
	});
});
