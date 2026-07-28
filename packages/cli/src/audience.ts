import { canonicalHref } from '@cupboard/nix-store/url';
import { z } from 'zod';

import { InvalidAudienceError } from './errors.ts';

/**
 * An OIDC audience: the exact string a token's `aud` claim and a stored trust
 * rule compare against. An audience is not always a URL (the owner rule's is
 * an access client id), so a string parses verbatim, preserving the operator's
 * bytes; a `URL` renders through its one canonical form, so an audience
 * defaulted from a tenant URL can never fork on spelling. Every audience the
 * CLI builds or exchanges with passes through this schema.
 */
export const audienceSchema = z
	.union([z.string().min(1), z.instanceof(URL).transform(canonicalHref)])
	.brand('Audience');
export type Audience = z.infer<typeof audienceSchema>;

/** The `--audience` option parser: a typed refusal instead of a raw ZodError. */
export function parseAudience(value: string): Audience {
	const parsed = audienceSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAudienceError(value);
	}

	return parsed.data;
}
