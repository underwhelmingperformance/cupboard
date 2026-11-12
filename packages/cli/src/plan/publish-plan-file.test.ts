import {
	cohortRootsVersion,
	publishPlanVersion
} from '@cupboard/protocol/publish-plan';
import { describe, expect, it } from 'vitest';

import { cliExitCode } from '../cli.ts';

import {
	CohortRootsVersionError,
	parseCohortRoots,
	parsePublishPlan,
	PublishPlanVersionError
} from './publish-plan-file.ts';

describe('parseCohortRoots', () => {
	const roots = {
		version: cohortRootsVersion,
		roots: [{ action: 'unchanged', name: 'github:acme/app/main/app' }]
	};

	it('reads a document of the supported version', () => {
		expect(parseCohortRoots(JSON.stringify(roots))).toStrictEqual(roots);
	});

	it('refuses a document of another version', () => {
		let failure: unknown;

		try {
			parseCohortRoots(JSON.stringify({ ...roots, version: 2 }));
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(CohortRootsVersionError);
		expect({
			found:
				failure instanceof CohortRootsVersionError ? failure.found : undefined,
			supported:
				failure instanceof CohortRootsVersionError
					? failure.supported
					: undefined,
			status: cliExitCode(failure, 130)
		}).toStrictEqual({ found: 2, supported: cohortRootsVersion, status: 2 });
	});
});

const plan = {
	version: publishPlanVersion,
	rootPrefix: 'github:acme/app/main',
	retained: [],
	targets: [],
	cohorts: [],
	cohortPreFilter: []
};

describe('parsePublishPlan', () => {
	it('reads a document of the supported version', () => {
		expect(parsePublishPlan(JSON.stringify(plan))).toStrictEqual(plan);
	});

	it.each([
		{ name: 'the previous version', value: { ...plan, version: 1 }, found: 1 },
		{ name: 'a newer version', value: { ...plan, version: 3 }, found: 3 },
		{
			name: 'no version',
			value: { ...plan, version: undefined },
			found: undefined
		},
		{ name: 'no object', value: [plan], found: undefined }
	])('refuses a document with $name', ({ value, found }) => {
		let failure: unknown;

		try {
			parsePublishPlan(JSON.stringify(value));
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(PublishPlanVersionError);
		expect({
			found:
				failure instanceof PublishPlanVersionError ? failure.found : undefined,
			supported:
				failure instanceof PublishPlanVersionError
					? failure.supported
					: undefined,
			status: cliExitCode(failure, 130)
		}).toStrictEqual({
			found,
			supported: publishPlanVersion,
			status: 2
		});
	});
});
