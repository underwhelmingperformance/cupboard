import type {
	StorePathBasename,
	StorePathHash,
	StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	BuildInputsRecordEntry,
	BuildInputsRecordResult
} from '@cupboard/protocol/build-inputs';
import type { DependencyStatusEntry } from '@cupboard/protocol/dependency-status';

/**
An output in the dependency graph of the targets that a publication covers,
with its direct build inputs as store path basenames. `target` is a target
output that its root keeps. `dependency` is an output that a target needs to
be built. `published` is a path that the run publishes itself and keeps with a
root, so the pass never copies it. The publication records its build inputs
only when it creates the row, so the pass records them like any other path's.
*/
export interface DependencyNode {
	readonly storePath: StorePathString;
	readonly buildInputs: readonly StorePathBasename[];
	readonly kind: 'target' | 'dependency' | 'published';
}

/**
The build inputs that a dependency pass records, in the order in which it
sends them, and the paths that it cannot record yet.
*/
export interface DependencyRecordPlan {
	/**
	One entry for each path that the cache has, or that the pass copied,
	without build inputs at the document's version, in graph order. Every path
	comes after the paths among its build inputs.
	*/
	readonly records: readonly BuildInputsRecordEntry[];
	/**
	The paths that need build inputs but have a build input, directly or
	further down, that is in flight or that the pass did not copy.
	*/
	readonly blocked: readonly StorePathString[];
}

/**
The outcome of recording the entries of a {@link DependencyRecordPlan}:
the result of each entry, or why the pass recorded none of them.
*/
export type BuildInputsRecordOutcome =
	| {
			readonly kind: 'recorded';
			readonly results: readonly BuildInputsRecordResult[];
	  }
	| { readonly kind: 'not-requested' | 'refused' | 'failed' };

function statusOf(
	statuses: ReadonlyMap<StorePathHash, DependencyStatusEntry>,
	storePath: StorePathString
): DependencyStatusEntry {
	const status = statuses.get(StorePath.hash(storePath));

	if (status === undefined) {
		throw new DependencyStatusMissingError(storePath);
	}

	return status;
}

/**
Returns the paths that the destination does not have and that another cache
of the tenant can supply, in graph order. The pass copies these by
reference. It never copies a path that the destination has, one that is
being uploaded to it, or one that the run publishes itself.
*/
export function dependencyCopies(
	nodes: readonly DependencyNode[],
	statuses: ReadonlyMap<StorePathHash, DependencyStatusEntry>
): readonly StorePathString[] {
	return nodes
		.filter(({ storePath, kind }) => {
			const status = statusOf(statuses, storePath);

			return (
				kind !== 'published' &&
				status.state === 'absent' &&
				status.source !== undefined
			);
		})
		.map(({ storePath }) => storePath);
}

/**
Plans the build inputs to record for the paths that the destination has and
the paths that the pass copied. A copy can lose its build inputs: the client
leaves out a list that a row cannot store, an earlier server does not accept
them, and a concurrent publication can create the row first. The server
answers `unchanged` when the copy recorded them.

A path whose build inputs include a path in flight, or an absent path that
another cache could supply but the pass did not copy, is blocked, and so is
every path above it. The plan never records a blocked path. A copy sends the
build inputs of every copied path, so a copied row can list an input that the
plan blocks; the walk does not rely on such a row until a record result
confirms it.

The entries keep graph order, which puts every path after its inputs. A
cancelled run therefore leaves no recorded path above an unrecorded one.
*/
export function dependencyRecordPlan(
	nodes: readonly DependencyNode[],
	statuses: ReadonlyMap<StorePathHash, DependencyStatusEntry>,
	copied: ReadonlySet<StorePathString>,
	buildInputsVersion: number
): DependencyRecordPlan {
	// The nodes whose closure in this graph has a path in flight or a path
	// that was not copied. Graph order lists every node after its inputs, so
	// each input is decided before the nodes that need it.
	const incomplete = new Set<StorePathBasename>();
	const records: BuildInputsRecordEntry[] = [];
	const blocked: StorePathString[] = [];

	for (const node of nodes) {
		const status = statusOf(statuses, node.storePath);
		const hasIncompleteInput = node.buildInputs.some((input) =>
			incomplete.has(input)
		);
		const isUncopied =
			status.state === 'absent' &&
			status.source !== undefined &&
			!copied.has(node.storePath);
		const isInFlight = status.state === 'in-flight';

		if (hasIncompleteInput || isUncopied || isInFlight) {
			incomplete.add(StorePath.basename(node.storePath));
		}

		const requiresRecord =
			status.state === 'present' ||
			copied.has(node.storePath) ||
			(status.state === 'recorded' &&
				!isRecordedAtVersion(status, buildInputsVersion));

		if (!requiresRecord) {
			continue;
		}

		if (hasIncompleteInput) {
			blocked.push(node.storePath);
			continue;
		}

		records.push({
			storePath: node.storePath,
			buildInputs: [...node.buildInputs],
			buildInputsVersion
		});
	}

	return { records, blocked };
}

