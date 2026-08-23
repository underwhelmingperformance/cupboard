import { canonicalHref } from '@cupboard/nix-store/url';
import { z } from 'zod';

import { InvalidAudienceError } from './errors.ts';

/**
 * An OIDC audience used by the CLI's trust and grant commands. String inputs
 * remain unchanged because an audience is not necessarily a URL. URL inputs
 * use their canonical form so defaults derived from a tenant URL have stable
 * spelling.
 */
export const audienceSchema = z
	.union([z.string().min(1), z.instanceof(URL).transform(canonicalHref)])
	.brand('Audience');
export type Audience = z.infer<typeof audienceSchema>;

export function parseAudience(value: string): Audience {
	const parsed = audienceSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAudienceError(value);
	}

	return parsed.data;
}
