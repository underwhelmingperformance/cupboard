import { z } from 'zod';

import {
	builtOriginFields,
	copiedOriginFields,
	republishedOriginFields,
	storeHeldOriginFields
} from './build.ts';

/**
 * The in-toto predicate type of a cupboard build-origin statement. The project
 * owns no domain, so the repository URL is the namespace, and the trailing
 * version changes when the predicate's shape does.
 */
export const buildOriginPredicateType =
	'https://github.com/underwhelmingperformance/cupboard/predicate/build-origin/v2';

// Each subject records the origin of one path from the receipt. The four cases
// distinguish paths that the run built, paths that the store identifies as
// builds, paths copied into the store, and paths that no queried store held.
//
// These are the receipt's own facts. The statement reports what the run
// established about where a path came from. It does not claim that the path is
// reproducible, that its producer deserves trust, or, for a copied path, that
// any particular substituter served it.
export const buildOriginSubjectSchema = z.discriminatedUnion('origin', [
	z.strictObject({ origin: z.literal('built'), ...builtOriginFields }),
	z.strictObject({ origin: z.literal('store-held'), ...storeHeldOriginFields }),
	z.strictObject({ origin: z.literal('copied'), ...copiedOriginFields }),
	z.strictObject({
		origin: z.literal('republished'),
		...republishedOriginFields
	})
]);
export type ParsedBuildOriginSubject = z.output<
	typeof buildOriginSubjectSchema
>;

// With run grouping, one statement contains every receipt subject accepted by
// the attestation step. A reader who verifies the statement for one subject can
// also inspect the evidence for the other accepted subjects. With individual
// grouping, each predicate contains only its own subject.
export const buildOriginPredicateSchema = z.strictObject({
	subjects: z.array(buildOriginSubjectSchema).min(1)
});
export type ParsedBuildOriginPredicate = z.output<
	typeof buildOriginPredicateSchema
>;

export type BuildOriginSubject = z.input<typeof buildOriginSubjectSchema>;
export type BuildOriginPredicate = z.input<typeof buildOriginPredicateSchema>;
