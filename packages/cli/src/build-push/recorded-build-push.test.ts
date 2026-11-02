import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Derivation } from '@cupboard/nix-store/derivation';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	rootNameSchema,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import {
	type BuildReceiptV3,
	buildReceiptV3Schema,
	buildSubjectV3Schema,
	invocationIdSchema
} from '@cupboard/protocol/build';
import {
	publicationCaptureBeginRequestSchema,
	publicationCapturePageRequestSchema,
	publicationEnsureRequestSchema,
	publicationLookupRequestSchema,
	publicationSourceSelectorSchema,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import {
	publicationCaptureCheckpointSchema,
	type PublicationWorkflowRequest,
	type PublicationWorkflowResponse
} from '@cupboard/protocol/publication-workflow';
import { uploadCapabilitiesHeader } from '@cupboard/protocol/upload';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { audienceSchema } from '../audience.ts';
import { cacheTargetFromUrl } from '../cache-target.ts';
import {
	BuildCommandFailedError,
	BuildPublicationFailedError,
	CliAbortError,
	CupboardHttpError
} from '../errors.ts';
import { publicationWorkflowFor } from '../publication/publication-client.ts';

import type {
	BuildPushDependencies,
	BuildPushRunOptions
} from './build-push.ts';
import { buildPublicationWorkflow } from './publication-client.ts';
import { runRecordedBuildPush } from './recorded-build-push.ts';

const storePath = (digit: string, name: string) =>
	storePathSchema.parse(`/nix/store/${digit.repeat(32)}-${name}`);
const app = storePath('1', 'app');
const sibling = storePath('2', 'sibling');
const tool = storePath('3', 'tool');
const upstream = storePath('4', 'upstream');
const appDrv = storePath('5', 'app.drv');
const siblingDrv = storePath('6', 'sibling.drv');
const toolDrv = storePath('7', 'tool.drv');
const upstreamDrv = storePath('8', 'upstream.drv');
const hash = NixSha256Hash.fromDigest(Buffer.alloc(32, 1));
const defaultSource = { cache: { kind: 'default' as const } };
const publication = (result = app, members = 2) =>
	recordedPublicationSchema.parse({
		result: {
			storePath: result,
			narHash: hash.toString(),
			generation: 1,
			cache: { kind: 'default' },
			cacheGeneration: 1
		},
		digest: 'a'.repeat(64),
		memberCount: members,
		origin: 'build-selection'
	});

function derivation(
	outputs: readonly StorePathString[],
	inputs: readonly StorePathString[] = []
) {
	return Derivation.parse(
		`Derive([${outputs.map((output, index) => `("${index === 0 ? 'out' : 'dev'}","${output}","","")`).join(',')}],[${inputs.map((input) => `("${input}",["out"])`).join(',')}],[],"x86_64-linux","/bin/sh",[],[])`
	);
}

function fixture(
	execute: (
		request: PublicationWorkflowRequest
	) => PublicationWorkflowResponse | Promise<PublicationWorkflowResponse>
) {
	const graph = new Map([
		[appDrv, derivation([app], [toolDrv, upstreamDrv])],
		[siblingDrv, derivation([sibling])],
		[toolDrv, derivation([tool])],
		[upstreamDrv, derivation([upstream])]
	]);
	const results: ResultPayload[] = [];
	const reporter: Reporter = {
		phase: (_label, body) =>
			Promise.resolve(body({ fact: vi.fn(), warn: vi.fn(), result: vi.fn() })),
		progress: vi.fn(),
		steps: vi.fn(),
		data: vi.fn(),
		success: vi.fn(),
		step: vi.fn(),
		error: vi.fn(),
		result: (result) => {
			results.push(result);
		},
		info: vi.fn(),
		warn: vi.fn()
	};
	const dependencies: BuildPushDependencies = {
		publicationWorkflow: {
			destination: {
				tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
				cache: { kind: 'default' }
			},
			execute: async (request) => await execute(request)
		},
		publicationSources: [defaultSource],
		client: {
			negotiate: vi.fn(() => Promise.resolve({ uploads: [] })),
			preview: vi.fn(() => Promise.resolve({ uploads: [] })),
			uploadNar: vi.fn(),
			commit: vi.fn(),
			setRoot: vi.fn()
		},
		credential: 'cupboard-login',
		store: {
			storeKind: 'local-filesystem',
			queryPathInfo: vi.fn(),
			queryValidPaths: vi.fn(),
			queryValidPathsInfo: vi.fn(),
			queryDerivationOutputPaths: vi.fn(),
			narFromPath: vi.fn(),
			resolveClosure: vi.fn(),
			readDerivation: vi.fn((path: string) => {
				const term = graph.get(storePathSchema.parse(path));
				if (term === undefined) {
					throw new Error(`Unexpected derivation ${path}`);
				}
				return Promise.resolve(term);
			})
		},
		batchStore: { withProtectedPaths: vi.fn() },
		storeDirectory: storeDirectorySchema.parse('/nix/store'),
		invocationId: invocationIdSchema.parse('test'),
		preflight: vi.fn(),
		targetDerivations: vi.fn((installables: readonly string[]) =>
			Promise.resolve(
				new Map(
					installables.map((installable) => [
						installable,
						[installable.startsWith(appDrv) ? appDrv : siblingDrv]
					])
				)
			)
		)
	};
	const options: BuildPushRunOptions = {
		invocation: {
			kind: 'constructed',
			build: { installables: [`${appDrv}^out`] }
		},
		publicationScope: 'built'
	};
	const receipt: BuildReceiptV3 = buildReceiptV3Schema.parse({
		version: 3,
		paths: [app, tool],
		subjects: [app, tool].map((storePath) => ({
			origin: 'built',
			storePath,
			narHash: hash.digestHex(),
			derivation: storePath === app ? appDrv : toolDrv,
			buildStore: 'auto',
			verification: 'local'
		}))
	});
	const build = vi.fn(
		async (
			_options: BuildPushRunOptions,
			_reporter: Reporter,
			dependencies_: BuildPushDependencies
		) => {
			await dependencies_.settledTargets?.([app]);
			return receipt;
		}
	);
	return { options, dependencies, reporter, results, receipt, build, graph };
}

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { recursive: true, force: true })
		)
	);
	directories.length = 0;
});

it.each(['none', 'intermediate', 'root'] as const)(
	'settles explicit intermediates outside a warm winner inside build recovery (interruption: %s)',
	async (interruption) => {
		const calls: PublicationWorkflowRequest[] = [];
		const winner = publication(app, 1);
		const completed = { ...winner, materialisation: 'complete' as const };
		const f = fixture((request) => {
			calls.push(structuredClone(request));
			if (request.operation === 'prepare-run-root') {
				return {
					operation: 'prepare-run-root',
					supported: true,
					output: { name: request.input.name }
				};
			}
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: {
						entries: [{ kind: 'recorded', publication: winner, complete: true }]
					}
				};
			}
			if (request.operation === 'ensure') {
				return { operation: 'ensure', supported: true, output: completed };
			}
			throw new Error(
				'Explicit intermediates must not expand the recorded winner'
			);
		});
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-explicit-intermediates-')
		);
		directories.push(directory);
		const receiptFile = path.join(directory, 'receipt.json');
		const { publicationScope: _scope, ...unscoped } = f.options;
		const options: BuildPushRunOptions = {
			...unscoped,
			intermediatePaths: [tool],
			receiptFile,
			root: rootNameSchema.parse('main'),
			retention: { kind: 'duration', seconds: ttlSecondsSchema.parse(123) },
			runRoot: {
				name: rootNameSchema.parse('run/123'),
				retention: { kind: 'permanent' }
			}
		};
		const settledTargets = vi.fn();
		const dependencies = { ...f.dependencies, settledTargets };
		const original = buildReceiptV3Schema.parse({
			version: 3,
			paths: [app, tool],
			subjects: [app, tool].map((storePath) => ({
				origin: 'store-held',
				storePath,
				narHash: hash.digestHex(),
				buildStore: 'auto'
			})),
			childExitStatus: 0,
			outcomes: [{ outcome: 'destination-served', storePath: app }],
			uploaded: [],
			failed: [],
			collected: []
		});
		const partial = {
			...original,
			paths: [app],
			subjects: original.subjects.slice(0, 1),
			failed: [tool]
		};
		const legacySummary = {
			mode: 'streamed',
			store: '/nix/store',
			targetPaths: 1,
			intermediatePaths: 1,
			queueDepth: 0,
			uploadedPaths: 0,
			skipped: 2,
			childExitStatus: 0,
			unconfirmedPaths: []
		};
		const failure = new BuildPublicationFailedError([tool], 74, {
			cause: new Error('intermediate refused')
		});
		let isInterrupted = interruption !== 'none';
		f.build.mockImplementation(async (actual, reporter, dependencies_) => {
			const { root: _root, ...expected } = options;
			expect(actual).toEqual(expected);
			expect(calls.map((request) => request.operation)).toContain('ensure');
			if (interruption === 'intermediate' && isInterrupted) {
				await writeFile(receiptFile, JSON.stringify(partial));
				reporter.result({
					kind: 'build-summary',
					rows: [],
					data: { ...legacySummary, skipped: 1, unconfirmedPaths: [tool] }
				});
				throw failure;
			}
			await dependencies_.settledTargets?.([app]);
			reporter.result({ kind: 'build-summary', rows: [], data: legacySummary });
			return original;
		});
		let rootTargets = [upstream];
		vi.mocked(dependencies.client).setRoot.mockImplementation((_name, body) => {
			if (interruption === 'root' && isInterrupted) {
				throw new Error('root interrupted');
			}
			rootTargets = body.targets.map((target) => storePathSchema.parse(target));
			return Promise.resolve({
				name: rootNameSchema.parse('main'),
				targets: [],
				expired: false,
				createdAt: '2026-07-31T00:00:00.000Z',
				updatedAt: '2026-07-31T00:00:00.000Z'
			});
		});
		const journalFile = `${receiptFile}.publication-requests.json`;
		let savedJournal: string | undefined;
		if (interruption !== 'none') {
			const run = runRecordedBuildPush(
				options,
				f.reporter,
				dependencies,
				f.build
			);
			if (interruption === 'intermediate') {
				await expect(run).rejects.toBe(failure);
				expect(failure.exitCode).toBe(74);
			} else {
				await expect(run).rejects.toMatchObject({
					cause: new Error('root interrupted')
				});
			}
			expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual({
				...(interruption === 'intermediate' ? partial : original),
				version: 4,
				publicationSets: [completed],
				...(interruption === 'root' && { terminalFailure: { kind: 'command' } })
			});
			expect(f.results).toEqual([
				{
					kind: 'build-summary-v4',
					rows: [],
					...(interruption === 'root' && { title: 'Publication incomplete' }),
					data: {
						...legacySummary,
						skipped: interruption === 'intermediate' ? 1 : 2,
						unconfirmedPaths: interruption === 'intermediate' ? [tool] : [],
						version: 4,
						publicationSets: [completed]
					}
				}
			]);
			expect(rootTargets).toEqual([upstream]);
			expect(settledTargets.mock.calls).toEqual([]);
			savedJournal = await readFile(journalFile, 'utf8');
			const journal: unknown = JSON.parse(savedJournal);
			if (interruption === 'root') {
				expect(journal).toHaveProperty('snapshots.build', {
					receipt: original,
					targets: [app],
					captures: [],
					recorded: [],
					supported: true,
					summary: legacySummary
				});
				f.build.mockRejectedValue(
					new Error('Builder forbidden during durable recovery')
				);
			} else {
				expect(journal).not.toHaveProperty('snapshots.build');
			}
			f.graph.clear();
			isInterrupted = false;
		}
		const expected = { ...original, version: 4, publicationSets: [completed] };
		expect(
			await runRecordedBuildPush(options, f.reporter, dependencies, f.build)
		).toEqual(expected);
		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual(expected);
		expect(f.results.at(-1)).toEqual({
			kind: 'build-summary-v4',
			title: 'Build and publication result',
			rows: [],
			data: { ...legacySummary, version: 4, publicationSets: [completed] }
		});
		expect(rootTargets).toEqual([app]);
		expect(settledTargets.mock.calls).toEqual([[[app]]]);
		expect(vi.mocked(dependencies.client).setRoot.mock.calls).toEqual(
			Array.from({ length: interruption === 'root' ? 2 : 1 }, () => [
				'main',
				{ targets: [app], retention: options.retention }
			])
		);
		expect(vi.mocked(dependencies.client).negotiate.mock.calls).toEqual([]);
		expect(
			calls.filter((request) => request.operation === 'prepare-run-root')
		).toEqual(
			Array.from({ length: interruption === 'none' ? 1 : 2 }, () => ({
				operation: 'prepare-run-root',
				input: options.runRoot
			}))
		);
		const ensures = calls.filter((request) => request.operation === 'ensure');
		expect(calls.map((request) => request.operation)).toEqual(
			interruption === 'none'
				? ['lookup', 'prepare-run-root', 'ensure']
				: ['lookup', 'prepare-run-root', 'ensure', 'prepare-run-root', 'ensure']
		);
		expect(ensures[0]?.input.source).toEqual(winner);
		if (interruption !== 'none') {
			expect(ensures[1]).toEqual(ensures[0]);
		}
		const journal = await readFile(journalFile, 'utf8');
		expect(JSON.parse(journal)).toHaveProperty('snapshots.build', {
			receipt: original,
			targets: [app],
			captures: [],
			recorded: [],
			supported: true,
			summary: legacySummary
		});
		if (interruption === 'root') {
			expect(journal).toBe(savedJournal);
		}
		expect(f.build).toHaveBeenCalledTimes(
			interruption === 'intermediate' ? 2 : 1
		);
		expect(dependencies.store.readDerivation).toHaveBeenCalledTimes(1);
		expect(dependencies.targetDerivations).not.toHaveBeenCalled();
	}
);

