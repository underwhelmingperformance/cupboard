import type { StorePathString } from '@cupboard/nix-store/scalars';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
	type AvailabilityFixture,
	closureOutcome,
	createAvailabilityFixture,
	createTargetStore,
	fillFromCache,
	offeredPaths,
	offeredThroughStore,
	realisationPlans,
	removeAvailabilityFixture,
	type SigningPolicy,
	type TargetStore
} from './availability.ts';
import { describeConformance } from './oracle.ts';

/**
 * The file shares one built and signed cache fixture. Cases that realise paths
 * use separate target stores so earlier fetches cannot affect later results.
 */
const prepared: { fixture?: AvailabilityFixture } = {};

class AvailabilityFixtureNotPreparedError extends Error {
	constructor() {
		super('the availability fixture was not prepared');
		this.name = 'AvailabilityFixtureNotPreparedError';
	}
}

function fixture(): AvailabilityFixture {
	const current = prepared.fixture;

	if (current === undefined) {
		throw new AvailabilityFixtureNotPreparedError();
	}

	return current;
}

function trusting(keys: readonly string[]): SigningPolicy {
	return { requireSignatures: true, trustedPublicKeys: keys };
}

describeConformance('what a store can obtain', (oracle) => {
	let stores = 0;

	beforeAll(async () => {
		prepared.fixture = await createAvailabilityFixture(oracle);
	}, 300_000);

	afterAll(async () => {
		const current = prepared.fixture;
		prepared.fixture = undefined;

		if (current !== undefined) {
			await removeAvailabilityFixture(current);
		}
	});

	const freshStore = async (): Promise<TargetStore> => {
		stores += 1;

		return createTargetStore(oracle, fixture(), `target-${String(stores)}`);
	};

	// Exact: both clients query the same cache for the same paths.
	it('reports the same offered paths as Nix', async () => {
		const current = fixture();
		const answers = await offeredPaths(oracle, current, await freshStore(), [
			current.builtPath,
			current.dependencyPath,
			current.absentPath
		]);

		expect(answers.client).toStrictEqual(answers.oracle);
	});

	// Exact: a substituter written as a path refers to the store rooted there,
	// and both sides read path metadata from its database. A store publishes no
	// narinfo, so neither side reports a transfer size.
	it('reports the same store-rooted offers as Nix', async () => {
		const current = fixture();
		const answers = await offeredThroughStore(
			oracle,
			current,
			await freshStore(),
			current.builtPath
		);

		expect({
			client: answers.client,
			downloadSize: answers.client?.downloadSize
		}).toStrictEqual({ client: answers.oracle, downloadSize: 0 });
	});

	// Exact: the work required to realise the targets, partitioned into what a
	// build must produce, what a fetch can supply, and what is unobtainable.
	it.each<{
		name: string;
		targets: (current: AvailabilityFixture) => readonly StorePathString[];
	}>([
		{
			name: 'a closure the cache offers',
			targets: (current) => [current.builtPath]
		},
		{
			name: 'a path absent from every store and substituter',
			targets: (current) => [current.absentPath]
		},
		{
			name: 'a derivation whose output has no substituter offer',
			targets: (current) => [current.derivationPath]
		},
		{
			name: 'a closure and an unobtainable path together',
			targets: (current) => [current.builtPath, current.absentPath]
		}
	])('matches the dry-run partition for $name', async ({ targets }) => {
		const current = fixture();
		const plans = await realisationPlans(
			oracle,
			current,
			await freshStore(),
			targets(current),
			trusting([current.trustedPublicKey])
		);

		expect(plans.client).toStrictEqual(plans.oracle);
	});

	// Exact: whether a consumer under this policy obtains the closure. The
	// oracle is the realisation itself, so the verdict is compared against what
	// fetching the closure actually did rather than against a prediction.
	it.each<{
		name: string;
		keys: (current: AvailabilityFixture) => readonly string[];
		expected: { realised: boolean; verdict: string };
	}>([
		{
			name: 'the key the cache signed with',
			keys: (current) => [current.trustedPublicKey],
			expected: { realised: true, verdict: 'served' }
		},
		{
			name: 'a key that did not sign the cached paths',
			keys: (current) => [current.untrustedPublicKey],
			expected: { realised: false, verdict: 'refused' }
		}
	])(
		'matches a real Nix realisation when trusting $name',
		async ({ keys, expected }) => {
			const current = fixture();
			const holding = await freshStore();

			await fillFromCache(oracle, current, holding, current.builtPath);

			const outcome = await closureOutcome(
				oracle,
				current,
				holding,
				await freshStore(),
				current.builtPath,
				trusting(keys(current))
			);

			expect({
				realised: outcome.realised,
				verdict: outcome.verdict.kind
			}).toStrictEqual(expected);
		}
	);
});
