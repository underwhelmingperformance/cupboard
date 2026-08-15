import { canonicalHref } from '@cupboard/nix-store/url';
import { z } from 'zod';

import { InvalidAudienceError } from './errors.ts';

/**
 * An OIDC audience: the exact string that a token's `aud` claim and a stored
 * trust rule are compared against. An audience is not always a URL (the owner
 * rule uses an access client id), so a string is parsed verbatim and the
 * operator's bytes are preserved. A `URL` is rendered through its canonical
 * form, so an audience defaulted from a tenant URL is always spelled the same
 * way. Every audience the CLI builds or exchanges passes through this schema.
 */
export const audienceSchema = z
	.union([z.string().min(1), z.instanceof(URL).transform(canonicalHref)])
	.brand('Audience');
export type Audience = z.infer<typeof audienceSchema>;

/**
The `--audience` option parser: a typed refusal instead of a raw ZodError.
*/
export function parseAudience(value: string): Audience {
	const parsed = audienceSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAudienceError(value);
	}

	return parsed.data;
}
