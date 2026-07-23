import { type RootName, rootNameSchema } from '@cupboard/nix-store/scalars';

import { InvalidRootNameError } from './errors.ts';

/**
 * The root-name option and argument parser: a typed refusal instead of a raw
 * ZodError, so the CLI rejects an ill-formed root name at the command boundary
 * with the same bounds the server enforces.
 */
export function parseRootName(value: string): RootName {
	const parsed = rootNameSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidRootNameError(value);
	}

	return parsed.data;
}
