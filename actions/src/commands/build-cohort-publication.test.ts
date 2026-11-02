import * as fs from 'node:fs/promises';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { buildReceiptV3Schema } from '@cupboard/protocol/build';
import {
	publicationCapturePageRequestSchema,
	type RecordedPublication,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import {
	publicationCaptureEnvelopeSchema,
	publicationWorkflowCaptureInputSchema,
	type PublicationWorkflowRequest,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import { uploadCapabilitiesHeader } from '@cupboard/protocol/upload';
import {
	parseReporterResults,
	type ReporterResultEvent
} from '@cupboard/reporter';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { registerPublicationResultCommand } from '../../../packages/cli/src/commands/publication-result.ts';
import { publicationWorkflowFor } from '../../../packages/cli/src/publication/publication-client.ts';
import { RecordedCohortPublication } from '../cohort-publication.ts';
import {
	CupboardReportedError,
	RemoteCohortBuildFailedError,
	type RemoteCohortBuildFailure
} from '../errors.ts';
import * as captureFiles from '../publication-capture-files.ts';
import { type PublicationReceipt } from '../publication-receipt.ts';
import { publicationReceiptSchema } from '../publication-receipt.ts';
import { recordingGithubReporter } from '../reporter-testing.ts';

import {
	buildCohortAction,
	type BuildCohortDependencies,
	type BuildCohortOptions,
	type CohortMember,
	resolveBuildCohortInputs
} from './build-cohort.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, open: vi.fn(actual.open) };
});

