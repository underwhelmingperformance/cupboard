import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DependencyOutput } from '@cupboard/nix';
import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	rootNameSchema,
	storePathSchema,
	type StorePathString,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { buildReceiptV4Schema } from '@cupboard/protocol/build';
import {
	type CompactPublicationSet,
	compactPublicationSetSchema,
	createPublicationRequestId,
	type PublicationLookupSource,
	type PublicationLookupTarget,
	publicationRequestIdSchema,
	publicationSourceSelectorSchema,
	type RecordedPublication,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	publicationCaptureEnvelopeSchema,
	publicationWorkflowCaptureInputSchema,
	type PublicationWorkflowRequestInput,
	publicationWorkflowRequestSchema,
	publicationWorkflowResponseSchema
} from '@cupboard/protocol/publication-workflow';
import {
	buildSummaryV4ResultKind,
	buildSummaryV4Schema
} from '@cupboard/protocol/reports';
import type { RootSummary } from '@cupboard/protocol/retention';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import type { Reporter } from '@cupboard/reporter';
import { z } from 'zod';

import { type CohortRootSummary, outcomeOrder } from './cohort-summary.ts';
import type {
	BuildCohortInputs,
	CohortMember,
	LocalDerivationGraph
} from './commands/build-cohort.ts';
import { type CupboardRunDependencies, runCupboard } from './cupboard-run.ts';
import type { Environment } from './inputs.ts';
import {
	namedRootEnsureArguments,
	namedRootEnsureResponse
} from './named-root.ts';
import {
	acquirePublicationFile,
	assertNoOrphanPublicationFiles,
	publicationCaptureFile,
	PublicationCaptureFileError,
	readPublicationCaptureFile,
	syncPublicationCaptureFile,
	syncPublicationDirectory,
	withPublicationCaptureFile,
	writePublicationStateFile
} from './publication-capture-files.ts';
import {
	type PublicationReceipt,
	publicationReceiptSchema,
	receiptPublicationSets
} from './publication-receipt.ts';
import { rootRetention } from './root-retention.ts';
import { cacheUrlFor } from './substituters.ts';

export interface CohortPublicationSnapshot {
	readonly receipt: PublicationReceipt;
	readonly targets: readonly string[];
	readonly owners: ReadonlyMap<string, ReadonlySet<string>>;
	readonly targetDerivations: ReadonlyMap<string, ReadonlySet<StorePathString>>;
	readonly dependencyOutputs: readonly DependencyOutput[];
	readonly graph: LocalDerivationGraph | undefined;
	readonly incompleteRoots: ReadonlySet<string>;
	readonly resolveClosure: (
		paths: readonly StorePathString[]
	) => Promise<readonly { readonly storePath: StorePathString }[]>;
}

/**
The actual accepted selection bounds membership; graph ownership only narrows it.
*/
export async function cohortPublicationFootprints(
	snapshot: CohortPublicationSnapshot,
	publish: BuildCohortInputs['publish']
): Promise<ReadonlyMap<StorePathString, readonly StorePathString[]>> {
	const accepted = new Set(snapshot.receipt.paths);
	const excluded = new Set([
		...(snapshot.receipt.leftUpstream ?? []),
		...(snapshot.receipt.failed ?? []),
		...(snapshot.receipt.collected ?? [])
	]);
	const footprints = new Map<StorePathString, readonly StorePathString[]>();
	const graph = new Map(
		snapshot.graph?.derivationDependencies?.map((entry) => [
			entry.derivation,
			entry.inputs
		])
	);
	for (const rawTarget of snapshot.targets) {
		const target = storePathSchema.parse(rawTarget);
		if (!accepted.has(target) || excluded.has(target)) {
			continue;
		}
		const owners =
			snapshot.targetDerivations.get(target) ?? new Set<StorePathString>();
		const dependencies = new Set<StorePathString>();
		const pending = [...owners];
		let index = 0;
		while (index < pending.length) {
			const current = pending[index];
			index += 1;
			const inputs = current === undefined ? [] : (graph.get(current) ?? []);
			for (const input of inputs) {
				if (dependencies.has(input)) {
					continue;
				}
				dependencies.add(input);
				pending.push(input);
			}
		}
		let candidates: readonly StorePathString[] = [];
		if (publish === 'closure') {
			const closure = await snapshot.resolveClosure([target]);
			candidates = closure.map((info) => info.storePath);
		} else if (publish === 'built') {
			candidates = [
				...snapshot.dependencyOutputs
					.filter((output) =>
						output.requiredBy.some((owner) => owners.has(owner))
					)
					.map((output) => output.storePath),
				...snapshot.receipt.subjects
					.filter(
						(subject) =>
							subject.origin === 'built' &&
							dependencies.has(subject.derivation) &&
							!owners.has(subject.derivation)
					)
					.map((subject) => subject.storePath)
			];
		}
		footprints.set(
			target,
			[
				...new Set([
					target,
					...candidates.filter(
						(member) => accepted.has(member) && !excluded.has(member)
					)
				])
			].toSorted(byCodeUnit)
		);
	}
	return footprints;
}