describe('runRecordedBuildPush', () => {
	it.each([undefined, []])(
		'ensures a warm record without dependency discovery, member metadata, confirmation, publication or receipts (intermediates: %j)',
		async (intermediatePaths) => {
			const calls: PublicationWorkflowRequest[] = [];
			const f = fixture((request) => {
				calls.push(request);
				if (request.operation === 'lookup') {
					return {
						operation: 'lookup',
						supported: true,
						output: {
							entries: [
								{ kind: 'recorded', publication: publication(), complete: true }
							]
						}
					};
				}
				if (request.operation === 'ensure') {
					return {
						operation: 'ensure',
						supported: true,
						output: { ...request.input.source, materialisation: 'complete' }
					};
				}
				throw new Error('No capture on a warm run');
			});
			const receipt = await runRecordedBuildPush(
				{
					...f.options,
					...(intermediatePaths !== undefined && { intermediatePaths })
				},
				f.reporter,
				f.dependencies,
				f.build
			);
			expect(receipt).toMatchObject({
				version: 4,
				paths: [],
				subjects: [],
				publicationSets: [{ memberCount: 2 }]
			});
			expect(calls.map((call) => call.operation)).toEqual(['lookup', 'ensure']);
			expect(f.build).not.toHaveBeenCalled();
			expect(f.dependencies.targetDerivations).not.toHaveBeenCalled();
			expect(
				vi.mocked(f.dependencies.store).readDerivation
			).toHaveBeenCalledTimes(1);
			expect(f.dependencies.store.queryValidPathsInfo).not.toHaveBeenCalled();
			expect(
				vi.mocked(f.dependencies.client).negotiate.mock.calls
			).toHaveLength(0);
			expect(f.results.map((result) => result.kind)).toEqual([
				'build-summary-v4'
			]);
		}
	);

	it('uses the resolved view selector and binds the run root additively before ensure', async () => {
		const view = publicationSourceSelectorSchema.parse({
			view: 'release',
			expectedRevision: 3
		});
		const calls: PublicationWorkflowRequest[] = [];
		const f = fixture((request) => {
			calls.push(request);
			if (request.operation === 'prepare-run-root') {
				return {
					operation: 'prepare-run-root',
					supported: true,
					output: { name: request.input.name }
				};
			}
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: {
						entries: [
							{ kind: 'recorded', publication: publication(), complete: true }
						],
						sourceSelector: view
					}
				};
			}
			if (request.operation === 'ensure') {
				return {
					operation: 'ensure',
					supported: true,
					output: { ...request.input.source, materialisation: 'complete' }
				};
			}
			throw new Error('Unexpected capture');
		});
		const runRoot = {
			name: rootNameSchema.parse('run/123'),
			retention: { kind: 'inherit' as const }
		};
		await runRecordedBuildPush(
			{ ...f.options, runRoot },
			f.reporter,
			f.dependencies,
			f.build
		);
		expect(vi.mocked(f.dependencies.client).negotiate.mock.calls).toEqual([]);
		expect(calls[1]).toEqual({ operation: 'prepare-run-root', input: runRoot });
		expect(calls[2]).toMatchObject({
			operation: 'ensure',
			input: { sourceSelector: view, runRoot: runRoot.name }
		});
	});

	it.each([
		'operation',
		'unsupported',
		'name',
		'provider',
		'authority',
		'conflict',
		'temporary',
		'cancel'
	] as const)(
		'fails closed before warm ensure or cold work when run root preparation reports %s',
		async (failure) => {
			const calls: PublicationWorkflowRequest[] = [];
			const cause =
				failure === 'cancel'
					? new CliAbortError()
					: ['authority', 'conflict', 'temporary'].includes(failure)
						? new CupboardHttpError(
								'POST',
								'/uploads',
								failure === 'authority'
									? 403
									: failure === 'conflict'
										? 409
										: 503,
								'refused'
							)
						: new Error(
								failure === 'operation'
									? 'Expected a run root preparation response'
									: failure === 'unsupported'
										? 'Recorded publication support changed during run root preparation'
										: failure === 'name'
											? 'Run root preparation returned a different root name'
											: 'credential provider failed'
							);
			const f = fixture((request) => {
				calls.push(structuredClone(request));
				if (request.operation === 'lookup') {
					return {
						operation: 'lookup',
						supported: true,
						output: {
							entries: [
								{
									kind: 'recorded',
									publication: publication(),
									complete: true
								},
								{ kind: 'unavailable', storePath: sibling }
							]
						}
					};
				}
				if (request.operation !== 'prepare-run-root') {
					throw new Error('No materialisation after failed preparation');
				}
				if (failure === 'operation') {
					return { operation: 'capture', supported: false };
				}
				if (failure === 'unsupported') {
					return { operation: 'prepare-run-root', supported: false };
				}
				if (failure === 'name') {
					return {
						operation: 'prepare-run-root',
						supported: true,
						output: { name: rootNameSchema.parse('other') }
					};
				}
				throw cause;
			});
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-prepare-failure-')
			);
			directories.push(directory);
			const receiptFile = path.join(directory, 'receipt.json');
			const runRoot = {
				name: rootNameSchema.parse('run/123'),
				retention: { kind: 'permanent' as const }
			};
			const options: BuildPushRunOptions = {
				...f.options,
				invocation: {
					kind: 'constructed',
					build: { installables: [app, sibling] }
				},
				root: rootNameSchema.parse('main'),
				runRoot,
				receiptFile
			};
			await expect(
				runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
			).rejects.toEqual(
				failure === 'cancel'
					? cause
					: new BuildPublicationFailedError(
							[],
							failure === 'authority' ? 77 : failure === 'temporary' ? 75 : 74,
							{ cause }
						)
			);
			expect(calls).toEqual([
				{
					operation: 'lookup',
					input: {
						source: defaultSource,
						results: [{ storePath: app }, { storePath: sibling }]
					}
				},
				{ operation: 'prepare-run-root', input: runRoot }
			]);
			expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual({
				version: 4,
				paths: [],
				subjects: [],
				childExitStatus: 0,
				publicationSets: [],
				terminalFailure: { kind: 'command' },
				failed: [app, sibling]
			});
			expect(f.results).toEqual([
				{
					kind: 'build-summary-v4',
					title: 'Publication incomplete',
					rows: [],
					data: {
						mode: 'streamed',
						store: '/nix/store',
						targetPaths: 2,
						intermediatePaths: 0,
						queueDepth: 0,
						uploadedPaths: 0,
						skipped: 0,
						childExitStatus: 0,
						unconfirmedPaths: [app, sibling],
						version: 4,
						publicationSets: []
					}
				}
			]);
			expect(f.build).not.toHaveBeenCalled();
			expect(vi.mocked(f.dependencies.client).negotiate.mock.calls).toEqual([]);
			expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual([]);
			expect(f.dependencies.store.readDerivation).not.toHaveBeenCalled();
		}
	);

	it('uses the legacy selection once, captures only owned actual paths, and then reuses the first winner', async () => {
		let winner: ReturnType<typeof publication> | undefined;
		const calls: PublicationWorkflowRequest[] = [];
		const f = fixture((request) => {
			calls.push(request);
			switch (request.operation) {
				case 'lookup': {
					return {
						operation: 'lookup',
						supported: true,
						output: {
							entries: [
								winner === undefined
									? { kind: 'missing', result: publication().result }
									: { kind: 'recorded', publication: winner, complete: true }
							]
						}
					};
				}
				case 'capture': {
					winner = { ...publication(), origin: request.input.origin };
					return { operation: 'capture', supported: true, output: winner };
				}
				case 'prepare-run-root': {
					return {
						operation: 'prepare-run-root',
						supported: true,
						output: { name: request.input.name }
					};
				}
				case 'ensure': {
					return {
						operation: 'ensure',
						supported: true,
						output: { ...request.input.source, materialisation: 'complete' }
					};
				}
			}
		});
		f.receipt.subjects = f.receipt.subjects.map((subject) =>
			buildSubjectV3Schema.parse({
				origin: 'store-held',
				storePath: subject.storePath,
				narHash: subject.narHash,
				buildStore: 'auto'
			})
		);
		f.receipt.paths.push(sibling);
		await runRecordedBuildPush(f.options, f.reporter, f.dependencies, f.build);
		await runRecordedBuildPush(f.options, f.reporter, f.dependencies, f.build);
		expect(f.build).toHaveBeenCalledTimes(1);
		const captures = calls.filter((call) => call.operation === 'capture');
		expect(captures).toHaveLength(1);
		expect(captures[0]).toMatchObject({
			input: {
				origin: 'legacy-selection',
				members: [{ storePath: app }, { storePath: tool }]
			}
		});
	});

	it('captures a new build tool footprint without sibling or deliberately upstream artifacts', async () => {
		const captures: PublicationWorkflowRequest[] = [];
		const f = fixture((request) => {
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: { entries: [{ kind: 'unavailable', storePath: app }] }
				};
			}
			if (request.operation === 'capture') {
				captures.push(request);
				return { operation: 'capture', supported: true, output: publication() };
			}
			if (request.operation === 'prepare-run-root') {
				return {
					operation: 'prepare-run-root',
					supported: true,
					output: { name: request.input.name }
				};
			}
			return {
				operation: 'ensure',
				supported: true,
				output: { ...request.input.source, materialisation: 'complete' }
			};
		});
		f.receipt.paths.push(sibling);
		const result = await runRecordedBuildPush(
			f.options,
			f.reporter,
			f.dependencies,
			f.build
		);
		expect(captures[0]).toMatchObject({
			input: {
				origin: 'build-selection',
				members: [{ storePath: app }, { storePath: tool }]
			}
		});
		expect(result.paths).toEqual([app, tool, sibling]);
		expect(result.subjects).toEqual(f.receipt.subjects);
	});

	it('captures actual floating build-tool outputs without resolving their paths before the build', async () => {
		const captures: PublicationWorkflowRequest[] = [];
		const f = fixture((request) => {
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: { entries: [{ kind: 'unavailable', storePath: app }] }
				};
			}
			if (request.operation === 'capture') {
				captures.push(request);
				return { operation: 'capture', supported: true, output: publication() };
			}
			if (request.operation === 'prepare-run-root') {
				return {
					operation: 'prepare-run-root',
					supported: true,
					output: { name: request.input.name }
				};
			}
			return {
				operation: 'ensure',
				supported: true,
				output: { ...request.input.source, materialisation: 'complete' }
			};
		});
		f.graph.set(
			toolDrv,
			Derivation.parse(
				'Derive([("out","","","")],[],[],"x86_64-linux","/bin/sh",[],[])'
			)
		);
		await runRecordedBuildPush(f.options, f.reporter, f.dependencies, f.build);
		expect(captures[0]).toMatchObject({
			input: { members: [{ storePath: app }, { storePath: tool }] }
		});
	});

	it.each([undefined, [tool]])(
		'splits a mixed multi-output selection and never enumerates the warm members (intermediates: %j)',
		async (intermediatePaths) => {
			const calls: PublicationWorkflowRequest[] = [];
			const f = fixture((request) => {
				calls.push(request);
				if (request.operation === 'lookup') {
					return {
						operation: 'lookup',
						supported: true,
						output: {
							entries: [
								{
									kind: 'recorded',
									publication: publication(app, 50),
									complete: true
								},
								{ kind: 'unavailable', storePath: sibling }
							]
						}
					};
				}
				if (request.operation === 'capture') {
					return {
						operation: 'capture',
						supported: true,
						output: publication(sibling, 50)
					};
				}
				if (request.operation === 'prepare-run-root') {
					return {
						operation: 'prepare-run-root',
						supported: true,
						output: { name: request.input.name }
					};
				}
				return {
					operation: 'ensure',
					supported: true,
					output: { ...request.input.source, materialisation: 'complete' }
				};
			});
			const { publicationScope: _scope, ...unscoped } = f.options;
			f.graph.set(appDrv, derivation([app, sibling]));
			f.build.mockImplementation(async (options, _reporter, dependencies) => {
				expect(options.invocation).toEqual({
					kind: 'constructed',
					build: { installables: [`${appDrv}^dev`] }
				});
				expect(options.intermediatePaths).toEqual(intermediatePaths);
				await dependencies.settledTargets?.([sibling]);
				return buildReceiptV3Schema.parse({
					version: 3,
					paths: [sibling],
					subjects: []
				});
			});
			const receipt = await runRecordedBuildPush(
				{
					...unscoped,
					...(intermediatePaths !== undefined && { intermediatePaths }),
					invocation: {
						kind: 'constructed',
						build: { installables: [`${appDrv}^out,dev`] }
					}
				},
				f.reporter,
				f.dependencies,
				f.build
			);
			expect(receipt).toMatchObject({
				version: 4,
				paths: [sibling],
				subjects: [],
				publicationSets: [{ memberCount: 50 }, { memberCount: 50 }]
			});
			expect(
				calls.filter((call) => call.operation === 'capture')
			).toMatchObject([{ input: { members: [{ storePath: sibling }] } }]);
			expect(f.results[0]?.data).toMatchObject({
				uploadedPaths: 0,
				skipped: 0
			});
		}
	);

	it('does not claim success after capture without a successful ensure and reuses the restart ID', async () => {
		const ids: string[] = [];
		const f = fixture((request) => {
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: {
						entries: [
							{ kind: 'recorded', publication: publication(), complete: false }
						]
					}
				};
			}
			if (request.operation === 'ensure') {
				ids.push(request.input.requestId ?? '');
				throw new Error('stale source');
			}
			throw new Error('Unexpected capture');
		});
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-recorded-build-')
		);
		directories.push(directory);
		const options = {
			...f.options,
			receiptFile: path.join(directory, 'receipt.json')
		};
		await expect(
			runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
		).rejects.toBeInstanceOf(BuildPublicationFailedError);
		await expect(
			runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
		).rejects.toBeInstanceOf(BuildPublicationFailedError);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[0]).not.toBe('');
		expect(
			JSON.parse(
				await readFile(
					`${options.receiptFile}.publication-requests.json`,
					'utf8'
				)
			)
		).toBeTypeOf('object');
		expect(f.results).toHaveLength(2);
		expect(
			f.results.every(
				(result) =>
					result.kind === 'build-summary-v4' &&
					result.title === 'Publication incomplete'
			)
		).toBe(true);
	});

	it('does not emit a legacy success summary when capture succeeded but ensure failed', async () => {
		const f = fixture((request) => {
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: { entries: [{ kind: 'unavailable', storePath: app }] }
				};
			}
			if (request.operation === 'capture') {
				return { operation: 'capture', supported: true, output: publication() };
			}
			throw new Error('ensure failed');
		});
		f.build.mockImplementation(async (_options, reporter, dependencies) => {
			await dependencies.settledTargets?.([app]);
			reporter.result({
				kind: 'build-summary',
				title: 'Success',
				rows: [],
				data: {
					mode: 'streamed',
					store: '/nix/store',
					targetPaths: 1,
					intermediatePaths: 1,
					queueDepth: 0,
					uploadedPaths: 2,
					skipped: 0,
					childExitStatus: 0,
					unconfirmedPaths: []
				}
			});
			return f.receipt;
		});
		await expect(
			runRecordedBuildPush(f.options, f.reporter, f.dependencies, f.build)
		).rejects.toBeInstanceOf(BuildPublicationFailedError);
		expect(
			f.results.filter((result) => result.kind === 'build-summary')
		).toEqual([]);
	});

	it('preserves V4 warm materialisations alongside a partial child-failure receipt', async () => {
		const f = fixture((request) => {
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: {
						entries: [
							{ kind: 'recorded', publication: publication(), complete: true }
						]
					}
				};
			}
			if (request.operation === 'ensure') {
				return {
					operation: 'ensure',
					supported: true,
					output: { ...request.input.source, materialisation: 'complete' }
				};
			}
			throw new Error('No capture');
		});
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-partial-recorded-build-')
		);
		directories.push(directory);
		const receiptFile = path.join(directory, 'receipt.json');
		const failure = new BuildCommandFailedError(42, undefined, 42);
		f.build.mockImplementation(async (_options, reporter) => {
			await writeFile(
				receiptFile,
				JSON.stringify({
					version: 3,
					paths: [tool],
					subjects: [],
					childExitStatus: 42,
					terminalFailure: { kind: 'target-build', failedTargets: ['.#bad'] },
					failed: []
				})
			);
			reporter.result({
				kind: 'build-summary',
				rows: [],
				data: {
					mode: 'streamed',
					store: '/nix/store',
					targetPaths: 1,
					intermediatePaths: 0,
					queueDepth: 0,
					uploadedPaths: 1,
					skipped: 0,
					childExitStatus: 42,
					unconfirmedPaths: []
				}
			});
			throw failure;
		});
		const options: BuildPushRunOptions = {
			...f.options,
			receiptFile,
			invocation: {
				kind: 'constructed',
				build: { installables: [`${appDrv}^out`, '.#bad'] }
			}
		};
		await expect(
			runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
		).rejects.toBe(failure);
		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toMatchObject({
			version: 4,
			paths: [tool],
			subjects: [],
			childExitStatus: 42,
			publicationSets: [{ memberCount: 2 }],
			terminalFailure: { kind: 'target-build', failedTargets: ['.#bad'] }
		});
		expect(f.results[0]).toMatchObject({
			kind: 'build-summary-v4',
			data: { childExitStatus: 42, publicationSets: [{ memberCount: 2 }] }
		});
	});

	it('keeps genuine old-server fallback and propagates stale lookup errors instead of downgrading', async () => {
		const f = fixture(() => ({ operation: 'lookup', supported: false }));
		expect(
			await runRecordedBuildPush(f.options, f.reporter, f.dependencies, f.build)
		).toBe(f.receipt);
		expect(f.build).toHaveBeenCalledTimes(1);
		const staleDependencies = {
			...f.dependencies,
			publicationWorkflow: {
				execute: () => {
					throw new Error('stale view');
				}
			}
		};
		await expect(
			runRecordedBuildPush(f.options, f.reporter, staleDependencies, f.build)
		).rejects.toThrow('stale view');
		expect(f.build).toHaveBeenCalledTimes(1);
	});

	it('leaves floating and unknown outputs on the normal build path and preserves child failure', async () => {
		const f = fixture(() => {
			throw new Error('No lookup');
		});
		f.graph.set(
			appDrv,
			Derivation.parse(
				'Derive([("out","","","")],[],[],"x86_64-linux","/bin/sh",[],[])'
			)
		);
		const failure = new BuildCommandFailedError(42, undefined, 42);
		f.build.mockRejectedValue(failure);
		await expect(
			runRecordedBuildPush(f.options, f.reporter, f.dependencies, f.build)
		).rejects.toBe(failure);
		expect(f.build).toHaveBeenCalledTimes(1);
	});
});

