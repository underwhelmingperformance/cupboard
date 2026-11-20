import {
	buildInputsDocumentVersion,
	cohortRootsVersion,
	publishPlanVersion
} from '@cupboard/protocol/publish-plan';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cliExitCode } from '../cli.ts';

import {
	BuildInputsDocumentVersionError,
	CohortRootsVersionError,
	parseBuildInputsDocument,
	parseCohortRoots,
	parsePublishPlan,
	PublishPlanVersionError
} from './publish-plan-file.ts';

describe('parseBuildInputsDocument', () => {
	const app = `/nix/store/${'0'.repeat(32)}-app`;
	const compiler = `${'1'.repeat(32)}-compiler`;
	const source = `${'2'.repeat(32)}-source.tar.gz`;

	it('reads a document of the supported version as sets of build inputs', () => {
		expect(
			parseBuildInputsDocument(
				JSON.stringify({
					version: buildInputsDocumentVersion,
					buildInputsVersion: 1,
					paths: { [app]: [source, compiler, source] }
				})
			)
		).toStrictEqual({
			version: buildInputsDocumentVersion,
			buildInputsVersion: 1,
			paths: { [app]: [compiler, source] }
		});
	});

	it('refuses a document of another version', () => {
		let failure: unknown;

		try {
			parseBuildInputsDocument(
				JSON.stringify({ version: 2, buildInputsVersion: 1, paths: {} })
			);
		} catch (error) {
			failure = error;
		}

		expect({
			isVersionError: failure instanceof BuildInputsDocumentVersionError,
			found:
				failure instanceof BuildInputsDocumentVersionError
					? failure.found
					: undefined,
			status: cliExitCode(failure, 130)
		}).toStrictEqual({ isVersionError: true, found: 2, status: 2 });
	});

	it('reads a path with more build inputs than a narinfo row can store', () => {
		const buildInputs = Array.from(
			{ length: 8193 },
			(_, index) => `${String(index).padStart(32, '0')}-input`
		);

		expect(
			parseBuildInputsDocument(
				JSON.stringify({
					version: buildInputsDocumentVersion,
					buildInputsVersion: 1,
					paths: { [app]: buildInputs }
				})
			)
		).toStrictEqual({
			version: buildInputsDocumentVersion,
			buildInputsVersion: 1,
			paths: { [app]: buildInputs }
		});
	});

	it.each([
		{ name: 'a key that is not a store path', paths: { app: [] } },
		{ name: 'a build input that is not a basename', paths: { [app]: ['x'] } }
	])('refuses a document with $name', ({ paths }) => {
		expect(() =>
			parseBuildInputsDocument(
				JSON.stringify({
					version: buildInputsDocumentVersion,
					buildInputsVersion: 1,
					paths
				})
			)
		).toThrow(z.ZodError);
	});
});

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
