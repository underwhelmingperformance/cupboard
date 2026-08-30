import { describe, expect, it } from 'vitest';

import { GracePolicyTooShortFinding, PassedCheckFinding } from './finding.ts';

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
		const finding = new GracePolicyTooShortFinding(
			'grace policy',
			'default',
			3600,
			86_400
		);

		expect({
			finding,
			rendered: finding.render(),
			serialised: finding.toJSON()
		}).toStrictEqual({
			finding: new GracePolicyTooShortFinding(
				'grace policy',
				'default',
				3600,
				86_400
			),
			rendered:
				'failed: the default cache has 3600s of grace; GitHub publication requires at least 86400s',
			serialised: {
				check: 'grace policy',
				status: 'failed',
				detail:
					'the default cache has 3600s of grace; GitHub publication requires at least 86400s'
			}
		});
	});
});