it('persists completed warm evidence when a subsequent warm ensure fails before the cold builder', async () => {
	const f = fixture((request) => {
		if (request.operation === 'lookup') {
			return {
				operation: 'lookup',
				supported: true,
				output: {
					entries: [app, sibling].map((target) => ({
						kind: 'recorded',
						publication: publication(target),
						complete: true
					}))
				}
			};
		}
		if (
			request.operation === 'ensure' &&
			request.input.source.result.storePath === app
		) {
			return {
				operation: 'ensure',
				supported: true,
				output: { ...request.input.source, materialisation: 'complete' }
			};
		}
		throw new Error('second ensure failed');
	});
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-warm-partial-')
	);
	directories.push(directory);
	const receiptFile = path.join(directory, 'receipt.json');
	await writeFile(
		receiptFile,
		JSON.stringify({
			version: 3,
			paths: [upstream],
			subjects: [],
			childExitStatus: 42
		})
	);
	await expect(
		runRecordedBuildPush(
			{
				...f.options,
				receiptFile,
				invocation: {
					kind: 'constructed',
					build: { installables: [app, sibling, '.#cold'] }
				}
			},
			f.reporter,
			f.dependencies,
			f.build
		)
	).rejects.toBeInstanceOf(BuildPublicationFailedError);
	expect(f.build).not.toHaveBeenCalled();
	expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toMatchObject({
		version: 4,
		paths: [],
		childExitStatus: 0,
		publicationSets: [{ result: { storePath: app } }],
		failed: [sibling],
		terminalFailure: { kind: 'command' }
	});
	expect(f.results).toHaveLength(1);
	expect(f.results[0]).toMatchObject({
		kind: 'build-summary-v4',
		data: { publicationSets: [{ result: { storePath: app } }] }
	});
});

