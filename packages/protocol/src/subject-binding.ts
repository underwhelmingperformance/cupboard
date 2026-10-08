import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { canonicalHref } from '@cupboard/nix-store/url';
import { z } from 'zod';

const subjectBindingVersion = 'cupboard/subject-binding/v1';

export const subjectBindingMaxTargets = 4;

// The base64url encoding of 32 random bytes, without padding.
const subjectBindingSeedSchema = z.string().regex(/^[\w-]{43}$/u);

const subjectBindingTargetsSchema = z
	.string()
	.transform((value, context): unknown => {
		try {
			return JSON.parse(value);
		} catch {
			context.addIssue({
				code: 'custom',
				message: 'cupboard_binding_targets must be a JSON array'
			});
			return z.NEVER;
		}
	})
	.pipe(z.array(z.string()).min(1).max(subjectBindingMaxTargets));

/**
 * The token-request fields that bind a subject token to its target servers.
 * Clients must send both fields to bind a token. The server refuses a request
 * that supplies only one.
 */
export const subjectBindingFields = {
	cupboard_binding_seed: subjectBindingSeedSchema.optional(),
	cupboard_binding_targets: subjectBindingTargetsSchema.optional()
} satisfies z.ZodRawShape;

/**
 * Whether `target` is a URL in the form that `canonicalHref` produces. The
 * nonce hashes the targets as the client sent them, so a server compares its
 * own canonical URL with each one.
 */
export function isCanonicalTarget(target: string): boolean {
	return URL.canParse(target) && canonicalHref(new URL(target)) === target;
}

/**
 * Returns the OIDC `nonce` that binds an ID token to `targets`: the unpadded
 * base64url encoding of the SHA-256 hash of the JSON array of a version label,
 * the targets and the seed.
 */
export async function subjectBindingNonce(
	targets: readonly string[],
	seed: string
): Promise<string> {
	const input = new TextEncoder().encode(
		JSON.stringify([subjectBindingVersion, targets, seed])
	);
	const digest = await crypto.subtle.digest('SHA-256', input);

	return bytesToBase64Url(new Uint8Array(digest));
}
