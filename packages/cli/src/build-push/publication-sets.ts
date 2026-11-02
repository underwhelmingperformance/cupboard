import { dependencyOutputs } from '@cupboard/nix';
import {
	type Derivation,
	derivationPathOf
} from '@cupboard/nix-store/derivation';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type CacheScope,
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { BuildReceiptV3 } from '@cupboard/protocol/build';
import {
	type CompactPublicationSet,
	type PublicationLookupSource,
	type PublicationSourceSelector,
	type RecordedPublication
} from '@cupboard/protocol/publication-manifests';
import type {
	PublicationWorkflowExecutionContext,
	PublicationWorkflowRequest,
	PublicationWorkflowResponse
} from '@cupboard/protocol/publication-workflow';

import type {
	BuildInvocation,
	BuildPushDependencies,
	BuildPushRunOptions
} from './build-push.ts';
import { publicationRequests } from './publication-requests.ts';
import { targetDerivations } from './target-derivations.ts';

export interface PublicationOwnership {
	readonly outputs: Awaited<ReturnType<typeof dependencyOutputs>>;
	readonly roots: ReadonlyMap<StorePathString, Derivation>;
	readonly derivations: ReadonlyMap<StorePathString, Derivation>;
}

export interface PublicationDestination {
	readonly tenantUrl: string;
	readonly cache: CacheScope;
}

export interface BuildPublicationWorkflow {
	readonly destination?: PublicationDestination;
	execute(
		request: PublicationWorkflowRequest,
		context?: PublicationWorkflowExecutionContext
	): Promise<PublicationWorkflowResponse>;
}

interface SelectedOutput {
	readonly storePath: StorePathString;
	readonly derivation?: StorePathString;
	readonly name?: string;
}

/**
Only concrete selected outputs can bypass Nix. Unresolved and floating selections still build.
*/
export async function exactSelectedOutputs(
	invocation: BuildInvocation,
	dependencies: BuildPushDependencies
): Promise<ReadonlyMap<string, readonly SelectedOutput[]>> {
	const selected = new Map<string, readonly SelectedOutput[]>();
	if (invocation.kind !== 'constructed') {
		return selected;
	}
	for (const installable of invocation.build.installables) {
		const direct = storePathSchema.safeParse(installable);
		if (direct.success && derivationPathOf(installable) === undefined) {
			selected.set(installable, [{ storePath: direct.data }]);
			continue;
		}
		let derivation = derivationPathOf(installable);
		const selection = installable.split('^', 2)[1];
		if (derivation === undefined && selection !== undefined) {
			const evaluated = await (
				dependencies.targetDerivations ?? targetDerivations
			)(
				[installable],
				dependencies.environment ?? process.env,
				dependencies.signal
			);
			const paths = evaluated.get(installable) ?? [];
			if (paths.length === 1) {
				derivation = paths[0];
			}
		}
		if (derivation === undefined) {
			continue;
		}
		const names = selection ?? '*';
		const term = await dependencies.store.readDerivation(derivation);
		const outputNames =
			names === '*' ? term.outputs.keys().toArray() : names.split(',');
		const outputs = outputNames.flatMap((name): SelectedOutput[] => {
			const output = term.outputs.get(name);
			return output === undefined
				? []
				: [
						{
							storePath: output,
							derivation: storePathSchema.parse(derivation),
							name
						}
					];
		});
		if (outputs.length !== outputNames.length) {
			continue;
		}
		if (outputs.length > 0) {
			selected.set(installable, outputs);
		}
	}
	return selected;
}

export interface RecordedSelection {
	readonly publication: RecordedPublication;
	readonly sourceSelector?: PublicationSourceSelector;
}