const selectionSchema = z.strictObject({
	publication: recordedPublicationSchema,
	sourceSelector: publicationSourceSelectorSchema.optional()
});
type RecordedSelection = z.output<typeof selectionSchema>;
const coldSnapshotSchema = z.strictObject({
	receipt: publicationReceiptSchema,
	targets: storePathSchema.array(),
	owners: z.tuple([z.string(), z.string().array()]).array(),
	incompleteRoots: z.string().array(),
	footprints: z.tuple([storePathSchema, storePathSchema.array()]).array(),
	outputFiles: z.strictObject({
		intermediatePaths: z.string(),
		referencePaths: z.string(),
		leftUpstream: z.string(),
		counts: z.string()
	})
});
const legacyStateSchema = z.strictObject({
	version: z.literal(2),
	identity: z.string(),
	supported: z.boolean(),
	prepared: z.boolean(),
	requests: z.record(z.string(), publicationRequestIdSchema),
	pendingCapture: publicationWorkflowCaptureInputSchema.optional(),
	selected: z.record(z.string(), selectionSchema),
	completed: compactPublicationSetSchema.array(),
	cold: coldSnapshotSchema.optional()
});
const captureFileSchema = z.strictObject({
	requestId: publicationRequestIdSchema,
	file: z.string(),
	readiness: z.enum(['preparing', 'ready']),
	input: publicationWorkflowCaptureInputSchema
});
const stateSchema = legacyStateSchema
	.extend({
		version: z.literal(3),
		phase: z.enum(['active', 'completed']),
		captures: z.record(publicationRequestIdSchema, captureFileSchema)
	})
	.refine((state) => {
		const pending = state.pendingCapture;
		if (pending === undefined) {
			return true;
		}
		if (pending.requestId === undefined) {
			return false;
		}
		return (
			JSON.stringify(state.captures[pending.requestId]?.input) ===
			JSON.stringify(pending)
		);
	}, 'Pending capture is missing its owned recovery record');
type PublicationState = z.output<typeof stateSchema>;

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function eligiblePath(member: CohortMember): StorePathString | undefined {
	const selection = member.queryInstallable?.split('^', 2)[1];
	if (selection === undefined || selection === '*' || selection.includes(',')) {
		return undefined;
	}
	return member.expectedPath === undefined
		? undefined
		: storePathSchema.parse(member.expectedPath);
}

/**
One active invocation's exact replay state, never source authority or credentials.
*/
export class RecordedCohortPublication {
	private state: PublicationState;
	private releaseOwnership: (() => Promise<void>) | undefined;
	private readonly replayedCaptures = new Set<string>();
	private snapshot:
		| Pick<
				CohortPublicationSnapshot,
				'receipt' | 'targets' | 'owners' | 'incompleteRoots'
		  >
		| undefined;
	private readonly ensured = new Set<StorePathString>();
	readonly sets: CompactPublicationSet[] = [];
	readonly warm = new Map<StorePathString, RecordedSelection>();
	readonly retainedRoots = new Map<string, RootSummary>();

	constructor(
		private readonly inputs: BuildCohortInputs,
		private readonly environment: Environment,
		private readonly run: typeof runCupboard,
		private readonly runDependencies: CupboardRunDependencies | undefined
	) {
		this.state = {
			version: 3,
			phase: 'active',
			captures: {},
			identity: JSON.stringify({
				cwd: process.cwd(),
				github: Object.fromEntries(
					[
						'GITHUB_SERVER_URL',
						'GITHUB_JOB',
						'GITHUB_ACTION',
						'GITHUB_ACTION_REPOSITORY',
						'GITHUB_ACTION_REF',
						'GITHUB_RUN_ID',
						'GITHUB_RUN_ATTEMPT',
						'GITHUB_SHA',
						'GITHUB_REPOSITORY',
						'GITHUB_REPOSITORY_ID',
						'GITHUB_WORKFLOW',
						'GITHUB_WORKFLOW_REF',
						'GITHUB_WORKFLOW_SHA',
						'GITHUB_REF',
						'GITHUB_EVENT_NAME',
						'GITHUB_HEAD_REF',
						'GITHUB_BASE_REF',
						'GITHUB_WORKSPACE'
					].map((name) => [name, environment[name]])
				),
				cohort: inputs.cohort,
				destination: canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
				build: inputs.build,
				maxJobs: inputs.maxJobs,
				gcBetweenCohorts: inputs.gcBetweenCohorts,
				store: inputs.store,
				failOnDivergence: inputs.failOnDivergence,
				allBestEffort: inputs.allBestEffort,
				publish: inputs.publish,
				substituter: inputs.substituter,
				referenceSource: inputs.referenceSource,
				reuseView: inputs.reuseView,
				runRoot: inputs.runRoot,
				runRootTtl: inputs.runRootTtl,
				runRootPermanent: inputs.runRootPermanent,
				ttl: inputs.ttl,
				permanent: inputs.permanent,
				audience: inputs.audience
			}),
			supported: false,
			prepared: false,
			requests: {},
			selected: {},
			completed: []
		};
	}

