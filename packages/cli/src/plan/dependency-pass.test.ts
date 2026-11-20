import {
	type StorePathHash,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { type BuildInputsRecordResult } from '@cupboard/protocol/build-inputs';
import { type DependencyStatusEntry } from '@cupboard/protocol/dependency-status';
import { describe, expect, it } from 'vitest';

import {
	type BuildInputsRecordOutcome,
	dependencyCopies,
	type DependencyNode,
	dependencyRecordPlan,
	dependencyWalk
} from './dependency-pass.ts';

function storePath(name: string, index: number): StorePathString {
	return storePathSchema.parse(
		`/nix/store/${String(index).padStart(32, '0')}-${name}`
	);
}

const fetched = storePath('source', 1);
const compiler = storePath('compiler', 2);
const library = storePath('library', 3);
const tool = storePath('tool', 4);
const app = storePath('app', 5);
const manual = storePath('manual', 6);

function node(
	path: StorePathString,
	inputs: readonly StorePathString[],
	kind: DependencyNode['kind'] = 'dependency'
): DependencyNode {
	return {
		storePath: path,
		buildInputs: inputs.map((input) => StorePath.basename(input)),
		kind
	};
}

// `app` needs `library` and `tool`, `library` needs the fetched source and
// `compiler`, and `manual` needs `tool`. The order lists every node after its
// inputs, as `dependencyGraph` does.
const graph: readonly DependencyNode[] = [
	node(fetched, []),
	node(compiler, []),
	node(library, [fetched, compiler]),
	node(tool, []),
	node(app, [library, tool], 'target'),
	node(manual, [tool], 'target')
];

// The same graph with `library` published by the run itself.
const publishedGraph: readonly DependencyNode[] = graph.map((entry) =>
	entry.storePath === library ? { ...entry, kind: 'published' } : entry
);

type State =
	| { readonly state: 'absent'; readonly hasSource?: boolean }
	| { readonly state: 'in-flight' | 'present' }
	| { readonly state: 'recorded'; readonly version: number };

function statuses(
	states: Partial<Record<StorePathString, State>>
): ReadonlyMap<StorePathHash, DependencyStatusEntry> {
	return new Map(
		graph.map(({ storePath: path }) => {
			const storePathHash = StorePath.hash(path);
			const state = states[path] ?? { state: 'present' };
			const entry: DependencyStatusEntry =
				state.state === 'absent'
					? {
							storePathHash,
							state: 'absent',
							...(state.hasSource === true && {
								source: { kind: 'default' }
							})
						}
					: state.state === 'recorded'
						? {
								storePathHash,
								state: 'recorded',
								buildInputsVersion: state.version
							}
						: { storePathHash, state: state.state };

			return [storePathHash, entry];
		})
	);
}

function recordedPaths(
	states: Partial<Record<StorePathString, State>>,
	copied: readonly StorePathString[] = [],
	version = 1
): {
	readonly records: readonly string[];
	readonly blocked: readonly string[];
} {
	const plan = dependencyRecordPlan(
		graph,
		statuses(states),
		new Set(copied),
		version
	);

	return {
		records: plan.records.map((entry) => entry.storePath),
		blocked: plan.blocked
	};
}

// Every planned entry answers `recorded`, except the overrides.
function recordedOutcome(
	records: readonly string[],
	overrides: Partial<Record<string, BuildInputsRecordResult['status']>> = {}
): BuildInputsRecordOutcome {
	return {
		kind: 'recorded',
		results: records.map((path) => ({
			storePath: storePathSchema.parse(path),
			status: overrides[path] ?? 'recorded'
		}))
	};
}

describe('dependencyCopies', () => {
	it('copies only the absent paths that another cache can supply', () => {
		expect(
			dependencyCopies(
				graph,
				statuses({
					[fetched]: { state: 'absent', hasSource: true },
					[compiler]: { state: 'absent' },
					[library]: { state: 'in-flight' },
					[tool]: { state: 'recorded', version: 1 },
					[manual]: { state: 'absent', hasSource: true }
				})
			)
		).toStrictEqual([fetched, manual]);
	});

	it('never copies a path that the run publishes itself', () => {
		expect(
			dependencyCopies(
				publishedGraph,
				statuses({
					[fetched]: { state: 'absent', hasSource: true },
					[library]: { state: 'absent', hasSource: true }
				})
			)
		).toStrictEqual([fetched]);
	});
});

describe('dependencyRecordPlan', () => {
	it('records each present path after its inputs, in graph order', () => {
		const plan = dependencyRecordPlan(graph, statuses({}), new Set(), 1);

		expect(plan).toStrictEqual({
			records: [
				{ storePath: fetched, buildInputs: [], buildInputsVersion: 1 },
				{ storePath: compiler, buildInputs: [], buildInputsVersion: 1 },
				{
					storePath: library,
					buildInputs: [
						StorePath.basename(fetched),
						StorePath.basename(compiler)
					],
					buildInputsVersion: 1
				},
				{ storePath: tool, buildInputs: [], buildInputsVersion: 1 },
				{
					storePath: app,
					buildInputs: [StorePath.basename(library), StorePath.basename(tool)],
					buildInputsVersion: 1
				},
				{
					storePath: manual,
					buildInputs: [StorePath.basename(tool)],
					buildInputsVersion: 1
				}
			],
			blocked: []
		});
	});

	it.each([
		{
			name: 'skips a path recorded at the current version',
			states: { [compiler]: { state: 'recorded', version: 2 } },
			version: 2,
			records: [fetched, library, tool, app, manual]
		},
		{
			name: 'records a path again that an earlier version recorded',
			states: { [compiler]: { state: 'recorded', version: 1 } },
			version: 2,
			records: [fetched, compiler, library, tool, app, manual]
		},
		{
			name: 'records a path again that a newer version recorded',
			states: { [compiler]: { state: 'recorded', version: 3 } },
			version: 2,
			records: [fetched, compiler, library, tool, app, manual]
		}
	] as const)('$name', ({ states, version, records }) => {
		expect(recordedPaths(states, [], version)).toStrictEqual({
			records,
			blocked: []
		});
	});

	it.each([
		{
			name: 'an input in flight blocks every path above it',
			states: { [compiler]: { state: 'in-flight' } },
			copied: [],
			result: { records: [fetched, tool, manual], blocked: [library, app] }
		},
		{
			name: 'an input that no cache can supply blocks nothing',
			states: { [fetched]: { state: 'absent' } },
			copied: [],
			result: { records: [compiler, library, tool, app, manual], blocked: [] }
		},
		{
			name: 'an input that was not copied blocks every path above it',
			states: { [fetched]: { state: 'absent', hasSource: true } },
			copied: [],
			result: { records: [compiler, tool, manual], blocked: [library, app] }
		},
		{
			name: 'a copied input blocks nothing and is recorded in case its copy dropped its build inputs',
			states: { [fetched]: { state: 'absent', hasSource: true } },
			copied: [fetched],
			result: {
				records: [fetched, compiler, library, tool, app, manual],
				blocked: []
			}
		},
		{
			name: 'a recorded path passes on an input in flight below it',
			states: {
				[compiler]: { state: 'in-flight' },
				[library]: { state: 'recorded', version: 1 }
			},
			copied: [],
			result: { records: [fetched, tool, manual], blocked: [app] }
		},
		{
			name: 'a target in flight is neither recorded nor blocked',
			states: { [manual]: { state: 'in-flight' } },
			copied: [],
			result: { records: [fetched, compiler, library, tool, app], blocked: [] }
		}
	] as const)('$name', ({ states, copied, result }) => {
		expect(recordedPaths(states, copied)).toStrictEqual(result);
	});

	it('records a path that the run publishes and the cache already has', () => {
		const plan = dependencyRecordPlan(
			publishedGraph,
			statuses({}),
			new Set(),
			1
		);

		expect({
			records: plan.records.map((entry) => entry.storePath),
			blocked: plan.blocked
		}).toStrictEqual({
			records: [fetched, compiler, library, tool, app, manual],
			blocked: []
		});
	});

	it('never records a path that the run publishes later, and passes on what is below it', () => {
		const plan = dependencyRecordPlan(
			publishedGraph,
			statuses({
				[compiler]: { state: 'in-flight' },
				[library]: { state: 'absent', hasSource: true }
			}),
			new Set(),
			1
		);

		expect({
			records: plan.records.map((entry) => entry.storePath),
			blocked: plan.blocked
		}).toStrictEqual({ records: [fetched, tool, manual], blocked: [app] });
	});

	it('records only the rest after a run that recorded a prefix was cancelled', () => {
		const first = dependencyRecordPlan(graph, statuses({}), new Set(), 1);
		const cancelledAfter = 3;
		const recordedPrefix = first.records
			.slice(0, cancelledAfter)
			.map(
				(entry) =>
					[entry.storePath, { state: 'recorded', version: 1 } as const] as const
			);
		const second = dependencyRecordPlan(
			graph,
			statuses(Object.fromEntries(recordedPrefix)),
			new Set(),
			1
		);

		expect(second).toStrictEqual({
			records: first.records.slice(cancelledAfter),
			blocked: []
		});
	});
});

function attached(
	nodes: readonly DependencyNode[],
	states: Partial<Record<StorePathString, State>>,
	outcome: (records: readonly string[]) => BuildInputsRecordOutcome,
	copied: readonly StorePathString[] = [],
	version = 1
): readonly StorePathString[] {
	const statusMap = statuses(states);
	const copiedSet = new Set(copied);
	const plan = dependencyRecordPlan(nodes, statusMap, copiedSet, version);

	return dependencyWalk(
		nodes,
		statusMap,
		copiedSet,
		outcome(plan.records.map((entry) => entry.storePath)),
		version
	).attached;
}

describe('dependencyWalk attachments', () => {
	it.each([
		{
			name: 'a run that records every path attaches nothing',
			nodes: graph,
			states: {},
			outcome: (records: readonly string[]) => recordedOutcome(records),
			paths: []
		},
		{
			name: 'an input in flight leaves the blocked path and the recorded path below it to the run root',
			nodes: graph,
			states: { [compiler]: { state: 'in-flight' } },
			outcome: (records: readonly string[]) => recordedOutcome(records),
			paths: [fetched, library]
		},
		{
			name: 'a pull-request run attaches a recorded path under an unrecorded parent',
			nodes: graph,
			states: { [tool]: { state: 'recorded', version: 1 } },
			outcome: (): BuildInputsRecordOutcome => ({ kind: 'not-requested' }),
			paths: [fetched, compiler, library, tool]
		},
		{
			name: 'an intermediate that the cache cannot record keeps nothing below it',
			nodes: graph,
			states: {},
			outcome: (records: readonly string[]) =>
				recordedOutcome(records, { [library]: 'limit-exceeded' }),
			paths: [fetched, compiler]
		},
		{
			name: 'an intermediate whose stored build inputs are unreadable keeps nothing below it',
			nodes: graph,
			states: {},
			outcome: (records: readonly string[]) =>
				recordedOutcome(records, { [library]: 'invalid-stored' }),
			paths: [fetched, compiler]
		},
		{
			name: 'a refused record attaches every path that no target reaches',
			nodes: graph,
			states: {},
			outcome: (): BuildInputsRecordOutcome => ({ kind: 'refused' }),
			paths: [fetched, compiler, library, tool]
		},
		{
			name: 'a path that the run publishes later leaves its present inputs to the run root',
			nodes: publishedGraph,
			states: { [library]: { state: 'absent', hasSource: true } },
			outcome: (records: readonly string[]) => recordedOutcome(records),
			paths: [fetched, compiler]
		},
		{
			name: 'a run after an upgrade, with every path present, records a path that it publishes and attaches nothing',
			nodes: publishedGraph,
			states: {},
			outcome: (records: readonly string[]) => recordedOutcome(records),
			paths: []
		},
		{
			name: 'a run after an upgrade, with every path present and the record refused, attaches the inputs of a path that it publishes',
			nodes: publishedGraph,
			states: {},
			outcome: (): BuildInputsRecordOutcome => ({ kind: 'refused' }),
			paths: [fetched, compiler, tool]
		}
	] as const)('$name', ({ nodes, states, outcome, paths }) => {
		expect(attached(nodes, states, outcome)).toStrictEqual(paths);
	});

	it('attaches a copied path that no recorded parent lists, and keeps its inputs through it', () => {
		expect(
			attached(
				graph,
				{ [library]: { state: 'absent', hasSource: true } },
				(records) => recordedOutcome(records, { [app]: 'limit-exceeded' }),
				[library]
			)
		).toStrictEqual([library]);
	});

	// The document is at version 2, and `library` was recorded at another
	// version or at the same one. Only the same version shows that its row
	// lists the graph's build inputs without a record result.
	it.each([
		{ version: 1, outcome: 'recorded', paths: [] },
		{ version: 2, outcome: 'recorded', paths: [] },
		{ version: 3, outcome: 'recorded', paths: [] },
		{
			version: 1,
			outcome: 'not-requested',
			paths: [fetched, compiler, library, tool]
		},
		{ version: 2, outcome: 'not-requested', paths: [library, tool] },
		{
			version: 3,
			outcome: 'not-requested',
			paths: [fetched, compiler, library, tool]
		}
	] as const)(
		'keeps the inputs of a path recorded at version $version only when they are confirmed ($outcome)',
		({ version, outcome, paths }) => {
			expect(
				attached(
					graph,
					{ [library]: { state: 'recorded', version } },
					(records) =>
						outcome === 'recorded'
							? recordedOutcome(records)
							: { kind: 'not-requested' },
					[],
					2
				)
			).toStrictEqual(paths);
		}
	);
});

describe('dependencyWalk', () => {
	it('lists the paths that it attaches and the listed paths whose rows keep their inputs', () => {
		const states = statuses({ [library]: { state: 'recorded', version: 1 } });

		expect(
			dependencyWalk(graph, states, new Set(), { kind: 'not-requested' }, 1)
		).toStrictEqual({
			attached: [library, tool],
			listed: [fetched, compiler],
			confirmed: []
		});
	});

	it.each([
		{
			name: 'a pass whose record results keep the inputs',
			states: {},
			confirmed: [library, app, manual]
		},
		{
			name: 'a pass over rows that were already recorded at its version',
			states: Object.fromEntries(
				graph.map(({ storePath: path }) => [
					path,
					{ state: 'recorded', version: 1 } as const
				])
			),
			confirmed: []
		}
	])(
		'lists the paths whose inputs it keeps only through a record result for $name',
		({ states, confirmed }) => {
			const statusMap = statuses(states);
			const plan = dependencyRecordPlan(graph, statusMap, new Set(), 1);
			const outcome = recordedOutcome(
				plan.records.map((entry) => entry.storePath)
			);

			expect(
				dependencyWalk(graph, statusMap, new Set(), outcome, 1)
			).toStrictEqual({
				attached: [],
				listed: [fetched, compiler, library, tool],
				confirmed
			});
		}
	);
});
