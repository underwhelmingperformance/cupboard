import { z } from 'zod';

import { listingAdoptionTaskIdSchema } from '../blob/listing-adoption-tasks.ts';

const kinds = [
	'listing-adoption-work-dispatch',
	'listing-adoption-expand',
	'listing-adoption-deliver'
] as const;
export const listingAdoptionWorkMessageSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal(kinds[0]) }),
	z.strictObject({
		kind: z.literal(kinds[1]),
		id: listingAdoptionTaskIdSchema
	}),
	z.strictObject({
		kind: z.literal(kinds[2]),
		ids: z
			.array(listingAdoptionTaskIdSchema)
			.min(1)
			.max(8)
			.refine((ids) => new Set(ids).size === ids.length, {
				message: 'A delivery hint must contain distinct task identities'
			})
	})
]);
export type ListingAdoptionWorkMessage = z.output<
	typeof listingAdoptionWorkMessageSchema
>;
export const listingAdoptionWorkHeaderSchema = z.looseObject({
	kind: z.enum(kinds)
});