	private get stateFile(): string {
		return `${this.inputs.receiptFile}.publication-state.json`;
	}
	private get requestFile(): string {
		return `${this.inputs.receiptFile}.publication-request.json`;
	}

	private async save(): Promise<void> {
		await writePublicationStateFile(
			this.stateFile,
			`${JSON.stringify(stateSchema.parse(this.state))}\n`
		);
	}

	private captureBinding(input: unknown) {
		return publicationCaptureBindingSchema.parse({
			invocation: createHash('sha256')
				.update(this.state.identity)
				.digest('hex'),
			tenantUrl: parseTenantCacheUrl(this.inputs.url).tenantUrl.href,
			cache: this.inputs.cache,
			input
		});
	}

	private async captureFile(
		record: z.output<typeof captureFileSchema>
	): Promise<string> {
		const file = publicationCaptureFile(
			this.inputs.receiptFile,
			record.requestId
		);
		if (
			record.file !== path.basename(file) ||
			record.input.requestId !== record.requestId
		) {
			throw new PublicationCaptureFileError(
				'Capture file ownership inventory changed.'
			);
		}
		await withPublicationCaptureFile(
			file,
			async () => {
				const binding = this.captureBinding(record.input);
				let envelope;
				try {
					envelope = await readPublicationCaptureFile(file);
				} catch (error) {
					if (!isMissingFile(error) || record.readiness === 'ready') {
						throw error;
					}
					envelope = publicationCaptureEnvelopeSchema.parse({
						version: 1,
						request: { operation: 'capture', input: record.input },
						checkpoint: initialPublicationCaptureCheckpoint(binding)
					});
					await writePublicationStateFile(
						file,
						`${JSON.stringify(envelope)}\n`,
						true
					);
				}
				if (
					JSON.stringify(envelope.checkpoint.binding) !==
					JSON.stringify(binding)
				) {
					throw new PublicationCaptureFileError(
						'Capture envelope binding changed.'
					);
				}
				if (record.readiness === 'ready') {
					return;
				}
				if (envelope.checkpoint.state.phase !== 'unresolved') {
					throw new PublicationCaptureFileError(
						'Preparing capture already contains remote work.'
					);
				}
				await syncPublicationCaptureFile(file);
				record.readiness = 'ready';
				await this.save();
			},
			this.runDependencies?.signal
		);
		return file;
	}

	private async execute(input: PublicationWorkflowRequestInput) {
		this.runDependencies?.signal?.throwIfAborted();
		const fingerprint = createHash('sha256')
			.update(JSON.stringify(input))
			.digest('hex');
		if (input.operation === 'capture' || input.operation === 'ensure') {
			this.state.requests[fingerprint] = publicationRequestIdSchema.parse(
				input.input.requestId ??
					this.state.requests[fingerprint] ??
					createPublicationRequestId()
			);
		}

		const request = publicationWorkflowRequestSchema.parse({
			...input,
			input:
				input.operation === 'capture' || input.operation === 'ensure'
					? { ...input.input, requestId: this.state.requests[fingerprint] }
					: input.input
		});
		let requestFile = this.requestFile;
		if (request.operation === 'capture') {
			const requestId = publicationRequestIdSchema.parse(
				request.input.requestId
			);
			this.state.pendingCapture = request.input;
			const previous = this.state.captures[requestId];
			if (
				previous !== undefined &&
				JSON.stringify(previous.input) !== JSON.stringify(request.input)
			) {
				throw new PublicationCaptureFileError(
					'Capture input changed during replay.'
				);
			}
			const record: z.output<typeof captureFileSchema> = previous ?? {
				requestId,
				file: path.basename(
					publicationCaptureFile(this.inputs.receiptFile, requestId)
				),
				readiness: 'preparing',
				input: request.input
			};
			this.state.captures[requestId] = record;
			await this.save();
			requestFile = await this.captureFile(record);
		} else {
			await this.save();
			await writePublicationStateFile(
				this.requestFile,
				`${JSON.stringify(request)}\n`
			);
		}
		this.runDependencies?.signal?.throwIfAborted();
		const results = await this.run(
			this.inputs.cupboardPath,
			[
				'--no-colour',
				'publication-result',
				canonicalHref(cacheUrlFor(this.inputs.url, this.inputs.cache)),
				'--github-oidc',
				'--request-file',
				requestFile,
				...(this.inputs.audience === ''
					? []
					: ['--audience', this.inputs.audience])
			],
			this.environment,
			this.runDependencies
		);
		const responses = results.filter(
			(result) => result.kind === 'publication-result'
		);
		if (responses.length !== 1) {
			throw new Error('Expected one recorded-publication result');
		}
		const response = publicationWorkflowResponseSchema.parse(
			responses[0]?.data
		);
		if (response.operation !== input.operation) {
			throw new Error('Recorded-publication response operation changed');
		}
		if (!response.supported && this.state.supported) {
			throw new Error('Recorded publication support changed during the cohort');
		}
		if (request.operation === 'capture') {
			this.replayedCaptures.add(
				publicationRequestIdSchema.parse(request.input.requestId)
			);
		}
		this.state.supported ||= response.supported;
		await this.save();
		return response;
	}