it('marks a final named-root failure as a durable command failure even after every ensure succeeds', async () => {
	const f = fixture((request) => {
		if (request.operation === 'lookup') {
			return {
				operation: 'lookup',
				supported: true,
				output: {
					entries: [
						{ kind: 'recorded', publication: publication(), complete: true }
					]
				}
			};
		}
		if (request.operation === 'ensure') {
			return {
				operation: 'ensure',
				supported: true,
				output: { ...request.input.source, materialisation: 'complete' }
			};
		}
		throw new Error('Unexpected capture');
	});
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-root-partial-')
	);
	directories.push(directory);
	const receiptFile = path.join(directory, 'receipt.json');
	vi.mocked(f.dependencies.client).setRoot.mockRejectedValue(
		new Error('root failed')
	);
	await expect(
		runRecordedBuildPush(
			{ ...f.options, root: rootNameSchema.parse('main'), receiptFile },
			f.reporter,
			f.dependencies,
			f.build
		)
	).rejects.toBeInstanceOf(BuildPublicationFailedError);
	expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toMatchObject({
		version: 4,
		childExitStatus: 0,
		failed: [],
		publicationSets: [{ memberCount: 2 }],
		terminalFailure: { kind: 'command' }
	});
});

it('replays a captured cold selection after an ensure reply is lost without rebuilding or recapturing a different footprint', async () => {
	const calls: PublicationWorkflowRequest[] = [];
	let ensures = 0;
	const f = fixture((request) => {
		calls.push(request);
		if (request.operation === 'lookup') {
			return {
				operation: 'lookup',
				supported: true,
				output: { entries: [{ kind: 'unavailable', storePath: app }] }
			};
		}
		if (request.operation === 'capture') {
			return { operation: 'capture', supported: true, output: publication() };
		}
		if (request.operation === 'ensure') {
			if (++ensures === 1) {
				throw new Error('lost successful ensure reply');
			}
			return {
				operation: 'ensure',
				supported: true,
				output: { ...request.input.source, materialisation: 'complete' }
			};
		}
		throw new Error('Unexpected operation');
	});
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-capture-recovery-')
	);
	directories.push(directory);
	const options = {
		...f.options,
		receiptFile: path.join(directory, 'receipt.json')
	};
	await expect(
		runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
	).rejects.toBeInstanceOf(BuildPublicationFailedError);
	const originalSubjects = structuredClone(f.receipt.subjects);
	f.receipt.paths.length = 0;
	f.receipt.subjects.length = 0;
	f.graph.clear();
	const receipt = await runRecordedBuildPush(
		options,
		f.reporter,
		f.dependencies,
		f.build
	);
	expect(f.build).toHaveBeenCalledTimes(1);
	expect(receipt.paths).toEqual([app, tool]);
	expect(receipt.subjects).toEqual(originalSubjects);
	expect(calls.filter((call) => call.operation === 'lookup')).toHaveLength(1);
	const captures = calls.filter((call) => call.operation === 'capture');
	const requests = calls.filter((call) => call.operation === 'ensure');
	expect(captures).toHaveLength(2);
	expect(captures[1]).toEqual(captures[0]);
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEqual(requests[0]);
});

it.each([
	'GITHUB_RUN_ID',
	'GITHUB_RUN_ATTEMPT',
	'GITHUB_SHA',
	'GITHUB_REPOSITORY'
])(
	'refuses standalone cold snapshot recovery after %s changes',
	async (name) => {
		const calls: PublicationWorkflowRequest[] = [];
		const f = fixture((request) => {
			calls.push(request);
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: { entries: [{ kind: 'unavailable', storePath: app }] }
				};
			}
			if (request.operation === 'capture') {
				return { operation: 'capture', supported: true, output: publication() };
			}
			throw new Error('ensure interrupted');
		});
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-identity-'));
		directories.push(directory);
		const options = {
			...f.options,
			receiptFile: path.join(directory, 'receipt.json')
		};
		const environment = {
			GITHUB_RUN_ID: '123',
			GITHUB_RUN_ATTEMPT: '1',
			GITHUB_SHA: 'a'.repeat(40),
			GITHUB_REPOSITORY: 'acme/app'
		};
		await expect(
			runRecordedBuildPush(
				options,
				f.reporter,
				{ ...f.dependencies, environment },
				f.build
			)
		).rejects.toBeInstanceOf(BuildPublicationFailedError);
		const journalFile = `${options.receiptFile}.publication-requests.json`;
		const journal = await readFile(journalFile, 'utf8');
		const before = structuredClone(calls);
		f.build.mockRejectedValue(new Error('builder forbidden during recovery'));
		await expect(
			runRecordedBuildPush(
				options,
				f.reporter,
				{
					...f.dependencies,
					environment: { ...environment, [name]: 'changed' }
				},
				f.build
			)
		).rejects.toThrow('different invocation');
		expect(calls).toEqual(before);
		expect(await readFile(journalFile, 'utf8')).toBe(journal);
		expect(f.build).toHaveBeenCalledTimes(1);
	}
);

it.each(['constructed', 'command', 'forced'])(
	'saves an all-cold %s build before replacing the target root and recovers with the builder forbidden',
	async (kind) => {
		const calls: PublicationWorkflowRequest[] = [];
		const f = fixture((request) => {
			calls.push(request);
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: { entries: [{ kind: 'unavailable', storePath: app }] }
				};
			}
			if (request.operation === 'capture') {
				return { operation: 'capture', supported: true, output: publication() };
			}
			if (request.operation === 'ensure') {
				return {
					operation: 'ensure',
					supported: true,
					output: { ...request.input.source, materialisation: 'complete' }
				};
			}
			throw new Error('Unexpected operation');
		});
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-cold-root-'));
		directories.push(directory);
		const options = {
			...f.options,
			root: rootNameSchema.parse('main'),
			retention: {
				kind: 'duration' as const,
				seconds: ttlSecondsSchema.parse(123)
			},
			receiptFile: path.join(directory, 'receipt.json')
		};
		if (kind === 'command') {
			options.invocation = {
				kind: 'command',
				command: ['nix', 'build', '.#app']
			};
		} else if (kind === 'forced') {
			options.invocation = {
				kind: 'constructed',
				build: { installables: [`${appDrv}^out`], requireProvenance: true }
			};
		}
		const original = structuredClone(f.receipt);
		const build = vi.fn(
			async (
				options_: BuildPushRunOptions,
				_reporter: Reporter,
				dependencies: BuildPushDependencies
			) => {
				if (options_.root !== undefined) {
					await dependencies.client.setRoot(options_.root, {
						targets: [app],
						retention: options_.retention ?? { kind: 'inherit' }
					});
				}
				await dependencies.settledTargets?.([app]);
				return f.receipt;
			}
		);
		vi.mocked(f.dependencies.client).setRoot.mockImplementationOnce(
			async () => {
				const journal: unknown = JSON.parse(
					await readFile(
						`${options.receiptFile}.publication-requests.json`,
						'utf8'
					)
				);
				expect(journal).toHaveProperty('snapshots.build.receipt', original);
				expect(calls.map((request) => request.operation)).toEqual([
					'lookup',
					'capture',
					'ensure'
				]);
				throw new Error('root interrupted');
			}
		);
		await expect(
			runRecordedBuildPush(options, f.reporter, f.dependencies, build)
		).rejects.toBeInstanceOf(BuildPublicationFailedError);
		build.mockRejectedValue(new Error('builder forbidden during recovery'));
		f.graph.clear();
		const result = await runRecordedBuildPush(
			options,
			f.reporter,
			f.dependencies,
			build
		);
		expect(result).toEqual({
			...original,
			version: 4,
			publicationSets: [{ ...publication(), materialisation: 'complete' }]
		});
		expect(build).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual([
			['main', { targets: [app], retention: options.retention }],
			['main', { targets: [app], retention: options.retention }]
		]);
		const captures = calls.filter((request) => request.operation === 'capture');
		const ensures = calls.filter((request) => request.operation === 'ensure');
		expect(captures[1]).toEqual(captures[0]);
		expect(ensures[1]).toEqual(ensures[0]);
	}
);

it.each(['warm-ensure', 'child', 'cold-ensure', 'root'])(
	'accounts for the entire deduplicated mixed selection on %s failure',
	async (step) => {
		const f = fixture((request) => {
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: {
						entries: [
							{ kind: 'recorded', publication: publication(), complete: true },
							{ kind: 'unavailable', storePath: sibling }
						]
					}
				};
			}
			if (request.operation === 'capture') {
				return {
					operation: 'capture',
					supported: true,
					output: publication(sibling)
				};
			}
			if (request.operation === 'ensure') {
				if (
					step === 'warm-ensure' ||
					(step === 'cold-ensure' &&
						request.input.source.result.storePath === sibling)
				) {
					throw new Error('ensure interrupted');
				}
				return {
					operation: 'ensure',
					supported: true,
					output: { ...request.input.source, materialisation: 'complete' }
				};
			}
			throw new Error('Unexpected operation');
		});
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-mixed-failure-')
		);
		directories.push(directory);
		const receiptFile = path.join(directory, 'receipt.json');
		f.build.mockImplementation(async (_options, reporter, dependencies) => {
			reporter.result({
				kind: 'build-summary',
				title: 'Build',
				rows: [],
				data: {
					mode: 'streamed',
					store: '/nix/store',
					targetPaths: 1,
					intermediatePaths: 0,
					queueDepth: 0,
					uploadedPaths: 0,
					skipped: 1,
					childExitStatus: step === 'child' ? 42 : 0,
					unconfirmedPaths: []
				}
			});
			const receipt = buildReceiptV3Schema.parse({
				version: 3,
				paths: [sibling],
				subjects: [],
				childExitStatus: step === 'child' ? 42 : 0
			});
			if (step === 'child') {
				await writeFile(receiptFile, JSON.stringify(receipt));
				throw new BuildCommandFailedError(42, undefined, 42);
			}
			await dependencies.settledTargets?.([sibling]);
			return receipt;
		});
		if (step === 'root') {
			vi.mocked(f.dependencies.client).setRoot.mockRejectedValue(
				new Error('root interrupted')
			);
		}
		await expect(
			runRecordedBuildPush(
				{
					...f.options,
					receiptFile,
					root: rootNameSchema.parse('main'),
					invocation: {
						kind: 'constructed',
						build: { installables: [app, `${appDrv}^out`, sibling, sibling] }
					}
				},
				f.reporter,
				f.dependencies,
				f.build
			)
		).rejects.toBeInstanceOf(
			step === 'child' ? BuildCommandFailedError : BuildPublicationFailedError
		);
		const publicationSets =
			step === 'warm-ensure'
				? []
				: [
						{ ...publication(), materialisation: 'complete' },
						...(step === 'root'
							? [{ ...publication(sibling), materialisation: 'complete' }]
							: [])
					];
		expect(f.results.map((result) => result.data)).toEqual([
			{
				mode: 'streamed',
				store: '/nix/store',
				targetPaths: 2,
				intermediatePaths: 0,
				queueDepth: 0,
				uploadedPaths: 0,
				skipped: step === 'warm-ensure' ? 0 : 1,
				childExitStatus: step === 'child' ? 42 : 0,
				unconfirmedPaths:
					step === 'warm-ensure'
						? [app, sibling]
						: step === 'root'
							? []
							: [sibling],
				version: 4,
				publicationSets
			}
		]);
	}
);

