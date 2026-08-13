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

function fixture(): AvailabilityFixture {
	const current = prepared.fixture;

	if (current === undefined) {
		throw new Error('the availability fixture was not prepared');
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

	// Exact: the cache either offers a path or it does not, and both sides read
	// that from the cache itself.
	it('reports the paths the cache offers, as nix does', async () => {
		const current = fixture();
		const answers = await offeredPaths(oracle, current, await freshStore(), [
			current.builtPath,
			current.dependencyPath,
			current.absentPath
		]);

		expect(answers.client).toStrictEqual(answers.oracle);
	});

	// Exact: a substituter written as a path refers to the store rooted there,
	// and both sides read path metadata from its database. A store publishes
	// no narinfo, so neither side states a transfer size.
	it('reports what a store-rooted substituter offers, as nix does', async () => {
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
	// build has to make, what a fetch can supply, and what nobody can produce.
	it.each<{
		name: string;
		targets: (current: AvailabilityFixture) => readonly StorePathString[];
	}>([
		{
			name: 'a closure the cache offers',
			targets: (current) => [current.builtPath]
		},
		{
			name: 'a path nothing holds and nothing offers',
			targets: (current) => [current.absentPath]
		},
		{
			name: 'a derivation whose output nothing offers',
			targets: (current) => [current.derivationPath]
		},
		{
			name: 'a closure and an unobtainable path together',
			targets: (current) => [current.builtPath, current.absentPath]
		}
	])('partitions $name the way a dry run does', async ({ targets }) => {
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
			name: 'a key nothing in the cache is signed with',
			keys: (current) => [current.untrustedPublicKey],
			expected: { realised: false, verdict: 'refused' }
		}
	])(
		'settles the closure the way a realisation does, trusting $name',
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