	private async prepareRoot(): Promise<void> {
		if (this.state.prepared || this.inputs.runRoot === '') {
			return;
		}
		const duration = /^(\d+)([smhdw])$/u.exec(this.inputs.runRootTtl);
		if (duration === null && this.inputs.runRootTtl !== '') {
			throw new Error('Invalid run-root duration');
		}
		const units: Readonly<Record<string, number>> = {
			s: 1,
			m: 60,
			h: 3600,
			d: 86_400,
			w: 604_800
		};
		const response = await this.execute({
			operation: 'prepare-run-root',
			input: {
				name: rootNameSchema.parse(this.inputs.runRoot),
				retention: this.inputs.runRootPermanent
					? { kind: 'permanent' }
					: this.inputs.runRootTtl === ''
						? { kind: 'inherit' }
						: {
								kind: 'duration',
								seconds: ttlSecondsSchema.parse(
									Number(duration?.[1]) * (units[duration?.[2] ?? ''] ?? 0)
								)
							}
			}
		});
		if (
			response.operation !== 'prepare-run-root' ||
			!response.supported ||
			response.output.name !== this.inputs.runRoot
		) {
			throw new Error('Could not prepare the exact shared run root');
		}
		this.state.prepared = true;
		await this.save();
	}

	private async ensure(selection: RecordedSelection): Promise<void> {
		await this.prepareRoot();
		const response = await this.execute({
			operation: 'ensure',
			input: {
				source: selection.publication,
				...(selection.sourceSelector !== undefined && {
					sourceSelector: selection.sourceSelector
				}),
				...(this.inputs.runRoot !== '' && {
					runRoot: rootNameSchema.parse(this.inputs.runRoot)
				})
			}
		});
		if (
			response.operation !== 'ensure' ||
			!response.supported ||
			response.output.digest !== selection.publication.digest ||
			response.output.memberCount !== selection.publication.memberCount ||
			response.output.result.storePath !==
				selection.publication.result.storePath ||
			response.output.result.narHash !== selection.publication.result.narHash ||
			JSON.stringify(response.output.result.cache) !==
				JSON.stringify(this.inputs.cache)
		) {
			throw new Error('Could not materialise the exact recorded winner');
		}
		this.ensured.add(response.output.result.storePath);
		this.state.completed = receiptPublicationSets([
			{ version: 4, paths: [], subjects: [], publicationSets: this.sets },
			{
				version: 4,
				paths: [],
				subjects: [],
				publicationSets: [response.output]
			}
		]);
		this.sets.splice(0, this.sets.length, ...this.state.completed);
		await this.save();
	}

	private async rememberCapture(
		result: PublicationLookupTarget,
		publication: RecordedPublication
	): Promise<RecordedSelection> {
		if (
			publication.result.storePath !== result.storePath ||
			(result.narHash !== undefined &&
				publication.result.narHash !== result.narHash) ||
			JSON.stringify(publication.result.cache) !==
				JSON.stringify(this.inputs.cache)
		) {
			throw new Error('Capture returned a different result');
		}
		const previous = this.state.selected[result.storePath];
		if (
			previous !== undefined &&
			JSON.stringify(previous.publication) !== JSON.stringify(publication)
		) {
			throw new PublicationCaptureFileError(
				'Previously selected capture winner changed.'
			);
		}
		const selection = { publication };
		this.state.selected[result.storePath] = selection;
		delete this.state.pendingCapture;
		await this.save();
		return selection;
	}

	private async cleanupCompleted(): Promise<void> {
		if (this.state.phase !== 'completed') {
			throw new PublicationCaptureFileError(
				'Cannot retire unfinished capture files.'
			);
		}
		for (const record of Object.values(this.state.captures)) {
			const file = publicationCaptureFile(
				this.inputs.receiptFile,
				record.requestId
			);
			await withPublicationCaptureFile(file, async () => {
				await rm(file, { force: true });
				await syncPublicationDirectory(file);
			});
		}
		await rm(this.requestFile, { force: true });
		await syncPublicationDirectory(this.requestFile);
		await rm(this.stateFile, { force: true });
		await syncPublicationDirectory(this.stateFile);
	}

