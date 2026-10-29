import {
	type NarInfoGeneration,
	type StorePathHash
} from '@cupboard/nix-store/scalars';

import { type CacheId } from '../db/cache.ts';

const recentChargeCapacity = 1024;

/**
A reserved narinfo generation of one path in one cache.
*/
export interface ChargedReservation {
	readonly cacheId: CacheId;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
}

/**
The recent charges of narinfo reservations in this Durable Object. The charge
batch is the only writer of reference edges. It records each reservation in
its batch when the bounded wait for the D1 batch ends, whether the batch
succeeded, failed or timed out. A batch that timed out can still reach D1, so
the charge batch records its reservations again when that batch finishes.

A caller that reads an edge before the input gate takes a mark before the
read. Inside the gate, a charge of the reservation after the mark means that
the read can be stale. A timed-out batch that finishes after the gate is not
detected; a read inside the gate could not detect it either.

Only the latest `capacity` reservations are kept. When a reservation that was
not kept could have been charged after a mark, the read counts as stale.
*/
export class ReservationCharges {
	private sequence = 0;
	private forgottenThrough = 0;
	private readonly latest = new Map<string, number>();

	constructor(private readonly capacity = recentChargeCapacity) {}

	mark(): number {
		return this.sequence;
	}

	record(reservation: ChargedReservation): void {
		const key = reservationKey(reservation);
		this.sequence += 1;
		this.latest.delete(key);
		this.latest.set(key, this.sequence);
		if (this.latest.size <= this.capacity) {
			return;
		}
		const [oldest] = this.latest;
		if (oldest === undefined) {
			return;
		}
		this.latest.delete(oldest[0]);
		this.forgottenThrough = oldest[1];
	}

	isChargedSince(reservation: ChargedReservation, mark: number): boolean {
		const charged = this.latest.get(reservationKey(reservation));
		return (charged ?? this.forgottenThrough) > mark;
	}
}

function reservationKey(reservation: ChargedReservation): string {
	return `${String(reservation.cacheId)} ${reservation.storePathHash} ${String(reservation.generation)}`;
}