it.each(['ensure', 'root'] as const)(
	'keeps persisted upstream exclusions out of %s failure and recovery',
	async (failure) => {
		const calls: PublicationWorkflowRequest[] = [];
		let isInterrupted = true;
		const f = fixture((request) => {
			calls.push(structuredClone(request));
			if (request.operation === 'lookup') {
				return {
					operation: 'lookup',
					supported: true,
					output: {
						entries: [app, sibling].map((storePath) => ({
							kind: 'unavailable',
							storePath
						}))
					}
				};
			}
			if (request.operation === 'capture') {
				return { operation: 'capture', supported: true, output: publication() };
			}
			if (request.operation === 'ensure') {
				if (failure === 'ensure' && isInterrupted) {
					throw new Error('ensure interrupted');
				}
				return {
					operation: 'ensure',
					supported: true,
					output: { ...request.input.source, materialisation: 'complete' }
				};
			}
			throw new Error('Unexpected operation');
		});
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-upstream-recovery-')
		);
		directories.push(directory);
		const receiptFile = path.join(directory, 'receipt.json');
		const options: BuildPushRunOptions = {
			...f.options,
			invocation: {
				kind: 'constructed',
				build: { installables: [`${appDrv}^out`, sibling] }
			},
			root: rootNameSchema.parse('main'),
			retention: { kind: 'duration', seconds: ttlSecondsSchema.parse(123) },
			receiptFile
		};
		const original = { ...structuredClone(f.receipt), leftUpstream: [sibling] };
		const coldSummary = {
			mode: 'streamed',
			store: '/nix/store',
			targetPaths: 2,
			intermediatePaths: 1,
			queueDepth: 1,
			uploadedPaths: 2,
			skipped: 0,
			childExitStatus: 0,
			unconfirmedPaths: []
		};
		f.build.mockImplementation(async (_options, reporter, dependencies) => {
			await dependencies.settledTargets?.([app]);
			reporter.result({
				kind: 'build-summary',
				title: 'Build',
				rows: [],
				data: coldSummary
			});
			return original;
		});
		let rootTargets = [upstream];
		vi.mocked(f.dependencies.client).setRoot.mockImplementation(
			(_name, body) => {
				if (failure === 'root' && isInterrupted) {
					return Promise.reject(new Error('root interrupted'));
				}
				rootTargets = body.targets.map((target) =>
					storePathSchema.parse(target)
				);
				return Promise.resolve({
					name: rootNameSchema.parse('main'),
					targets: [],
					expired: false,
					createdAt: '2026-07-31T00:00:00.000Z',
					updatedAt: '2026-07-31T00:00:00.000Z'
				});
			}
		);
		await expect(
			runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
		).rejects.toBeInstanceOf(BuildPublicationFailedError);
		const publicationSets =
			failure === 'root'
				? [{ ...publication(), materialisation: 'complete' }]
				: [];
		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual({
			...original,
			version: 4,
			publicationSets,
			terminalFailure: { kind: 'command' },
			failed: failure === 'ensure' ? [app] : []
		});
		expect(f.results).toEqual([
			{
				kind: 'build-summary-v4',
				title: 'Publication incomplete',
				rows: [],
				data: {
					...coldSummary,
					version: 4,
					publicationSets,
					unconfirmedPaths: failure === 'ensure' ? [app] : []
				}
			}
		]);
		expect(rootTargets).toEqual([upstream]);
		expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual(
			failure === 'root'
				? [['main', { targets: [app], retention: options.retention }]]
				: []
		);
		const journalFile = `${receiptFile}.publication-requests.json`;
		const journal = await readFile(journalFile, 'utf8');
		const saved: unknown = JSON.parse(journal);
		expect(saved).toHaveProperty('snapshots.build', {
			receipt: original,
			targets: [app],
			captures: [
				{
					result: { storePath: app, narHash: hash.toString() },
					members: [app, tool].map((storePath) => ({
						storePath,
						narHash: hash.toString()
					})),
					origin: 'build-selection'
				}
			],
			recorded: [],
			supported: true,
			summary: coldSummary
		});
		const expected = structuredClone(original);
		original.paths.length = 0;
		original.subjects.length = 0;
		original.leftUpstream.length = 0;
		f.graph.clear();
		f.build.mockRejectedValue(new Error('builder forbidden during recovery'));
		isInterrupted = false;
		const result = await runRecordedBuildPush(
			options,
			f.reporter,
			f.dependencies,
			f.build
		);
		const complete = {
			...expected,
			version: 4,
			publicationSets: [{ ...publication(), materialisation: 'complete' }]
		};
		expect(result).toEqual(complete);
		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual(complete);
		expect(f.results).toEqual([
			{
				kind: 'build-summary-v4',
				title: 'Publication incomplete',
				rows: [],
				data: {
					...coldSummary,
					version: 4,
					publicationSets,
					unconfirmedPaths: failure === 'ensure' ? [app] : []
				}
			},
			{
				kind: 'build-summary-v4',
				title: 'Build and publication result',
				rows: [],
				data: {
					...coldSummary,
					version: 4,
					publicationSets: complete.publicationSets
				}
			}
		]);
		expect(rootTargets).toEqual([app]);
		expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual(
			Array.from({ length: failure === 'root' ? 2 : 1 }, () => [
				'main',
				{ targets: [app], retention: options.retention }
			])
		);
		expect(await readFile(journalFile, 'utf8')).toBe(journal);
		expect(f.build).toHaveBeenCalledTimes(1);
		for (const operation of ['capture', 'ensure']) {
			const requests = calls.filter(
				(request) => request.operation === operation
			);
			expect(requests).toHaveLength(2);
			expect(requests[1]).toEqual(requests[0]);
		}
	}
);

it.each([
	{ view: false, interrupted: false },
	{ view: true, interrupted: false },
	{ view: false, interrupted: true },
	{ view: true, interrupted: true }
])(
	'reconciles an unresolved alias with a completed foreign warm result (view: $view, interrupted: $interrupted)',
	async ({ view, interrupted }) => {
		const source = recordedPublicationSchema.parse({
			...publication(app, 1),
			result: {
				...publication().result,
				cache: { kind: 'named', name: 'source' }
			}
		});
		const completed = {
			...publication(app, 1),
			materialisation: 'complete' as const
		};
		const selector = publicationSourceSelectorSchema.parse({
			view: 'release',
			expectedRevision: 3
		});
		const foreignSource = view
			? { selector: { view: selector.view } }
			: { cache: source.result.cache };
		const calls: PublicationWorkflowRequest[] = [];
		let destination: typeof completed | undefined;
		const runTargets = new Set<StorePathString>([upstream]);
		const f = fixture((request) => {
			calls.push(structuredClone(request));
			if (request.operation === 'prepare-run-root') {
				return {
					operation: 'prepare-run-root',
					supported: true,
					output: { name: request.input.name }
				};
			}
			if (request.operation === 'lookup') {
				const isDestination = request.input.source.cache?.kind === 'default';
				return {
					operation: 'lookup',
					supported: true,
					output: {
						entries: [
							isDestination && destination === undefined
								? { kind: 'unavailable', storePath: app }
								: {
										kind: 'recorded',
										publication: isDestination ? publication(app, 1) : source,
										complete: true
									}
						],
						...(!isDestination && view && { sourceSelector: selector })
					}
				};
			}
			if (request.operation === 'capture') {
				if (destination === undefined) {
					throw new Error('Warm ensure must materialise the destination first');
				}
				// A real capture returns the destination's first complete association,
				// not the foreign source identity used by the immutable ensure.
				return {
					operation: 'capture',
					supported: true,
					output: publication(app, 1)
				};
			}
			expect(request.input.source).toEqual(source);
			destination = completed;
			runTargets.add(app);
			return { operation: 'ensure', supported: true, output: completed };
		});
		const aggregateTargets = vi.fn();
		f.dependencies = {
			...f.dependencies,
			publicationSources: [defaultSource, foreignSource],
			settledTargets: aggregateTargets
		};
		const coldSummary = {
			mode: 'streamed',
			store: '/nix/store',
			targetPaths: 1,
			intermediatePaths: 1,
			queueDepth: 0,
			uploadedPaths: 0,
			skipped: 2,
			childExitStatus: 0,
			unconfirmedPaths: []
		};
		const original = structuredClone(f.receipt);
		f.build.mockImplementation(async (options, reporter, dependencies) => {
			expect(options.invocation).toEqual({
				kind: 'constructed',
				build: { installables: ['.#app'] }
			});
			expect(options.root).toBeUndefined();
			expect(destination).toEqual(completed);
			await dependencies.settledTargets?.([app]);
			reporter.result({ kind: 'build-summary', rows: [], data: coldSummary });
			return f.receipt;
		});
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-alias-recovery-')
		);
		directories.push(directory);
		const receiptFile = path.join(directory, 'receipt.json');
		const options: BuildPushRunOptions = {
			...f.options,
			invocation: {
				kind: 'constructed',
				build: { installables: [`${appDrv}^out`, '.#app'] }
			},
			receiptFile,
			root: rootNameSchema.parse('main'),
			retention: { kind: 'duration', seconds: ttlSecondsSchema.parse(123) },
			runRoot: {
				name: rootNameSchema.parse('run/123'),
				retention: { kind: 'permanent' }
			}
		};
		let rootTargets = [upstream];
		let shouldInterrupt = interrupted;
		vi.mocked(f.dependencies.client).setRoot.mockImplementation(
			(_name, body) => {
				if (shouldInterrupt) {
					throw new Error('named root interrupted');
				}
				rootTargets = body.targets.map((target) =>
					storePathSchema.parse(target)
				);
				return Promise.resolve({
					name: rootNameSchema.parse('main'),
					targets: [],
					expired: false,
					createdAt: '2026-07-31T00:00:00.000Z',
					updatedAt: '2026-07-31T00:00:00.000Z'
				});
			}
		);
		const journalFile = `${receiptFile}.publication-requests.json`;
		let savedJournal: string | undefined;
		if (interrupted) {
			await expect(
				runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
			).rejects.toBeInstanceOf(BuildPublicationFailedError);
			expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual({
				...original,
				version: 4,
				publicationSets: [completed],
				terminalFailure: { kind: 'command' },
				failed: []
			});
			expect(f.results).toEqual([
				{
					kind: 'build-summary-v4',
					title: 'Publication incomplete',
					rows: [],
					data: { ...coldSummary, version: 4, publicationSets: [completed] }
				}
			]);
			expect(rootTargets).toEqual([upstream]);
			expect(aggregateTargets).not.toHaveBeenCalled();
			savedJournal = await readFile(journalFile, 'utf8');
			f.build.mockRejectedValue(new Error('No rebuild during recovery'));
			f.graph.clear();
			f.receipt.paths.length = 0;
			f.receipt.subjects.length = 0;
			shouldInterrupt = false;
		}
		const result = await runRecordedBuildPush(
			options,
			f.reporter,
			f.dependencies,
			f.build
		);
		const expected = { ...original, version: 4, publicationSets: [completed] };
		expect(result).toEqual(expected);
		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual(expected);
		expect(f.results.at(-1)).toEqual({
			kind: 'build-summary-v4',
			title: 'Build and publication result',
			rows: [],
			data: { ...coldSummary, version: 4, publicationSets: [completed] }
		});
		expect(rootTargets).toEqual([app]);
		expect([...runTargets]).toEqual([upstream, app]);
		expect(aggregateTargets.mock.calls).toEqual([[[app]]]);
		expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual(
			Array.from({ length: interrupted ? 2 : 1 }, () => [
				'main',
				{ targets: [app], retention: options.retention }
			])
		);
		expect(vi.mocked(f.dependencies.client).negotiate.mock.calls).toEqual([]);
		expect(
			calls.filter((request) => request.operation === 'prepare-run-root')
		).toEqual(
			Array.from({ length: interrupted ? 2 : 1 }, () => ({
				operation: 'prepare-run-root',
				input: options.runRoot
			}))
		);
		expect(calls.filter((request) => request.operation === 'lookup')).toEqual([
			{
				operation: 'lookup',
				input: { source: defaultSource, results: [{ storePath: app }] }
			},
			{
				operation: 'lookup',
				input: { source: foreignSource, results: [{ storePath: app }] }
			}
		]);
		expect(calls.filter((request) => request.operation === 'capture')).toEqual(
			[]
		);
		const ensures = calls.filter((request) => request.operation === 'ensure');
		const originalRequestId = ensures[0]?.input.requestId;
		expect(originalRequestId).toBeTypeOf('string');
		expect(originalRequestId).not.toBe('');
		expect(ensures).toEqual(
			Array.from({ length: interrupted ? 2 : 1 }, () => ({
				operation: 'ensure',
				input: {
					source,
					...(view && { sourceSelector: selector }),
					runRoot: options.runRoot?.name,
					requestId: originalRequestId
				}
			}))
		);
		if (interrupted) {
			expect(await readFile(journalFile, 'utf8')).toBe(savedJournal);
		}
		const journal: unknown = JSON.parse(await readFile(journalFile, 'utf8'));
		expect(journal).toHaveProperty('snapshots.build', {
			receipt: original,
			targets: [app],
			captures: [],
			recorded: [],
			supported: true,
			summary: coldSummary
		});
		expect(journal).toHaveProperty('intents', {
			[JSON.stringify(['ensure', app])]: ensures[0]
		});
		expect(f.build).toHaveBeenCalledTimes(1);
		expect(f.dependencies.targetDerivations).not.toHaveBeenCalled();
		expect(f.dependencies.store.readDerivation).toHaveBeenCalledTimes(1);
	}
);