/**
Whether a `recorded` status shows, without a record result, that the row
lists this graph's build inputs. The path of an input-addressed output
decides its derivation and therefore its direct build inputs, so a row
recorded at the document's version lists the same inputs. A fixed-output
output has no build inputs, and a floating content-addressed output has no
entry in the graph. A row recorded at another version, lower or higher, can
list other inputs, so only a record result confirms them.
*/
function isRecordedAtVersion(
	status: DependencyStatusEntry,
	buildInputsVersion: number
): boolean {
	return (
		status.state === 'recorded' &&
		status.buildInputsVersion === buildInputsVersion
	);
}

/**
The result of the walk that decides what the run root keeps, with each list
in graph order. `attached` lists the paths to attach, and `listed` the paths
with rows that a kept parent's recorded build inputs keep; the walk relies on
the rows of both. `confirmed` lists the kept paths whose build inputs the walk
follows only because a record result of this pass confirmed them. Their
statuses did not show those inputs when the pass read them.
*/
export interface DependencyWalk {
	readonly attached: readonly StorePathString[];
	readonly listed: readonly StorePathString[];
	readonly confirmed: readonly StorePathString[];
}

/**
Walks the graph from the targets down to decide what the run root keeps.
Collection keeps a path through its target root, through the run root, or
through the recorded build inputs of a path that it keeps. A target, and a
path that the run publishes itself, is kept by its root. Another path is
kept when a kept parent has recorded build inputs after the pass: its status
shows them at the document's version, or its record result confirms them. A
path that the cache has but that nothing keeps is attached, and from then on
counts as kept, so its own recorded build inputs keep the paths below it.
*/
export function dependencyWalk(
	nodes: readonly DependencyNode[],
	statuses: ReadonlyMap<StorePathHash, DependencyStatusEntry>,
	copied: ReadonlySet<StorePathString>,
	outcome: BuildInputsRecordOutcome,
	buildInputsVersion: number
): DependencyWalk {
	const confirmed = new Set(
		outcome.kind === 'recorded'
			? outcome.results
					.filter(
						({ status }) => status === 'recorded' || status === 'unchanged'
					)
					.map(({ storePath }) => storePath)
			: []
	);
	const listed = new Set<StorePathBasename>();
	const attached = new Set<StorePathString>();
	const listedRows = new Set<StorePathString>();
	const confirmedRows = new Set<StorePathString>();

	for (const node of nodes.toReversed()) {
		const status = statusOf(statuses, node.storePath);
		const isOwnRoot = node.kind === 'target' || node.kind === 'published';
		const hasRow =
			status.state === 'present' ||
			status.state === 'recorded' ||
			copied.has(node.storePath);
		const isListed = listed.has(StorePath.basename(node.storePath));
		let isKept = isOwnRoot || isListed;

		if (isListed && !isOwnRoot && hasRow) {
			listedRows.add(node.storePath);
		}

		if (!isKept && hasRow) {
			attached.add(node.storePath);
			isKept = true;
		}

		const isRecordedInStatus = isRecordedAtVersion(status, buildInputsVersion);
		const hasRecordedBuildInputs =
			isRecordedInStatus || confirmed.has(node.storePath);

		if (
			isKept &&
			!isRecordedInStatus &&
			confirmed.has(node.storePath) &&
			node.buildInputs.length > 0
		) {
			confirmedRows.add(node.storePath);
		}

		if (isKept && hasRecordedBuildInputs) {
			for (const input of node.buildInputs) {
				listed.add(input);
			}
		}
	}

	const inGraphOrder = (paths: ReadonlySet<StorePathString>) =>
		nodes
			.filter(({ storePath }) => paths.has(storePath))
			.map(({ storePath }) => storePath);

	return {
		attached: inGraphOrder(attached),
		listed: inGraphOrder(listedRows),
		confirmed: inGraphOrder(confirmedRows)
	};
}

/**
The dependency status answer has no entry for a path in the graph.
*/
export class DependencyStatusMissingError extends Error {
	constructor(readonly storePath: StorePathString) {
		super(`The dependency status has no entry for ${storePath}`);
		this.name = 'DependencyStatusMissingError';
	}
}
