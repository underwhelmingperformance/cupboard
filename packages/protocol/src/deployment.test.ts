import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';

import {
	currentLocalStep,
	deferredTransition,
	expansionLocalStep,
	hasReachedTransitionState,
	requiredLocalStepAmong,
	requiredLocalStepFrom,
	type SchemaTransition,
	schemaTransitions,
	type TransitionId,
	transitionIds,
	transitionIdSchema,
	type TransitionState
} from './deployment.ts';

function states(
	entries: readonly (readonly [TransitionId, TransitionState])[]
): ReadonlyMap<TransitionId, TransitionState> {
	return new Map(entries);
}

describe('schemaTransitions', () => {
	it("lists every migration once, in name order, with each transition's contract migrations after its expand migrations", () => {
		const sequence = schemaTransitions.flatMap((transition) => [
			...transition.expand,
			...transition.contract
		]);

		expect({
			sorted: [...sequence].toSorted(byCodeUnit),
			distinct: new Set(sequence).size,
			contractsAfterExpands: schemaTransitions.map((transition) => {
				const lastExpand = transition.expand.at(-1) ?? '';
				const firstContract = transition.contract[0];

				return firstContract === undefined || lastExpand < firstContract;
			})
		}).toStrictEqual({
			sorted: sequence,
			distinct: sequence.length,
			contractsAfterExpands: schemaTransitions.map(() => true)
		});
	});

	// A deployment that recorded a transition complete never applies a
	// migration added to it later, so a released transition's lists are fixed.
	// Its other fields decide what the deploy does on a deployment that is
	// part-way through it, so they are fixed too. Add a transition here in the
	// release that first ships it.
	it('keeps every released transition apart from completedBy', () => {
		const released = new Set<string>([
			'cache-identity',
			'deployment-transitions'
		]);

		expect(
			schemaTransitions
				.filter((transition) => released.has(transition.id))
				.map(({ completedBy: _completedBy, ...transition }) => transition)
		).toStrictEqual([
			{
				id: 'cache-identity',
				expand: [
					'0000_blob_state.sql',
					'0001_blob_ref_tenant_blob.sql',
					'0002_blob_state_delete_after.sql',
					'0003_control_auth_key.sql',
					'0004_control_trust.sql',
					'0005_tenant_registry.sql',
					'0006_manifest_state.sql',
					'0007_tenant_read_verifier.sql',
					'0008_tenant_usage.sql',
					'0009_tenant_last_maintained.sql',
					'0010_next_pepper_potts.sql',
					'0011_concerned_winter_soldier.sql',
					'0012_spicy_may_parker.sql',
					'0013_common_mac_gargan.sql',
					'0014_reshape_eligibility_projection.sql',
					'0015_lying_thor_girl.sql',
					'0016_global_admin_audience.sql',
					'0017_object_incarnations.sql',
					'0018_tenant_cache_read_credential.sql',
					'0019_nar_read_authority.sql',
					'0020_tenant_local_step.sql',
					'0021_deployment_phase.sql',
					'0022_cache_access_expand.sql',
					'0023_cache_access_legacy_write_mirror.sql',
					'0024_cache_access_backfill.sql',
					'0025_cache_incarnation_expand.sql',
					'0026_cache_identity_contract_assertions.sql',
					'0027_cache_identity_compatible_contract.sql'
				],
				contract: [
					'0028_cache_identity_contract.sql',
					'0029_cache_grant_contract.sql',
					'0030_cache_credential_lifecycle.sql'
				],
				contractStep: expansionLocalStep,
				reportableStepOnComplete: currentLocalStep,
				compatibilityPhase: true
			},
			{
				id: 'deployment-transitions',
				expand: ['0031_deployment_transitions.sql'],
				contract: [],
				independent: true
			}
		]);
	});

	// The server classifies stored rows against `transitionIds`, and the
	// response schema against `transitionIdSchema`. The two must agree.
	it('lists the same ids in transitionIdSchema as in schemaTransitions', () => {
		expect(transitionIdSchema.options).toStrictEqual(transitionIds);
	});

	// v0.0.34 and v0.0.35 have one `deployment_phase` row, which describes the
	// cache-identity transition only.
	it('sets compatibilityPhase on cache-identity only', () => {
		expect(
			schemaTransitions
				.filter((transition) => transition.compatibilityPhase === true)
				.map((transition) => transition.id)
		).toStrictEqual(['cache-identity']);
	});

	// A contract step identifies the object work that must finish before the
	// transition's contract migrations run. An object's `recordLocalStep`
	// (packages/server/src/do/local-step.ts) does such work only for
	// `cache-identity`: it reports `expansionLocalStep` until that transition is
	// complete and `currentLocalStep` afterwards. Any other contract step would
	// refer to work that no object does. Extend `recordLocalStep` before extending
	// this list.
	it('declares only contract steps that an object can record', () => {
		expect(
			new Set(
				schemaTransitions.flatMap((transition) =>
					transition.contractStep === undefined ? [] : [transition.contractStep]
				)
			)
		).toStrictEqual(new Set([expansionLocalStep]));
	});
});