it('does not reconcile a cold alias with a different NAR into the completed warm set', async () => {
	const source = recordedPublicationSchema.parse({
		...publication(),
		result: {
			...publication().result,
			cache: { kind: 'named', name: 'source' }
		}
	});
	const calls: PublicationWorkflowRequest[] = [];
	const f = fixture((request) => {
		calls.push(structuredClone(request));
		if (request.operation === 'lookup') {
			return {
				operation: 'lookup',
				supported: true,
				output: {
					entries: [
						request.input.source.cache?.kind === 'default'
							? { kind: 'unavailable', storePath: app }
							: { kind: 'recorded', publication: source, complete: true }
					]
				}
			};
		}
		if (request.operation === 'ensure') {
			return {
				operation: 'ensure',
				supported: true,
				output: { ...publication(), materialisation: 'complete' }
			};
		}
		throw new Error('Publication NAR divergence');
	});
	const aggregateTargets = vi.fn();
	f.dependencies = {
		...f.dependencies,
		publicationSources: [defaultSource, { cache: source.result.cache }],
		targetDerivations: vi.fn(() =>
			Promise.resolve(new Map([['.#app', [appDrv]]]))
		),
		settledTargets: aggregateTargets
	};
	const differentHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 2));
	f.receipt.subjects = f.receipt.subjects.map((subject) =>
		buildSubjectV3Schema.parse({
			...subject,
			narHash: differentHash.digestHex()
		})
	);
	await expect(
		runRecordedBuildPush(
			{
				...f.options,
				root: rootNameSchema.parse('main'),
				invocation: {
					kind: 'constructed',
					build: { installables: [`${appDrv}^out`, '.#app'] }
				}
			},
			f.reporter,
			f.dependencies,
			f.build
		)
	).rejects.toMatchObject({ cause: new Error('Publication NAR divergence') });
	expect(calls.map((request) => request.operation)).toEqual([
		'lookup',
		'lookup',
		'ensure',
		'capture'
	]);
	expect(calls.at(-1)).toMatchObject({
		operation: 'capture',
		input: {
			result: { storePath: app, narHash: differentHash.toString() },
			members: [app, tool].map((storePath) => ({
				storePath,
				narHash: differentHash.toString()
			}))
		}
	});
	expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual([]);
	expect(aggregateTargets).not.toHaveBeenCalled();
});

function concededAliasFixture(isView: boolean) {
	const source = recordedPublicationSchema.parse({
		...publication(),
		result: {
			...publication().result,
			cache: { kind: 'named', name: 'source' }
		}
	});
	const completed = {
		...publication(),
		materialisation: 'complete' as const
	};
	const selector = publicationSourceSelectorSchema.parse({
		view: 'release',
		expectedRevision: 3
	});
	const foreignSource = isView
		? { selector: { view: selector.view } }
		: { cache: source.result.cache };
	const calls: PublicationWorkflowRequest[] = [];
	let destination: typeof completed | undefined;
	const runTargets = new Set<StorePathString>([upstream]);
	const capture = vi.fn(() => publication());
	const ensure = vi.fn(() => completed);
	const f = fixture((request) => {
		calls.push(structuredClone(request));
		if (request.operation === 'prepare-run-root') {
			return {
				operation: 'prepare-run-root',
				supported: true,
				output: { name: request.input.name }
			};
		}
		if (request.operation === 'lookup') {
			const isDestination = request.input.source.cache?.kind === 'default';
			return {
				operation: 'lookup',
				supported: true,
				output: {
					entries: [
						isDestination && destination === undefined
							? { kind: 'unavailable', storePath: app }
							: {
									kind: 'recorded',
									publication: isDestination ? publication() : source,
									complete: true
								}
					],
					...(!isDestination && isView && { sourceSelector: selector })
				}
			};
		}
		if (request.operation === 'capture') {
			expect(destination).toEqual(completed);
			// Like publication-workflow.ts capture: resolve the accepted destination
			// and return its existing first-winner association, not local subjects.
			return { operation: 'capture', supported: true, output: capture() };
		}
		expect(request.input.source).toEqual(source);
		destination = ensure();
		runTargets.add(app);
		return { operation: 'ensure', supported: true, output: destination };
	});
	const aggregateTargets = vi.fn();
	f.dependencies = {
		...f.dependencies,
		publicationSources: [defaultSource, foreignSource],
		settledTargets: aggregateTargets,
		targetDerivations: vi.fn(() =>
			Promise.resolve(new Map([['.#app', [appDrv]]]))
		)
	};
	// Exact concession outcome from reconcile.test.ts: destination copy whose
	// NAR differs from the build output. Divergent local subjects are omitted.
	const conceded = buildReceiptV3Schema.parse({
		version: 3,
		paths: [app],
		subjects: [],
		outcomes: [{ outcome: 'destination-served', storePath: app }],
		uploaded: [],
		failed: [],
		collected: []
	});
	const coldSummary = {
		mode: 'streamed',
		store: '/nix/store',
		targetPaths: 1,
		intermediatePaths: 0,
		queueDepth: 0,
		uploadedPaths: 0,
		skipped: 1,
		childExitStatus: 0,
		unconfirmedPaths: []
	};
	f.build.mockImplementation(async (options, reporter, dependencies) => {
		expect(options.invocation).toEqual({
			kind: 'constructed',
			build: { installables: ['.#app'] }
		});
		expect(options.root).toBeUndefined();
		await dependencies.settledTargets?.([app]);
		reporter.result({ kind: 'build-summary', rows: [], data: coldSummary });
		return conceded;
	});
	const options: BuildPushRunOptions = {
		...f.options,
		invocation: {
			kind: 'constructed',
			build: { installables: [`${appDrv}^out`, '.#app'] }
		},
		root: rootNameSchema.parse('main'),
		retention: { kind: 'duration', seconds: ttlSecondsSchema.parse(123) },
		runRoot: {
			name: rootNameSchema.parse('run/123'),
			retention: { kind: 'permanent' }
		}
	};
	return {
		...f,
		options,
		source,
		completed,
		selector,
		foreignSource,
		calls,
		conceded,
		coldSummary,
		aggregateTargets,
		runTargets,
		capture,
		ensure
	};
}

