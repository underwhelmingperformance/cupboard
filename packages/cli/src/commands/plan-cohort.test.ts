import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	Nix,
	NixMissingPartition,
	NixSubstitutablePathInfo
} from '@cupboard/nix';
import {
	type CacheScope,
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { RootEnsureResponse } from '@cupboard/protocol/retention';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	type RecordedCall,
	recordingCacheScopedClient
} from '../client/cache-scoped.test-support.ts';
import { InvalidStoreUriError } from '../errors.ts';

const defaultCache: CacheScope = { kind: 'default' };

interface RootEnsureBody {
	readonly name: string;
	readonly targets: string[];
	readonly ttlSeconds?: number;
}
import {
	type AvailabilityPartition,
	UnknownPathsCeilingError,
	type UnknownRequeryOutcome
} from '../plan/availability-partition.ts';
import {
	defaultHeadroomAbsoluteMinimum,
	StoreCapacityError
} from '../plan/capacity.ts';
import type { CohortTarget } from '../plan/cohort-target.ts';

import {
	requeryUnknownWith,
	resolvePlannedSubstitutionPolicy
} from './plan-cohort.ts';
import {
	type PlanCohortDependencies,
	type PlanCohortRunOptions,
	registerPlanCommands,
	runPlanCohort
} from './plan-cohort.ts';
import type { RootClient } from './root.ts';

function noop(): void {
	// Intentionally empty test callback.
}

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const otherPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-other'
);
const appRoot = rootNameSchema.parse('github:owner/repo/main/app');

function target(overrides: Partial<CohortTarget> = {}): CohortTarget {
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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	const [result] = await Promise.allSettled([promise]);

	if (result.status === 'fulfilled') {
		return;
	}

	const error: unknown = result.reason;

	return error;
}

function buildRequired(
	unavailable: readonly StorePathString[]
): RootEnsureResponse {
	return { status: 'build-required', unavailable: [...unavailable] };
}

function missingStore(
	missing: NixMissingPartition
): Pick<
	Nix,
	| 'queryMissing'
	| 'querySubstitutablePathInfos'
	| 'querySubstitutablePaths'
	| 'queryValidPaths'
	| 'unreachableSubstituters'
> {
	return {
		queryMissing: () => Promise.resolve(missing),
		querySubstitutablePathInfos: () => Promise.resolve([]),
		querySubstitutablePaths: () => Promise.resolve([]),
		queryValidPaths: () => Promise.resolve([]),
		unreachableSubstituters: () => Promise.resolve([])
	};
}

function requeryAnswering(
	missing: NixMissingPartition
): () => Promise<UnknownRequeryOutcome> {
	return () =>
		Promise.resolve({ kind: 'answered', partition: missing, sizes: new Map() });
}

function rejectingRootClient(): Pick<RootClient, 'ensure'> {
	return {
		ensure: recordingCacheScopedClient(() =>
			Promise.reject(new Error('roots.ensure must not be called here'))
		)
	};
}

function recordingRootClient(response: RootEnsureResponse): Pick<
	RootClient,
	'ensure'
