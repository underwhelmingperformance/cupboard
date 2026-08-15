import { storePathHashPattern } from './scalars.ts';

const implicitPinPrefix = 'pin:';

/**
 * The retention root name a plain push (no explicit `--root`) pins a path under:
 * `pin:<storePathHash>`. Each pushed path gets its own implicit pin, so it is
 * retained without the caller supplying a root name.
 */
export function implicitPinName(storePathHash: string): string {
	return `${implicitPinPrefix}${storePathHash}`;
}

/**
Whether a root name is an implicit pin produced by a plain push.
*/
export function isImplicitPinName(name: string): boolean {
	return (
		name.startsWith(implicitPinPrefix) &&
		storePathHashPattern.test(name.slice(implicitPinPrefix.length))
	);
}
