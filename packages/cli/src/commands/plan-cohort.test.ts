import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type {
	Nix,
	NixMissingPartition,
	NixSubstitutablePathInfo
} from '@cupboard/nix';
import {
	SubstituterAnswerUnreadableError,
	SubstituterUnreachableError
} from '@cupboard/nix';
import {
	type CacheScope,
	rootNameSchema,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { RootEnsureResponse } from '@cupboard/protocol/retention';
import {
	createGithubReporter,
	type Reporter,
	type ResultPayload
} from '@cupboard/reporter';
import { Command } from 'commander';
import { fetch as undiciFetch, Response } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import {
	maxSubstituterDocumentByteLength,
	openSubstituters,
	SubstituterClient
} from '../../../nix/src/substituter.ts';
import { cliExitCode } from '../cli.ts';
import {
	type RecordedCall,
	recordingCacheScopedClient
} from '../client/cache-scoped.test-support.ts';
import { InvalidStoreUriError } from '../errors.ts';
import { confirmUpstreamAvailabilityWith } from '../plan/upstream-confirmation.ts';

const defaultCache: CacheScope = { kind: 'default' };

interface RootEnsureBody {
	readonly name: string;
	readonly targets: string[];
	readonly retention:
		| { readonly kind: 'inherit' | 'permanent' }
		| { readonly kind: 'duration'; readonly seconds: number };
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
	planRootClient,
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
		retention: { kind: 'inherit' },
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
		capacityProbe: () =>
			Promise.resolve({ available: 10_000_000_000, capacity: 10_000_000_000 }),
		...overrides
	};
}

function reporter(payloads: ResultPayload[]): Reporter {
	const record = (payload: ResultPayload): void => {
		payloads.push(payload);
	};

	return {
		phase: (_label, body) =>
			Promise.resolve(body({ fact: noop, warn: noop, result: record })),
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
		result: record,
		data: noop,
		warn: noop,
		info: noop,
		success: noop,
		step: noop,
		error: noop
	};
}

it('keeps automation helpers accessible without promoting them in root help', () => {
	const program = new Command('cupboard');
	registerPlanCommands(program);
	const plan = program.commands.find((command) => command.name() === 'plan');
	expect({
		rootHelp: program.helpInformation().includes('plan'),
		explicitHelp: plan?.helpInformation().includes('cohort')
	}).toStrictEqual({ rootHelp: false, explicitHelp: true });
});