	async dispose(hasFailed = false): Promise<void> {
		const release = this.releaseOwnership;
		this.releaseOwnership = undefined;
		if (release === undefined) {
			return;
		}
		try {
			await release();
		} catch (error) {
			if (!hasFailed) {
				throw error;
			}
			process.stderr.write(
				`Could not release cohort publication ownership '${this.stateFile}.publication-lock': ${String(error)}\n`
			);
		}
	}

	async open(): Promise<void> {
		this.releaseOwnership = await acquirePublicationFile(
			this.stateFile,
			this.runDependencies?.signal
		);
		let json: unknown;
		try {
			json = JSON.parse(await readFile(this.stateFile, 'utf8'));
		} catch (error) {
			if (!isMissingFile(error)) {
				throw error;
			}
			await assertNoOrphanPublicationFiles(this.inputs.receiptFile);
			return;
		}
		let previous: PublicationState;
		const current = stateSchema.safeParse(json);
		if (current.success) {
			previous = current.data;
		} else {
			const legacy = legacyStateSchema.parse(json);
			if (legacy.pendingCapture !== undefined || legacy.cold !== undefined) {
				throw new PublicationCaptureFileError(
					'Unfinished v2 capture recovery is ambiguous. Preserve the publication state and original capture evidence; it cannot be reset or safely upgraded.'
				);
			}
			// v2 always saves cold evidence before its first capture; absence proves no capture mutation.
			previous = stateSchema.parse({
				...legacy,
				version: 3,
				phase: 'active',
				captures: {}
			});
		}
		for (const [requestId, record] of Object.entries(previous.captures)) {
			if (
				requestId !== record.requestId ||
				record.file !==
					path.basename(
						publicationCaptureFile(this.inputs.receiptFile, requestId)
					) ||
				record.input.requestId !== requestId
			) {
				throw new PublicationCaptureFileError(
					'Capture file ownership inventory changed.'
				);
			}
		}
		if (previous.phase === 'completed') {
			const fresh = this.state;
			this.state = previous;
			await this.cleanupCompleted();
			this.state = fresh;
			return;
		}
		if (previous.identity !== this.state.identity) {
			throw new Error(
				'An interrupted publication belongs to a different cohort invocation'
			);
		}
		this.state = previous;
		for (const record of Object.values(previous.captures)) {
			await this.captureFile(record);
		}
		this.sets.push(...previous.completed);
		if (previous.cold !== undefined) {
			this.snapshot = {
				...previous.cold,
				owners: new Map(
					previous.cold.owners.map(([target, roots]) => [
						target,
						new Set(roots)
					])
				),
				incompleteRoots: new Set(previous.cold.incompleteRoots)
			};
		}
	}

	requiresSupport(): boolean {
		return (
			this.state.supported ||
			this.state.pendingCapture !== undefined ||
			Object.keys(this.state.selected).length > 0
		);
	}

	async recover(): Promise<void> {
		for (const record of Object.values(this.state.captures)) {
			const response = await this.execute({
				operation: 'capture',
				input: record.input
			});
			if (response.operation !== 'capture' || !response.supported) {
				throw new Error(
					'Recorded publication support changed during capture recovery'
				);
			}
			await this.rememberCapture(record.input.result, response.output);
		}
	}

