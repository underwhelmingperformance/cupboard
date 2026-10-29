import {
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { cacheIdSchema } from '../db/cache.ts';

import {
	type ChargedReservation,
	ReservationCharges
} from './reservation-charges.ts';

function reservation(character: string): ChargedReservation {
	return {
		cacheId: cacheIdSchema.parse(1),
		storePathHash: storePathHashSchema.parse(character.repeat(32)),
		generation: narInfoGenerationSchema.parse(0)
	};
}

describe('ReservationCharges', () => {
	it.each([
		{ charges: 'no charge', charged: [], isStale: false },
		{ charges: 'a charge of the reservation', charged: ['a'], isStale: true },
		{
			charges: 'a charge of another reservation',
			charged: ['b'],
			isStale: false
		},
		{
			charges: 'enough charges of others to forget the reservation',
			charged: ['a', 'b', 'c'],
			isStale: true
		},
		{
			charges: 'enough charges of others to forget an earlier reservation',
			charged: ['b', 'c', 'd'],
			isStale: true
		}
	])(
		'reports whether a read can be stale after $charges',
		({ charged, isStale }) => {
			const charges = new ReservationCharges(2);
			const mark = charges.mark();
			for (const character of charged) {
				charges.record(reservation(character));
			}

			expect(charges.isChargedSince(reservation('a'), mark)).toBe(isStale);
		}
	);

	it.each([
		{ charges: 'a charge of the reservation', charged: ['a'] },
		{
			charges: 'charges that forget the reservation',
			charged: ['a', 'b', 'c']
		}
	])(
		'reports a read as current after $charges before the mark',
		({ charged }) => {
			const charges = new ReservationCharges(2);
			for (const character of charged) {
				charges.record(reservation(character));
			}
			const mark = charges.mark();

			expect(charges.isChargedSince(reservation('a'), mark)).toBe(false);
		}
	);
});
