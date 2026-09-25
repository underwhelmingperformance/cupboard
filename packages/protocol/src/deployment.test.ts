import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';

import {
	currentLocalStep,
	expansionLocalStep,
	hasReachedTransitionState,
	requiredLocalStepFrom,
	schemaTransitions,
	type TransitionId,
	type TransitionState
} from './deployment.ts';

function states(
	entries: readonly (readonly [TransitionId, TransitionState])[]
): ReadonlyMap<TransitionId, TransitionState> {
	return new Map(entries);
}

describe('schemaTransitions', () => {
	it('lists every migration once, in name order, with each contract after its expand', () => {
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
		'answers $reached for $recorded against $wanted',
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
			name: 'only the transition without a settle step complete',
			recorded: states([['deployment-transitions', 'complete']]),
			step: expansionLocalStep
		}
	])('requires $step with $name', ({ recorded, step }) => {
		expect(requiredLocalStepFrom(recorded)).toBe(step);
	});
});
