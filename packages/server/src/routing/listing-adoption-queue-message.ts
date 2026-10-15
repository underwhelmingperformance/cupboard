import { z } from 'zod';

import { listingAdoptionSeedScopeSchema } from '../blob/listing-adoption-seed-dispatch.ts';

const kinds = ['listing-adoption-dispatch', 'listing-adoption-seed'] as const;
export const listingAdoptionQueueMessageSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal(kinds[0]) }),
	z.strictObject({
		kind: z.literal(kinds[1]),
		scope: listingAdoptionSeedScopeSchema
	})
]);
export type ListingAdoptionQueueMessage = z.output<
	typeof listingAdoptionQueueMessageSchema
>;
export const listingAdoptionQueueHeaderSchema = z.looseObject({
	kind: z.enum(kinds)
});