export async function lookupSelectedPublications(
	selected: ReadonlyMap<string, readonly SelectedOutput[]>,
	sources: readonly PublicationLookupSource[],
	workflow: BuildPublicationWorkflow
): Promise<ReadonlyMap<StorePathString, RecordedSelection> | undefined> {
	const recorded = new Map<StorePathString, RecordedSelection>();
	const resolved = new Set<StorePathString>();
	let isSupported = false;
	const paths = [
		...new Set(
			selected
				.values()
				.flatMap((outputs) => outputs.map((output) => output.storePath))
		)
	];
	for (const source of sources) {
		let fencedSource = source;
		const pending = paths.filter((path) => !resolved.has(path));
		for (let offset = 0; offset < pending.length; offset += 64) {
			const response = await workflow.execute({
				operation: 'lookup',
				input: {
					source: fencedSource,
					results: pending
						.slice(offset, offset + 64)
						.map((storePath) => ({ storePath }))
				}
			});
			if (response.operation !== 'lookup') {
				throw new Error('Expected a publication lookup response');
			}
			if (!response.supported) {
				if (isSupported) {
					throw new Error('Recorded publication support changed during lookup');
				}
				return undefined;
			}
			isSupported = true;
			if (response.output.sourceSelector !== undefined) {
				fencedSource = {
					...fencedSource,
					selector: response.output.sourceSelector
				};
			}
			for (const entry of response.output.entries) {
				if (entry.kind === 'unavailable') {
					continue;
				}
				const result =
					entry.kind === 'recorded' ? entry.publication.result : entry.result;
				resolved.add(result.storePath);
				if (fencedSource.cache !== undefined) {
					fencedSource = {
						...fencedSource,
						expectedCacheGeneration: result.cacheGeneration
					};
				}
				if (entry.kind !== 'recorded') {
					continue;
				}
				recorded.set(entry.publication.result.storePath, {
					publication: entry.publication,
					...(response.output.sourceSelector !== undefined && {
						sourceSelector: response.output.sourceSelector
					})
				});
			}
		}
	}
	return recorded;
}

export function remainingInvocation(
	invocation: Extract<BuildInvocation, { kind: 'constructed' }>,
	selected: ReadonlyMap<string, readonly SelectedOutput[]>,
	recorded: ReadonlyMap<StorePathString, RecordedSelection>
): BuildInvocation | undefined {
	const installables = invocation.build.installables.flatMap((installable) => {
		const outputs = selected.get(installable);
		if (outputs === undefined) {
			return installable;
		}
		const remaining = outputs.filter(
			(output) => !recorded.has(output.storePath)
		);
		if (remaining.length === outputs.length) {
			return installable;
		}
		if (remaining.length === 0) {
			return [];
		}
		return `${installable.split('^', 1)[0] ?? installable}^${remaining.map((output) => output.name).join(',')}`;
	});
	return installables.length === 0
		? undefined
		: { kind: 'constructed', build: { ...invocation.build, installables } };
}

