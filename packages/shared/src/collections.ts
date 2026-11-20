import { positiveSafeInteger } from './limits.ts';

/**
Splits `items` into consecutive runs of at most `size`.
*/
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunkSize = positiveSafeInteger(size, 'chunk size');
	const chunks: T[][] = [];

	for (let start = 0; start < items.length; start += chunkSize) {
		chunks.push(items.slice(start, start + chunkSize));
	}

	return chunks;
}

/**
The limits of each run that {@link chunkByWeight} makes.
*/
export interface WeightedChunkLimits {
	readonly maxItems: number;
	readonly maxWeight: number;
}

/**
Splits `items` into consecutive runs of at most `limits.maxItems` items whose
weights add up to at most `limits.maxWeight`. An item that weighs more than
`limits.maxWeight` on its own gets a run of its own.
*/
export function chunkByWeight<T>(
	items: readonly T[],
	limits: WeightedChunkLimits,
	weight: (item: T) => number
): T[][] {
	const maxItems = positiveSafeInteger(limits.maxItems, 'chunk size');
	const chunks: T[][] = [];
	let current: T[] = [];
	let currentWeight = 0;

	for (const item of items) {
		const itemWeight = weight(item);

		if (
			current.length > 0 &&
			(current.length === maxItems ||
				currentWeight + itemWeight > limits.maxWeight)
		) {
			chunks.push(current);
			current = [];
			currentWeight = 0;
		}

		current.push(item);
		currentWeight += itemWeight;
	}

	if (current.length > 0) {
		chunks.push(current);
	}

	return chunks;
}

/**
One page of a collection and the operation that fetches its continuation.
*/
export interface ProgressivePage<T> {
	readonly items: readonly T[];
	readonly next?: () => Promise<ProgressivePage<T>>;
}

/**
Limits for a collection that is read one page at a time.
*/
export interface ProgressiveCollectionLimits {
	readonly description: string;
	readonly maximumItems: number;
	readonly maximumPages: number;
}

export class ProgressiveCollectionLimitError extends Error {
	constructor(
		public readonly description: string,
		public readonly maximumItems: number,
		public readonly maximumPages: number,
		public readonly observedItems: number,
		public readonly observedPages: number
	) {
		const limitDescription =
			observedItems > maximumItems
				? `received more than ${String(maximumItems)} items`
				: `still had results after ${String(maximumPages)} pages`;

		super(
			`${description} ${limitDescription}. It read ${String(observedItems)} items across ${String(observedPages)} pages; narrow the search before retrying`
		);
		this.name = 'ProgressiveCollectionLimitError';
	}
}

interface ProgressiveVisitor<T, R> {
	visit(item: T): { readonly value: R } | undefined;
	complete(): R;
}

function noItem(): undefined {
	return;
}

async function visitProgressively<T, R>(
	firstPage: ProgressivePage<T>,
	limits: ProgressiveCollectionLimits,
	visitor: ProgressiveVisitor<T, R>
): Promise<R> {
	const maximumItems = positiveSafeInteger(
		limits.maximumItems,
		'progressive collection item limit'
	);
	const maximumPages = positiveSafeInteger(
		limits.maximumPages,
		'progressive collection page limit'
	);
	let observedItems = 0;
	let observedPages = 0;
	let page: ProgressivePage<T> = firstPage;

	for (;;) {
		observedPages += 1;

		for (const item of page.items) {
			observedItems += 1;

			if (observedItems > maximumItems) {
				throw new ProgressiveCollectionLimitError(
					limits.description,
					maximumItems,
					maximumPages,
					observedItems,
					observedPages
				);
			}

			const result = visitor.visit(item);

			if (result !== undefined) {
				return result.value;
			}
		}

		if (page.next === undefined) {
			return visitor.complete();
		}

		if (observedPages >= maximumPages) {
			throw new ProgressiveCollectionLimitError(
				limits.description,
				maximumItems,
				maximumPages,
				observedItems,
				observedPages
			);
		}

		page = await page.next();
	}
}

/**
Finds the first matching item without fetching later pages.
*/
export function findProgressively<T>(
	firstPage: ProgressivePage<T>,
	isMatch: (item: T) => boolean,
	limits: ProgressiveCollectionLimits
): Promise<T | undefined> {
	return visitProgressively(firstPage, limits, {
		visit: (item) => (isMatch(item) ? { value: item } : undefined),
		complete: noItem
	});
}

/**
Collects every item while enforcing item and page limits.
*/
export function collectProgressively<T>(
	firstPage: ProgressivePage<T>,
	limits: ProgressiveCollectionLimits
): Promise<T[]> {
	const items: T[] = [];

	return visitProgressively(firstPage, limits, {
		visit(item) {
			items.push(item);

			return;
		},
		complete: () => items
	});
}

/**
Collects matching items while enforcing item and page limits.
*/
export function filterProgressively<T>(
	firstPage: ProgressivePage<T>,
	isMatch: (item: T) => boolean,
	limits: ProgressiveCollectionLimits
): Promise<T[]> {
	const matches: T[] = [];

	return visitProgressively(firstPage, limits, {
		visit(item) {
			if (isMatch(item)) {
				matches.push(item);
			}

			return;
		},
		complete: () => matches
	});
}
