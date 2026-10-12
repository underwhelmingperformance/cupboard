import { currentLocalStep } from '@cupboard/protocol/deployment';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
	currentServer,
	latestMigrationIndex,
	migrateThrough,
	recordTransition,
	testServerFor,
	useTestServer,
	withoutAlarmArming
} from '../test-support.ts';

// A Durable Object remembers that it has initialised on the instance, not in
// its storage, so an eviction makes the next request initialise again over a
// store this build has already migrated in full. Every other case starts from
// empty storage and exercises only a first start, so a build that handed the
// later start a prefix of its migration bundle passed the suites while refusing
// every already-migrated object.
describe('server initialisation over a migrated store', () => {
	const serverName = 'server-restart';

	it('initialises over a store it has already migrated', () =>
		withoutAlarmArming(async () => {
			await recordTransition('cache-identity', 'complete');
			await recordTransition('cas-storage', 'expanded');
			await recordTransition('attestation-list-revision', 'expanded');
			// Migrate the storage without initialising the object, which leaves it
			// exactly as a first start would and as an eviction would find it.
			await runInDurableObject(testServerFor(serverName), (_instance, state) =>
				migrateThrough(state, latestMigrationIndex)
			);

			// Configuring the tenant initialises the object over that storage.
			await useTestServer(serverName);

			const outcome = await runInDurableObject(
				currentServer(),
				async (instance) => {
					let result = await instance.reportLocalStep(currentLocalStep);
					for (let pass = 0; pass < 3 && result.kind === 'incomplete'; pass++) {
						result = await instance.reportLocalStep(currentLocalStep);
					}
					return result;
				}
			);

			expect(outcome).toStrictEqual({
				kind: 'recorded',
				step: currentLocalStep,
				progressed: true
			});
		}));
});