/**
Intersect ownership with the actual accepted selection; cache availability cannot enlarge it.
*/
export async function selectedPublicationFootprints(
	targets: readonly StorePathString[],
	receipt: BuildReceiptV3,
	options: BuildPushRunOptions,
	dependencies: BuildPushDependencies,
	knownOwnership?: PublicationOwnership
): Promise<ReadonlyMap<StorePathString, readonly StorePathString[]>> {
	const footprints = new Map<StorePathString, readonly StorePathString[]>();
	let terms = knownOwnership?.roots;
	if (terms === undefined) {
		const evaluated =
			options.invocation.kind === 'constructed'
				? await (dependencies.targetDerivations ?? targetDerivations)(
						options.invocation.build.installables,
						dependencies.environment ?? process.env,
						dependencies.signal
					)
				: new Map<string, readonly StorePathString[]>(
						targets.map((target) => [
							target,
							receipt.subjects
								.filter(
									(subject) =>
										subject.storePath === target &&
										subject.derivation !== undefined
								)
								.map((subject) => storePathSchema.parse(subject.derivation))
						])
					);
		const roots = [...new Set(evaluated.values().toArray().flat())];
		terms = new Map(
			await Promise.all(
				roots.map(
					async (root) =>
						[root, await dependencies.store.readDerivation(root)] as const
				)
			)
		);
	}
	const roots = terms.keys().toArray();
	const graph = new Map(knownOwnership?.derivations ?? terms);
	const ownership =
		knownOwnership?.outputs ??
		(options.publicationScope === 'outputs' ||
		options.publicationScope === 'closure'
			? []
			: await dependencyOutputs(roots, {
					readDerivation: async (path) => {
						const term =
							graph.get(path) ??
							(await dependencies.store.readDerivation(path));
						graph.set(path, term);
						return term;
					},
					...(dependencies.signal !== undefined && {
						signal: dependencies.signal
					})
				}));
	for (const target of targets) {
		if (!receipt.paths.includes(target)) {
			continue;
		}
		const owners = new Set(
			roots.filter(
				(root) =>
					(terms
						.get(root)
						?.outputs.values()
						.some((output) => output === target) ??
						false) ||
					receipt.subjects.some(
						(subject) =>
							subject.storePath === target && subject.derivation === root
					)
			)
		);
		const producingDependencies = dependencyDerivations(owners, graph);
		const builtIntermediates = receipt.subjects
			.filter(
				(subject) =>
					subject.origin === 'built' &&
					producingDependencies.has(subject.derivation)
			)
			.map((subject) => subject.storePath);
		const closure =
			options.publicationScope === 'closure' || options.closure === true
				? await dependencies.store.resolveClosure([target])
				: undefined;
		let candidates: readonly StorePathString[];
		if (closure !== undefined) {
			candidates = closure.map((info) => info.storePath);
		} else if (options.publicationScope === 'outputs') {
			candidates = [];
		} else {
			candidates = [
				...ownership
					.filter((output) =>
						output.requiredBy.some((root) => owners.has(root))
					)
					.map((output) => output.storePath),
				...builtIntermediates
			];
		}
		footprints.set(
			target,
			[
				...new Set([
					target,
					...candidates.filter(
						(member) =>
							receipt.paths.includes(storePathSchema.parse(member)) &&
							!receipt.leftUpstream?.includes(storePathSchema.parse(member))
					)
				])
			].map((member) => storePathSchema.parse(member))
		);
	}
	return footprints;
}

function dependencyDerivations(
	roots: ReadonlySet<StorePathString>,
	graph: ReadonlyMap<StorePathString, Derivation>
): ReadonlySet<StorePathString> {
	const visited = new Set<StorePathString>();
	const pending = [...roots];
	let index = 0;
	while (index < pending.length) {
		const path = pending[index];
		index += 1;
		if (path === undefined) {
			continue;
		}
		const inputs = graph.get(path)?.inputDerivations.keys() ?? [];
		for (const input of inputs) {
			if (visited.has(input)) {
				continue;
			}
			visited.add(input);
			pending.push(input);
		}
	}
	return visited;
}

export async function ensureSelectedPublication(
	selection: RecordedSelection,
	workflow: BuildPublicationWorkflow,
	options: BuildPushRunOptions,
	requestId: Awaited<ReturnType<typeof publicationRequests>>
): Promise<CompactPublicationSet> {
	const input = {
		source: selection.publication,
		...(selection.sourceSelector !== undefined && {
			sourceSelector: selection.sourceSelector
		}),
		...(options.runRoot !== undefined && {
			runRoot: rootNameSchema.parse(options.runRoot.name)
		})
	};
	const intent = await requestId.intent({ operation: 'ensure', input });
	const response = await workflow.execute(intent);
	if (response.operation !== 'ensure' || !response.supported) {
		throw new Error('Recorded publication support changed during ensure');
	}
	return response.output;
}

export function publicationMemberFor(
	receipt: BuildReceiptV3,
	storePath: StorePathString
) {
	const subject = receipt.subjects.find(
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
}