describe('runPlanCohort', () => {
	it('ensures the publication root with explicit permanent retention', async () => {
		const rootClient = recordingRootClient(buildRequired([]));
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		try {
			await runPlanCohort(
				runOptions({
					targets: [target()],
					retention: { kind: 'permanent' },
					planFile: path.join(directory, 'plan.json')
				}),
				reporter([]),
				dependencies({ rootClient })
			);
			expect(rootClient.ensure.calls).toStrictEqual([
				{
					cache: defaultCache,
					input: {
						name: appRoot,
						targets: [appPath],
						retention: { kind: 'permanent' }
					}
				}
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

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
					input: {
						name: appRoot,
						targets: [appPath, otherPath],
						retention: { kind: 'inherit' }
					}
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
				rebuildSet: [],
				closureTargets: [],
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
					title: 'Build plan',
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

	it('writes an outcome inside each phase group in GitHub mode', async () => {
		const written: string[] = [];
		const github = createGithubReporter({
			stream: new Writable({
				write(chunk: Buffer | string, _encoding, callback) {
					written.push(String(chunk));
					callback();
				}
			})
		});
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const otherTarget = target({
			attr: 'packages.x86_64-linux.other',
			installable: otherPath,
			expectedPath: otherPath
		});
		const rootClient = recordingRootClient(buildRequired([otherPath]));

		try {
			await runPlanCohort(
				runOptions({ targets: [target(), otherTarget], planFile }),
				github,
				dependencies({
					rootClient,
					destinationServed: () => Promise.resolve(new Set([appPath]))
				})
			);

			expect(written).toStrictEqual([
				'::group::Checking retention roots\n',
				'Roots retained: 0\n',
				'Roots not yet retained: 1\n',
				'::endgroup::\n',
				'::group::Checking which targets need a build\n',
				'To build: 1\n',
				'Download size: 0 B\n',
				'::endgroup::\n',
				'::group::Checking store capacity\n',
				'Substitutable NAR size: 0 B\n',
				'Space available: 10 GB\n',
				'Headroom: 5.37 GB\n',
				'::endgroup::\n',
				'Build plan\n',
				'Already served by the cache: 1\n',
				'Reused from the tenant: 0\n',
				'Left to upstream caches: 0\n',
				'To build: 1\n',
				`Plan file: ${planFile}\n`
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
						rebuildSet: [],
						closureTargets: [],
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
				rebuildSet: [],
				closureTargets: [],
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
						title: 'Build plan',
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

	it.each([
		{ description: 'anonymous authentication', status: 401, expected: 77 },
		{ description: 'anonymous authorisation', status: 403, expected: 77 },
		{ description: 'a request timeout', status: 408, expected: 75 },
		{ description: 'rate limiting', status: 429, expected: 75 },
		{ description: 'a provider error', status: 500, expected: 75 },
		{ description: 'service unavailability', status: 503, expected: 75 },
		{ description: 'a storage quota refusal', status: 507, expected: 1 },
		{ description: 'an HTML login response', status: 200, expected: 75 },
		{ description: 'a malformed partial response', status: 206, expected: 75 },
		{ description: 'a malformed narinfo', status: 0, expected: 75 },
		{ description: 'an oversized narinfo', status: -1, expected: 75 },
		{ description: 'a lost connection', status: -2, expected: 75 }
	])(
		'preserves the upstream probe failure for $description at the cohort CLI boundary',
		async ({ status, expected }) => {
			const directory = mkdtempSync(
				path.join(tmpdir(), 'cupboard-plan-cohort-')
			);
			const planFile = path.join(directory, 'plan.json');
			const payloads: ResultPayload[] = [];
			const requested: string[] = [];
			const requestedHeaders: unknown[] = [];
			const fetcher: typeof undiciFetch = (input, init) => {
				requestedHeaders.push(init?.headers);
				const url = new URL(
					typeof input === 'string'
						? input
						: 'href' in input
							? input.href
							: input.url
				);
				requested.push(url.pathname);
				if (url.pathname === '/nix-cache-info') {
					return Promise.resolve(
						new Response('StoreDir: /nix/store\nWantMassQuery: 1\n')
					);
				}
				if (url.pathname.endsWith('.narinfo')) {
					const document =
						status === 0
							? `StorePath: ${appPath}\nNarHash: invalid\n`
							: status === -1
								? 'a'.repeat(maxSubstituterDocumentByteLength + 1)
								: [
										`StorePath: ${appPath}`,
										'URL: https://archives.example/nar/app',
										'Compression: none',
										`NarHash: sha256:${'22'.repeat(32)}`,
										'NarSize: 1000',
										'FileSize: 400',
										'References: '
									].join('\n') + '\n';
					return Promise.resolve(new Response(document));
				}
				if (status === -2) {
					return Promise.reject(new Error('connection lost'));
				}
				return Promise.resolve(
					new Response(
						status === 200 ? '<html>Sign in</html>' : new Uint8Array([1]),
						{
							status,
							headers: status === 200 ? { 'content-type': 'text/html' } : {}
						}
					)
				);
			};
			const storeDirectory = storeDirectorySchema.parse('/nix/store');
			const external = new SubstituterClient(
				() =>
					openSubstituters(['https://runner:secret@upstream.example'], {
						requirePublicNar: true,
						netrc:
							'machine upstream.example login runner password secret\nmachine archives.example login runner password secret',
						fetch: fetcher
					}),
				{
					storeDirectory,
					substitute: true,
					fallback: true,
					requirePublicNar: true,
					fetch: fetcher
				}
			);
			let probeFailure: unknown;
			const confirm = confirmUpstreamAvailabilityWith({
				substitution: {
					substitute: true,
					fallback: true,
					alwaysAllowSubstitutes: false,
					substituters: ['https://upstream.example']
				},
				accepts: () => Promise.resolve(true),
				store: {
					honoursSubstituterSettings: () =>
						Promise.resolve({ isHonoured: true }),
					canSubstituteDerivation: () => Promise.resolve(true),
					resolveSubstitutableClosure: async () => {
						try {
							await external.querySubstitutablePathInfos([appPath]);
						} catch (error) {
							probeFailure = error;
							throw error;
						}
						return {
							kind: 'served',
							pathCount: 1,
							narSize: 1000,
							downloadSize: 400
						};
					}
				}
			});
			try {
				const probeDependencies = dependencies({
					rootClient: recordingRootClient(buildRequired([appPath])),
					store: {
						...missingStore(emptyMissing()),
						queryValidPaths: () => Promise.resolve([appPath]),
						querySubstitutablePaths: () => Promise.resolve([appPath])
					},
					confirmUpstreamAvailability: confirm
				});
				const run = runPlanCohort(
					runOptions({ targets: [target()], planFile }),
					reporter(payloads),
					probeDependencies
				);
				const failure = await rejectionOf(run);
				expect(failure).toBe(probeFailure);
				expect(failure).toHaveProperty(
					'substituter',
					'https://upstream.example'
				);
				expect(failure).toHaveProperty(
					'message',
					expect.stringContaining('--substituter copy')
				);
				expect(failure).toBeInstanceOf(
					status === 0 || status === -1
						? SubstituterAnswerUnreadableError
						: SubstituterUnreachableError
				);
				expect({
					exitCode: cliExitCode(failure, 130),
					planWritten: existsSync(planFile),
					payloads,
					requested,
					requestedHeaders
				}).toStrictEqual({
					exitCode: expected,
					requestedHeaders:
						status === 0 || status === -1
							? [undefined, undefined]
							: [
									undefined,
									undefined,
									{ range: 'bytes=0-0', 'accept-encoding': 'identity' }
								],
					planWritten: false,
					payloads: [],
					requested:
						status === 0 || status === -1
							? [
									'/nix-cache-info',
									`/${appPath.slice('/nix/store/'.length, '/nix/store/'.length + 32)}.narinfo`
								]
							: [
									'/nix-cache-info',
									`/${appPath.slice('/nix/store/'.length, '/nix/store/'.length + 32)}.narinfo`,
									'/nar/app'
								]
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

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
				rebuildSet: [],
				closureTargets: [],
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
					rebuildSet: [],
					closureTargets: [],
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
					title: 'Build plan',
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

	it('records forced rebuild installables in the cohort plan', async () => {
		const payloads: ResultPayload[] = [];
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const missingCalls: (readonly string[])[] = [];
		const store = {
			...missingStore(emptyMissing()),
			queryMissing: (installables: readonly string[]) => {
				missingCalls.push(installables);

				return Promise.resolve(emptyMissing());
			}
		};
		const rootClient = recordingRootClient(buildRequired([appPath]));

		try {
			await runPlanCohort(
				runOptions({
					targets: [target()],
					planFile,
					build: 'rebuild',
					substituter: 'copy',
					publish: 'closure'
				}),
				reporter(payloads),
				dependencies({
					rootClient,
					destinationServed: () => Promise.resolve(new Set([appPath])),
					store
				})
			);

			const plan: unknown = JSON.parse(await readFile(planFile, 'utf8'));

			expect({ missingCalls, plan }).toStrictEqual({
				missingCalls: [[appPath]],
				plan: {
					partition: {
						attachOnly: [],
						publishByReference: [],
						leftUpstream: [],
						leftUpstreamRejections: [],
						buildSet: [appPath],
						rebuildSet: [appPath],
						closureTargets: [],
						dependencyBuilds: [],
						dependencyCopies: [],
						counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
						downloadSize: 0,
						narSize: 0,
						alreadyValid: [],
						unknownCount: 0,
						ceiling: { value: 0, source: 'configured' },
						unreachableSubstituters: []
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

	it('does not set retention roots when publication is disabled', async () => {
		const payloads: ResultPayload[] = [];
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const rootClient = recordingRootClient(buildRequired([appPath]));

		try {
			await runPlanCohort(
				runOptions({ targets: [target()], planFile, publish: 'none' }),
				reporter(payloads),
				dependencies({ rootClient })
			);

			const plan: unknown = JSON.parse(await readFile(planFile, 'utf8'));

			expect({ rootCalls: rootClient.ensure.calls, plan }).toStrictEqual({
				rootCalls: [],
				plan: {
					partition: {
						attachOnly: [],
						publishByReference: [],
						leftUpstream: [],
						leftUpstreamRejections: [],
						buildSet: [appPath],
						rebuildSet: [],
						closureTargets: [],
						dependencyBuilds: [],
						dependencyCopies: [],
						counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
						downloadSize: 0,
						narSize: 0,
						alreadyValid: [],
						unknownCount: 0,
						ceiling: { value: 0, source: 'configured' },
						unreachableSubstituters: []
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

	it('keeps a destination-served target available for closure publication without rebuilding it', async () => {
		const payloads: ResultPayload[] = [];
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-cohort-'));
		const planFile = path.join(directory, 'plan.json');
		const storeIdentity = { kind: 'ssh-ng' as const, uri: 'ssh-ng://builder' };
		const rootClient = recordingRootClient(buildRequired([appPath]));

		try {
			await runPlanCohort(
				runOptions({
					targets: [target()],
					planFile,
					storeIdentity,
					build: 'missing',
					substituter: 'leave',
					publish: 'closure'
				}),
				reporter(payloads),
				dependencies({
					rootClient,
					destinationServed: () => Promise.resolve(new Set([appPath]))
				})
			);

			const plan: unknown = JSON.parse(await readFile(planFile, 'utf8'));

			expect(plan).toStrictEqual({
				partition: {
					attachOnly: [appPath],
					publishByReference: [],
					leftUpstream: [],
					leftUpstreamRejections: [],
					buildSet: [],
					rebuildSet: [],
					closureTargets: [appPath],
					dependencyBuilds: [],
					dependencyCopies: [],
					counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
					downloadSize: 0,
					narSize: 0,
					alreadyValid: [],
					unknownCount: 0,
					ceiling: { value: 0, source: 'configured' },
					unreachableSubstituters: []
				},
				capacity: { skipped: 'remote-store' }
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
	it.each([
		{ publish: 'none' as const, authenticated: false },
		{ publish: 'outputs' as const, authenticated: true },
		{ publish: 'closure' as const, authenticated: true }
	])(
		'requests a write client only for publish: $publish',
		async ({ publish, authenticated }) => {
			const client = recordingRootClient(buildRequired([]));
			const authenticate = vi.fn(() => Promise.resolve(client));

			expect({
				rootClient: await planRootClient(publish, authenticate),
				authenticated: authenticate.mock.calls.length > 0
			}).toStrictEqual({
				rootClient: authenticated ? client : undefined,
				authenticated
			});
		}
	);

	it.each([
		{ flag: '--build', value: 'copy', allowed: 'missing or rebuild' },
		{
			flag: '--substituter',
			value: 'rebuild',
			allowed: 'leave or copy'
		},
		{
			flag: '--publish',
			value: 'all',
			allowed: 'none, outputs, built or closure'
		}
	])('rejects invalid $flag choice', async ({ flag, value, allowed }) => {
		await expect(
			silentProgram().parseAsync(
				[
					'plan',
					'cohort',
					'https://cache.example.workers.dev/t/acme',
					'--targets-file',
					'targets.json',
					flag,
					value
				],
				{ from: 'user' }
			)
		).rejects.toMatchObject({
			message: `error: option '${flag} <mode>' argument '${value}' is invalid. must be ${allowed}`
		});
	});

	it.each([
		{
			flag: '--read-user',
			value: 'reader',
			pair: '--read-user and --read-password'
		},
		{
			flag: '--read-password',
			value: 'synthetic-secret',
			pair: '--read-user and --read-password'
		},
		{
			flag: '--view-read-user',
			value: 'reader',
			pair: '--view-read-user and --view-read-password'
		},
		{
			flag: '--view-read-password',
			value: 'synthetic-secret',
			pair: '--view-read-user and --view-read-password'
		}
	])(
		'rejects an incomplete $flag pair before reading targets',
		async ({ flag, value, pair }) => {
			const directory = mkdtempSync(
				path.join(tmpdir(), 'cupboard-plan-credentials-')
			);

			try {
				await expect(
					silentProgram().parseAsync(
						[
							'plan',
							'cohort',
							'https://cache.example.workers.dev/t/acme',
							'--targets-file',
							path.join(directory, 'missing.json'),
							flag,
							value
						],
						{ from: 'user' }
					)
				).rejects.toMatchObject({
					name: 'ReadCredentialPairError',
					message: `${pair} must be supplied together`
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

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
