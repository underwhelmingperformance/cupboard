import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type BuildReceiptV4,
	buildReceiptV4Schema
} from '@cupboard/protocol/build';
import type { CompactPublicationSet } from '@cupboard/protocol/publication-manifests';
import { z } from 'zod';

export const publicationReceiptSchema = z.union([
	buildReceiptV3Schema,
	buildReceiptV4Schema
]);
export type PublicationReceipt = BuildReceiptV3 | BuildReceiptV4;

/**
Sets overlap: deduplicate identities, never add their member counts.
*/
export function receiptPublicationSets(
	receipts: readonly PublicationReceipt[]
): CompactPublicationSet[] {
	const sets = new Map<string, CompactPublicationSet>();
	for (const receipt of receipts) {
		const publications =
			receipt.version === 4 ? (receipt.publicationSets ?? []) : [];
		for (const set of publications) {
			sets.set(JSON.stringify([set.result, set.digest]), set);
		}
	}
	return [...sets]
		.toSorted(([left], [right]) => byCodeUnit(left, right))
		.map(([, set]) => set);
}