	async lookup(members: readonly CohortMember[]): Promise<boolean> {
		const paths = [
			...new Set(members.flatMap((member) => eligiblePath(member) ?? []))
		];
		for (const storePath of paths) {
			const previous = this.state.selected[storePath];
			if (previous !== undefined) {
				this.warm.set(storePath, previous);
			}
		}
		// A settled cold cohort already made its destination-first selection.
		// Missing/failed outputs must not become a new build or a new source choice.
		if (this.state.cold !== undefined) {
			return true;
		}
		const sources: PublicationLookupSource[] = [{ cache: this.inputs.cache }];
		if (this.inputs.reuseView !== '') {
			sources.push({
				selector: { view: reuseViewNameSchema.parse(this.inputs.reuseView) }
			});
		} else if (this.inputs.referenceSource !== undefined) {
			const source = parseTenantCacheUrl(new URL(this.inputs.referenceSource));
			if (
				canonicalHref(source.tenantUrl) ===
				canonicalHref(parseTenantCacheUrl(this.inputs.url).tenantUrl)
			) {
				sources.push({ cache: source.cache });
			}
		}
		const resolved = new Set(this.warm.keys());
		for (let source of sources) {
			const pending = paths.filter((storePath) => !resolved.has(storePath));
			for (let offset = 0; offset < pending.length; offset += 64) {
				const batch = pending.slice(offset, offset + 64);
				const response = await this.execute({
					operation: 'lookup',
					input: { source, results: batch.map((storePath) => ({ storePath })) }
				});
				if (response.operation !== 'lookup') {
					throw new Error('Expected a publication lookup');
				}
				if (!response.supported) {
					return false;
				}
				if (response.output.entries.length !== batch.length) {
					throw new Error('Publication lookup changed the requested selection');
				}
				const selector = response.output.sourceSelector;
				if (
					source.selector !== undefined &&
					(selector?.view !== source.selector.view ||
						(source.selector.expectedRevision !== undefined &&
							selector.expectedRevision !== source.selector.expectedRevision))
				) {
					throw new Error(
						'Publication lookup changed the selected view revision'
					);
				}
				if (selector !== undefined && source.selector === undefined) {
					throw new Error('Publication lookup introduced an unrequested view');
				}
				if (selector !== undefined) {
					source = { ...source, selector };
				}
				for (const [index, entry] of response.output.entries.entries()) {
					const result =
						entry.kind === 'recorded'
							? entry.publication.result
							: entry.kind === 'missing'
								? entry.result
								: undefined;
					const returnedPath =
						result?.storePath ??
						(entry.kind === 'unavailable' ? entry.storePath : undefined);
					if (returnedPath !== batch[index]) {
						throw new Error('Publication lookup returned a different result');
					}
					if (result === undefined) {
						continue;
					}
					resolved.add(result.storePath);
					if (source.cache !== undefined) {
						if (
							JSON.stringify(source.cache) !== JSON.stringify(result.cache) ||
							(source.expectedCacheGeneration !== undefined &&
								source.expectedCacheGeneration !== result.cacheGeneration)
						) {
							throw new Error(
								'Publication lookup changed the source cache identity'
							);
						}
						source = {
							...source,
							expectedCacheGeneration: result.cacheGeneration
						};
					}
					if (entry.kind !== 'recorded') {
						continue;
					}
					const selection = {
						publication: entry.publication,
						...(response.output.sourceSelector !== undefined && {
							sourceSelector: response.output.sourceSelector
						})
					};
					this.warm.set(result.storePath, selection);
					this.state.selected[result.storePath] = selection;
					await this.save();
				}
			}
		}
		return true;
	}

	isWarm(member: CohortMember): boolean {
		const storePath = eligiblePath(member);
		return storePath !== undefined && this.warm.has(storePath);
	}

	async ensureWarm(): Promise<void> {
		for (const selection of this.warm.values()) {
			await this.ensure(selection);
		}
	}

	hasColdSnapshot(): boolean {
		return this.state.cold !== undefined;
	}

	coldTargets(): readonly string[] {
		return this.snapshot?.targets ?? [];
	}

	async restoreColdOutputFiles(): Promise<void> {
		const files = this.state.cold?.outputFiles;
		await writeFile(
			this.inputs.intermediatePathsFile,
			files?.intermediatePaths ?? ''
		);
		await writeFile(
			this.inputs.referencePathsFile,
			files?.referencePaths ?? ''
		);
		await writeFile(
			this.inputs.leftUpstreamFile,
			files?.leftUpstream ??
				`${JSON.stringify({ leftUpstream: [] }, undefined, 2)}\n`
		);
		await writeFile(this.inputs.countsFile, files?.counts ?? '{}\n');
	}

	async capture(snapshot: CohortPublicationSnapshot): Promise<void> {
		this.snapshot = snapshot;
		const footprints = await cohortPublicationFootprints(
			snapshot,
			this.inputs.publish
		);
		// Freeze accepted execution evidence and ownership before any remote mutation.
		// Recorded sets alone are never evidence that this invocation built a subject.
		this.state.cold = coldSnapshotSchema.parse({
			receipt: snapshot.receipt,
			targets: snapshot.targets,
			owners: [...snapshot.owners].map(([target, roots]) => [
				target,
				[...roots]
			]),
			incompleteRoots: [...snapshot.incompleteRoots],
			footprints: [...footprints],
			outputFiles: {
				intermediatePaths: await readFile(
					this.inputs.intermediatePathsFile,
					'utf8'
				),
				referencePaths: await readFile(this.inputs.referencePathsFile, 'utf8'),
				leftUpstream: await readFile(this.inputs.leftUpstreamFile, 'utf8'),
				counts: await readFile(this.inputs.countsFile, 'utf8')
			}
		});
		await this.save();
		await this.resumeCold();
	}

