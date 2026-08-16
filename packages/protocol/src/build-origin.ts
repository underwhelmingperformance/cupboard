import { z } from 'zod';

import {
	builtOriginFields,
	copiedOriginFields,
	storeHeldOriginFields
} from './build.ts';

/**
 * The in-toto predicate type of a cupboard build-origin statement. The project
 * owns no domain, so the repository URL is the namespace, and the trailing
 * version changes when the predicate's shape does.
 */
export const buildOriginPredicateType =
	'https://github.com/underwhelmingperformance/cupboard/predicate/build-origin/v2';

// One path's origin, copied from the receipt subject that recorded it. The
// three cases carry different fields because the run has different evidence for
// each: a path it built, a path the store registered as its own work, and a
// path that entered the store from elsewhere.
//
// These are the receipt's own facts. The statement reports what the run
// established about where a path came from. It does not claim that the path is
// reproducible, that its producer deserves trust, or, for a copied path, that
// any particular substituter served it.
export const buildOriginSubjectSchema = z.discriminatedUnion('origin', [
	z.strictObject({ origin: z.literal('built'), ...builtOriginFields }),
	z.strictObject({ origin: z.literal('store-held'), ...storeHeldOriginFields }),
	z.strictObject({ origin: z.literal('copied'), ...copiedOriginFields })
]);
export type ParsedBuildOriginSubject = z.output<
	typeof buildOriginSubjectSchema
>;

// One statement covers every path the run published from its store, so a reader
// who verified the statement for one path can also read the origin of every
// other path in the same run.
export const buildOriginPredicateSchema = z.strictObject({
	subjects: z.array(buildOriginSubjectSchema).min(1)
});
export type ParsedBuildOriginPredicate = z.output<
	typeof buildOriginPredicateSchema
>;

// Input types for constructing a predicate: a schema's input is unbranded, so
// the attest command constructs a predicate from these types directly.
export type BuildOriginSubject = z.input<typeof buildOriginSubjectSchema>;
export type BuildOriginPredicate = z.input<typeof buildOriginPredicateSchema>;