const app = storePathSchema.parse(`/nix/store/${'0'.repeat(32)}-app`);
const other = storePathSchema.parse(`/nix/store/${'1'.repeat(32)}-other`);
const tool = storePathSchema.parse(`/nix/store/${'2'.repeat(32)}-tool`);
const defaultCache = { kind: 'default' };
const root = 'github:acme/app/main';
const url = 'https://cupboard.example.workers.dev/t/acme';
const directories: string[] = [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(disposals.splice(0).map((dispose) => dispose()));
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

function member(
	output: StorePathString,
	name = output.split('-').at(-1) ?? 'app'
): CohortMember {
	return {
		attr: name,
		installable: `.#${name}`,
		queryInstallable: `${output}.drv^out`,
		expectedPath: output,
		root
	};
}
function matrix(members: readonly CohortMember[], key = 'cohort') {
	return JSON.stringify({
		key,
		attrs: members.map((entry) => entry.attr),
		installables: members.map((entry) => entry.installable),
		queryInstallables: members.map((entry) => entry.queryInstallable),
		expectedPaths: members.map((entry) => entry.expectedPath),
		roots: members.map((entry) => entry.root),
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: false,
		runsOn: 'ubuntu-latest'
	});
}
function publication(
	output: StorePathString,
	cache: unknown = defaultCache,
	digest = 'a'.repeat(64)
): RecordedPublication {
	return recordedPublicationSchema.parse({
		result: {
			storePath: output,
			narHash: `sha256:${'0'.repeat(52)}`,
			generation: 1,
			cache,
			cacheGeneration: 1
		},
		digest,
		memberCount: 2,
		origin: 'build-selection'
	});
}
function value(argv: readonly string[], option: string): string {
	const index = argv.indexOf(option);
	return index === -1 ? '' : (argv[index + 1] ?? '');
}
function results(kind: string, data: unknown): readonly ReporterResultEvent[] {
	return [{ kind, data }];
}

async function fixture(
	members: readonly CohortMember[] = [member(app)],
	overrides: BuildCohortOptions = {}
) {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-action-publication-')
	);
	directories.push(directory);
	const binary = path.join(directory, 'cupboard.cjs');
	await writeFile(
		binary,
		'#!/usr/bin/env node\nconsole.log("Usage: cupboard publication-result [options] <url>\\n  --request-file <path>  Workflow request");\n'
	);
	await chmod(binary, 0o755);
	const environment: Record<string, string> = {
		GITHUB_RUN_ID: '123',
		GITHUB_RUN_ATTEMPT: '1',
		GITHUB_SHA: 'a'.repeat(40),
		GITHUB_REPOSITORY: 'acme/app',
		GITHUB_WORKFLOW_REF:
			'acme/app/.github/workflows/publish.yml@refs/heads/main',
		RUNNER_TEMP: directory,
		GITHUB_OUTPUT: path.join(directory, 'output')
	};
	const options: BuildCohortOptions = {
		cohortJson: matrix(members),
		cupboardPath: binary,
		url,
		publish: 'outputs',
		substituter: 'copy',
		runRoot: 'github:acme/app/run-123',
		runRootTtl: '1d',
		...overrides
	};
	const inputs = resolveBuildCohortInputs(options, environment);
	const recorded = new Map<string, RecordedPublication>();
	const accepted = new Set<StorePathString>();
	const requests: PublicationWorkflowRequest[] = [];
	const commands: (readonly string[])[] = [];
	const httpRequests: Request[] = [];
	const rootTargets = new Map<string, Set<string>>();
	const reporter = recordingGithubReporter();
	const report = vi.spyOn(reporter.reporter, 'result');
	const faults = {
		ensure: false,
		ensurePath: '',
		prepare: false,
		root: false,
		unsupported: false,
		badOperation: false,
		lookup: false,
		failBuild: false,
		capture: false,
		begin: false,
		page: false,
		authority: false,
		staleView: false,
		currentLookup: false,
		lookupStatus: 0
	};
	const planSelection = {
		publishByReference: [] as StorePathString[]
	};
	let destinationOrigin: RecordedPublication['origin'] | undefined;
	let coldReceipt: PublicationReceipt = buildReceiptV3Schema.parse({
		version: 3,
		paths: members.flatMap((entry) => entry.expectedPath ?? []),
		subjects: members.flatMap((entry) =>
			entry.expectedPath === undefined
				? []
				: {
						origin: 'built',
						storePath: entry.expectedPath,
						narHash: '00'.repeat(32),
						derivation: `${entry.expectedPath}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}
		),
		childExitStatus: 0
	});
	const materialise = vi.fn(() => Promise.resolve());
	const graph = vi.fn((derivations: readonly StorePathString[]) =>
		Promise.resolve({
			closure: derivations,
			floatingOutputs: [],
			substitutableDerivations: [],
			outputs: [],
			dependencyOutputs: [],
			derivationDependencies: []
		})
	);
	const build = vi.fn((installables: readonly string[]) =>
		Promise.resolve({
			paths: installables.flatMap((installable) =>
				members
					.filter(
						(entry) =>
							entry.installable === installable ||
							entry.queryInstallable === installable
					)
					.flatMap((entry) => entry.expectedPath ?? [])
			),
			status: 0,
			copiedFrom: new Map<StorePathString, readonly string[]>()
		})
	);
	const run: NonNullable<BuildCohortDependencies['runCupboard']> = async (
		_binary,
		argv,
		_environment,
		runDependencies
	) => {
		commands.push(argv);
		if (argv[1] === 'publication-result') {
			const requestFile = value(argv, '--request-file');
			const json: unknown = JSON.parse(await readFile(requestFile, 'utf8'));
			const envelope = publicationCaptureEnvelopeSchema.safeParse(json);
			const request = envelope.success
				? envelope.data.request
				: publicationWorkflowRequestSchema.parse(json);
			requests.push(request);
			if (
				request.operation === 'capture' ||
				(request.operation === 'lookup' && faults.currentLookup)
			) {
				const controller = new AbortController();
				const fetcher: typeof fetch = async (input, init) => {
					const http = new Request(input, init);
					const pathname = new URL(http.url).pathname;
					httpRequests.push(http.clone());
					if (pathname.endsWith('/uploads/credential')) {
						return Response.json(
							{
								pushId: 'push-1',
								accessKeyId: 'access',
								secretAccessKey: 'secret',
								sessionToken: 'session',
								endpoint: 'https://r2.test',
								bucket: 'blobs',
								expiresAt: '2099-01-01T00:00:00.000Z'
							},
							{
								headers: {
									[uploadCapabilitiesHeader]: faults.unsupported
										? ''
										: 'publication-manifests-v1'
								}
							}
						);
					}
					if (pathname.endsWith('/lookup')) {
						if (faults.lookupStatus !== 0) {
							return new Response('lookup refused', {
								status: faults.lookupStatus
							});
						}
						const json: unknown = await http.json();
						const body = publicationWorkflowRequestSchema.parse({
							operation: 'lookup',
							input: json
						});
						if (body.operation !== 'lookup') {
							throw new Error('Expected lookup model');
						}
						return Response.json({
							entries: body.input.results.map((target) => {
								const winner = recorded.get(`default:${target.storePath}`);
								return winner === undefined
									? {
											kind: 'missing',
											result: publication(target.storePath).result
										}
									: { kind: 'recorded', publication: winner, complete: true };
							})
						});
					}
					if (request.operation !== 'capture') {
						throw new Error(`Unexpected modelled lookup HTTP ${pathname}`);
					}
					const operationId = request.input.requestId;
					if (pathname.endsWith('/captures')) {
						if (faults.authority) {
							return new Response('authority refused', { status: 403 });
						}
						if (faults.begin) {
							controller.abort(new Error('capture begin interrupted'));
						}
						const current = recorded.get(
							`default:${request.input.result.storePath}`
						);
						// Model the server's exact generation fencing, not local cached authority.
						if (current !== undefined && current.result.generation !== 1) {
							return new Response('identity changed', { status: 409 });
						}
						return Response.json(
							current === undefined
								? {
										kind: 'staging',
										operationId,
										expiresAt: '2099-01-01T00:00:00.000Z'
									}
								: { kind: 'existing', publication: current }
						);
					}
					if (pathname.includes('/pages/')) {
						if (faults.page) {
							controller.abort(new Error('capture page interrupted'));
						}
						const json: unknown = await http.json();
						const body = publicationCapturePageRequestSchema.parse({
							...publicationCapturePageRequestSchema
								.omit({ operationId: true, page: true })
								.parse(json),
							operationId,
							page: 0
						});
						return Response.json({
							operationId,
							page: 0,
							acceptedCount: body.members.length
						});
					}
					if (pathname.endsWith('/seal')) {
						const winner = {
							...publication(request.input.result.storePath),
							memberCount: request.input.members.length,
							origin: request.input.origin
						};
						recorded.set(`default:${winner.result.storePath}`, winner);
						if (faults.capture) {
							controller.abort(new Error('capture reply interrupted'));
						}
						return Response.json({
							kind: 'captured',
							association: 'created',
							publication: winner
						});
					}
					throw new Error(`Unexpected modelled capture HTTP ${pathname}`);
				};
				const command = new Command()
					.option('--no-colour')
					.option('--output-mode <mode>')
					.option('--result-file <file>');
				const signal =
					runDependencies?.signal === undefined
						? controller.signal
						: AbortSignal.any([controller.signal, runDependencies.signal]);
				registerPublicationResultCommand(
					command,
					{ signal },
					{
						authenticate: () =>
							Promise.resolve({
								get: () => Promise.resolve('access-token'),
								refresh: () => Promise.resolve('access-token')
							}),
						fetchCacheAccess: () => Promise.resolve('public'),
						workflowFor: (target, credential, options) =>
							publicationWorkflowFor(target, credential, {
								...options,
								fetcher
							})
					}
				);
				const resultFile = path.join(directory, 'hidden-results.jsonl');
				await rm(resultFile, { force: true });
				await command.parseAsync(
					['--output-mode', 'json', '--result-file', resultFile, ...argv],
					{ from: 'user' }
				);
				return parseReporterResults(await readFile(resultFile, 'utf8'));
			}

			if (faults.unsupported) {
				return results('publication-result', {
					operation: request.operation,
					supported: false
				});
			}
			if (faults.badOperation) {
				return results('publication-result', {
					operation: 'prepare-run-root',
					supported: true,
					output: { name: inputs.runRoot }
				});
			}
			if (request.operation === 'lookup') {
				if (faults.lookup) {
					throw new Error('provider or stale-view failure');
				}
				const source = request.input.source;
				const sourceKey =
					source.selector === undefined
						? source.cache?.kind === 'named'
							? source.cache.name
							: 'default'
						: 'view';
				return results('publication-result', {
					operation: 'lookup',
					supported: true,
					output: {
						entries: request.input.results.map((target) => {
							const record = recorded.get(`${sourceKey}:${target.storePath}`);
							return record === undefined
								? sourceKey === 'default' && accepted.has(target.storePath)
									? {
											kind: 'missing',
											result: publication(target.storePath).result
										}
									: { kind: 'unavailable', storePath: target.storePath }
								: { kind: 'recorded', publication: record, complete: true };
						}),
						...(source.selector !== undefined && {
							sourceSelector: {
								view: source.selector.view,
								expectedRevision:
									faults.staleView &&
									source.selector.expectedRevision !== undefined
										? 8
										: 7
							}
						})
					}
				});
			}
			if (request.operation === 'prepare-run-root') {
				if (faults.prepare) {
					throw new Error('root preparation failed');
				}
				const targets = rootTargets.get(request.input.name) ?? new Set();
				rootTargets.set(request.input.name, targets);
				return results('publication-result', {
					operation: request.operation,
					supported: true,
					output: { name: request.input.name }
				});
			}

			if (
				faults.ensure ||
				faults.ensurePath === request.input.source.result.storePath
			) {
				throw new Error('ensure interrupted');
			}
			const output = {
				...request.input.source,
				origin: destinationOrigin ?? request.input.source.origin,
				result: { ...request.input.source.result, cache: { kind: 'default' } },
				materialisation: 'complete'
			};
			accepted.add(output.result.storePath);
			if (request.input.runRoot !== undefined) {
				rootTargets.get(request.input.runRoot)?.add(output.result.storePath);
			}
			return results('publication-result', {
				operation: 'ensure',
				supported: true,
				output
			});
		}
		if (argv[1] === 'root' && argv[2] === 'ensure') {
			const name = argv[4] ?? '';
			const firstOption = argv.indexOf('--github-oidc');
			const targets = argv
				.slice(5, firstOption)
				.map((output) => storePathSchema.parse(output));
			if (faults.root) {
				return results('root-ensure', {
					status: 'build-required',
					unavailable: targets
				});
			}
			rootTargets.set(name, new Set(targets));
			return results('root-ensure', {
				status: 'retained',
				root: {
					name,
					expired: false,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					targets: targets.map((storePath) => ({
						storePath,
						storePathHash: storePath.slice(
							'/nix/store/'.length,
							'/nix/store/'.length + 32
						),
						present: true
					}))
				}
			});
		}
		if (argv[1] === 'plan' && argv[2] === 'cohort') {
			const targets = JSON.parse(
				await readFile(value(argv, '--targets-file'), 'utf8')
			) as { targets: { installable: string }[] };
			const referencePaths = new Set<string>(planSelection.publishByReference);
			return results('plan-cohort', {
				partition: {
					attachOnly: [],
					publishByReference: planSelection.publishByReference,
					leftUpstream: [],
					alreadyValid: [],
					buildSet: targets.targets
						.filter((entry) =>
							members.every(
								(member) =>
									member.queryInstallable !== entry.installable ||
									!referencePaths.has(member.expectedPath ?? '')
							)
						)
						.map((entry) => entry.installable),
					rebuildSet: [],
					counts: {
						willBuild: targets.targets.length,
						willSubstitute: 0,
						unknown: 0
					},
					downloadSize: 0,
					narSize: 0,
					unknownCount: 0,
					ceiling: { value: 5, source: 'configured' }
				},
				capacity: { available: 100, capacity: 100, headroom: 0 }
			});
		}
		if (argv[1] === 'build-push') {
			await writeFile(
				value(argv, '--receipt-file'),
				JSON.stringify(coldReceipt)
			);
			for (const output of coldReceipt.paths) {
				accepted.add(output);
			}
			if (faults.failBuild) {
				throw new CupboardReportedError(1, [], undefined, true);
			}
			return [];
		}
		if (argv[1] === 'push') {
			const file = value(argv, '--receipt-file');
			if (file !== '') {
				await writeFile(
					file,
					JSON.stringify({
						version: 3,
						paths: coldReceipt.paths,
						subjects: coldReceipt.subjects.map((subject) => ({
							origin: 'store-held',
							storePath: subject.storePath,
							narHash: subject.narHash,
							derivation: subject.derivation,
							buildStore: inputs.store || 'auto'
						}))
					})
				);
			}
			return [];
		}
		throw new Error(`Unexpected command ${argv.join(' ')}`);
	};
	const dependencies: BuildCohortDependencies = {
		runCupboard: run,
		reporter: reporter.reporter,
		materialiseDerivationGraph: materialise,
		resolveLocalDerivationGraph: graph,
		runNixDerivationShow: vi.fn((installables: readonly string[]) =>
			Promise.resolve(
				installables.flatMap((installable) =>
					members
						.filter((entry) => entry.installable === installable)
						.map((entry) =>
							storePathSchema.parse(entry.queryInstallable?.split('^', 1)[0])
						)
				)
			)
		),
		withLocalDerivationRoots: (_derivations, use) => use(),
		runNixBuild: build
	};
	return {
		run,
		directory,
		options,
		environment,
		inputs,
		dependencies,
		recorded,
		planSelection,
		accepted,
		requests,
		commands,
		httpRequests,
		rootTargets,
		reporter,
		report,
		faults,
		materialise,
		graph,
		build,
		setReceipt: (receipt: PublicationReceipt) => {
			coldReceipt = receipt;
		},
		setDestinationOrigin: (origin: RecordedPublication['origin']) => {
			destinationOrigin = origin;
		},
		execute: (
			extraOptions: BuildCohortOptions = {},
			extraDependencies: BuildCohortDependencies = {}
		) =>
			buildCohortAction({ ...options, ...extraOptions }, environment, {
				...dependencies,
				...extraDependencies
			}),
		receipt: async () =>
			publicationReceiptSchema.parse(
				JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
			)
	};
}

const captureRecordSchema = z.strictObject({
	requestId: z.string(),
	file: z.string(),
	readiness: z.enum(['preparing', 'ready']),
	input: publicationWorkflowCaptureInputSchema
});
const actionRecoverySchema = z.object({
	phase: z.enum(['active', 'completed']),
	captures: z.record(z.string(), captureRecordSchema)
});
async function recoveryState(receiptFile: string) {
	return actionRecoverySchema.parse(
		JSON.parse(await readFile(`${receiptFile}.publication-state.json`, 'utf8'))
	);
}

describe('buildCohortAction recorded publication', () => {
	it('refuses orphaned capture files after missing ownership state rather than beginning new recovery', async () => {
		const f = await fixture();
		f.faults.capture = true;
		await expect(f.execute()).rejects.toThrow('interrupted');
		const stateFile = `${f.inputs.receiptFile}.publication-state.json`;
		const state = await recoveryState(f.inputs.receiptFile);
		const record = Object.values(state.captures)[0];
		if (record === undefined) {
			throw new Error('Expected capture');
		}
		const file = captureFiles.publicationCaptureFile(
			f.inputs.receiptFile,
			record.requestId
		);
		const saved = await captureFiles.readPublicationCaptureFile(file);
		await rm(stateFile);
		const count = f.commands.length;
		await expect(f.execute()).rejects.toThrow('missing invocation state');
		expect(f.commands.slice(count)).toEqual([]);
		expect(await captureFiles.readPublicationCaptureFile(file)).toEqual(saved);
	});

	it('excludes a second active coordinator until the first invocation has completed all work', async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<undefined>();
		const proceed = Promise.withResolvers<undefined>();
		const first = f.execute(
			{},
			{
				hasPublicationSupport: async () => {
					entered.resolve(undefined);
					await proceed.promise;
					return true;
				}
			}
		);
		await entered.promise;
		await expect(f.execute()).rejects.toBeInstanceOf(
			captureFiles.PublicationFileOwnershipError
		);
		expect(f.commands).toEqual([]);
		proceed.resolve(undefined);
		await first;
		await expect(
			stat(`${f.inputs.receiptFile}.publication-state.json.publication-lock`)
		).rejects.toHaveProperty('code', 'ENOENT');
	});

	it('never overwrites a corrupt preparing file after failed exclusive initialisation', async () => {
		const f = await fixture();
		const write = captureFiles.writePublicationStateFile;
		const fault = vi
			.spyOn(captureFiles, 'writePublicationStateFile')
			.mockImplementation(async (file, text, isExclusive) => {
				if (isExclusive) {
					await writeFile(file, 'partial-json', { flag: 'wx', mode: 0o600 });
					throw new Error('initial write interrupted');
				}
				await write(file, text, isExclusive);
			});
		await expect(f.execute()).rejects.toThrow('initial write interrupted');
		fault.mockRestore();
		const state = await recoveryState(f.inputs.receiptFile);
		const record = Object.values(state.captures)[0];
		if (record === undefined) {
			throw new Error('Expected preparing record');
		}
		expect(record.readiness).toBe('preparing');
		const file = captureFiles.publicationCaptureFile(
			f.inputs.receiptFile,
			record.requestId
		);
		const count = f.commands.length;
		await expect(f.execute()).rejects.toBeDefined();
		expect(f.commands.slice(count)).toEqual([]);
		expect(await readFile(file, 'utf8')).toBe('partial-json');
	});

	it('retains every capture through actual receipt-write failure and reopens earlier checkpoints without rebuilding', async () => {
		const f = await fixture([member(app), member(other)]);
		const run: NonNullable<BuildCohortDependencies['runCupboard']> = async (
			...arguments_
		) => {
			const result = await f.run(...arguments_);
			if (arguments_[1][1] === 'root') {
				await rm(f.inputs.receiptFile, { force: true });
				await mkdir(f.inputs.receiptFile);
			}
			return result;
		};
		await expect(f.execute({}, { runCupboard: run })).rejects.toHaveProperty(
			'code',
			'EISDIR'
		);
		const state = await recoveryState(f.inputs.receiptFile);
		expect(state.phase).toBe('active');
		const records = Object.values(state.captures);
		const files = records.map((record) =>
			captureFiles.publicationCaptureFile(
				f.inputs.receiptFile,
				record.requestId
			)
		);
		const checkpoints = await Promise.all(
			files.map((file) => captureFiles.readPublicationCaptureFile(file))
		);
		expect(
			checkpoints.map((envelope) => envelope.checkpoint.state.phase)
		).toEqual(['captured', 'captured']);
		await rm(f.inputs.receiptFile, { recursive: true });
		const originalCaptures = f.requests.filter(
			(request) => request.operation === 'capture'
		);
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		const count = f.requests.length;
		await f.execute();
		expect(f.requests.slice(count, count + 2)).toEqual(originalCaptures);
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		for (const file of files) {
			await expect(stat(file)).rejects.toHaveProperty('code', 'ENOENT');
		}
	});

	it.each(['write', 'file-sync', 'directory-sync'] as const)(
		'keeps all recovery evidence active when the actual final V4 receipt writer fails at %s',
		async (boundary) => {
			const f = await fixture([member(app), member(other)]);
			const failure = new Error(`receipt ${boundary} failed`);
			const actual =
				await vi.importActual<typeof import('node:fs/promises')>(
					'node:fs/promises'
				);
			const inventory = async (): Promise<Record<string, string>> => {
				const names = await readdir(f.directory);
				return Object.fromEntries<string>(
					await Promise.all(
						names
							.filter(
								(name) =>
									name.includes('.publication-') && name.endsWith('.json')
							)
							.toSorted(byCodeUnit)
							.map(
								async (name) =>
									[
										name,
										await readFile(path.join(f.directory, name), 'utf8')
									] as const
							)
					)
				);
			};
			let saved: Record<string, string> = {};
			let isReceiptPending = false;
			const order: string[] = [];
			const fault = vi
				.spyOn(fs, 'open')
				.mockImplementation(async (file, flags, mode) => {
					const handle = await actual.open(file, flags, mode);
					if (
						flags === 'wx' &&
						typeof file === 'string' &&
						file.startsWith(`${f.inputs.receiptFile}.`) &&
						!file.startsWith(`${f.inputs.receiptFile}.publication-`) &&
						/\.[\da-f-]{36}$/u.test(file)
					) {
						saved = await inventory();
						isReceiptPending = true;
						order.push('receipt-open');
						if (boundary === 'write') {
							vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
						} else {
							const sync = handle.sync.bind(handle);
							vi.spyOn(handle, 'sync').mockImplementationOnce(() => {
								order.push('receipt-file-sync');
								return boundary === 'file-sync'
									? Promise.reject(failure)
									: sync();
							});
						}
					} else if (isReceiptPending && file === f.directory) {
						order.push('receipt-directory-open');
						vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
					}
					return handle;
				});
			await expect(f.execute()).rejects.toBe(failure);
			fault.mockRestore();
			expect(order).toStrictEqual(
				boundary === 'write'
					? ['receipt-open']
					: boundary === 'file-sync'
						? ['receipt-open', 'receipt-file-sync']
						: ['receipt-open', 'receipt-file-sync', 'receipt-directory-open']
			);
			expect(await inventory()).toStrictEqual(saved);
			const captures = f.requests.filter(
				(request) => request.operation === 'capture'
			);
			const state = await recoveryState(f.inputs.receiptFile);
			expect(state).toStrictEqual({
				phase: 'active',
				captures: Object.fromEntries(
					captures.map((request) => {
						const requestId = z.string().parse(request.input.requestId);
						return [
							requestId,
							{
								requestId,
								file: path.basename(
									captureFiles.publicationCaptureFile(
										f.inputs.receiptFile,
										requestId
									)
								),
								readiness: 'ready',
								input: request.input
							}
						] as const;
					})
				)
			});
			const envelopes = await Promise.all(
				Object.values(state.captures).map((record) =>
					captureFiles.readPublicationCaptureFile(
						captureFiles.publicationCaptureFile(
							f.inputs.receiptFile,
							record.requestId
						)
					)
				)
			);
			expect(
				envelopes.map((envelope) => envelope.checkpoint.state.phase)
			).toStrictEqual(['captured', 'captured']);
			const original = buildReceiptV3Schema.parse({
				version: 3,
				paths: [app, other],
				childExitStatus: 0,
				uploaded: [],
				subjects: [app, other].map((storePath) => ({
					origin: 'built',
					storePath,
					narHash: '00'.repeat(32),
					derivation: `${storePath}.drv`,
					buildStore: 'auto',
					verification: 'local'
				}))
			});
			const completed = {
				...original,
				version: 4,
				publicationSets: [app, other].map((output) => ({
					...publication(output),
					memberCount: 1,
					materialisation: 'complete'
				}))
			};
			expect(await f.receipt()).toStrictEqual(
				boundary === 'directory-sync' ? completed : original
			);
			const count = f.requests.length;
			f.materialise.mockClear();
			f.graph.mockClear();
			f.build.mockClear();
			await f.execute();
			expect(f.requests.slice(count, count + 2)).toStrictEqual(captures);
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			expect(await f.receipt()).toStrictEqual(completed);
			expect(f.rootTargets.get(root)).toStrictEqual(new Set([app, other]));
			expect(await inventory()).toStrictEqual({});
		}
	);

	it('keeps the initial old-peer cold V3 snapshot active until its receipt is durable, then restores it without rebuilding', async () => {
		const f = await fixture([member(app)], { build: 'rebuild' });
		f.faults.currentLookup = true;
		f.faults.unsupported = true;
		const dependencies = {
			buildSettings: { systems: ['x86_64-linux'], features: [] }
		};
		const actual =
			await vi.importActual<typeof import('node:fs/promises')>(
				'node:fs/promises'
			);
		const failure = new Error('V3 receipt file sync failed');
		const fault = vi
			.spyOn(fs, 'open')
			.mockImplementation(async (file, flags, mode) => {
				const handle = await actual.open(file, flags, mode);
				if (
					flags === 'wx' &&
					typeof file === 'string' &&
					file.startsWith(`${f.inputs.receiptFile}.`) &&
					!file.startsWith(`${f.inputs.receiptFile}.publication-`) &&
					/\.[\da-f-]{36}$/u.test(file)
				) {
					vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
				}
				return handle;
			});
		await expect(f.execute({}, dependencies)).rejects.toBe(failure);
		fault.mockRestore();
		const stateFile = `${f.inputs.receiptFile}.publication-state.json`;
		const saved = await readFile(stateFile, 'utf8');
		expect(await recoveryState(f.inputs.receiptFile)).toStrictEqual({
			phase: 'active',
			captures: {}
		});
		const original = await f.receipt();
		expect(original).toStrictEqual({
			version: 3,
			paths: [app],
			childExitStatus: 0,
			uploaded: [],
			subjects: [
				{
					origin: 'built',
					storePath: app,
					narHash: '00'.repeat(32),
					derivation: `${app}.drv`,
					buildStore: 'auto',
					verification: 'local'
				}
			]
		});
		await rm(f.inputs.receiptFile);
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		const count = f.commands.length;
		await f.execute({}, dependencies);
		expect(f.commands.slice(count).map((argv) => argv[1])).toStrictEqual([
			'publication-result',
			'root'
		]);
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		expect(await f.receipt()).toStrictEqual(original);
		expect(f.rootTargets.get(root)).toStrictEqual(new Set([app]));
		expect(
			z
				.object({ cold: z.object({ receipt: publicationReceiptSchema }) })
				.parse(JSON.parse(saved)).cold.receipt
		).toStrictEqual(original);
		await expect(stat(stateFile)).rejects.toHaveProperty('code', 'ENOENT');
	});

	it.each([false, true])(
		'does not spawn before durable ready state (uncertain ready save %s) and never reinitialises an existing file',
		async (isUncertain) => {
			const f = await fixture();
			const write = captureFiles.writePublicationStateFile;
			let didFail = false;
			const fault = vi
				.spyOn(captureFiles, 'writePublicationStateFile')
				.mockImplementation(async (file, text, isExclusive) => {
					if (file.endsWith('.publication-state.json')) {
						const state = actionRecoverySchema.parse(JSON.parse(text));
						if (
							!didFail &&
							Object.values(state.captures).some(
								(record) => record.readiness === 'ready'
							)
						) {
							didFail = true;
							if (isUncertain) {
								await write(file, text, isExclusive);
							}
							throw new Error('ready sync failed');
						}
					}
					await write(file, text, isExclusive);
				});
			await expect(f.execute()).rejects.toThrow('ready sync failed');
			const state = await recoveryState(f.inputs.receiptFile);
			const record = Object.values(state.captures)[0];
			if (record === undefined) {
				throw new Error('Expected capture intent');
			}
			expect(record.readiness).toBe(isUncertain ? 'ready' : 'preparing');
			const file = captureFiles.publicationCaptureFile(
				f.inputs.receiptFile,
				record.requestId
			);
			const savedEnvelope1 =
				await captureFiles.readPublicationCaptureFile(file);
			expect(savedEnvelope1.checkpoint.state).toEqual({ phase: 'unresolved' });
			expect(
				f.requests.filter((request) => request.operation === 'capture')
			).toEqual([]);
			fault.mockRestore();
			const initialised: string[] = [];
			const observe = vi
				.spyOn(captureFiles, 'writePublicationStateFile')
				.mockImplementation(async (file, text, isExclusive) => {
					if (isExclusive) {
						initialised.push(file);
					}
					await write(file, text, isExclusive);
				});
			await f.execute();
			expect(initialised).toEqual([]);
			observe.mockRestore();
		}
	);

	it('keeps ready state and its unresolved file after cancellation before spawn, then safely resumes', async () => {
		const f = await fixture();
		const controller = new AbortController();
		const failure = new Error('cancelled before spawn');
		const write = captureFiles.writePublicationStateFile;
		const fault = vi
			.spyOn(captureFiles, 'writePublicationStateFile')
			.mockImplementation(async (file, text, isExclusive) => {
				await write(file, text, isExclusive);
				if (!file.endsWith('.publication-state.json')) {
					return;
				}
				{
					const state = actionRecoverySchema.parse(JSON.parse(text));
					if (
						Object.values(state.captures).some(
							(record) => record.readiness === 'ready'
						)
					) {
						controller.abort(failure);
					}
				}
			});
		await expect(f.execute({}, { signal: controller.signal })).rejects.toBe(
			failure
		);
		const state = await recoveryState(f.inputs.receiptFile);
		const record = Object.values(state.captures)[0];
		if (record === undefined) {
			throw new Error('Expected capture intent');
		}
		expect(record.readiness).toBe('ready');
		const file = captureFiles.publicationCaptureFile(
			f.inputs.receiptFile,
			record.requestId
		);
		const savedEnvelope2 = await captureFiles.readPublicationCaptureFile(file);
		expect(savedEnvelope2.checkpoint.state).toEqual({ phase: 'unresolved' });
		expect(
			f.requests.filter((request) => request.operation === 'capture')
		).toEqual([]);
		fault.mockRestore();
		await f.execute();
	});

	it('preserves primary action exit classification when coordinator release also fails and reports the secondary failure', async () => {
		const f = await fixture();
		const primary = new CupboardReportedError(77, [], undefined, true);
		const didWriteDiagnostic = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);
		await expect(
			f.execute(
				{},
				{
					hasPublicationSupport: async () => {
						await writeFile(
							`${f.inputs.receiptFile}.publication-state.json.publication-lock/blocker`,
							'active'
						);
						throw primary;
					}
				}
			)
		).rejects.toBe(primary);
		expect(didWriteDiagnostic).toHaveBeenCalled();
		const inspection1 = await stat(
			`${f.inputs.receiptFile}.publication-state.json.publication-lock`
		);
		expect(inspection1.isDirectory()).toBe(true);
	});

	it('refuses false action success when coordinator ownership cannot be released', async () => {
		const f = await fixture();
		f.recorded.set(`default:${app}`, publication(app));
		const run: NonNullable<BuildCohortDependencies['runCupboard']> = async (
			...arguments_
		) => {
			const result = await f.run(...arguments_);
			if (arguments_[1][1] === 'root') {
				await writeFile(
					`${f.inputs.receiptFile}.publication-state.json.publication-lock/blocker`,
					'active'
				);
			}
			return result;
		};
		await expect(f.execute({}, { runCupboard: run })).rejects.toHaveProperty(
			'code',
			'ENOTEMPTY'
		);
		const inspection2 = await stat(
			`${f.inputs.receiptFile}.publication-state.json.publication-lock`
		);
		expect(inspection2.isDirectory()).toBe(true);
	});

	it.each(['begin', 'page', 'capture'] as const)(
		'rejects replacement generation/set after lost %s before any replacement ensure (real envelope transport, modelled HTTP)',
		async (boundary) => {
			const f = await fixture();
			f.faults[boundary] = true;
			await expect(f.execute()).rejects.toThrow('interrupted');
			const capture = f.requests.find(
				(request) => request.operation === 'capture'
			);
			if (capture?.operation !== 'capture') {
				throw new Error('Expected original capture');
			}
			const state = await recoveryState(f.inputs.receiptFile);
			const record = state.captures[capture.input.requestId ?? ''];
			if (record === undefined) {
				throw new Error('Expected capture inventory');
			}
			const file = captureFiles.publicationCaptureFile(
				f.inputs.receiptFile,
				record.requestId
			);
			const checkpoint = await captureFiles.readPublicationCaptureFile(file);
			expect(record).toEqual({
				requestId: capture.input.requestId,
				file: path.basename(file),
				readiness: 'ready',
				input: capture.input
			});
			expect(checkpoint.checkpoint.state.phase).toBe(
				boundary === 'begin' ? 'resolved' : 'begun'
			);
			f.faults[boundary] = false;
			f.recorded.set(
				`default:${app}`,
				recordedPublicationSchema.parse({
					...publication(app),
					result: { ...publication(app).result, generation: 2 },
					digest: 'b'.repeat(64),
					memberCount: 3
				})
			);
			const count = f.requests.length;
			await expect(f.execute()).rejects.toThrow('Conflict');
			expect(f.requests.slice(count)).toEqual([capture]);
			expect(await captureFiles.readPublicationCaptureFile(file)).toEqual(
				checkpoint
			);
			await expect(
				stat(`${f.inputs.receiptFile}.publication-state.json.publication-lock`)
			).rejects.toHaveProperty('code', 'ENOENT');
		}
	);

	it('retains two distinct capture files through later ensure/root failure, and revalidates the earlier result before any new ensure', async () => {
		const f = await fixture([member(app), member(other)]);
		const unrelated = path.join(f.directory, 'unrelated.json');
		await writeFile(unrelated, 'keep');
		f.faults.root = true;
		await expect(f.execute()).rejects.toThrow('not retained');
		const captures = f.requests.filter(
			(request) => request.operation === 'capture'
		);
		const files = captures.map((capture) =>
			captureFiles.publicationCaptureFile(
				f.inputs.receiptFile,
				capture.input.requestId ?? ''
			)
		);
		expect(files).toEqual([...new Set(files)]);
		const saved = await Promise.all(
			files.map((file) => captureFiles.readPublicationCaptureFile(file))
		);
		expect(
			saved.map((envelope) => envelope.request.input.result.storePath)
		).toEqual([app, other]);
		expect(saved.map((envelope) => envelope.checkpoint.state.phase)).toEqual([
			'captured',
			'captured'
		]);
		f.faults.root = false;
		f.faults.ensurePath = other;
		const count = f.requests.length;
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		expect(f.requests.slice(count, count + 2)).toEqual(captures);
		expect(
			await Promise.all(
				files.map((file) => captureFiles.readPublicationCaptureFile(file))
			)
		).toEqual(saved);
		f.recorded.set(
			`default:${app}`,
			recordedPublicationSchema.parse({
				...publication(app),
				result: { ...publication(app).result, generation: 2 },
				digest: 'c'.repeat(64)
			})
		);
		const replayCount = f.requests.length;
		await expect(f.execute()).rejects.toThrow('Conflict');
		expect(f.requests.slice(replayCount)).toEqual([captures[0]]);
		expect(
			await Promise.all(
				files.map((file) => captureFiles.readPublicationCaptureFile(file))
			)
		).toEqual(saved);
		const first = saved[0]?.checkpoint.state;
		if (first?.phase !== 'captured') {
			throw new Error('Expected original completed capture');
		}
		f.recorded.set(`default:${app}`, first.publication);
		f.faults.ensurePath = '';
		await f.execute();
		for (const file of files) {
			await expect(stat(file)).rejects.toHaveProperty('code', 'ENOENT');
		}
		expect(await readFile(unrelated, 'utf8')).toBe('keep');
	});

	it.each(['missing', 'corrupt', 'binding', 'inventory'] as const)(
		'fails closed on a ready %s capture before support/auth/lookup and never resets it',
		async (fault) => {
			const f = await fixture();
			f.faults.root = true;
			await expect(f.execute()).rejects.toThrow('not retained');
			const state = await recoveryState(f.inputs.receiptFile);
			const record = Object.values(state.captures)[0];
			if (record === undefined) {
				throw new Error('Expected capture inventory');
			}
			const file = captureFiles.publicationCaptureFile(
				f.inputs.receiptFile,
				record.requestId
			);
			switch (fault) {
				case 'missing': {
					await rm(file);
					break;
				}
				case 'corrupt': {
					await writeFile(file, 'bad');
					break;
				}
				case 'binding': {
					const envelope = await captureFiles.readPublicationCaptureFile(file);
					await writeFile(
						file,
						JSON.stringify({
							...envelope,
							checkpoint: {
								...envelope.checkpoint,
								binding: {
									...envelope.checkpoint.binding,
									invocation: 'b'.repeat(64)
								}
							}
						})
					);
					break;
				}
				case 'inventory': {
					const text = await readFile(
						`${f.inputs.receiptFile}.publication-state.json`,
						'utf8'
					);
					await writeFile(
						`${f.inputs.receiptFile}.publication-state.json`,
						text.replace(record.file, '../../outside.json')
					);
					break;
				}
			}
			const stateText = await readFile(
				`${f.inputs.receiptFile}.publication-state.json`,
				'utf8'
			);
			const count = f.commands.length;
			const hasSupport = vi.fn(() => Promise.resolve(true));
			await expect(
				f.execute({}, { hasPublicationSupport: hasSupport })
			).rejects.toBeDefined();
			expect(hasSupport).not.toHaveBeenCalled();
			expect(f.commands.slice(count)).toEqual([]);
			expect(
				await readFile(`${f.inputs.receiptFile}.publication-state.json`, 'utf8')
			).toBe(stateText);
		}
	);

	it.each([false, true])(
		'resumes preparing state after exclusive file creation failure (uncertain durable creation %s) without rebuilding',
		async (isUncertain) => {
			const f = await fixture();
			const write = captureFiles.writePublicationStateFile;
			let didFail = false;
			const fault = vi
				.spyOn(captureFiles, 'writePublicationStateFile')
				.mockImplementation(async (file, text, isExclusive) => {
					if (isExclusive && !didFail) {
						didFail = true;
						if (isUncertain) {
							await write(file, text, isExclusive);
						}
						throw new Error('capture file durability failed');
					}
					await write(file, text, isExclusive);
				});
			await expect(f.execute()).rejects.toThrow(
				'capture file durability failed'
			);
			const state = await recoveryState(f.inputs.receiptFile);
			const records = Object.values(state.captures);
			expect(records.map((record) => record.readiness)).toEqual(['preparing']);
			expect(
				f.requests.filter((request) => request.operation === 'capture')
			).toEqual([]);
			fault.mockRestore();
			f.materialise.mockClear();
			f.graph.mockClear();
			f.build.mockClear();
			await f.execute();
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
		}
	);

	it('persists completion before bounded cleanup, refuses an active file writer and finishes interrupted cleanup on reopen', async () => {
		const f = await fixture([member(app), member(other)]);
		let releaseFile: (() => Promise<void>) | undefined;
		let blockedFile = '';
		const run: NonNullable<BuildCohortDependencies['runCupboard']> = async (
			...arguments_
		) => {
			const result = await f.run(...arguments_);
			if (releaseFile === undefined && arguments_[1][1] === 'root') {
				const state = await recoveryState(f.inputs.receiptFile);
				const record = Object.values(state.captures)[1];
				if (record === undefined) {
					throw new Error('Expected second capture');
				}
				blockedFile = captureFiles.publicationCaptureFile(
					f.inputs.receiptFile,
					record.requestId
				);
				releaseFile = await captureFiles.acquirePublicationFile(blockedFile);
			}
			return result;
		};
		await expect(f.execute({}, { runCupboard: run })).rejects.toBeInstanceOf(
			captureFiles.PublicationFileOwnershipError
		);
		const completedState = await recoveryState(f.inputs.receiptFile);
		expect(completedState.phase).toBe('completed');
		const saved = await captureFiles.readPublicationCaptureFile(blockedFile);
		expect(saved.checkpoint.state.phase).toBe('captured');
		const inventory = await readdir(f.directory);
		expect(
			inventory.filter(
				(name) =>
					name.includes('.publication-capture-') && name.endsWith('.json')
			)
		).toEqual([path.basename(blockedFile)]);
		if (releaseFile === undefined) {
			throw new Error('Expected active file owner');
		}
		await releaseFile();
		const unrelated = captureFiles.publicationCaptureFile(
			path.join(f.directory, 'other-receipt'),
			saved.checkpoint.binding.input.requestId
		);
		await writeFile(unrelated, 'unrelated');
		await f.execute();
		await expect(stat(blockedFile)).rejects.toHaveProperty('code', 'ENOENT');
		await expect(
			stat(`${f.inputs.receiptFile}.publication-state.json`)
		).rejects.toHaveProperty('code', 'ENOENT');
		expect(await readFile(unrelated, 'utf8')).toBe('unrelated');
	});

	it.each(['open', 'support', 'recover', 'lookup', 'cancel'] as const)(
		'releases coordinator ownership after early %s failure',
		async (boundary) => {
			const f = await fixture();
			const controller = new AbortController();
			switch (boundary) {
				case 'open': {
					await writeFile(
						`${f.inputs.receiptFile}.publication-state.json`,
						'corrupt'
					);

					break;
				}
				case 'recover': {
					f.faults.capture = true;
					await expect(f.execute()).rejects.toThrow('interrupted');
					f.faults.capture = false;
					f.faults.authority = true;

					break;
				}
				case 'lookup': {
					f.faults.lookup = true;

					break;
				}
				// No default
			}
			const hasSupport = () => {
				if (boundary === 'support') {
					throw new Error('support failed');
				}
				if (boundary === 'cancel') {
					controller.abort(new Error('cancelled'));
				}
				return Promise.resolve(true);
			};
			await expect(
				f.execute(
					{},
					{ hasPublicationSupport: hasSupport, signal: controller.signal }
				)
			).rejects.toBeDefined();
			await expect(
				stat(`${f.inputs.receiptFile}.publication-state.json.publication-lock`)
			).rejects.toHaveProperty('code', 'ENOENT');
		}
	);

	it('does not release another coordinator after failed acquisition, including a lock-left retry', async () => {
		const f = await fixture();
		const lock = `${f.inputs.receiptFile}.publication-state.json.publication-lock`;
		await mkdir(lock);
		await expect(f.execute()).rejects.toBeInstanceOf(
			captureFiles.PublicationFileOwnershipError
		);
		const inspection3 = await stat(lock);
		expect(inspection3.isDirectory()).toBe(true);
		expect(f.commands).toEqual([]);
		await expect(f.execute()).rejects.toThrow(
			'verify the original writer is inactive'
		);
		const inspection4 = await stat(lock);
		expect(inspection4.isDirectory()).toBe(true);
	});

	it('awaits genuine old-peer fallback while still owning the receipt/output domain', async () => {
		const f = await fixture();
		await f.execute(
			{},
			{
				hasPublicationSupport: () => Promise.resolve(false),
				runNixBuild: async (installables) => {
					const inspection5 = await stat(
						`${f.inputs.receiptFile}.publication-state.json.publication-lock`
					);
					expect(inspection5.isDirectory()).toBe(true);
					return f.build(installables);
				}
			}
		);
		await expect(
			stat(`${f.inputs.receiptFile}.publication-state.json.publication-lock`)
		).rejects.toHaveProperty('code', 'ENOENT');
	});

	it('rejects ambiguous v2 cold capture state but safely migrates source-proven no-capture v2 state', async () => {
		const f = await fixture();
		f.recorded.set(`default:${app}`, publication(app));
		f.faults.root = true;
		await expect(f.execute()).rejects.toThrow('not retained');
		const stateFile = `${f.inputs.receiptFile}.publication-state.json`;
		const json: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
		const legacy = z
			.object({ version: z.number(), phase: z.string(), captures: z.unknown() })
			.loose()
			.parse(json);
		const { phase: _phase, captures: _captures, ...rest } = legacy;
		await writeFile(stateFile, JSON.stringify({ ...rest, version: 2 }));
		f.faults.root = false;
		await f.execute();
		const cold = await fixture();
		cold.faults.capture = true;
		await expect(cold.execute()).rejects.toThrow('interrupted');
		const coldFile = `${cold.inputs.receiptFile}.publication-state.json`;
		const coldJson: unknown = JSON.parse(await readFile(coldFile, 'utf8'));
		const old = z
			.object({ phase: z.string(), captures: z.unknown() })
			.loose()
			.parse(coldJson);
		const { phase: _coldPhase, captures: _coldCaptures, ...oldRest } = old;
		const text = JSON.stringify({ ...oldRest, version: 2 });
		await writeFile(coldFile, text);
		await expect(cold.execute()).rejects.toThrow('ambiguous');
		expect(await readFile(coldFile, 'utf8')).toBe(text);
	});

	it.each([
		{ publish: 'outputs', store: '' },
		{ publish: 'built', store: '' },
		{ publish: 'closure', store: '' },
		{ publish: 'outputs', store: 'ssh-ng://builder.example.test' }
	])(
		'uses default hidden help detection and completes all-warm $publish $store with zero graph, closure, build, member receipt or publication work',
		async ({ publish, store }) => {
			const f = await fixture([member(app)], { publish, store });
			f.recorded.set(`default:${app}`, publication(app));
			f.rootTargets.set(f.inputs.runRoot, new Set(['another-cohort-target']));
			await f.execute();
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			expect(f.commands.map((argv) => argv[1])).toEqual([
				'publication-result',
				'publication-result',
				'publication-result',
				'root'
			]);
			expect(f.requests.map((request) => request.operation)).toEqual([
				'lookup',
				'prepare-run-root',
				'ensure'
			]);
			expect(f.rootTargets.get(f.inputs.runRoot)).toEqual(
				new Set(['another-cohort-target', app])
			);
			expect(await f.receipt()).toMatchObject({
				version: 4,
				paths: [app],
				subjects: [],
				publicationSets: [{ memberCount: 2 }]
			});
			expect(f.commands.at(-1)).toContain('--github-oidc');
			expect(
				JSON.parse(await readFile(f.inputs.leftUpstreamFile, 'utf8'))
			).toStrictEqual({ leftUpstream: [] });
			expect(await readFile(f.inputs.intermediatePathsFile, 'utf8')).toBe('');
			expect(await readFile(f.inputs.referencePathsFile, 'utf8')).toBe('');
			expect(
				JSON.parse(await readFile(f.inputs.countsFile, 'utf8'))
			).toStrictEqual({});
		}
	);

	it('creates a separate nested target output directory after all-warm publication', async () => {
		const f = await fixture();
		const outputs = {
			receiptFile: path.join(f.directory, 'receipts', 'receipt.json'),
			targetPathsFile: path.join(f.directory, 'targets', 'nested', 'paths.txt')
		};
		const source = publication(app);
		f.recorded.set(`default:${app}`, source);
		await expect(
			stat(path.dirname(outputs.targetPathsFile))
		).rejects.toMatchObject({
			code: 'ENOENT'
		});

		await f.execute(outputs);

		expect(await readFile(outputs.targetPathsFile, 'utf8')).toBe(`${app}\n`);
		const completed = [{ ...source, materialisation: 'complete' }];
		expect(
			JSON.parse(await readFile(outputs.receiptFile, 'utf8'))
		).toStrictEqual({
			version: 4,
			paths: [app],
			subjects: [],
			publicationSets: completed
		});
		expect(
			f.report.mock.calls.findLast(
				([event]) => event.kind === 'build-summary-v4'
			)?.[0].data
		).toStrictEqual({
			version: 4,
			mode: 'streamed',
			store: 'auto',
			targetPaths: 1,
			intermediatePaths: 0,
			queueDepth: 0,
			uploadedPaths: 0,
			skipped: 0,
			childExitStatus: 0,
			unconfirmedPaths: [],
			publicationSets: completed
		});
		expect(f.requests.map((request) => request.operation)).toStrictEqual([
			'lookup',
			'prepare-run-root',
			'ensure'
		]);
		expect(
			f.commands.filter((argv) => argv[1] !== 'publication-result')
		).toStrictEqual([
			['--no-colour', 'root', 'ensure', url, root, app, '--github-oidc']
		]);
		expect(f.rootTargets).toStrictEqual(
			new Map([
				[f.inputs.runRoot, new Set([app])],
				[root, new Set([app])]
			])
		);
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		expect(f.dependencies.runNixDerivationShow).not.toHaveBeenCalled();
		await expect(
			readFile(`${outputs.receiptFile}.publication-state.json`, 'utf8')
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('accepts the destination winner origin for an otherwise identical recorded set', async () => {
		const f = await fixture();
		const source = publication(app);
		f.recorded.set(`default:${app}`, source);
		f.setDestinationOrigin('legacy-selection');

		await f.execute();

		expect(await f.receipt()).toStrictEqual({
			version: 4,
			paths: [app],
			subjects: [],
			publicationSets: [
				{
					...source,
					origin: 'legacy-selection',
					materialisation: 'complete'
				}
			]
		});
	});

	it('replaces each named root once with its mixed warm/cold union after acceptance, preserving retention', async () => {
		const f = await fixture([member(app), member(other)], {
			ttl: '3d',
			audience: 'test-audience'
		});
		f.recorded.set(`default:${app}`, publication(app));
		f.setReceipt(
			buildReceiptV3Schema.parse({
				version: 3,
				paths: [other],
				subjects: [
					{
						origin: 'built',
						storePath: other,
						narHash: '00'.repeat(32),
						derivation: `${other}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}
				]
			})
		);
		await f.execute();
		expect(f.materialise).toHaveBeenCalledWith(['.#other'], undefined);
		expect(f.rootTargets.get(root)).toEqual(new Set([app, other]));
		const replacements = f.commands.filter((argv) => argv[1] === 'root');
		expect(replacements).toHaveLength(1);
		expect(replacements[0]).toEqual(
			expect.arrayContaining([
				'--ttl',
				'3d',
				'--audience',
				'test-audience',
				app,
				other
			])
		);
		expect(
			f.commands
				.filter((argv) => argv[1] === 'push')
				.every(
					(argv) => argv.includes('--no-retain') && !argv.includes('--root')
				)
		).toBe(true);
		expect(
			f.requests.filter((request) => request.operation === 'prepare-run-root')
		).toHaveLength(1);
		const receipt = await f.receipt();
		expect(receipt.subjects).toHaveLength(1);
		expect(receipt.subjects[0]).toMatchObject({
			origin: 'built',
			storePath: other
		});
	});

	it('runs the legacy bounded path once, captures its actual footprint and reuses it without graph work next invocation', async () => {
		const f = await fixture();
		f.accepted.add(app);
		f.setReceipt(
			buildReceiptV3Schema.parse({
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'store-held',
						storePath: app,
						narHash: '00'.repeat(32),
						derivation: `${app}.drv`,
						buildStore: 'auto'
					}
				]
			})
		);
		await f.execute();
		expect(f.materialise).toHaveBeenCalledTimes(1);
		expect(
			f.requests.find((request) => request.operation === 'capture')
		).toMatchObject({
			input: { origin: 'legacy-selection', members: [{ storePath: app }] }
		});
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		f.commands.length = 0;
		await f.execute();
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		const receipt = await f.receipt();
		expect(receipt.subjects).toEqual([]);
	});

	it('preserves exact view selection and revision on ensure without mutating the source', async () => {
		const f = await fixture([member(app)], { reuseView: 'release' });
		f.recorded.set(
			`view:${app}`,
			publication(app, { kind: 'named', name: 'release-cache' })
		);
		await f.execute();
		const ensure = f.requests.find((request) => request.operation === 'ensure');
		expect(ensure).toMatchObject({
			input: {
				sourceSelector: { view: 'release', expectedRevision: 7 },
				source: { result: { cache: { kind: 'named', name: 'release-cache' } } }
			}
		});
		expect(
			f.commands.every((argv) =>
				argv.every((argument) => !argument.includes('/cache/release-cache'))
			)
		).toBe(true);
		expect(f.requests.some((request) => request.operation === 'capture')).toBe(
			false
		);
	});

	it('keeps shared run-root attachments additive across independently completed cohorts', async () => {
		const f = await fixture([member(app)]);
		f.recorded.set(`default:${app}`, publication(app));
		f.recorded.set(`default:${other}`, publication(other));
		await f.execute();
		await f.execute({ cohortJson: matrix([member(other)], 'second') });
		expect(f.rootTargets.get(f.inputs.runRoot)).toEqual(new Set([app, other]));
		expect(
			f.requests.filter((request) => request.operation === 'prepare-run-root')
		).toHaveLength(2);
	});

	it('replays an interrupted ensure with the same UUID, then creates a fresh retention event after full success', async () => {
		const f = await fixture();
		f.recorded.set(`default:${app}`, publication(app));
		f.faults.ensure = true;
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		const first = f.requests.find((request) => request.operation === 'ensure');
		f.faults.ensure = false;
		await f.execute();
		const ensures = f.requests.filter(
			(request) => request.operation === 'ensure'
		);
		expect(ensures[1]).toEqual(first);
		await f.execute();
		const fresh = f.requests.findLast(
			(request) => request.operation === 'ensure'
		);
		expect(fresh).not.toEqual(first);
		expect(
			f.requests.filter((request) => request.operation === 'prepare-run-root')
		).toHaveLength(2);
		expect(f.materialise).not.toHaveBeenCalled();
	});

	it.each(['root', 'prepare', 'ensure'] as const)(
		'fails closed on %s failure without graph/member fallback',
		async (fault) => {
			const f = await fixture();
			f.recorded.set(`default:${app}`, publication(app));
			f.faults[fault] = true;
			await expect(f.execute()).rejects.toThrow();
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			const receipt = await f.receipt();
			expect(receipt.terminalFailure).toEqual({ kind: 'command' });
		}
	);

	it.each([app, other])(
		'reports every selected warm target when ensure fails at %s',
		async (failedPath) => {
			const f = await fixture([member(app), member(other)]);
			const first = publication(app);
			f.recorded.set(`default:${app}`, first);
			f.recorded.set(`default:${other}`, publication(other));
			f.faults.ensurePath = failedPath;
			await expect(f.execute()).rejects.toThrow('ensure interrupted');
			if (failedPath === other) {
				// Even a failure replaying the first ensure must retain its earlier completion.
				f.faults.ensurePath = app;
				await expect(f.execute()).rejects.toThrow('ensure interrupted');
			}
			const completed =
				failedPath === app ? [] : [{ ...first, materialisation: 'complete' }];
			expect(await f.receipt()).toStrictEqual({
				version: 4,
				paths: failedPath === app ? [] : [app],
				subjects: [],
				publicationSets: completed,
				terminalFailure: { kind: 'command' }
			});
			expect(
				f.report.mock.calls.findLast(
					([event]) => event.kind === 'build-summary-v4'
				)?.[0].data
			).toStrictEqual({
				version: 4,
				mode: 'streamed',
				store: 'auto',
				targetPaths: 2,
				intermediatePaths: 0,
				queueDepth: 0,
				uploadedPaths: 0,
				skipped: 0,
				childExitStatus: 0,
				unconfirmedPaths: failedPath === app ? [app, other] : [other],
				publicationSets: completed
			});
		}
	);

	it('counts known cold requested results when a warm ensure fails before any cold execution', async () => {
		const f = await fixture([member(app), member(other)]);
		f.recorded.set(`default:${app}`, publication(app));
		f.faults.ensure = true;
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		expect(await f.receipt()).toStrictEqual({
			version: 4,
			paths: [],
			subjects: [],
			publicationSets: [],
			terminalFailure: { kind: 'command' }
		});
		expect(
			f.report.mock.calls.findLast(
				([event]) => event.kind === 'build-summary-v4'
			)?.[0].data
		).toStrictEqual({
			version: 4,
			mode: 'streamed',
			store: 'auto',
			targetPaths: 2,
			intermediatePaths: 0,
			queueDepth: 0,
			uploadedPaths: 0,
			skipped: 0,
			childExitStatus: 0,
			unconfirmedPaths: [app, other],
			publicationSets: []
		});
	});

	it.each([
		{
			bestEffort: 'false',
			kind: 'target',
			rejects: true,
			interruptEnsure: false
		},
		{
			bestEffort: 'false',
			kind: 'target',
			rejects: true,
			interruptEnsure: true
		},
		{
			bestEffort: 'true',
			kind: 'protocol',
			rejects: true,
			interruptEnsure: false
		},
		{
			bestEffort: 'true',
			kind: 'protocol',
			rejects: true,
			interruptEnsure: true
		},
		{
			bestEffort: 'true',
			kind: 'target',
			rejects: false,
			interruptEnsure: true
		}
	] as const)(
		'preserves original remote $kind failure policy with best-effort $bestEffort across recovery (ensure interruption $interruptEnsure)',
		async ({ bestEffort, kind, rejects, interruptEnsure }) => {
			const f = await fixture([member(app), member(other)], {
				store: 'ssh-ng://builder.example.test',
				bestEffort
			});
			f.setReceipt(
				buildReceiptV3Schema.parse({
					version: 3,
					paths: [app],
					subjects: [
						{
							origin: 'store-held',
							storePath: app,
							narHash: '00'.repeat(32),
							derivation: `${app}.drv`,
							buildStore: f.inputs.store
						}
					]
				})
			);
			const failures: readonly RemoteCohortBuildFailure[] = [
				{
					target: `${other}.drv^out`,
					kind,
					outcome: kind === 'target' ? 'permanent-failure' : 'missing-result',
					message: 'remote target failed'
				}
			];
			const remote = vi.fn<
				NonNullable<BuildCohortDependencies['runNixBuildWithResults']>
			>(async (_installables, _maxJobs, _store, publish) => {
				await publish(
					[
						{
							target: `${storePathSchema.parse(`${app}.drv`)}^out`,
							execution: 'local',
							outcome: { kind: 'built', outputs: { out: app } },
							timesBuilt: 1,
							nonDeterministic: false,
							startTime: 1,
							stopTime: 2
						}
					],
					failures,
					[app],
					new Set(),
					new Map()
				);
				throw new RemoteCohortBuildFailedError(failures);
			});
			f.faults.ensure = interruptEnsure;
			await expect(
				f.execute({}, { runNixBuildWithResults: remote })
			).rejects.toThrow(
				interruptEnsure ? 'ensure interrupted' : 'Remote Nix did not complete'
			);
			expect(remote).toHaveBeenCalledTimes(1);
			const firstCaptures = f.requests.filter(
				(request) => request.operation === 'capture'
			);
			const firstEnsures = f.requests.filter(
				(request) => request.operation === 'ensure'
			);
			const completed = [
				{
					...publication(app),
					origin: 'legacy-selection',
					memberCount: 1,
					materialisation: 'complete'
				}
			];
			const originalReceipt = {
				version: 4,
				paths: [app],
				subjects: [
					{
						origin: 'store-held',
						storePath: app,
						narHash: '00'.repeat(32),
						derivation: `${app}.drv`,
						buildStore: f.inputs.store
					}
				],
				uploaded: [],
				terminalFailure:
					kind === 'target'
						? { kind: 'target-build', failedTargets: [`${other}.drv^out`] }
						: { kind: 'command' },
				publicationSets: interruptEnsure ? [] : completed
			};
			expect(await f.receipt()).toStrictEqual(originalReceipt);
			const stateFile = `${f.inputs.receiptFile}.publication-state.json`;
			const originalState = JSON.parse(await readFile(stateFile, 'utf8')) as {
				cold: unknown;
			};
			f.faults.ensure = false;
			f.materialise.mockClear();
			f.graph.mockClear();
			f.build.mockClear();
			remote.mockClear();
			const count = f.requests.length;
			const recovery = f.execute({}, { runNixBuildWithResults: remote });
			if (rejects) {
				await expect(recovery).rejects.toThrow(
					kind === 'target' ? 'required targets' : 'command failure'
				);
			} else {
				await recovery;
			}
			expect(f.requests.slice(count)).toStrictEqual([
				...firstCaptures,
				...firstEnsures
			]);
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			expect(remote).not.toHaveBeenCalled();
			expect(await f.receipt()).toStrictEqual({
				...originalReceipt,
				publicationSets: completed
			});
			expect(f.commands.filter((argv) => argv[1] === 'root')).toStrictEqual([]);
			if (rejects) {
				const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
					cold: unknown;
				};
				expect(state.cold).toStrictEqual(originalState.cold);
				await expect(
					f.execute({}, { runNixBuildWithResults: remote })
				).rejects.toThrow();
				expect(remote).not.toHaveBeenCalled();
			} else {
				await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({
					code: 'ENOENT'
				});
				// A genuine invocation may reuse the set, but must execute the failed sibling afresh.
				remote.mockImplementationOnce(() =>
					Promise.reject(new Error('fresh cold execution'))
				);
				await expect(
					f.execute({}, { runNixBuildWithResults: remote })
				).rejects.toThrow('fresh cold execution');
				expect(remote).toHaveBeenCalledTimes(1);
				const freshReceipt = await f.receipt();
				expect(freshReceipt).toStrictEqual({
					version: 4,
					paths: [app],
					subjects: [],
					publicationSets: completed,
					terminalFailure: { kind: 'command' }
				});
			}
		}
	);

	it.each(['capture', 'ensure', 'root'] as const)(
		'restores same-invocation cold evidence after %s interruption without rebuilding or graph work',
		async (fault) => {
			const f = await fixture();
			const original = buildReceiptV3Schema.parse({
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'built',
						storePath: app,
						narHash: '00'.repeat(32),
						derivation: `${app}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}
				],
				uploaded: [app],
				childExitStatus: 0
			});
			f.setReceipt(original);
			f.faults[fault] = true;
			await expect(f.execute()).rejects.toThrow();
			f.faults[fault] = false;
			f.materialise.mockClear();
			f.graph.mockClear();
			f.build.mockClear();
			f.commands.length = 0;
			await rm(f.inputs.receiptFile);
			if (fault === 'ensure') {
				f.faults.ensure = true;
				await expect(f.execute()).rejects.toThrow('ensure interrupted');
				expect(await f.receipt()).toStrictEqual({
					...original,
					version: 4,
					publicationSets: [],
					terminalFailure: { kind: 'command' }
				});
				f.faults.ensure = false;
			}
			await f.execute();
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			expect(
				f.commands.every(
					(argv) => argv[1] === 'publication-result' || argv[1] === 'root'
				)
			).toBe(true);
			expect(await f.receipt()).toStrictEqual({
				...original,
				version: 4,
				publicationSets: [
					{ ...publication(app), memberCount: 1, materialisation: 'complete' }
				]
			});
			expect(
				f.report.mock.calls.findLast(
					([event]) => event.kind === 'build-summary-v4'
				)?.[0].data
			).toStrictEqual({
				version: 4,
				mode: 'streamed',
				store: 'auto',
				targetPaths: 1,
				intermediatePaths: 0,
				queueDepth: 0,
				uploadedPaths: 1,
				skipped: 0,
				childExitStatus: 0,
				unconfirmedPaths: [],
				publicationSets: [
					{ ...publication(app), memberCount: 1, materialisation: 'complete' }
				]
			});
			// A completed invocation's leftover receipt is not evidence for the next one.
			await f.execute();
			expect(await f.receipt()).toStrictEqual({
				version: 4,
				paths: [app],
				subjects: [],
				publicationSets: [
					{ ...publication(app), memberCount: 1, materialisation: 'complete' }
				]
			});
		}
	);

	it.each(['capture', 'ensure', 'root'] as const)(
		'preserves full cold output inventories and counts after %s interruption',
		async (fault) => {
			const upstream = storePathSchema.parse(
				`/nix/store/${'3'.repeat(32)}-upstream`
			);
			const f = await fixture([member(app), member(other), member(upstream)], {
				publish: 'built',
				reuseView: 'release'
			});
			f.planSelection.publishByReference.push(other);
			const original = buildReceiptV3Schema.parse({
				version: 3,
				paths: [app, other, tool],
				leftUpstream: [upstream],
				childExitStatus: 0,
				uploaded: [app, tool],
				subjects: [app, tool].map((storePath) => ({
					origin: 'built',
					storePath,
					narHash: '00'.repeat(32),
					derivation: `${storePath}.drv`,
					buildStore: 'auto',
					verification: 'local'
				}))
			});
			f.setReceipt(original);
			f.faults[fault] = true;
			await expect(f.execute()).rejects.toThrow(
				fault === 'capture'
					? 'capture reply interrupted'
					: fault === 'ensure'
						? 'ensure interrupted'
						: 'not retained'
			);
			const files = {
				targets: f.inputs.targetPathsFile,
				intermediates: f.inputs.intermediatePathsFile,
				references: f.inputs.referencePathsFile,
				leftUpstream: f.inputs.leftUpstreamFile,
				counts: f.inputs.countsFile
			};
			const readOutputs = async () => ({
				targets: await readFile(files.targets, 'utf8'),
				intermediates: await readFile(files.intermediates, 'utf8'),
				references: await readFile(files.references, 'utf8'),
				leftUpstream: await readFile(files.leftUpstream, 'utf8'),
				counts: await readFile(files.counts, 'utf8')
			});
			const outputs = await readOutputs();
			expect(outputs).toStrictEqual({
				targets: `${app}\n${other}\n`,
				intermediates: `${other}\n${tool}\n`,
				references: `${other}\n`,
				leftUpstream: `${JSON.stringify({ leftUpstream: [upstream] }, undefined, 2)}\n`,
				counts: `${JSON.stringify(
					{
						partition: {
							counts: { willBuild: 3, willSubstitute: 0, unknown: 0 },
							downloadSize: 0,
							narSize: 0,
							unknownCount: 0,
							ceiling: { value: 5, source: 'configured' }
						},
						capacity: { available: 100, capacity: 100, headroom: 0 }
					},
					undefined,
					2
				)}\n`
			});
			f.faults[fault] = false;
			f.materialise.mockClear();
			f.graph.mockClear();
			f.build.mockClear();
			f.commands.length = 0;
			await Promise.all(Object.values(files).map((file) => rm(file)));
			f.faults.ensure = true;
			await expect(f.execute()).rejects.toThrow('ensure interrupted');
			expect(await readOutputs()).toStrictEqual(outputs);
			f.faults.ensure = false;
			await f.execute();
			const recovered = await readOutputs();
			expect(recovered).toStrictEqual(outputs);
			expect({
				targets: recovered.targets.split('\n').filter(Boolean),
				intermediates: recovered.intermediates.split('\n').filter(Boolean),
				references: recovered.references.split('\n').filter(Boolean),
				leftUpstream: JSON.parse(recovered.leftUpstream) as unknown,
				counts: JSON.parse(recovered.counts) as unknown
			}).toStrictEqual({
				targets: [app, other],
				intermediates: [other, tool],
				references: [other],
				leftUpstream: { leftUpstream: [upstream] },
				counts: {
					partition: {
						counts: { willBuild: 3, willSubstitute: 0, unknown: 0 },
						downloadSize: 0,
						narSize: 0,
						unknownCount: 0,
						ceiling: { value: 5, source: 'configured' }
					},
					capacity: { available: 100, capacity: 100, headroom: 0 }
				}
			});
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			expect(
				f.requests.filter((request) => request.operation === 'lookup')
			).toHaveLength(2);
			expect(
				f.commands.every(
					(argv) => argv[1] === 'publication-result' || argv[1] === 'root'
				)
			).toBe(true);
			const publicationSets = [app, other].map((output) => ({
				...publication(output),
				origin: output === app ? 'build-selection' : 'legacy-selection',
				memberCount: 1,
				materialisation: 'complete'
			}));
			expect(await f.receipt()).toStrictEqual({
				...original,
				version: 4,
				publicationSets
			});
			expect(f.rootTargets.get(root)).toStrictEqual(new Set([app, other]));
			expect(f.rootTargets.get(f.inputs.runRoot)).toStrictEqual(
				new Set([app, other])
			);
			expect(
				f.report.mock.calls.findLast(
					([event]) => event.kind === 'build-summary-v4'
				)?.[0].data
			).toStrictEqual({
				version: 4,
				mode: 'streamed',
				store: 'auto',
				targetPaths: 3,
				intermediatePaths: 1,
				queueDepth: 0,
				uploadedPaths: 2,
				skipped: 0,
				childExitStatus: 0,
				unconfirmedPaths: [],
				publicationSets
			});
		}
	);

	it.each([{ maxJobs: '2' }, { gcBetweenCohorts: 'true' }])(
		'rejects changed execution options %j before any discovery or remote work',
		async (changed) => {
			const f = await fixture();
			f.faults.ensure = true;
			await expect(f.execute()).rejects.toThrow('ensure interrupted');
			const stateFile = `${f.inputs.receiptFile}.publication-state.json`;
			const state = await readFile(stateFile, 'utf8');
			const receipt = await f.receipt();
			f.materialise.mockClear();
			f.graph.mockClear();
			f.build.mockClear();
			f.commands.length = 0;
			const hasSupport = vi.fn(() => Promise.resolve(true));
			await expect(
				f.execute(changed, { hasPublicationSupport: hasSupport })
			).rejects.toThrow('different cohort invocation');
			expect(hasSupport).not.toHaveBeenCalled();
			expect(f.commands).toStrictEqual([]);
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			expect(await readFile(stateFile, 'utf8')).toBe(state);
			expect(await f.receipt()).toStrictEqual(receipt);
		}
	);

	it.each([
		'GITHUB_SERVER_URL',
		'GITHUB_JOB',
		'GITHUB_ACTION',
		'GITHUB_ACTION_REPOSITORY',
		'GITHUB_ACTION_REF',
		'GITHUB_RUN_ID',
		'GITHUB_RUN_ATTEMPT',
		'GITHUB_SHA',
		'GITHUB_REPOSITORY',
		'GITHUB_WORKFLOW_REF',
		'GITHUB_WORKFLOW_SHA',
		'GITHUB_WORKFLOW',
		'GITHUB_WORKSPACE'
	])('refuses cold evidence from a different %s', async (key) => {
		const f = await fixture();
		f.faults.ensure = true;
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		f.environment[key] = 'changed';
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		await expect(f.execute()).rejects.toThrow('different cohort invocation');
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
	});

	it('restores a mixed cohort partial child failure and incomplete root without rebuilding or widening source permissions', async () => {
		const f = await fixture([member(app), member(other), member(tool)], {
			bestEffort: 'true',
			reuseView: 'release'
		});
		const source = publication(app, { kind: 'named', name: 'release-cache' });
		f.recorded.set(`view:${app}`, source);
		const original = buildReceiptV3Schema.parse({
			version: 3,
			paths: [other],
			subjects: [
				{
					origin: 'built',
					storePath: other,
					narHash: '00'.repeat(32),
					derivation: `${other}.drv`,
					buildStore: 'auto',
					verification: 'local'
				}
			],
			uploaded: [other],
			childExitStatus: 1,
			terminalFailure: {
				kind: 'target-build',
				failedTargets: [`${tool}.drv^out`]
			}
		});
		f.setReceipt(original);
		f.faults.failBuild = true;
		f.faults.ensurePath = other;
		f.rootTargets.set(root, new Set(['previous-root-target']));
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		const firstCaptures = f.requests.filter(
			(request) => request.operation === 'capture'
		);
		const firstEnsures = f.requests.filter(
			(request) => request.operation === 'ensure'
		);
		f.faults.ensurePath = '';
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		const requestCount = f.requests.length;
		await f.execute();
		expect(f.requests.slice(requestCount)).toStrictEqual([
			...firstCaptures,
			...firstEnsures
		]);
		expect(f.requests.slice(requestCount)[1]).toStrictEqual({
			operation: 'ensure',
			input: {
				source,
				sourceSelector: { view: 'release', expectedRevision: 7 },
				runRoot: f.inputs.runRoot,
				requestId: firstEnsures[0]?.input.requestId
			}
		});
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		expect(f.rootTargets.get(root)).toStrictEqual(
			new Set(['previous-root-target'])
		);
		expect(f.commands.filter((argv) => argv[1] === 'root')).toStrictEqual([]);
		expect(await f.receipt()).toStrictEqual({
			...original,
			version: 4,
			paths: [app, other],
			publicationSets: [
				{
					...source,
					result: { ...source.result, cache: defaultCache },
					materialisation: 'complete'
				},
				{ ...publication(other), memberCount: 1, materialisation: 'complete' }
			]
		});
	});

	it('resumes remaining multi-output captures using persisted actual ownership, without a new graph or build', async () => {
		const f = await fixture([
			{
				attr: 'multi',
				installable: '.#multi',
				queryInstallable: `${app}.drv^dev,out`,
				root
			}
		]);
		const original = buildReceiptV3Schema.parse({
			version: 3,
			paths: [app, other],
			subjects: [app, other].map((storePath) => ({
				origin: 'built',
				storePath,
				narHash: '00'.repeat(32),
				derivation: `${app}.drv`,
				buildStore: 'auto',
				verification: 'local'
			}))
		});
		f.setReceipt(original);
		f.faults.ensurePath = app;
		const build = vi.fn(() =>
			Promise.resolve({
				paths: [app, other],
				status: 0,
				copiedFrom: new Map<StorePathString, readonly string[]>()
			})
		);
		await expect(f.execute({}, { runNixBuild: build })).rejects.toThrow(
			'ensure interrupted'
		);
		f.faults.ensurePath = '';
		f.materialise.mockClear();
		f.graph.mockClear();
		build.mockClear();
		await f.execute({}, { runNixBuild: build });
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(build).not.toHaveBeenCalled();
		expect(f.rootTargets.get(root)).toStrictEqual(new Set([app, other]));
		expect(await f.receipt()).toStrictEqual({
			...original,
			version: 4,
			uploaded: [],
			publicationSets: [app, other].map((output) => ({
				...publication(output),
				memberCount: 1,
				materialisation: 'complete'
			}))
		});
	});

	it('preserves deliberately upstream outputs across cold recovery without adding them to captures or roots', async () => {
		const f = await fixture([member(app), member(other)], {
			substituter: 'leave'
		});
		const original = buildReceiptV3Schema.parse({
			version: 3,
			paths: [app],
			leftUpstream: [other],
			uploaded: [app],
			subjects: [
				{
					origin: 'built',
					storePath: app,
					narHash: '00'.repeat(32),
					derivation: `${app}.drv`,
					buildStore: 'auto',
					verification: 'local'
				}
			]
		});
		f.setReceipt(original);
		f.faults.root = true;
		await expect(f.execute()).rejects.toThrow('not retained');
		f.faults.root = false;
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		await f.execute();
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		expect(f.rootTargets.get(root)).toStrictEqual(new Set([app]));
		expect(
			JSON.parse(await readFile(f.inputs.leftUpstreamFile, 'utf8'))
		).toStrictEqual({ leftUpstream: [other] });
		expect(
			f.report.mock.calls.findLast(
				([event]) => event.kind === 'build-summary-v4'
			)?.[0].data
		).toStrictEqual({
			version: 4,
			mode: 'streamed',
			store: 'auto',
			targetPaths: 2,
			intermediatePaths: 0,
			queueDepth: 0,
			uploadedPaths: 1,
			skipped: 0,
			childExitStatus: 0,
			unconfirmedPaths: [],
			publicationSets: [
				{ ...publication(app), memberCount: 1, materialisation: 'complete' }
			]
		});
		expect(await f.receipt()).toStrictEqual({
			...original,
			version: 4,
			publicationSets: [
				{
					...publication(app),
					memberCount: 1,
					materialisation: 'complete'
				}
			]
		});
	});

	it('refuses ambiguous older recovery state without consuming its leftover receipt', async () => {
		const f = await fixture();
		f.faults.ensure = true;
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		const receipt = await f.receipt();
		const file = `${f.inputs.receiptFile}.publication-state.json`;
		const state = JSON.parse(await readFile(file, 'utf8')) as Record<
			string,
			unknown
		>;
		state.version = 1;
		await writeFile(file, JSON.stringify(state));
		f.commands.length = 0;
		await expect(f.execute()).rejects.toThrow();
		expect(f.commands).toStrictEqual([]);
		expect(await f.receipt()).toStrictEqual(receipt);
	});

	it('keeps credentials out of replay state while binding recovery to the working directory', async () => {
		const f = await fixture();
		f.environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'secret-oidc';
		f.environment.CUPBOARD_TOKEN = 'secret-cupboard';
		f.environment.ARBITRARY_ENV_SECRET = 'secret-env';
		f.faults.ensure = true;
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		const file = `${f.inputs.receiptFile}.publication-state.json`;
		const text = await readFile(file, 'utf8');
		expect(text.includes('secret-')).toBe(false);
		const state = JSON.parse(text) as { identity: string };
		const identity = JSON.parse(state.identity) as Record<string, unknown>;
		expect(identity.cwd).toBe(process.cwd());
		identity.cwd = '/another/checkout';
		state.identity = JSON.stringify(identity);
		await writeFile(file, JSON.stringify(state));
		f.commands.length = 0;
		await expect(f.execute()).rejects.toThrow('different cohort invocation');
		expect(f.commands).toStrictEqual([]);
	});

	it('does not downgrade when support disappears after interrupted recorded selection', async () => {
		const f = await fixture();
		f.recorded.set(`default:${app}`, publication(app));
		f.faults.ensure = true;
		await expect(f.execute()).rejects.toThrow();
		f.faults.ensure = false;
		f.faults.unsupported = true;
		await expect(f.execute()).rejects.toThrow('support changed');
		expect(f.materialise).not.toHaveBeenCalled();
	});

	it('treats provider/stale-view errors as failures before graph work, not cache misses', async () => {
		const f = await fixture();
		f.faults.lookup = true;
		await expect(f.execute()).rejects.toThrow('provider or stale-view');
		expect(f.materialise).not.toHaveBeenCalled();
	});

	it('permits initial genuine old-server non-support to use the existing bounded path', async () => {
		const f = await fixture();
		f.faults.unsupported = true;
		await f.execute();
		expect(f.materialise).toHaveBeenCalledTimes(1);
		const receipt = await f.receipt();
		expect(receipt.version).toBe(3);
		expect(f.requests.map((request) => request.operation)).toEqual(['lookup']);
	});

	it.each(
		[
			{ kind: 'rebuild', outputs: [app] },
			{ kind: 'unknown', outputs: [app, other] },
			{ kind: 'multi-output', outputs: [app, other] }
		].flatMap((entry) =>
			[false, true].map((supported) => ({ ...entry, supported }))
		)
	)(
		'negotiates initial peer $kind with the current hidden command before allocating capture recovery (support $supported)',
		async ({ kind, outputs, supported }) => {
			const selection: CohortMember =
				kind === 'rebuild'
					? member(app)
					: {
							attr: 'multi',
							installable: '.#multi',
							root,
							...(kind === 'multi-output' && {
								queryInstallable: `${app}.drv^dev,out`
							})
						};
			const f = await fixture(
				[selection],
				kind === 'rebuild' ? { build: 'rebuild' } : {}
			);
			f.faults.currentLookup = true;
			f.faults.unsupported = !supported;
			const original = buildReceiptV3Schema.parse({
				version: 3,
				paths: outputs,
				childExitStatus: 0,
				subjects: outputs.map((storePath) => ({
					origin: 'built',
					storePath,
					narHash: '00'.repeat(32),
					derivation: `${app}.drv`,
					buildStore: 'auto',
					verification: 'local'
				}))
			});
			f.setReceipt(original);
			const actual = vi.fn(() =>
				Promise.resolve({
					paths: outputs,
					status: 0,
					copiedFrom: new Map<StorePathString, readonly string[]>()
				})
			);
			await f.execute(
				{},
				{
					runNixBuild: actual,
					now: () => 0,
					buildSettings: { systems: ['x86_64-linux'], features: [] }
				}
			);
			expect(actual).toHaveBeenCalledTimes(kind === 'rebuild' ? 1 : 2);
			expect(
				f.commands.filter((argv) => argv[1] === 'build-push')
			).toHaveLength(1);
			expect(
				f.requests.filter((request) => request.operation === 'lookup')
			).toStrictEqual([
				{
					operation: 'lookup',
					input: {
						source: { cache: defaultCache },
						results: [{ storePath: app, narHash: `sha256:${'0'.repeat(52)}` }]
					}
				}
			]);
			expect(await f.receipt()).toStrictEqual({
				...original,
				uploaded: [],
				...(supported && {
					version: 4,
					publicationSets: outputs.map((output) => ({
						...publication(output),
						memberCount: 1,
						materialisation: 'complete'
					}))
				})
			});
			if (!supported) {
				expect(f.requests.map((request) => request.operation)).toStrictEqual([
					'lookup'
				]);
				expect(
					f.httpRequests.map((request) => new URL(request.url).pathname)
				).toStrictEqual(['/t/acme/uploads/credential']);
			}
			expect(f.rootTargets.get(root)).toStrictEqual(new Set(outputs));
			expect(await readFile(f.inputs.targetPathsFile, 'utf8')).toBe(
				`${outputs.join('\n')}\n`
			);
			expect(
				f.report.mock.calls
					.filter(([event]) => event.kind === 'cohort-summary')
					.map(([event]) => event.data)
			).toStrictEqual([
				{
					durationMs: 0,
					roots: [
						{
							attrs: [selection.attr],
							root,
							outcomes: ['built'],
							retention: { kind: 'cache' },
							recordedRetention: {
								name: root,
								expired: false,
								createdAt: '2026-01-01T00:00:00.000Z',
								updatedAt: '2026-01-01T00:00:00.000Z',
								targets: outputs.map((storePath) => ({
									storePath,
									storePathHash: storePath.slice(
										'/nix/store/'.length,
										'/nix/store/'.length + 32
									),
									present: true
								}))
							}
						}
					]
				}
			]);
			const names = await readdir(f.directory);
			expect(
				names.filter((name) => name.includes('.publication-'))
			).toStrictEqual([]);
		}
	);

	it.each([403, 409, 503])(
		'preserves cold evidence after initial no-lookup capability/provider refusal %s without capture or rebuilding',
		async (status) => {
			const f = await fixture([member(app)], { build: 'rebuild' });
			f.faults.currentLookup = true;
			f.faults.lookupStatus = status;
			const dependencies = {
				buildSettings: { systems: ['x86_64-linux'], features: [] }
			};
			await expect(f.execute({}, dependencies)).rejects.toBeDefined();
			expect(f.requests.map((request) => request.operation)).toStrictEqual([
				'lookup'
			]);
			expect(await recoveryState(f.inputs.receiptFile)).toStrictEqual({
				phase: 'active',
				captures: {}
			});
			const original = await f.receipt();
			expect(original).toStrictEqual({
				version: 3,
				paths: [app],
				uploaded: [],
				childExitStatus: 0,
				subjects: [
					{
						origin: 'built',
						storePath: app,
						narHash: '00'.repeat(32),
						derivation: `${app}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}
				]
			});
			f.faults.lookupStatus = 0;
			f.materialise.mockClear();
			f.graph.mockClear();
			f.build.mockClear();
			await f.execute({}, dependencies);
			expect(f.materialise).not.toHaveBeenCalled();
			expect(f.graph).not.toHaveBeenCalled();
			expect(f.build).not.toHaveBeenCalled();
			expect(await f.receipt()).toStrictEqual({
				...original,
				version: 4,
				publicationSets: [
					{ ...publication(app), memberCount: 1, materialisation: 'complete' }
				]
			});
		}
	);

	it('does not invent a capability probe identity for a zero-footprint invocation', async () => {
		const f = await fixture([member(app)], {
			build: 'rebuild',
			bestEffort: 'true'
		});
		const original = buildReceiptV3Schema.parse({
			version: 3,
			paths: [],
			subjects: [],
			childExitStatus: 1,
			terminalFailure: {
				kind: 'target-build',
				failedTargets: [`${app}.drv^out`]
			}
		});
		f.setReceipt(original);
		f.faults.failBuild = true;
		f.faults.currentLookup = true;
		await f.execute(
			{},
			{ buildSettings: { systems: ['x86_64-linux'], features: [] } }
		);
		expect(f.requests).toStrictEqual([]);
		expect(f.httpRequests).toStrictEqual([]);
		expect(f.rootTargets).toStrictEqual(new Map());
		expect(await f.receipt()).toStrictEqual(original);
		const names = await readdir(f.directory);
		expect(
			names.filter((name) => name.includes('.publication-'))
		).toStrictEqual([]);
	});

	it('captures build-only tools using requiredBy and actual producing derivations, excluding a sibling target', async () => {
		const f = await fixture([member(app), member(other, 'sibling')], {
			publish: 'built'
		});
		f.setReceipt(
			buildReceiptV3Schema.parse({
				version: 3,
				paths: [app, other, tool],
				subjects: [app, other, tool].map((storePath) => ({
					origin: 'built',
					storePath,
					narHash: '00'.repeat(32),
					derivation: `${storePath}.drv`,
					buildStore: 'auto',
					verification: 'local'
				}))
			})
		);
		await f.execute(
			{},
			{
				resolveLocalDerivationGraph: (derivations) =>
					Promise.resolve({
						closure: derivations,
						floatingOutputs: [],
						substitutableDerivations: [],
						outputs: [],
						dependencyOutputs: [
							{
								storePath: tool,
								requiredBy: [storePathSchema.parse(`${app}.drv`)]
							}
						],
						derivationDependencies: [
							{
								derivation: storePathSchema.parse(`${app}.drv`),
								inputs: [storePathSchema.parse(`${tool}.drv`)]
							}
						]
					})
			}
		);
		const captures = f.requests.filter(
			(request) => request.operation === 'capture'
		);
		expect(captures).toHaveLength(2);
		expect(
			captures
				.find((request) => request.input.result.storePath === app)
				?.input.members.map((entry) => entry.storePath)
		).toEqual([app, tool]);
		expect(
			captures
				.find((request) => request.input.result.storePath === other)
				?.input.members.map((entry) => entry.storePath)
		).toEqual([other]);
	});

	it.each([true, false])(
		'uses actual multi-output ownership for floating/unknown selections (queryable %s)',
		async (isQueryable) => {
			const selection: CohortMember = {
				attr: 'multi',
				installable: '.#multi',
				root,
				...(isQueryable && { queryInstallable: `${app}.drv^dev,out` })
			};
			const f = await fixture([selection]);
			f.setReceipt(
				buildReceiptV3Schema.parse({
					version: 3,
					paths: [app, other],
					subjects: [app, other].map((storePath) => ({
						origin: 'built',
						storePath,
						narHash: '00'.repeat(32),
						derivation: `${app}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}))
				})
			);
			const actual = vi.fn(() =>
				Promise.resolve({
					paths: [app, other],
					status: 0,
					copiedFrom: new Map<StorePathString, readonly string[]>()
				})
			);
			await f.execute({}, { runNixBuild: actual });
			expect(actual).toHaveBeenCalled();
			const captures = f.requests.filter(
				(request) => request.operation === 'capture'
			);
			expect(
				captures.map((request) =>
					request.input.members.map((entry) => entry.storePath)
				)
			).toEqual([[app], [other]]);
			expect(f.rootTargets.get(root)).toEqual(new Set([app, other]));
			expect(f.commands.filter((argv) => argv[1] === 'root')).toHaveLength(1);
		}
	);

	it('ensures the actual earlier capture winner rather than assuming its proposed footprint won', async () => {
		const f = await fixture();
		const winner = publication(app, defaultCache, 'c'.repeat(64));
		f.materialise.mockImplementation(() => {
			f.recorded.set(`default:${app}`, winner);
			return Promise.resolve();
		});
		await f.execute();
		const capture = f.requests.find(
			(request) => request.operation === 'capture'
		);
		expect(capture).toMatchObject({ input: { members: [{ storePath: app }] } });
		expect(
			f.requests.find((request) => request.operation === 'ensure')
		).toMatchObject({ input: { source: winner } });
		const receipt = await f.receipt();
		expect(receipt).toMatchObject({
			publicationSets: [{ digest: winner.digest, memberCount: 2 }]
		});
	});

	it('preserves partial V4 subjects and target failure, capturing survivors without replacing an incomplete mixed root', async () => {
		const f = await fixture([member(app), member(other)], {
			bestEffort: 'true'
		});
		f.recorded.set(`default:${app}`, publication(app));
		f.setReceipt(
			buildReceiptV3Schema.parse({
				version: 3,
				paths: [],
				subjects: [],
				childExitStatus: 1,
				terminalFailure: {
					kind: 'target-build',
					failedTargets: [`${other}.drv^out`]
				}
			})
		);
		f.faults.failBuild = true;
		f.rootTargets.set(root, new Set(['previous-root-target']));
		await f.execute();
		expect(f.rootTargets.get(root)).toEqual(new Set(['previous-root-target']));
		expect(f.commands.some((argv) => argv[1] === 'root')).toBe(false);
		const receipt = await f.receipt();
		expect(receipt).toMatchObject({
			version: 4,
			paths: [app],
			subjects: [],
			childExitStatus: 1,
			terminalFailure: { kind: 'target-build' },
			publicationSets: [{ result: { storePath: app } }]
		});
	});

	it('keeps permanent named-root retention distinct from permanent additive run-root preparation', async () => {
		const f = await fixture([member(app)], {
			permanent: 'true',
			runRootPermanent: 'true',
			runRootTtl: ''
		});
		f.recorded.set(`default:${app}`, publication(app));
		await f.execute();
		expect(
			f.requests.find((request) => request.operation === 'prepare-run-root')
		).toMatchObject({
			input: { name: f.inputs.runRoot, retention: { kind: 'permanent' } }
		});
		expect(f.commands.find((argv) => argv[1] === 'root')).toContain(
			'--permanent'
		);
	});

	it('rejects malformed/operation-switched workflow responses without member fallback', async () => {
		const f = await fixture();
		f.faults.badOperation = true;
		await expect(f.execute()).rejects.toThrow('operation changed');
		expect(f.materialise).not.toHaveBeenCalled();
	});

	it('recovers a lost capture reply by replaying the exact capture UUID before any new lookup or graph', async () => {
		const f = await fixture();
		f.faults.capture = true;
		await expect(f.execute()).rejects.toThrow('capture reply interrupted');
		const first = f.requests.find((request) => request.operation === 'capture');
		f.faults.capture = false;
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		const previousRequestCount = f.requests.length;
		await f.execute();
		expect(f.requests[previousRequestCount]).toEqual(first);
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
	});

	it('does not downgrade a lost capture reply recovery to a legacy rebuild', async () => {
		const f = await fixture();
		f.faults.capture = true;
		await expect(f.execute()).rejects.toThrow('capture reply interrupted');
		f.faults.capture = false;
		f.faults.unsupported = true;
		f.materialise.mockClear();
		await expect(f.execute()).rejects.toThrow('support changed');
		expect(f.materialise).not.toHaveBeenCalled();
	});

	it('reconciles an actual partial V4 cold build, captures surviving results, and preserves its target failure', async () => {
		const f = await fixture([member(app), member(other)], {
			bestEffort: 'true'
		});
		f.setReceipt(
			publicationReceiptSchema.parse({
				version: 4,
				paths: [app],
				subjects: [
					{
						origin: 'built',
						storePath: app,
						narHash: '00'.repeat(32),
						derivation: `${app}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}
				],
				publicationSets: [],
				childExitStatus: 1,
				terminalFailure: {
					kind: 'target-build',
					failedTargets: [`${other}.drv^out`]
				}
			})
		);
		f.faults.failBuild = true;
		await f.execute();
		expect(
			f.requests.find((request) => request.operation === 'capture')
		).toMatchObject({ input: { result: { storePath: app } } });
		expect(f.commands.some((argv) => argv[1] === 'root')).toBe(false);
		await expect(
			readFile(`${f.inputs.receiptFile}.publication-state.json`, 'utf8')
		).rejects.toMatchObject({ code: 'ENOENT' });
		const receipt = await f.receipt();
		expect(receipt).toMatchObject({
			version: 4,
			paths: [app],
			subjects: [{ origin: 'built', storePath: app }],
			terminalFailure: { kind: 'target-build' },
			childExitStatus: 1,
			publicationSets: [{ result: { storePath: app } }]
		});
	});

	it('fences later lookup pages with the resolved destination generation before graph work', async () => {
		const members = Array.from({ length: 65 }, (_, index) =>
			member(
				storePathSchema.parse(
					`/nix/store/${'0'.repeat(32)}-app-${String(index)}`
				)
			)
		);
		const f = await fixture(members);
		for (const entry of members) {
			if (entry.expectedPath !== undefined) {
				f.accepted.add(storePathSchema.parse(entry.expectedPath));
			}
		}
		const cohort = new RecordedCohortPublication(
			f.inputs,
			f.environment,
			f.run,
			{}
		);
		disposals.push(() => cohort.dispose());
		await cohort.open();
		await cohort.lookup(members);
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1]).toMatchObject({
			input: {
				source: { cache: { kind: 'default' }, expectedCacheGeneration: 1 }
			}
		});
		expect(f.materialise).not.toHaveBeenCalled();
	});

	it('fails closed if a view changes its resolved revision between lookup pages', async () => {
		const members = Array.from({ length: 65 }, (_, index) =>
			member(
				storePathSchema.parse(
					`/nix/store/${'0'.repeat(32)}-app-${String(index)}`
				)
			)
		);
		const f = await fixture(members, { reuseView: 'release' });
		f.faults.staleView = true;
		const cohort = new RecordedCohortPublication(
			f.inputs,
			f.environment,
			f.run,
			{}
		);
		disposals.push(() => cohort.dispose());
		await cohort.open();
		await expect(cohort.lookup(members)).rejects.toThrow('view revision');
		expect(f.requests.at(-1)).toMatchObject({
			input: { source: { selector: { view: 'release', expectedRevision: 7 } } }
		});
		expect(f.materialise).not.toHaveBeenCalled();
	});

	it('rejects loss of the installed hidden command after an interrupted recorded selection', async () => {
		const f = await fixture();
		f.recorded.set(`default:${app}`, publication(app));
		f.faults.ensure = true;
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		f.faults.ensure = false;
		await expect(
			f.execute({}, { hasPublicationSupport: () => Promise.resolve(false) })
		).rejects.toThrow('installed CLI');
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
	});

	it('does not report capture success or replace a named root until the actual winner is ensured', async () => {
		const f = await fixture();
		f.faults.ensure = true;
		f.materialise.mockImplementation(() => {
			f.recorded.set(
				`default:${app}`,
				publication(app, defaultCache, 'd'.repeat(64))
			);
			return Promise.resolve();
		});
		await expect(f.execute()).rejects.toThrow('ensure interrupted');
		expect(
			f.requests.find((request) => request.operation === 'ensure')
		).toMatchObject({ input: { source: { digest: 'd'.repeat(64) } } });
		expect(f.commands.some((argv) => argv[1] === 'root')).toBe(false);
		const receipt = await f.receipt();
		expect(receipt).toMatchObject({
			version: 4,
			terminalFailure: { kind: 'command' },
			publicationSets: []
		});
		const first = f.requests.find((request) => request.operation === 'ensure');
		f.recorded.set(
			`default:${app}`,
			publication(app, defaultCache, 'e'.repeat(64))
		);
		f.faults.ensure = false;
		f.materialise.mockClear();
		f.graph.mockClear();
		f.build.mockClear();
		await expect(f.execute()).rejects.toThrow('identity');
		expect(
			f.requests.findLast((request) => request.operation === 'ensure')
		).toStrictEqual(first);
		expect(f.materialise).not.toHaveBeenCalled();
		expect(f.graph).not.toHaveBeenCalled();
		expect(f.build).not.toHaveBeenCalled();
		expect(await f.receipt()).toStrictEqual({
			version: 4,
			paths: [app],
			childExitStatus: 0,
			uploaded: [],
			subjects: [
				{
					origin: 'built',
					storePath: app,
					derivation: `${app}.drv`,
					narHash: '00'.repeat(32),
					buildStore: 'auto',
					verification: 'local'
				}
			],
			publicationSets: [],
			terminalFailure: { kind: 'command' }
		});
	});

	it('does not send foreign read-only source URLs to a mutating helper', async () => {
		const f = await fixture([member(app)], {
			referenceSource: `${url}/cache/release`
		});
		f.recorded.set(
			`release:${app}`,
			publication(app, { kind: 'named', name: 'release' })
		);
		await f.execute();
		expect(
			f.requests.filter((request) => request.operation === 'lookup')
		).toHaveLength(2);
		expect(f.requests.some((request) => request.operation === 'capture')).toBe(
			false
		);
		expect(
			f.commands.every(
				(argv) => argv[1] !== 'publication-result' || argv[2] === url
			)
		).toBe(true);
	});
});