it.each(
	[false, true].flatMap((view) =>
		(['none', 'root', 'capture', 'ensure'] as const).map((failure) => ({
			view,
			failure
		}))
	)
)(
	'reconciles a subjectless conceded alias without replacing its foreign intent (view: $view, interruption: $failure)',
	async ({ view, failure }) => {
		const f = concededAliasFixture(view);
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-conceded-alias-')
		);
		directories.push(directory);
		const receiptFile = path.join(directory, 'receipt.json');
		const options = { ...f.options, receiptFile };
		let rootTargets = [upstream];
		let shouldInterrupt = failure !== 'none';
		vi.mocked(f.dependencies.client).setRoot.mockImplementation(
			(_name, body) => {
				if (shouldInterrupt && failure === 'root') {
					throw new Error('named root interrupted');
				}
				rootTargets = body.targets.map((target) =>
					storePathSchema.parse(target)
				);
				return Promise.resolve({
					name: rootNameSchema.parse('main'),
					targets: [],
					expired: false,
					createdAt: '2026-07-31T00:00:00.000Z',
					updatedAt: '2026-07-31T00:00:00.000Z'
				});
			}
		);
		if (failure === 'capture') {
			f.capture.mockImplementationOnce(() => {
				throw new Error('capture interrupted');
			});
		} else if (failure === 'ensure') {
			f.ensure
				.mockImplementationOnce(() => f.completed)
				.mockImplementationOnce(() => {
					throw new Error('ensure interrupted');
				});
		}
		const journalFile = `${receiptFile}.publication-requests.json`;
		let savedJournal: string | undefined;
		const expected = {
			...f.conceded,
			version: 4,
			publicationSets: [f.completed]
		};
		const summary = {
			...f.coldSummary,
			version: 4,
			publicationSets: [f.completed]
		};
		if (failure !== 'none') {
			await expect(
				runRecordedBuildPush(options, f.reporter, f.dependencies, f.build)
			).rejects.toMatchObject({
				cause: new Error(
					`${failure === 'root' ? 'named root' : failure} interrupted`
				)
			});
			expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual({
				...expected,
				terminalFailure: { kind: 'command' },
				failed: []
			});
			expect(f.results).toEqual([
				{
					kind: 'build-summary-v4',
					title: 'Publication incomplete',
					rows: [],
					data: summary
				}
			]);
			expect(rootTargets).toEqual([upstream]);
			expect(f.aggregateTargets.mock.calls).toEqual([]);
			savedJournal = await readFile(journalFile, 'utf8');
			f.build.mockRejectedValue(new Error('No rebuild during recovery'));
			f.graph.clear();
			shouldInterrupt = false;
		}
		const result = await runRecordedBuildPush(
			options,
			f.reporter,
			f.dependencies,
			f.build
		);
		expect(result).toEqual(expected);
		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual(expected);
		expect(f.results).toEqual([
			...(failure === 'none'
				? []
				: [
						{
							kind: 'build-summary-v4',
							title: 'Publication incomplete',
							rows: [],
							data: summary
						}
					]),
			{
				kind: 'build-summary-v4',
				title: 'Build and publication result',
				rows: [],
				data: summary
			}
		]);
		expect(rootTargets).toEqual([app]);
		expect([...f.runTargets]).toEqual([upstream, app]);
		expect(f.aggregateTargets.mock.calls).toEqual([[[app]]]);
		expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual(
			Array.from({ length: failure === 'root' ? 2 : 1 }, () => [
				'main',
				{ targets: [app], retention: options.retention }
			])
		);
		expect(vi.mocked(f.dependencies.client).negotiate.mock.calls).toEqual([]);
		expect(
			f.calls.filter((request) => request.operation === 'prepare-run-root')
		).toEqual(
			Array.from({ length: failure === 'none' ? 1 : 2 }, () => ({
				operation: 'prepare-run-root',
				input: options.runRoot
			}))
		);
		const ensureId = f.calls.find((request) => request.operation === 'ensure')
			?.input.requestId;
		const captureId = f.calls.find((request) => request.operation === 'capture')
			?.input.requestId;
		expect(ensureId).toBeTypeOf('string');
		expect(captureId).toBeTypeOf('string');
		const ensureInput = {
			source: f.source,
			...(view && { sourceSelector: f.selector }),
			runRoot: options.runRoot?.name
		};
		const ensure = {
			operation: 'ensure',
			input: { ...ensureInput, requestId: ensureId }
		};
		const captureInput = {
			result: { storePath: app, narHash: hash.toString(), generation: 1 },
			members: [{ storePath: app }],
			origin: 'legacy-selection'
		};
		const capture = {
			operation: 'capture',
			input: { ...captureInput, requestId: captureId }
		};
		expect(f.calls).toEqual([
			{
				operation: 'lookup',
				input: { source: defaultSource, results: [{ storePath: app }] }
			},
			{
				operation: 'lookup',
				input: { source: f.foreignSource, results: [{ storePath: app }] }
			},
			{ operation: 'prepare-run-root', input: options.runRoot },
			ensure,
			capture,
			...(failure === 'capture' ? [] : [ensure]),
			...(failure === 'none'
				? []
				: [
						{ operation: 'prepare-run-root', input: options.runRoot },
						ensure,
						capture,
						ensure
					])
		]);
		if (failure !== 'none') {
			expect(await readFile(journalFile, 'utf8')).toBe(savedJournal);
		}
		const invocation: unknown = expect.stringMatching(/^[a-f0-9]{64}$/u);
		expect(JSON.parse(await readFile(journalFile, 'utf8'))).toEqual({
			version: 3,
			invocation,
			captures: {
				[String(captureId)]: {
					version: 1,
					binding: {
						invocation,
						tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
						cache: { kind: 'default' },
						input: capture.input
					},
					state: { phase: 'unresolved' }
				}
			},
			requests: Object.fromEntries(
				[
					['ensure', ensureInput, ensureId],
					['capture', captureInput, captureId]
				].map(([operation, input, id]) => [
					createHash('sha256')
						.update(JSON.stringify([operation, input]))
						.digest('hex'),
					id
				])
			),
			snapshots: {
				selection: {
					selected: [
						[
							`${appDrv}^out`,
							[{ storePath: app, derivation: appDrv, name: 'out' }]
						]
					],
					recorded: [
						[
							app,
							{
								publication: f.source,
								...(view && { sourceSelector: f.selector })
							}
						]
					],
					supported: true
				},
				build: {
					receipt: f.conceded,
					targets: [app],
					captures: [captureInput],
					recorded: [],
					supported: true,
					summary: f.coldSummary
				}
			},
			intents: {
				[JSON.stringify(['ensure', app])]: ensure,
				[JSON.stringify(['capture', app])]: capture
			}
		});
		expect(f.build).toHaveBeenCalledTimes(1);
		expect(f.dependencies.targetDerivations).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.dependencies.store).readDerivation.mock.calls).toEqual(
			[appDrv, appDrv, toolDrv, upstreamDrv].map((derivation) => [derivation])
		);
	}
);

it.each(
	(['capture', 'ensure'] as const).flatMap((phase) =>
		(
			[
				'storePath',
				'narHash',
				'generation',
				'cache',
				'cacheGeneration',
				'digest',
				'memberCount',
				'origin'
			] as const
		).map((field) => ({ phase, field }))
	)
)(
	'rejects a changed accepted destination $field during subjectless alias $phase validation',
	async ({ phase, field }) => {
		const f = concededAliasFixture(true);
		const changed = publication();
		switch (field) {
			case 'storePath': {
				changed.result.storePath = sibling;
				break;
			}
			case 'narHash': {
				changed.result.narHash = NixSha256Hash.fromDigest(
					Buffer.alloc(32, 2)
				).toString();
				break;
			}
			case 'generation': {
				changed.result.generation = recordedPublicationSchema.parse({
					...changed,
					result: { ...changed.result, generation: 2 }
				}).result.generation;
				break;
			}
			case 'cache': {
				changed.result.cache = f.source.result.cache;
				break;
			}
			case 'cacheGeneration': {
				changed.result.cacheGeneration = recordedPublicationSchema.parse({
					...changed,
					result: { ...changed.result, cacheGeneration: 2 }
				}).result.cacheGeneration;
				break;
			}
			case 'digest': {
				changed.digest = recordedPublicationSchema.parse({
					...changed,
					digest: 'b'.repeat(64)
				}).digest;
				break;
			}
			case 'memberCount': {
				changed.memberCount = 1;
				break;
			}
			case 'origin': {
				changed.origin = 'legacy-selection';
				break;
			}
		}
		if (phase === 'capture') {
			f.capture.mockReturnValue(changed);
		} else {
			f.ensure
				.mockReturnValueOnce(f.completed)
				.mockReturnValue({ ...changed, materialisation: 'complete' });
		}
		await expect(
			runRecordedBuildPush(f.options, f.reporter, f.dependencies, f.build)
		).rejects.toMatchObject({
			cause: new Error(
				'Accepted publication changed after warm materialisation'
			)
		});
		expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual([]);
		expect(f.aggregateTargets.mock.calls).toEqual([]);
		expect(f.results).toEqual([
			{
				kind: 'build-summary-v4',
				title: 'Publication incomplete',
				rows: [],
				data: { ...f.coldSummary, version: 4, publicationSets: [f.completed] }
			}
		]);
	}
);

it('reopens the native owner after a lost capture response and refuses a replacement same-NAR generation/set (modelled HTTP remote)', async () => {
	const f = fixture(() => {
		throw new Error('Use the real native facade');
	});
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-native-capture-')
	);
	directories.push(directory);
	const receiptFile = path.join(directory, 'receipt.json');
	const options = { ...f.options, receiptFile };
	const destination = cacheTargetFromUrl(
		new URL('https://cupboard.example.workers.dev/t/acme')
	);
	const original = publication();
	let accepted: typeof original | undefined;
	let controller = new AbortController();
	const lost = new Error('capture response lost');
	const begins: unknown[] = [];
	const ensured: unknown[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const pathname = new URL(request.url).pathname;
		if (pathname.endsWith('/uploads/credential')) {
			return Response.json(
				{
					pushId: 'native-push',
					accessKeyId: 'access',
					secretAccessKey: 'secret',
					sessionToken: 'session',
					endpoint: 'https://r2.test',
					bucket: 'blobs',
					expiresAt: '2099-01-01T00:00:00.000Z'
				},
				{ headers: { [uploadCapabilitiesHeader]: 'publication-manifests-v1' } }
			);
		}
		const text = await request.text();
		const body: unknown = text === '' ? {} : JSON.parse(text);
		if (pathname.endsWith('/publication-results/lookup')) {
			const lookup = z
				.object({ results: z.array(z.object({ storePath: storePathSchema })) })
				.parse(body);
			return Response.json({
				entries: lookup.results.map(({ storePath }) =>
					accepted !== undefined && storePath === app
						? { kind: 'recorded', publication: accepted, complete: true }
						: { kind: 'missing', result: { ...original.result, storePath } }
				)
			});
		}
		if (pathname.endsWith('/publication-results/captures')) {
			begins.push(body);
			if (accepted !== undefined) {
				const begin = z
					.object({ result: z.object({ generation: z.number() }) })
					.parse(body);
				if (begin.result.generation !== accepted.result.generation) {
					return Response.json(
						{ message: 'identity changed' },
						{ status: 409 }
					);
				}
				return Response.json({ kind: 'existing', publication: accepted });
			}
			return Response.json({
				kind: 'staging',
				operationId: '22222222-2222-4222-8222-222222222222',
				expiresAt: '2099-01-01T00:00:00.000Z'
			});
		}
		if (pathname.includes('/pages/')) {
			const page = z
				.object({
					operationId: z.string(),
					page: z.number(),
					members: z.array(z.unknown())
				})
				.parse({
					...z.record(z.string(), z.unknown()).parse(body),
					operationId: pathname.split('/').at(-3),
					page: Number(pathname.split('/').at(-1))
				});
			return Response.json({
				operationId: page.operationId,
				page: page.page,
				acceptedCount: page.members.length
			});
		}
		if (pathname.endsWith('/seal')) {
			accepted = original;
			controller.abort(lost);
			return Response.json({
				kind: 'captured',
				association: 'created',
				publication: original
			});
		}
		if (pathname.endsWith('/uploads/plan')) {
			return Response.json({
				cacheGeneration: 1,
				pushExpiresAt: '2099-01-01T00:00:00.000Z',
				uploads: []
			});
		}
		if (pathname.endsWith('/publication-results/ensure')) {
			ensured.push(body);
			return Response.json({
				kind: 'complete',
				association: 'existing',
				publication: { ...accepted, materialisation: 'complete' }
			});
		}
		throw new Error(`Unexpected remote request: ${pathname}`);
	};
	const reopen = () =>
		buildPublicationWorkflow(
			destination,
			{ audience: audienceSchema.parse(destination.tenantUrl) },
			controller.signal,
			{
				authenticate: () =>
					Promise.resolve({
						get: () => Promise.resolve('token'),
						refresh: () => Promise.resolve('token')
					}),
				fetchAccess: () => Promise.resolve('public'),
				workflowFor: (url, credential, clientOptions) =>
					publicationWorkflowFor(url, credential, { ...clientOptions, fetcher })
			}
		);
	await expect(
		runRecordedBuildPush(
			options,
			f.reporter,
			{ ...f.dependencies, publicationWorkflow: reopen() },
			f.build
		)
	).rejects.toEqual(new BuildPublicationFailedError([], 74, { cause: lost }));
	const originalBegin = structuredClone(begins[0]);
	expect(accepted).toEqual(original);
	accepted = recordedPublicationSchema.parse({
		...original,
		result: { ...original.result, generation: 2 },
		digest: 'b'.repeat(64),
		memberCount: 3
	});
	controller = new AbortController();
	f.build.mockRejectedValue(new Error('Builder forbidden during recovery'));
	await expect(
		runRecordedBuildPush(
			options,
			f.reporter,
			{ ...f.dependencies, publicationWorkflow: reopen() },
			f.build
		)
	).rejects.toBeInstanceOf(BuildPublicationFailedError);
	expect(begins).toEqual([originalBegin, originalBegin]);
	expect(ensured).toEqual([]);
	expect(f.build).toHaveBeenCalledTimes(1);
});

