import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import {
	listingAdoptionCaptureSequenceSchema,
	listingAdoptionCaptureSourceSchema
} from './listing-adoption-capture.ts';

export const listingAdoptionConsumerEpochSchema = z
	.string()
	.regex(/^[\da-f]{32}$/)
	.brand('ListingAdoptionConsumerEpoch');
export type ListingAdoptionConsumerEpoch = z.output<
	typeof listingAdoptionConsumerEpochSchema
>;
export const listingAdoptionWorkIdSchema = z
	.string()
	.regex(/^[\da-f]{32}$/)
	.brand('ListingAdoptionWorkId');
export type ListingAdoptionWorkId = z.output<
	typeof listingAdoptionWorkIdSchema
>;
export const listingAdoptionCapturedWorkSchema = z.strictObject({
	id: listingAdoptionWorkIdSchema,
	consumerEpoch: listingAdoptionConsumerEpochSchema,
	eventId: listingAdoptionCaptureSequenceSchema.positive(),
	source: listingAdoptionCaptureSourceSchema,
	createdAt: isoTimestampSchema
});
export type ListingAdoptionCapturedWork = z.output<
	typeof listingAdoptionCapturedWorkSchema
>;
