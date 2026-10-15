import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import {
	listingGeneratorRevisionSchema,
	type NarListingIdentity,
	narListingIdentitySchema
} from '@cupboard/protocol/artifacts';
import { z } from 'zod';

import {
	type ListingAdoptionParent,
	listingAdoptionParentIdSchema,
	listingAdoptionParentSchema
} from './listing-adoption-parents.ts';

const parentWindowSchema = z
	.strictObject({
		kind: z.literal('parent'),
		parent: listingAdoptionParentSchema,
		after: listingGeneratorRevisionSchema.optional(),
		through: listingGeneratorRevisionSchema
	})
	.refine(
		(window) => window.after === undefined || window.after <= window.through,
		{
			path: ['after'],
			message: 'The expansion cursor must not exceed its upper boundary'
		}
	);
const listingWindowSchema = z
	.strictObject({
		kind: z.literal('listing'),
		identity: narListingIdentitySchema,
		after: listingAdoptionParentIdSchema.optional(),
		through: listingAdoptionParentIdSchema
	})
	.refine(
		(window) => window.after === undefined || window.after <= window.through,
		{
			path: ['after'],
			message: 'The expansion cursor must not exceed its upper boundary'
		}
	);
const casWindowSchema = z
	.strictObject({
		kind: z.literal('cas'),
		digest: sha256HexDigestSchema,
		incarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		after: narListingIdentitySchema.optional(),
		through: narListingIdentitySchema
	})
	.refine(
		(window) =>
			window.after === undefined ||
			window.after.narHash < window.through.narHash ||
			(window.after.narHash === window.through.narHash &&
				window.after.generatorRevision <= window.through.generatorRevision),
		{
			path: ['after'],
			message: 'The expansion cursor must not exceed its upper boundary'
		}
	);
export const listingAdoptionExpansionWindowSchema = z.discriminatedUnion(
	'kind',
	[parentWindowSchema, listingWindowSchema, casWindowSchema]
);
export type ListingAdoptionExpansionWindow = z.output<
	typeof listingAdoptionExpansionWindowSchema
>;
export interface ListingAdoptionTarget {
	readonly parent: ListingAdoptionParent;
	readonly identity: NarListingIdentity;
}
interface ExpansionProgress {
	readonly scanned: number;
	readonly isComplete: boolean;
}
export type ListingAdoptionExpansionPage =
	| (ExpansionProgress & {
			readonly kind: 'parent';
			readonly window: Extract<
				ListingAdoptionExpansionWindow,
				{ kind: 'parent' }
			>;
			readonly targets: readonly ListingAdoptionTarget[];
	  })
	| (ExpansionProgress & {
			readonly kind: 'listing';
			readonly window: Extract<
				ListingAdoptionExpansionWindow,
				{ kind: 'listing' }
			>;
			readonly targets: readonly ListingAdoptionTarget[];
	  })
	| (ExpansionProgress & {
			readonly kind: 'cas';
			readonly window: Extract<ListingAdoptionExpansionWindow, { kind: 'cas' }>;
			readonly identities: readonly NarListingIdentity[];
	  });
export type ListingAdoptionExpansionOpenResult =
	| { readonly kind: 'window'; readonly window: ListingAdoptionExpansionWindow }
	| { readonly kind: 'empty' | 'unavailable' };
export type ListingAdoptionExpansionPageResult =
	| { readonly kind: 'page'; readonly page: ListingAdoptionExpansionPage }
	| { readonly kind: 'obsolete' | 'unavailable' };
