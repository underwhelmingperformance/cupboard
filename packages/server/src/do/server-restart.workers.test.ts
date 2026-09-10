import { currentLocalStep } from '@cupboard/protocol/deployment';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
	currentServer,
	latestMigrationIndex,
	migrateThrough,
	testServerFor,
	useTestServer
} from '../test-support.ts';

// A Durable Object remembers that it has initialised on the instance rather
// than in its storage, so an eviction makes the next request initialise again
// over a store this build has already migrated in full. Every other case starts
// from empty storage and exercises only a first start, which is why a build
// that handed the later start a prefix of its migration bundle passed the
// suites while refusing every already-migrated object in production.
describe('server initialisation over a migrated store', () => {
	const serverName = 'server-restart';

	it('initialises over a store it has already migrated', async () => {
		// Migrate the storage without initialising the object, which leaves it
		// exactly as a first start would and as an eviction would find it.
		await runInDurableObject(testServerFor(serverName), (_instance, state) =>
			migrateThrough(state, latestMigrationIndex)
		);

		// Configuring the tenant initialises the object over that storage.
		await useTestServer(serverName);

		const outcome = await runInDurableObject(currentServer(), (instance) =>
			instance.reportLocalStep()
		);

		expect(outcome).toStrictEqual({
			kind: 'recorded',
			step: currentLocalStep
		});
	});
});