// The native factory, auth facade, adapter and journal are real. Only HTTP and
// the already-completed Nix build are modelled at this consumer boundary.
function nativeCaptureRemote(receiptFile: string) {
	const destination = cacheTargetFromUrl(
		new URL('https://cupboard.example.workers.dev/t/acme')
	);
	const accepted = new Map<StorePathString, ReturnType<typeof publication>>();
	const begins: z.output<typeof publicationCaptureBeginRequestSchema>[] = [];
	const pages: z.output<typeof publicationCapturePageRequestSchema>[] = [];
	const ensures: z.output<typeof publicationEnsureRequestSchema>[] = [];
	const prepares: unknown[] = [];
	const operations = new Map<string, StorePathString>();
	let areLookupsForbidden = false;
	const checkpoints = async () =>
		z
			.object({
				captures: z.record(z.string(), publicationCaptureCheckpointSchema)
			})
			.parse(
				JSON.parse(
					await readFile(`${receiptFile}.publication-requests.json`, 'utf8')
				)
			).captures;
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const pathname = new URL(request.url).pathname;
		if (pathname.endsWith('/uploads/credential')) {
			return Response.json(
				{
					pushId: 'native-push',
					accessKeyId: 'access',
					secretAccessKey: 'secret',
					sessionToken: 'session',
					endpoint: 'https://r2.test',
					bucket: 'blobs',
					expiresAt: '2099-01-01T00:00:00.000Z'
				},
				{ headers: { [uploadCapabilitiesHeader]: 'publication-manifests-v1' } }
			);
		}
		const text = await request.text();
		const body: unknown = text === '' ? {} : JSON.parse(text);
		if (pathname.endsWith('/publication-results/lookup')) {
			if (areLookupsForbidden) {
				throw new Error('No fresh lookups during checkpoint recovery');
			}
			const lookup = publicationLookupRequestSchema.parse(body);
			return Response.json({
				entries: lookup.results.map(({ storePath }) => ({
					kind: 'missing',
					result: { ...publication().result, storePath }
				}))
			});
		}
		if (pathname.endsWith('/publication-results/captures')) {
			const begin = publicationCaptureBeginRequestSchema.parse(body);
			begins.push(begin);
			const checkpoint = Object.values(await checkpoints()).find(
				(item) => item.binding.input.requestId === begin.requestId
			);
			const members = begin.result.storePath === app ? [app, tool] : [sibling];
			const capture = {
				result: { ...publication().result, storePath: begin.result.storePath },
				begin,
				pages: [
					members.map((storePath) => ({
						storePath,
						narHash: hash.toString(),
						generation: 1
					}))
				]
			};
			expect(checkpoint).toEqual({
				version: 1,
				binding: {
					invocation: checkpoint?.binding.invocation,
					tenantUrl: destination.tenantUrl.href,
					cache: destination.cache,
					input: {
						result: {
							storePath: begin.result.storePath,
							narHash: hash.toString()
						},
						members: members.map((storePath) => ({
							storePath,
							narHash: hash.toString()
						})),
						origin: 'build-selection',
						requestId: begin.requestId
					}
				},
				state: accepted.has(begin.result.storePath)
					? {
							phase: 'captured',
							capture,
							operationId:
								begin.result.storePath === app
									? '22222222-2222-4222-8222-222222222222'
									: '33333333-3333-4333-8333-333333333333',
							publication: accepted.get(begin.result.storePath)
						}
					: { phase: 'resolved', capture }
			});
			const winner = accepted.get(begin.result.storePath);
			if (winner !== undefined) {
				return Response.json({ kind: 'existing', publication: winner });
			}
			const operationId =
				begin.result.storePath === app
					? '22222222-2222-4222-8222-222222222222'
					: '33333333-3333-4333-8333-333333333333';
			operations.set(operationId, begin.result.storePath);
			return Response.json({
				kind: 'staging',
				operationId,
				expiresAt: '2099-01-01T00:00:00.000Z'
			});
		}
		if (pathname.includes('/pages/')) {
			const page = publicationCapturePageRequestSchema.parse({
				...z.record(z.string(), z.unknown()).parse(body),
				operationId: pathname.split('/').at(-3),
				page: Number(pathname.split('/').at(-1))
			});
			pages.push(page);
			const checkpoint = Object.values(await checkpoints()).find(
				(item) =>
					'operationId' in item.state &&
					item.state.operationId === page.operationId
			);
			if (checkpoint?.state.phase !== 'begun') {
				throw new Error('Operation ID must be durable before a page');
			}
			expect(page).toEqual({
				operationId: checkpoint.state.operationId,
				page: 0,
				members: checkpoint.state.capture.pages[0]
			});
			return Response.json({
				operationId: page.operationId,
				page: page.page,
				acceptedCount: page.members.length
			});
		}
		if (pathname.endsWith('/seal')) {
			const storePath = operations.get(pathname.split('/').at(-2) ?? '');
			if (storePath === undefined) {
				throw new Error('Unknown remote capture');
			}
			const winner = publication(storePath, storePath === app ? 2 : 1);
			accepted.set(storePath, winner);
			return Response.json({
				kind: 'captured',
				association: 'created',
				publication: winner
			});
		}
		if (pathname.endsWith('/uploads')) {
			prepares.push(body);
			return Response.json({ uploads: [] });
		}
		if (pathname.endsWith('/uploads/plan')) {
			return Response.json({
				cacheGeneration: 1,
				pushExpiresAt: '2099-01-01T00:00:00.000Z',
				uploads: []
			});
		}
		if (pathname.endsWith('/publication-results/ensure')) {
			const ensure = publicationEnsureRequestSchema.parse(body);
			ensures.push(ensure);
			const winner = accepted.get(ensure.source.result.storePath);
			expect(ensure.source).toEqual(winner);
			return Response.json({
				kind: 'complete',
				association: 'existing',
				publication: { ...winner, materialisation: 'complete' }
			});
		}
		throw new Error(`Unexpected remote request: ${pathname}`);
	};
	return {
		accepted,
		begins,
		pages,
		ensures,
		prepares,
		checkpoints,
		forbidLookups() {
			areLookupsForbidden = true;
		},
		reopen() {
			return buildPublicationWorkflow(
				destination,
				{ audience: audienceSchema.parse(destination.tenantUrl) },
				undefined,
				{
					authenticate: () =>
						Promise.resolve({
							get: () => Promise.resolve('token'),
							refresh: () => Promise.resolve('token')
						}),
					fetchAccess: () => Promise.resolve('public'),
					workflowFor: (url, credential, options) =>
						publicationWorkflowFor(url, credential, { ...options, fetcher })
				}
			);
		}
	};
}

it.each(['root', 'receipt'] as const)(
	'replays every earlier native capture after later %s failure with exact receipts, provenance and roots (modelled HTTP remote)',
	async (failure) => {
		const f = fixture(() => {
			throw new Error('Use the real native facade');
		});
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-native-multiple-')
		);
		directories.push(directory);
		const receiptFile = path.join(directory, 'receipt.json');
		const remote = nativeCaptureRemote(receiptFile);
		const options: BuildPushRunOptions = {
			...f.options,
			receiptFile,
			invocation: {
				kind: 'constructed',
				build: { installables: [`${appDrv}^out`, `${siblingDrv}^out`] }
			},
			root: rootNameSchema.parse('main'),
			retention: { kind: 'permanent' },
			runRoot: {
				name: rootNameSchema.parse('run/123'),
				retention: { kind: 'duration', seconds: ttlSecondsSchema.parse(123) }
			}
		};
		const original = buildReceiptV3Schema.parse({
			...f.receipt,
			paths: [app, sibling, tool],
			subjects: [
				...f.receipt.subjects,
				{
					origin: 'built',
					storePath: sibling,
					narHash: hash.digestHex(),
					derivation: siblingDrv,
					buildStore: 'auto',
					verification: 'local'
				}
			]
		});
		f.build.mockImplementation(async (_options, _reporter, dependencies) => {
			await dependencies.settledTargets?.([app, sibling]);
			return original;
		});
		let isInterrupted = true;
		vi.mocked(f.dependencies.client).setRoot.mockImplementation(async () => {
			if (isInterrupted && failure === 'root') {
				throw new Error('later root failed');
			}
			if (isInterrupted && failure === 'receipt') {
				await mkdir(receiptFile);
			}
			return {
				name: rootNameSchema.parse('main'),
				targets: [],
				expired: false,
				createdAt: '2026-07-31T00:00:00.000Z',
				updatedAt: '2026-07-31T00:00:00.000Z'
			};
		});
		await expect(
			runRecordedBuildPush(
				options,
				f.reporter,
				{ ...f.dependencies, publicationWorkflow: remote.reopen() },
				f.build
			)
		).rejects.toThrow();
		const before = await readFile(
			`${receiptFile}.publication-requests.json`,
			'utf8'
		);
		const saved = await remote.checkpoints();
		expect(
			Object.values(saved).map((checkpoint) => checkpoint.state.phase)
		).toEqual(['captured', 'captured']);
		const originalBegins = structuredClone(remote.begins);
		const originalEnsures = structuredClone(remote.ensures);
		expect(originalBegins.map((begin) => begin.result)).toEqual(
			[app, sibling].map((storePath) => ({
				storePath,
				narHash: hash.toString(),
				generation: 1
			}))
		);
		if (failure === 'receipt') {
			await rm(receiptFile, { recursive: true });
		}
		remote.forbidLookups();
		isInterrupted = false;
		f.build.mockRejectedValue(
			new Error('No build or changed local ownership during recovery')
		);
		f.graph.clear();
		const publicationSets = [publication(app, 2), publication(sibling, 1)].map(
			(winner) => ({ ...winner, materialisation: 'complete' })
		);
		const expected = { ...original, version: 4, publicationSets };
		expect(
			await runRecordedBuildPush(
				options,
				f.reporter,
				{ ...f.dependencies, publicationWorkflow: remote.reopen() },
				f.build
			)
		).toEqual(expected);
		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toEqual(expected);
		expect(f.results.at(-1)).toEqual({
			kind: 'build-summary-v4',
			title: 'Build and publication result',
			rows: [],
			data: {
				mode: 'streamed',
				store: '/nix/store',
				targetPaths: 2,
				intermediatePaths: 0,
				queueDepth: 0,
				uploadedPaths: 0,
				skipped: 0,
				childExitStatus: 0,
				unconfirmedPaths: [],
				version: 4,
				publicationSets
			}
		});
		expect(remote.begins).toEqual([...originalBegins, ...originalBegins]);
		expect(remote.ensures).toEqual([...originalEnsures, ...originalEnsures]);
		expect(remote.pages).toEqual([
			{
				operationId: '22222222-2222-4222-8222-222222222222',
				page: 0,
				members: [app, tool].map((storePath) => ({
					storePath,
					narHash: hash.toString(),
					generation: 1
				}))
			},
			{
				operationId: '33333333-3333-4333-8333-333333333333',
				page: 0,
				members: [
					{ storePath: sibling, narHash: hash.toString(), generation: 1 }
				]
			}
		]);
		expect(
			await readFile(`${receiptFile}.publication-requests.json`, 'utf8')
		).toBe(before);
		expect(vi.mocked(f.dependencies.client).setRoot.mock.calls).toEqual(
			Array.from({ length: 2 }, () => [
				'main',
				{ targets: [app, sibling], retention: options.retention }
			])
		);
		expect(vi.mocked(f.dependencies.client).negotiate.mock.calls).toEqual([]);
		expect(remote.prepares).toEqual(
			Array.from({ length: 2 }, () => ({
				pushId: 'native-push',
				paths: [],
				attachRoot: options.runRoot
			}))
		);
		expect(f.build).toHaveBeenCalledTimes(1);
	}
);
