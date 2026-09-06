import { describe, expect, it } from 'vitest';

import {
	PassedCheckFinding,
	ReuseViewPriorityInsufficientFinding
} from './finding.ts';

describe('CheckFinding', () => {
	it('renders and serialises a passing result', () => {
		const finding = new PassedCheckFinding('trust rule');

		expect({
			rendered: finding.render(),
			serialised: finding.toJSON()
		}).toStrictEqual({
			rendered: 'ok',
			serialised: { check: 'trust rule', status: 'ok' }
		});
	});

	it('renders and serialises a typed failure', () => {
		const finding = new ReuseViewPriorityInsufficientFinding(
			'reuse view',
			40,
			40
		);

		expect({
			finding,
			rendered: finding.render(),
			serialised: finding.toJSON()
		}).toStrictEqual({
			finding: new ReuseViewPriorityInsufficientFinding('reuse view', 40, 40),
			rendered: "failed: view priority 40 does not exceed the destination's 40",
			serialised: {
				check: 'reuse view',
				status: 'failed',
				detail: "view priority 40 does not exceed the destination's 40"
			}
		});
	});
});