	async resumeCold(): Promise<void> {
		const snapshot = this.state.cold;
		if (snapshot === undefined) {
			return;
		}
		if ((snapshot.receipt.failed?.length ?? 0) > 0) {
			throw new Error('Publication receipt contains failed paths');
		}
		for (const [target, members] of snapshot.footprints) {
			if (this.ensured.has(target)) {
				continue;
			}
			const memberFor = (storePath: StorePathString) => {
				const subject = snapshot.receipt.subjects.find(
					(subject) => subject.storePath === storePath
				);
				return {
					storePath,
					...(subject !== undefined && {
						narHash: NixSha256Hash.fromDigest(
							Buffer.from(subject.narHash, 'hex')
						).toString()
					})
				};
			};
			const result = memberFor(target);
			if (!this.requiresSupport()) {
				// A capture envelope makes missing capability a recovery error in the CLI.
				const response = await this.execute({
					operation: 'lookup',
					input: { source: { cache: this.inputs.cache }, results: [result] }
				});
				if (response.operation !== 'lookup') {
					throw new Error('Expected a publication lookup');
				}
				if (!response.supported) {
					return;
				}
			}
			const previous = this.state.selected[target];
			if (previous !== undefined) {
				if (
					result.narHash !== undefined &&
					result.narHash !== previous.publication.result.narHash
				) {
					throw new Error('Accepted result changed during publication replay');
				}
				const capture = Object.values(this.state.captures).find(
					(record) => record.input.result.storePath === target
				);
				if (
					capture !== undefined &&
					!this.replayedCaptures.has(capture.requestId)
				) {
					const response = await this.execute({
						operation: 'capture',
						input: capture.input
					});
					if (response.operation !== 'capture' || !response.supported) {
						throw new PublicationCaptureFileError(
							'Could not revalidate the original captured winner.'
						);
					}
					await this.rememberCapture(result, response.output);
				}
				await this.ensure(previous);
				continue;
			}
			const response = await this.execute({
				operation: 'capture',
				input: {
					result,
					members: members.map((member) => memberFor(member)),
					origin: snapshot.receipt.subjects.some(
						(subject) =>
							subject.storePath === target && subject.origin === 'built'
					)
						? 'build-selection'
						: 'legacy-selection'
				}
			});
			if (response.operation !== 'capture') {
				throw new Error('Expected a publication capture');
			}
			if (!response.supported) {
				delete this.state.pendingCapture;
				await this.save();
				break;
			}
			const selection = await this.rememberCapture(result, response.output);

			// First-complete wins: ensure the returned winner, not our proposed membership.
			await this.ensure(selection);
		}
	}

	assertColdBuildAccepted(): void {
		const receipt = this.snapshot?.receipt;
		const terminalFailure = receipt?.terminalFailure;
		if (terminalFailure?.kind === 'command') {
			throw new Error('Recorded cohort build had a command failure');
		}
		if (terminalFailure?.kind === 'target-build') {
			if (!this.inputs.allBestEffort) {
				throw new Error(
					`Recorded cohort build did not complete required targets: ${terminalFailure.failedTargets.join(', ')}`
				);
			}
			return;
		}
		if (
			(receipt?.childExitStatus ?? 0) !== 0 ||
			(this.snapshot?.incompleteRoots.size ?? 0) > 0
		) {
			throw new Error('Recorded cohort build did not complete');
		}
	}

	hasWarmRoot(root: string): boolean {
		return this.inputs.cohort.roots.some((name, index) => {
			const output = this.inputs.cohort.expectedPaths[index];
			return (
				name === root &&
				output !== null &&
				output !== undefined &&
				this.warm.has(output)
			);
		});
	}

	summaryRoots(
		cold: readonly CohortRootSummary[]
	): readonly CohortRootSummary[] {
		return [...new Set(this.inputs.cohort.roots)].map((root) => {
			const previous = cold.find((summary) => summary.root === root);
			const outcomes = new Set(previous?.outcomes);
			if (this.snapshot?.incompleteRoots.has(root)) {
				outcomes.add('failed');
			}
			if (this.hasWarmRoot(root) && !outcomes.has('failed')) {
				outcomes.delete('not-built');
				outcomes.add('already-served');
			}
			const retained = this.retainedRoots.get(root);
			return {
				...previous,
				root,
				attrs: this.inputs.cohort.attrs.filter(
					(_, index) => this.inputs.cohort.roots[index] === root
				),
				outcomes: outcomeOrder.filter((outcome) => outcomes.has(outcome)),
				...(retained !== undefined && {
					recordedRetention: retained,
					retention: rootRetention(this.inputs.ttl, this.inputs.permanent)
				})
			};
		});
	}