describe('deferredTransition', () => {
	const first: SchemaTransition<string> = {
		id: 'first',
		expand: ['0000_first.sql'],
		contract: ['0001_first_contract.sql'],
		contractStep: expansionLocalStep
	};
	const dependent: SchemaTransition<string> = {
		id: 'dependent',
		expand: ['0002_dependent.sql'],
		contract: []
	};
	const independent: SchemaTransition<string> = {
		id: 'independent',
		expand: ['0003_independent.sql'],
		contract: [],
		independent: true
	};

	it.each([
		{
			name: 'an independent transition after a pending one',
			transitions: [first, independent],
			recorded: [],
			deferred: undefined
		},
		{
			name: 'a transition that is not independent after a pending one',
			transitions: [first, dependent, independent],
			recorded: [],
			deferred: { transition: dependent, waitsFor: first }
		},
		{
			name: 'a transition that is not independent after an expanded one',
			transitions: [first, dependent],
			recorded: [['first', 'expanded']],
			deferred: { transition: dependent, waitsFor: first }
		},
		{
			name: 'a transition that is not independent after a complete one',
			transitions: [first, dependent, independent],
			recorded: [['first', 'complete']],
			deferred: undefined
		}
	] as const)(
		'returns the deferred transition, if any, for $name',
		({ transitions, recorded, deferred }) => {
			expect(
				deferredTransition(
					transitions,
					new Map<string, TransitionState>(recorded)
				)
			).toStrictEqual(deferred);
		}
	);
});

describe('hasReachedTransitionState', () => {
	it.each([
		{ recorded: undefined, wanted: 'expanded', reached: false },
		{ recorded: undefined, wanted: 'complete', reached: false },
		{ recorded: 'expanded', wanted: 'expanded', reached: true },
		{ recorded: 'expanded', wanted: 'complete', reached: false },
		{ recorded: 'complete', wanted: 'expanded', reached: true },
		{ recorded: 'complete', wanted: 'complete', reached: true }
	] as const)(
		'returns $reached for $recorded against $wanted',
		({ recorded, wanted, reached }) => {
			expect(hasReachedTransitionState(recorded, wanted)).toBe(reached);
		}
	);
});

describe('requiredLocalStepFrom', () => {
	it.each([
		{
			name: 'nothing recorded',
			recorded: states([]),
			step: expansionLocalStep
		},
		{
			name: 'cache-identity expanded',
			recorded: states([['cache-identity', 'expanded']]),
			step: expansionLocalStep
		},
		{
			name: 'cache-identity complete',
			recorded: states([['cache-identity', 'complete']]),
			step: currentLocalStep
		},
		{
			name: 'only the transition without a contract step complete',
			recorded: states([['deployment-transitions', 'complete']]),
			step: expansionLocalStep
		}
	])('requires $step with $name', ({ recorded, step }) => {
		expect(requiredLocalStepFrom(recorded)).toBe(step);
	});

	// A later transition that declares the contract step that cache-identity
	// declares.
	const later: SchemaTransition<'cache-identity' | 'later'> = {
		id: 'later',
		expand: ['0032_later.sql'],
		contract: ['0033_later_contract.sql'],
		contractStep: expansionLocalStep
	};
	const cacheIdentity = schemaTransitions.find(
		(transition) => transition.id === 'cache-identity'
	);

	if (cacheIdentity === undefined) {
		throw new Error('schemaTransitions has no cache-identity transition');
	}

	it.each([
		{
			name: 'cache-identity incomplete',
			recorded: new Map([['later', 'expanded']] as const),
			step: expansionLocalStep
		},
		{
			name: 'cache-identity complete',
			recorded: new Map([
				['cache-identity', 'complete'],
				['later', 'expanded']
			] as const),
			step: currentLocalStep
		}
	])(
		'requires $step with a later incomplete transition and $name',
		({ recorded, step }) => {
			expect(requiredLocalStepAmong([cacheIdentity, later], recorded)).toBe(
				step
			);
		}
	);
});
