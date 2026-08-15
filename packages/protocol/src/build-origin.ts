import {
	sha256HexDigestSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	buildStoreSchema,
	derivationPathSchema,
	subjectVerificationSchema
} from './build.ts';

/**
 * The in-toto predicate type of a cupboard build-origin statement. The project
 * owns no domain, so the repository URL is the namespace, and the trailing
 * version changes when the predicate's shape does.
 */
export const buildOriginPredicateType =
	'https://github.com/underwhelmingperformance/cupboard/predicate/build-origin/v1';

// One path's origin, copied from the receipt subject that recorded it: the
// path, the NAR hash the destination serves it under, the derivation that
// produced it, which producer the path came from, the store where the build
// ran, and the builder from the activity log when the log recorded one.
//
// These are the receipt's own facts. The statement says where a path came
// from. It makes no claim that the path is reproducible or that its producer
// deserves trust.
export const buildOriginSubjectSchema = z.strictObject({
	storePath: storePathSchema,
	narHash: sha256HexDigestSchema,
	derivation: derivationPathSchema,
	buildStore: buildStoreSchema,
	machine: z.string().min(1).optional(),
	verification: subjectVerificationSchema
});
export type ParsedBuildOriginSubject = z.output<
	typeof buildOriginSubjectSchema
>;

// One statement covers every subject of one run, so a reader who verified the
// statement for one path can read the origin of every path the run signed.
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
