import { describe, expect, it } from 'vitest';

import {
	hintCapacity,
	hintTtlMs,
	type NegotiateHints,
	NegotiateHintStore
} from './negotiate-hints.ts';

const hints: NegotiateHints = {
	blobStates: [],
	ownedNarHashes: []
};

describe('NegotiateHintStore', () => {
	it('hands a staged set out at most once', () => {
		const store = new NegotiateHintStore();
		const token = store.stage(hints, 0);

		expect({
			first: store.take(token, 1),
			replay: store.take(token, 1)
		}).toStrictEqual({ first: hints, replay: undefined });
	});

	it('refuses an expired token', () => {
		const store = new NegotiateHintStore();
		const live = store.stage(hints, 0);
		const expired = store.stage(hints, 0);

		expect({
			live: store.take(live, hintTtlMs - 1),
			expired: store.take(expired, hintTtlMs)
		}).toStrictEqual({ live: hints, expired: undefined });
	});

	it('evicts the oldest set once at capacity', () => {
		const store = new NegotiateHintStore();
		const oldest = store.stage(hints, 0);
		const survivors = Array.from({ length: hintCapacity }, () =>
			store.stage(hints, 0)
		);

		expect({
			oldest: store.take(oldest, 1),
			youngest: store.take(survivors.at(-1) ?? '', 1),
			secondOldest: store.take(survivors[0] ?? '', 1)
		}).toStrictEqual({
			oldest: undefined,
			youngest: hints,
			secondOldest: hints
		});
	});
});
