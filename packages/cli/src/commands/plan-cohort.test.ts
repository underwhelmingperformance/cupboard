import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Nix, NixMissingPartition } from '@cupboard/nix';
import {
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { InvalidStoreUriError } from '../errors.ts';
import {
	type AvailabilityPartition,
	UnknownPathsCeilingError,
	type UnknownRequeryOutcome
} from '../plan/availability-partition.ts';
import {
	defaultHeadroomAbsoluteMinimum,
	StoreCapacityError
} from '../plan/capacity.ts';
import type { ParsedCohortTarget } from '../plan/cohort-target.ts';

import { requeryUnknownWith } from './plan-cohort.ts';
import {
	type PlanCohortDependencies,
	type PlanCohortRunOptions,
	registerPlanCommands,
	runPlanCohort
} from './plan-cohort.ts';
import type { RootClient } from './root.ts';

function noop(): void {
	/* test double: nothing to record */
}

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const otherPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-other'
);
const appRoot = rootNameSchema.parse('github:owner/repo/main/app');

function target(
	overrides: Partial<ParsedCohortTarget> = {}
): ParsedCohortTarget {
	return {
		attr: 'packages.x86_64-linux.app',
		installable: appPath,
		expectedPath: appPath,
		root: appRoot,
		...overrides
	};
}

function emptyMissing(): NixMissingPartition {
	return {
		willBuild: [],
		willSubstitute: [],
		unknown: [],
		downloadSize: 0,
		narSize: 0
	};
}

function buildRequired(
	unavailable: readonly StorePathString[]
): ParsedRootEnsureResponse {
	return { status: 'build-required', unavailable: [...unavailable] };
}

function missingStore(
	missing: NixMissingPartition
): Pick<
	Nix,
	| 'queryMissing'
	| 'querySubstitutablePaths'
	| 'queryValidPaths'
	| 'unreachableSubstituters'
> {
	return {
		queryMissing: () => Promise.resolve(missing),
		querySubstitutablePaths: () => Promise.resolve([]),
		queryValidPaths: () => Promise.resolve([]),
		unreachableSubstituters: () => Promise.resolve([])
	};
}

function requeryAnswering(
	missing: NixMissingPartition
): () => Promise<UnknownRequeryOutcome> {
	return () => Promise.resolve({ kind: 'answered', partition: missing });
}

function rejectingRootClient(): Pick<RootClient, 'ensure'> {
	return {
		ensure: () =>
			Promise.reject(new Error('roots.ensure must not be called here'))
	};
}

function recordingRootClient(
	calls: unknown[],
	response: ParsedRootEnsureResponse
): Pick<RootClient, 'ensure'> {
	return {
		ensure(input) {
			calls.push(input);

			return Promise.resolve(response);
		}
	};
}

function neverAsked(): Promise<UnknownRequeryOutcome> {
	throw new Error('the unknown paths must not be re-queried here');
}

function runOptions(
	overrides: Partial<PlanCohortRunOptions> = {}
): PlanCohortRunOptions {
	return {
		targets: [],
		cacheName: '_default',
		storeKind: 'daemon',
		storePath: '/nix/store',
		planFile: path.join(tmpdir(), 'unused-cupboard-plan-cohort.json'),
		ceiling: { value: 0, untrustedFallback: 0 },
		detected: {
			cohortSplitPossible: false,
			remoteStoreConfigured: false,
			componentPublicationApplicable: false
		},
		...overrides
	};
}

function dependencies(
	overrides: Partial<PlanCohortDependencies> = {}
): PlanCohortDependencies {
	return {
		rootClient: rejectingRootClient(),
		store: missingStore(emptyMissing()),
		requeryUnknown: neverAsked,
		confirmLeftUpstream: () => Promise.resolve({ kind: 'confirmed' }),
		destinationServed: () => Promise.resolve(new Set()),
		viewServed: () => Promise.resolve(new Set()),
		capacityProbe: () =>
			Promise.resolve({ available: 10_000_000_000, capacity: 10_000_000_000 }),
		...overrides
	};
}

function reporter(payloads: ResultPayload[]): Reporter {
	return {
		phase: (_label, body) => Promise.resolve(body({ fact: noop, warn: noop })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: noop, fact: noop, warn: noop })),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: noop,
					group: () => ({ message: noop, success: noop, error: noop }),
					warn: noop
				})
			),
		result(payload) {
			payloads.push(payload);
		},
		data: noop,
		warn: noop,
		info: noop,
		success: noop,
		step: noop,
		error: noop
	};
}

