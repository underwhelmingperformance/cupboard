import { isContractProcedure } from '@orpc/contract';
import { describe, expect, it } from 'vitest';

import { controlContract } from './control.ts';
import { tenantContract } from './tenant.ts';

type Declaration = 'requires' | 'derives' | 'both' | 'neither';

function declarationOf(meta: unknown): Declaration {
	const hasDeclaration = (key: string): boolean =>
		typeof meta === 'object' &&
		meta !== null &&
		Reflect.get(meta, key) !== undefined;

	if (hasDeclaration('requires')) {
		return hasDeclaration('derives') ? 'both' : 'requires';
	}

	return hasDeclaration('derives') ? 'derives' : 'neither';
}

/**
The procedures of `contract` that do not declare exactly one of `requires`
and `derives`, with what they declare.
*/
function undeclared(
	contract: object,
	prefix: readonly string[] = []
): [string, Declaration][] {
	return Object.entries(contract).flatMap(
		([key, value]: [string, unknown]): [string, Declaration][] => {
			const path = [...prefix, key];

			if (isContractProcedure(value)) {
				const declaration = declarationOf(value['~orpc'].meta);

				return declaration === 'requires' || declaration === 'derives'
					? []
					: [[path.join('.'), declaration]];
			}

			return typeof value === 'object' && value !== null
				? undeclared(value, path)
				: [];
		}
	);
}

describe('procedure authority', () => {
	it.each([
		{ name: 'tenant', contract: tenantContract },
		{ name: 'control', contract: controlContract }
	])(
		'declares either requires or derives on every $name procedure',
		({ contract }) => {
			expect(undeclared(contract)).toStrictEqual([]);
		}
	);
});
