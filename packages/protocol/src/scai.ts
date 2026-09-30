import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

/**
 * The in-toto predicate type of a SCAI attribute report. The in-toto project
 * owns this predicate and its versioning, so the URI and its version change
 * upstream.
 */
export const scaiPredicateType = 'https://in-toto.io/attestation/scai/v0.3';

/**
 * SCAI's reproducibility example uses this attribute spelling. Producers and
 * consumers agree on the verification procedure for the asserted property.
 */
export const reproducibleAttribute = 'REPRODUCIBLE';

const hexadecimalDigest = z.string().regex(/^(?:[0-9a-f]{2})+$/);
const resourceUriSchema = z.url().refine(
	(value) => {
		const prefix = /^[^:]+:(?:\/\/[^/?#]*)?/.exec(value)?.[0];
		return prefix === prefix?.toLowerCase();
	},
	{ message: 'A resource URI requires a lowercase scheme and authority' }
);
const digestSetSchema = z
	.object({
		sha256: sha256HexDigestSchema.optional(),
		sha224: hexadecimalDigest.length(56).optional(),
		sha384: hexadecimalDigest.length(96).optional(),
		sha512: hexadecimalDigest.length(128).optional(),
		sha512_224: hexadecimalDigest.length(56).optional(),
		sha512_256: hexadecimalDigest.length(64).optional(),
		sha3_224: hexadecimalDigest.length(56).optional(),
		sha3_256: hexadecimalDigest.length(64).optional(),
		sha3_384: hexadecimalDigest.length(96).optional(),
		sha3_512: hexadecimalDigest.length(128).optional(),
		shake128: hexadecimalDigest.optional(),
		shake256: hexadecimalDigest.optional(),
		blake2b: hexadecimalDigest.optional(),
		blake2s: hexadecimalDigest.optional(),
		ripemd160: hexadecimalDigest.length(40).optional(),
		sm3: hexadecimalDigest.length(64).optional(),
		gost: hexadecimalDigest.optional(),
		sha1: hexadecimalDigest.length(40).optional(),
		md5: hexadecimalDigest.length(32).optional()
	})
	.catchall(z.string().min(1))
	.refine((digests) => Object.keys(digests).length > 0, {
		message: 'A digest set must contain at least one immutable reference'
	});

const resourceDescriptorSchema = z
	.looseObject({
		name: z.string().optional(),
		uri: resourceUriSchema.optional(),
		digest: digestSetSchema.optional(),
		content: z.base64().optional(),
		downloadLocation: resourceUriSchema.optional(),
		mediaType: z.string().optional(),
		annotations: z.record(z.string(), z.unknown()).optional()
	})
	.refine(
		(descriptor) =>
			descriptor.uri !== undefined ||
			descriptor.digest !== undefined ||
			descriptor.content !== undefined,
		{ message: 'A resource descriptor requires uri, digest or content' }
	);

const scaiAttributeAssertionSchema = z.looseObject({
	attribute: z.string(),
	target: resourceDescriptorSchema.optional(),
	conditions: z.record(z.string(), z.unknown()).optional(),
	evidence: resourceDescriptorSchema.optional()
});

export const scaiAttributeReportSchema = z.looseObject({
	attributes: z.array(scaiAttributeAssertionSchema).min(1),
	producer: resourceDescriptorSchema.optional()
});
export type ScaiAttributeReport = z.output<typeof scaiAttributeReportSchema>;