describe('runPlanCohort', () => {
	it('computes the partition, checks capacity, writes the plan file and reports the result', async () => {
		const payloads: ResultPayload[] = [];
		const ensureCalls: unknown[] = [];
		const otherTarget = target({
			attr: 'packages.x86_64-linux.other',
			installable: otherPath,
			expectedPath: otherPath
		});
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const servedByDestination: PlanCohortDependencies = dependencies({
			rootClient: recordingRootClient(ensureCalls, buildRequired([])),
			destinationServed: () => Promise.resolve(new Set([appPath, otherPath]))
		});

		try {
			await runPlanCohort(
				runOptions({ targets: [target(), otherTarget], planFile }),
				reporter(payloads),
				servedByDestination
			);

			expect(ensureCalls).toStrictEqual([
				{
					cacheName: '_default',
					name: appRoot,
					targets: [appPath, otherPath]
				}
			]);

			const expectedPartition: AvailabilityPartition = {
				attachOnly: [appPath, otherPath],
				publishByReference: [],
				leftUpstream: [],
				leftUpstreamRejections: [],
				buildSet: [],
				counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
				downloadSize: 0,
				narSize: 0,
				unknownCount: 0,
				alreadyValid: [],
				unreachableSubstituters: [],
				ceiling: { value: 0, source: 'configured' }
			};
			const expectedCapacity = {
				available: 10_000_000_000,
				capacity: 10_000_000_000,
				headroom: defaultHeadroomAbsoluteMinimum
			};
			const expectedResult = {
				partition: expectedPartition,
				capacity: expectedCapacity
			};

			expect(JSON.parse(await readFile(planFile, 'utf8'))).toStrictEqual(
				expectedResult
			);
			expect(payloads).toStrictEqual([
				{
					kind: 'plan-cohort',
					data: expectedResult,
					rows: [
						{ label: 'Attach only', value: '2' },
						{ label: 'Publish by reference', value: '0' },
						{ label: 'Left upstream', value: '0' },
						{ label: 'Build set', value: '0' },
						{ label: 'Plan file', value: planFile }
					]
				}
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('reports and rethrows a typed refusal when unknown paths exceed the ceiling', async () => {
		const payloads: ResultPayload[] = [];
		const missing: NixMissingPartition = {
			willBuild: [],
			willSubstitute: [],
			unknown: [appPath],
			downloadSize: 10,
			narSize: 20
		};
		const requeryResult: NixMissingPartition = {
			willBuild: [],
			willSubstitute: [],
			unknown: [appPath],
			downloadSize: 0,
			narSize: 0
		};

		let error: unknown;

		try {
			await runPlanCohort(
				runOptions({ targets: [target({ expectedPath: undefined })] }),
				reporter(payloads),
				dependencies({
					store: missingStore(missing),
					requeryUnknown: requeryAnswering(requeryResult)
				})
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(UnknownPathsCeilingError);
		expect(payloads).toStrictEqual([
			{
				kind: 'plan-cohort-refusal',
				data: {
					reason: 'unknown-paths-ceiling',
					unknownCount: 1,
					ceiling: { value: 0, source: 'configured' },
					downloadSize: 10,
					narSize: 20
				},
				rows: [
					{ label: 'Refusal', value: 'unknown paths over ceiling' },
					{ label: 'Unknown count', value: '1' },
					{ label: 'Ceiling', value: '0' }
				]
			}
		]);
	});

	it('reports and rethrows a typed refusal when the measured bytes would not fit', async () => {
		const payloads: ResultPayload[] = [];
		const missing: NixMissingPartition = {
			willBuild: [appPath],
			willSubstitute: [],
			unknown: [],
			downloadSize: 5,
			narSize: 1000
		};

		let error: unknown;

		try {
			await runPlanCohort(
				runOptions({ targets: [target({ expectedPath: undefined })] }),
				reporter(payloads),
				dependencies({
					store: missingStore(missing),
					capacityProbe: () =>
						Promise.resolve({ available: 100, capacity: 100 })
				})
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(StoreCapacityError);
		expect(payloads).toStrictEqual([
			{
				kind: 'plan-cohort-refusal',
				data: {
					reason: 'store-capacity',
					measured: { downloadSize: 5, narSize: 1000, unknownCount: 0 },
					available: 100,
					headroom: defaultHeadroomAbsoluteMinimum,
					detected: {
						cohortSplitPossible: false,
						remoteStoreConfigured: false,
						componentPublicationApplicable: false
					}
				},
				rows: [
					{ label: 'Refusal', value: 'insufficient store capacity' },
					{ label: 'Available', value: '100' },
					{ label: 'Headroom', value: String(defaultHeadroomAbsoluteMinimum) }
				]
			}
		]);
	});

	it('builds a candidate the upstream confirmation refuses and records the reason', async () => {
		const payloads: ResultPayload[] = [];
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const refusing = dependencies({
			rootClient: recordingRootClient([], buildRequired([appPath])),
			store: {
				queryMissing: () => Promise.resolve(emptyMissing()),
				querySubstitutablePaths: () => Promise.resolve([appPath]),
				queryValidPaths: () => Promise.resolve([appPath]),
				unreachableSubstituters: () => Promise.resolve([])
			},
			confirmLeftUpstream: () =>
				Promise.resolve({ kind: 'closure-not-served', missing: otherPath })
		});

		try {
			await runPlanCohort(
				runOptions({ targets: [target()], planFile }),
				reporter(payloads),
				refusing
			);

			const expectedPartition: AvailabilityPartition = {
				attachOnly: [],
				publishByReference: [],
				leftUpstream: [],
				leftUpstreamRejections: [
					{ kind: 'closure-not-served', missing: otherPath, storePath: appPath }
				],
				buildSet: [appPath],
				counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
				downloadSize: 0,
				narSize: 0,
				unknownCount: 0,
				alreadyValid: [appPath],
				unreachableSubstituters: [],
				ceiling: { value: 0, source: 'configured' }
			};

			expect(JSON.parse(await readFile(planFile, 'utf8'))).toStrictEqual({
				partition: expectedPartition,
				capacity: {
					available: 10_000_000_000,
					capacity: 10_000_000_000,
					headroom: defaultHeadroomAbsoluteMinimum
				}
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('records a capacity skip for a remote store without probing this filesystem', async () => {
		const payloads: ResultPayload[] = [];
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const remoteDependencies = dependencies({
			rootClient: recordingRootClient([], buildRequired([])),
			destinationServed: () => Promise.resolve(new Set([appPath])),
			capacityProbe: () =>
				Promise.reject(
					new Error('the capacity probe must not be consulted here')
				)
		});

		try {
			await runPlanCohort(
				runOptions({ targets: [target()], storeKind: 'ssh-ng', planFile }),
				reporter(payloads),
				remoteDependencies
			);

			const expectedResult = {
				partition: {
					attachOnly: [appPath],
					publishByReference: [],
					leftUpstream: [],
					leftUpstreamRejections: [],
					buildSet: [],
					counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
					downloadSize: 0,
					narSize: 0,
					unknownCount: 0,
					alreadyValid: [],
					unreachableSubstituters: [],
					ceiling: { value: 0, source: 'configured' }
				},
				capacity: { skipped: 'remote-store' }
			};

			expect(JSON.parse(await readFile(planFile, 'utf8'))).toStrictEqual(
				expectedResult
			);
			expect(payloads).toStrictEqual([
				{
					kind: 'plan-cohort',
					data: expectedResult,
					rows: [
						{ label: 'Attach only', value: '1' },
						{ label: 'Publish by reference', value: '0' },
						{ label: 'Left upstream', value: '0' },
						{ label: 'Build set', value: '0' },
						{ label: 'Plan file', value: planFile }
					]
				}
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function silentProgram(): Command {
	const program = new Command();
	program.exitOverride();
	program.configureOutput({
		writeErr() {
			return;
		},
		writeOut() {
			return;
		}
	});
	registerPlanCommands(program);

	return program;
}

describe('plan cohort command', () => {
	it('rejects a --store URI that names no ssh-ng destination before authenticating', async () => {
		let error: unknown;

		try {
			await silentProgram().parseAsync(
				[
					'plan',
					'cohort',
					'https://cache.example.workers.dev/t/acme',
					'--targets-file',
					'targets.json',
					'--store',
					'ssh://builder'
				],
				{ from: 'user' }
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(InvalidStoreUriError);

		if (!(error instanceof InvalidStoreUriError)) {
			return;
		}

		expect(error.value).toBe('ssh://builder');
	});
});

// What the plan does about the paths its first pass left unknown. A daemon
// caches what the substituters said and drops an untrusted client's settings;
// a store this process drives asks the substituters as the question is put.
describe('requeryUnknownWith', () => {
	const requeried: NixMissingPartition = {
		...emptyMissing(),
		willSubstitute: [appPath]
	};

	function bypassAnswering(opened: string[]): () => Pick<Nix, 'queryMissing'> {
		return () => {
			opened.push('opened');

			return { queryMissing: () => Promise.resolve(requeried) };
		};
	}

	it('asks nothing again of a store whose answers were never cached', async () => {
		const opened: string[] = [];

		const outcome = await requeryUnknownWith(
			{
				cachesSubstituterAnswers: false,
				honoursSubstituterSettings: () =>
					Promise.reject(new Error('the settings must not be asked about'))
			},
			bypassAnswering(opened),
			[appPath]
		);

		expect({ outcome, opened }).toStrictEqual({
			outcome: { kind: 'already-fresh' },
			opened: []
		});
	});

	it('asks again through the bypass when the store honours its settings', async () => {
		const opened: string[] = [];

		const outcome = await requeryUnknownWith(
			{
				cachesSubstituterAnswers: true,
				honoursSubstituterSettings: () => Promise.resolve({ isHonoured: true })
			},
			bypassAnswering(opened),
			[appPath]
		);

		expect({ outcome, opened }).toStrictEqual({
			outcome: { kind: 'answered', partition: requeried },
			opened: ['opened']
		});
	});

	it.each([
		{ name: 'not-trusted', trust: 'not-trusted' as const },
		{ name: 'unknown', trust: 'unknown' as const }
	])(
		'refuses, without opening a bypass, when the daemon is $name',
		async ({ trust }) => {
			const opened: string[] = [];

			const outcome = await requeryUnknownWith(
				{
					cachesSubstituterAnswers: true,
					honoursSubstituterSettings: () =>
						Promise.resolve({ isHonoured: false, trust })
				},
				bypassAnswering(opened),
				[appPath]
			);

			expect({ kind: outcome.kind, opened }).toStrictEqual({
				kind: 'refused',
				opened: []
			});
		}
	);
});
