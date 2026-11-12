import {
	type RootBatchBody,
	rootBatchCapacity,
	rootBatchEntryCost,
	type RootBatchResponse,
	type RootBatchResult
} from '@cupboard/protocol/retention';
import { UsageError } from '@cupboard/shared/errors';

export type RootBatchEntry = RootBatchBody['roots'][number];

// A server from before `roots.batch` gets one request per root. A push sets its
// implicit pins with the same number of requests at a time.
export const separateRootRequestConcurrency = 6;

export class RootTargetLimitError extends UsageError {
	constructor(
		public readonly count: number,
		public readonly limit: number
	) {
		super(
			`the root update would carry ${String(count)} targets, but one update ` +
				`accepts at most ${String(limit)}; split the paths across named roots`
		);
		this.name = 'RootTargetLimitError';
	}
}

/**
Splits root updates into consecutive batches in their original order. The
`rootBatchEntryCost` of the entries in one batch adds up to at most
`rootBatchCapacity`, the bound that the tenant object enforces. A root whose
cost alone exceeds the capacity is refused with `RootTargetLimitError` before
any request is sent.
*/
export function rootBatches(
	entries: readonly RootBatchEntry[]
): readonly (readonly RootBatchEntry[])[] {
	const batches: RootBatchEntry[][] = [];
	let current: RootBatchEntry[] = [];
	let currentCost = 0;

	for (const entry of entries) {
		const cost = rootBatchEntryCost(entry);

		if (cost > rootBatchCapacity) {
			throw new RootTargetLimitError(entry.targets.length, rootBatchCapacity);
		}

		if (currentCost + cost > rootBatchCapacity) {
			batches.push(current);
			current = [];
			currentCost = 0;
		}

		current.push(entry);
		currentCost += cost;
	}

	if (current.length > 0) {
		batches.push(current);
	}

	return batches;
}

/**
Sends the root updates in batches, one request at a time, and returns one
result per update in the original order.
*/
export async function applyRootBatches(
	send: (body: RootBatchBody) => Promise<RootBatchResponse>,
	entries: readonly RootBatchEntry[]
): Promise<readonly RootBatchResult[]> {
	const results: RootBatchResult[] = [];

	for (const batch of rootBatches(entries)) {
		const response = await send({ roots: [...batch] });

		results.push(...response.roots);
	}

	return results;
}