	async retainRoots(members: readonly CohortMember[]): Promise<void> {
		const roots = new Set(members.map((member) => member.root));
		const accepted = new Set(this.snapshot?.receipt.paths);
		const rejected = new Set([
			...(this.snapshot?.receipt.failed ?? []),
			...(this.snapshot?.receipt.collected ?? [])
		]);
		for (const root of roots) {
			if (this.snapshot?.incompleteRoots.has(root)) {
				continue;
			}
			const selectedCold =
				this.snapshot?.targets.filter((target) =>
					this.snapshot?.owners.get(target)?.has(root)
				) ?? [];
			if (
				selectedCold.some(
					(target) =>
						!accepted.has(storePathSchema.parse(target)) ||
						rejected.has(storePathSchema.parse(target))
				)
			) {
				throw new Error(
					`Named target root ${root} has unaccepted selected outputs`
				);
			}

			const targets = [
				...new Set([
					...members
						.filter((member) => member.root === root && this.isWarm(member))
						.flatMap((member) => eligiblePath(member) ?? []),
					...(this.snapshot?.targets.filter(
						(target) =>
							this.snapshot?.owners.get(target)?.has(root) &&
							this.snapshot.receipt.paths.includes(
								storePathSchema.parse(target)
							) &&
							!this.snapshot.receipt.leftUpstream?.includes(
								storePathSchema.parse(target)
							)
					) ?? [])
				])
			]
				.map((target) => storePathSchema.parse(target))
				.toSorted(byCodeUnit);
			if (targets.length === 0) {
				continue;
			}
			const results = await this.run(
				this.inputs.cupboardPath,
				[
					'--no-colour',
					...namedRootEnsureArguments(this.inputs, root, targets)
				],
				this.environment,
				this.runDependencies
			);
			const response = namedRootEnsureResponse(root, results);
			if (
				response.status !== 'retained' ||
				response.root.name !== root ||
				response.root.expired ||
				response.root.targets.length !== targets.length ||
				response.root.targets.some(
					(target) => !target.present || !targets.includes(target.storePath)
				)
			) {
				throw new Error(
					`Named target root ${root} was not retained with its complete accepted selection`
				);
			}
			this.retainedRoots.set(root, response.root);
		}
	}

	async finish(reporter: Reporter, failure: unknown): Promise<void> {
		const previous = this.snapshot?.receipt ?? (await this.receipt());
		if (!this.state.supported) {
			if (this.state.cold !== undefined) {
				await writePublicationStateFile(
					this.inputs.receiptFile,
					`${JSON.stringify(this.state.cold.receipt, undefined, 2)}\n`
				);
			}
			return;
		}
		const receipt = buildReceiptV4Schema.parse({
			...(previous ?? { paths: [], subjects: [] }),
			version: 4,
			paths: [
				...new Set([
					...(previous?.paths ?? []),
					...this.sets.map((set) => set.result.storePath)
				])
			].toSorted(byCodeUnit),
			publicationSets: receiptPublicationSets([
				{ version: 4, paths: [], subjects: [], publicationSets: this.sets },
				...(previous === undefined ? [] : [previous])
			]),
			...(failure !== undefined &&
				previous?.terminalFailure === undefined && {
					terminalFailure: { kind: 'command' }
				})
		});
		await writePublicationStateFile(
			this.inputs.receiptFile,
			`${JSON.stringify(receipt, undefined, 2)}\n`
		);
		const requested = new Set(
			[
				...this.inputs.cohort.expectedPaths.filter(
					(storePath) => storePath !== null
				),
				...(this.snapshot?.targets ?? []),
				...this.warm.keys(),
				...this.sets.map((set) => set.result.storePath)
			].map((storePath) => storePathSchema.parse(storePath))
		);
		const data = buildSummaryV4Schema.parse({
			version: 4,
			mode: this.inputs.store === '' ? 'streamed' : 'reconciled-local',
			store: this.inputs.store || 'auto',
			targetPaths: requested.size,
			intermediatePaths: receipt.paths.filter(
				(storePath) => !requested.has(storePath)
			).length,
			queueDepth: 0,
			uploadedPaths: receipt.uploaded?.length ?? 0,
			skipped: 0,
			childExitStatus: Math.max(0, receipt.childExitStatus ?? 0),
			unconfirmedPaths: [
				...new Set([
					...(receipt.failed ?? []),
					...[...requested].filter((storePath) =>
						this.sets.every((set) => set.result.storePath !== storePath)
					)
				])
			]
				.filter((storePath) => !receipt.leftUpstream?.includes(storePath))
				.toSorted(byCodeUnit),
			publicationSets: receipt.publicationSets
		});
		reporter.result({
			kind: buildSummaryV4ResultKind,
			title: 'Recorded cohort publication',
			data,
			rows: []
		});
	}

	async complete(): Promise<void> {
		const receipt = await this.receipt();
		this.assertColdBuildAccepted();
		if ((receipt?.failed?.length ?? 0) > 0) {
			throw new Error('Publication receipt contains failed paths');
		}
		this.state.phase = 'completed';
		await this.save();
		await this.cleanupCompleted();
	}

	async close(): Promise<void> {
		if (Object.keys(this.state.captures).length > 0) {
			throw new PublicationCaptureFileError(
				'Cannot discard unfinished capture recovery.'
			);
		}
		this.state.phase = 'completed';
		await this.save();
		await this.cleanupCompleted();
	}

	async receipt(): Promise<PublicationReceipt | undefined> {
		try {
			return publicationReceiptSchema.parse(
				JSON.parse(await readFile(this.inputs.receiptFile, 'utf8'))
			);
		} catch (error) {
			if (!isMissingFile(error)) {
				throw error;
			}
			return undefined;
		}
	}
}