> & {
	readonly ensure: { readonly calls: readonly RecordedCall<RootEnsureBody>[] };
} {
	return {
		ensure: recordingCacheScopedClient((_input: RootEnsureBody) =>
			Promise.resolve(response)
		)
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
		cache: defaultCache,
		storeIdentity: { kind: 'daemon' },
		plannedSubstitutionPolicy: {
			kind: 'known',
			substitute: true,
			alwaysAllowSubstitutes: false
		},
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
		confirmUpstreamAvailability: () => Promise.resolve({ kind: 'confirmed' }),
		destinationServed: () => Promise.resolve(new Set()),
		viewServed: () => Promise.resolve(new Set()),
		attestedServed: () =>
			Promise.reject(
				new Error('the attestation probe must not be called in this test')
			),
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
		const rootClient = recordingRootClient(buildRequired([]));
		const otherTarget = target({
			attr: 'packages.x86_64-linux.other',
			installable: otherPath,
			expectedPath: otherPath
		});
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const servedByDestination: PlanCohortDependencies = dependencies({
			rootClient,
			destinationServed: () => Promise.resolve(new Set([appPath, otherPath]))
		});

		try {
			await runPlanCohort(
				runOptions({ targets: [target(), otherTarget], planFile }),
				reporter(payloads),
				servedByDestination
			);

			expect(rootClient.ensure.calls).toStrictEqual([
				{
					cache: defaultCache,
					input: { name: appRoot, targets: [appPath, otherPath] }
				}
			]);

			const expectedPartition: AvailabilityPartition = {
				attachOnly: [appPath, otherPath],
				publishByReference: [],
				leftUpstream: [],
				leftUpstreamRejections: [],
				buildSet: [],
				dependencyBuilds: [],
				dependencyCopies: [],
				unattested: [],
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
						{ label: 'Already served by the cache', value: '2' },
						{ label: 'Reused from the tenant', value: '0' },
						{ label: 'Left to upstream caches', value: '0' },
						{ label: 'To build', value: '0' },
						{ label: 'Plan file', value: planFile }
					]
				}
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not partially reconcile a root whose complete target set is unknown', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const floatingTarget = target({
			attr: 'packages.x86_64-linux.other',
			installable: otherPath,
			expectedPath: undefined
		});
		const rootClient = recordingRootClient(buildRequired([]));
		const planDependencies = dependencies({
			rootClient,
			store: missingStore({
				willBuild: [otherPath],
				willSubstitute: [],
				unknown: [],
				downloadSize: 0,
				narSize: 0
			}),
			destinationServed: () => Promise.resolve(new Set([appPath]))
		});

		try {
			await runPlanCohort(
				runOptions({ targets: [target(), floatingTarget], planFile }),
				reporter([]),
				planDependencies
			);
			const plan: unknown = JSON.parse(await readFile(planFile, 'utf8'));

			expect({
				ensureCalls: rootClient.ensure.calls,
				plan
			}).toStrictEqual({
				ensureCalls: [],
				plan: {
					partition: {
						attachOnly: [appPath],
						publishByReference: [],
						leftUpstream: [],
						leftUpstreamRejections: [],
						buildSet: [otherPath],
						dependencyBuilds: [],
						dependencyCopies: [],
						unattested: [],
						counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
						downloadSize: 0,
						narSize: 0,
						alreadyValid: [],
						unknownCount: 0,
						unreachableSubstituters: [],
						ceiling: { value: 0, source: 'configured' }
					},
					capacity: {
						available: 10_000_000_000,
						capacity: 10_000_000_000,
						headroom: defaultHeadroomAbsoluteMinimum
					}
				}
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('passes a target’s planned local derivation through to the partition', async () => {
		const derivation = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
		);
		const dependencyDerivation = storePathSchema.parse(
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-other.drv'
		);
		const alternativeDependencyDerivation = storePathSchema.parse(
			'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-alternative.drv'
		);
		const installable = `${derivation}^out` as const;
		const dependencyInstallable = `${dependencyDerivation}^out` as const;
		const alternativeDependencyInstallable =
			`${alternativeDependencyDerivation}^out` as const;
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const payloads: ResultPayload[] = [];
		const rootClient = recordingRootClient(buildRequired([appPath]));
		const expectedResult = {
			partition: {
				attachOnly: [],
				publishByReference: [],
				leftUpstream: [],
				leftUpstreamRejections: [],
				buildSet: [installable],
				dependencyBuilds: [
					{
						path: otherPath,
						installables: [
							dependencyInstallable,
							alternativeDependencyInstallable
						],
						requiredBy: [installable]
					}
				],
				dependencyCopies: [],
				unattested: [],
				counts: { willBuild: 1, willSubstitute: 1, unknown: 0 },
				downloadSize: 10,
				narSize: 20,
				alreadyValid: [],
				unknownCount: 0,
				ceiling: { value: 0, source: 'configured' },
				unreachableSubstituters: []
			},
			capacity: { skipped: 'remote-store' }
		};

		try {
			const missingAnswers = [
				{
					willBuild: [],
					willSubstitute: [],
					unknown: [derivation],
					downloadSize: 0,
					narSize: 0
				},
				{
					willBuild: [],
					willSubstitute: [appPath],
					unknown: [otherPath],
					downloadSize: 10,
					narSize: 20
				}
			] satisfies NixMissingPartition[];
			let missingIndex = 0;
			const store = {
				...missingStore(emptyMissing()),
				queryMissing: () =>
					Promise.resolve(
						missingAnswers[missingIndex++] ??
							missingAnswers.at(-1) ??
							emptyMissing()
					),
				querySubstitutablePathInfos: () =>
					Promise.resolve([
						{
							source: 'daemon' as const,
							storePath: appPath,
							references: [otherPath],
							downloadSize: 10,
							narSize: 20
						}
					])
			};

			await runPlanCohort(
				runOptions({
					targets: [
						target({
							installable,
							plannedLocalDerivation: derivation
						})
					],
					plannedLocalClosure: [
						derivation,
						dependencyDerivation,
						alternativeDependencyDerivation
					],
					plannedSubstitutableDerivations: [derivation],
					plannedLocalOutputs: [
						{ path: otherPath, installable: dependencyInstallable },
						{
							path: otherPath,
							installable: alternativeDependencyInstallable
						}
					],
					storeIdentity: { kind: 'ssh-ng' },
					planFile,
					ceiling: { value: 0, untrustedFallback: 0 }
				}),
				reporter(payloads),
				dependencies({
					rootClient,
					store,
					requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' })
				})
			);

			const plan: unknown = JSON.parse(await readFile(planFile, 'utf8'));

			expect({ plan, payloads }).toStrictEqual({
				plan: expectedResult,
				payloads: [
					{
						kind: 'plan-cohort',
						data: expectedResult,
						rows: [
							{ label: 'Already served by the cache', value: '0' },
							{ label: 'Reused from the tenant', value: '0' },
							{ label: 'Left to upstream caches', value: '0' },
							{ label: 'To build', value: '1' },
							{ label: 'Dependencies to build', value: '1' },
							{ label: 'Plan file', value: planFile }
						]
					}
				]
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('emits plan-cohort-refusal before throwing UnknownPathsCeilingError', async () => {
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

		const options = runOptions({
			targets: [target({ expectedPath: undefined })]
		});
		const run = runPlanCohort(
			options,
			reporter(payloads),
			dependencies({
				store: missingStore(missing),
				requeryUnknown: requeryAnswering(requeryResult)
			})
		);
		const error = await rejectionOf(run);

		expect(error).toBeInstanceOf(UnknownPathsCeilingError);
		expect(payloads).toStrictEqual([
			{
				kind: 'plan-cohort-refusal',
				data: {
					reason: 'unknown-paths-ceiling',
					unknownCount: 1,
					unknownPaths: [
						{
							path: appPath,
							cause: { kind: 'not-in-store-or-substituters' },
							targets: [
								{
									attr: 'packages.x86_64-linux.app',
									installable: appPath
								}
							]
						}
					],
					store: { kind: 'daemon' },
					unreachableSubstituters: [],
					ceiling: { value: 0, source: 'configured' },
					downloadSize: 10,
					narSize: 20
				},
				rows: [
					{
						label: 'Refusal',
						value: 'Nix cannot obtain one or more required store paths'
					},
					{ label: 'Unavailable paths', value: '1' },
					{ label: 'Limit', value: '0' },
					{
						label: 'Unavailable path',
						value:
							'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app; ' +
							'target packages.x86_64-linux.app ' +
							'(/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app)\n' +
							"The local Nix daemon's store does not contain this path. The " +
							'plan queried the available substituters, but none provided it.'
					}
				]
			}
		]);
	});

	it('emits plan-cohort-refusal before throwing StoreCapacityError', async () => {
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

	it('adds a candidate to buildSet and records closure-not-served when upstream confirmation fails', async () => {
		const payloads: ResultPayload[] = [];
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const refusing = dependencies({
			rootClient: recordingRootClient(buildRequired([appPath])),
			store: {
				queryMissing: () => Promise.resolve(emptyMissing()),
				querySubstitutablePathInfos: () => Promise.resolve([]),
				querySubstitutablePaths: () => Promise.resolve([appPath]),
				queryValidPaths: () => Promise.resolve([appPath]),
				unreachableSubstituters: () => Promise.resolve([])
			},
			confirmUpstreamAvailability: () =>
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
				dependencyBuilds: [],
				dependencyCopies: [],
				unattested: [],
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
			rootClient: recordingRootClient(buildRequired([])),
			destinationServed: () => Promise.resolve(new Set([appPath])),
			capacityProbe: () =>
				Promise.reject(
					new Error('the capacity probe must not be consulted here')
				)
		});

		try {
			await runPlanCohort(
				runOptions({
					targets: [target()],
					storeIdentity: { kind: 'ssh-ng' },
					planFile
				}),
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
					dependencyBuilds: [],
					dependencyCopies: [],
					unattested: [],
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
						{ label: 'Already served by the cache', value: '1' },
						{ label: 'Reused from the tenant', value: '0' },
						{ label: 'Left to upstream caches', value: '0' },
						{ label: 'To build', value: '0' },
						{ label: 'Plan file', value: planFile }
					]
				}
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{
			name: 'attaches a served path the cache also holds an attestation for',
			attested: [appPath],
			attachOnly: [appPath],
			buildSet: [],
			unattested: [],
			extraRows: []
		},
		{
			name: 'builds a served path the cache holds no attestation for',
			attested: [],
			attachOnly: [],
			buildSet: [appPath],
			unattested: [appPath],
			extraRows: [{ label: 'Served but not attested', value: '1' }]
		}
	])('with attested availability required, $name', async (row) => {
		const payloads: ResultPayload[] = [];
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const asked: (readonly StorePathString[])[] = [];
		const attested = new Set(row.attested);
		const probing = dependencies({
			rootClient: recordingRootClient(buildRequired([appPath])),
			destinationServed: () => Promise.resolve(new Set([appPath])),
			attestedServed: (paths) => {
				asked.push(paths);

				return Promise.resolve(attested);
			}
		});

		try {
			await runPlanCohort(
				runOptions({ targets: [target()], planFile, requireAttested: true }),
				reporter(payloads),
				probing
			);

			const expectedResult = {
				partition: {
					attachOnly: row.attachOnly,
					publishByReference: [],
					leftUpstream: [],
					leftUpstreamRejections: [],
					buildSet: row.buildSet,
					dependencyBuilds: [],
					dependencyCopies: [],
					unattested: row.unattested,
					counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
					downloadSize: 0,
					narSize: 0,
					unknownCount: 0,
					alreadyValid: [],
					unreachableSubstituters: [],
					ceiling: { value: 0, source: 'configured' }
				},
				capacity: {
					available: 10_000_000_000,
					capacity: 10_000_000_000,
					headroom: defaultHeadroomAbsoluteMinimum
				}
			};

			const plan: unknown = JSON.parse(await readFile(planFile, 'utf8'));

			expect({ asked, plan, payloads }).toStrictEqual({
				asked: [[appPath]],
				plan: expectedResult,
				payloads: [
					{
						kind: 'plan-cohort',
						data: expectedResult,
						rows: [
							{
								label: 'Already served by the cache',
								value: String(row.attachOnly.length)
							},
							{ label: 'Reused from the tenant', value: '0' },
							{ label: 'Left to upstream caches', value: '0' },
							{ label: 'To build', value: String(row.buildSet.length) },
							...row.extraRows,
							{ label: 'Plan file', value: planFile }
						]
					}
				]
			});
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

// Bypass cached results only when the selected store caches substituter
// queries and honours per-command settings. Otherwise return `already-fresh`
// or `refused` without opening the bypass.
describe('requeryUnknownWith', () => {
	const requeried: NixMissingPartition = {
		...emptyMissing(),
		willSubstitute: [appPath]
	};

	const appOffer: NixSubstitutablePathInfo = {
		source: 'daemon',
		storePath: appPath,
		references: [],
		downloadSize: 40,
		narSize: 90
	};

	function bypassAnswering(
		opened: string[]
	): () => Pick<Nix, 'queryMissing' | 'querySubstitutablePathInfos'> {
		return () => {
			opened.push('opened');

			return {
				queryMissing: () => Promise.resolve(requeried),
				querySubstitutablePathInfos: (paths) => {
					opened.push(`sizes:${paths.join(',')}`);

					return Promise.resolve([appOffer]);
				}
			};
		};
	}

	it('skips the bypass query when the store does not cache substituter results', async () => {
		const opened: string[] = [];

		const outcome = await requeryUnknownWith(
			{
				cachesSubstituterQueries: false,
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

	it('uses the bypass partition and sizes when the store honours per-command settings', async () => {
		const opened: string[] = [];

		const outcome = await requeryUnknownWith(
			{
				cachesSubstituterQueries: true,
				honoursSubstituterSettings: () => Promise.resolve({ isHonoured: true })
			},
			bypassAnswering(opened),
			[appPath]
		);

		expect({ outcome, opened }).toStrictEqual({
			outcome: {
				kind: 'answered',
				partition: requeried,
				sizes: new Map([[appPath, { downloadSize: 40, narSize: 90 }]])
			},
			opened: ['opened', `sizes:${appPath}`]
		});
	});

	it.each([
		{
			name: 'not-trusted',
			settings: {
				isHonoured: false,
				reason: 'daemon-trust',
				trust: 'not-trusted'
			} as const,
			reason:
				'Cupboard cannot confirm the Nix daemon applied its per-command settings on this connection'
		},
		{
			name: 'unknown',
			settings: {
				isHonoured: false,
				reason: 'daemon-trust',
				trust: 'unknown'
			} as const,
			reason:
				'Cupboard cannot confirm the Nix daemon applied its per-command settings on this connection'
		},
		{
			name: 'preserving remote daemon options',
			settings: {
				isHonoured: false,
				reason: 'daemon-options-preserved',
				trust: 'unknown'
			} as const,
			reason:
				'the remote transport does not pass per-command settings to the Nix daemon'
		}
	])(
		'returns refused without opening the bypass when the connection is $name',
		async ({ settings, reason }) => {
			const opened: string[] = [];

			const outcome = await requeryUnknownWith(
				{
					cachesSubstituterQueries: true,
					honoursSubstituterSettings: () => Promise.resolve(settings)
				},
				bypassAnswering(opened),
				[appPath]
			);

			expect({ outcome, opened }).toStrictEqual({
				outcome: { kind: 'refused', reason },
				opened: []
			});
		}
	);
});

describe('resolvePlannedSubstitutionPolicy', () => {
	const settings = {
		substitute: true,
		alwaysAllowSubstitutes: true,
		fallback: false,
		substituters: ['https://cache.example.test']
	};

	it.each([
		{
			name: 'the selected store honours the configured settings',
			outcome: { isHonoured: true } as const,
			expected: {
				kind: 'known',
				substitute: true,
				alwaysAllowSubstitutes: true
			}
		},
		{
			name: 'the selected store preserves its own settings',
			outcome: {
				isHonoured: false,
				reason: 'daemon-options-preserved',
				trust: 'unknown'
			} as const,
			expected: { kind: 'unknown' }
		}
	])(
		'returns the effective policy when $name',
		async ({ outcome, expected }) => {
			const policy = await resolvePlannedSubstitutionPolicy(
				{
					honoursSubstituterSettings: () => Promise.resolve(outcome)
				},
				settings
			);

			expect(policy).toStrictEqual(expected);
		}
	);
});
