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
