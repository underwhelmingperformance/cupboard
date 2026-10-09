import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ChildEnvironment } from '@cupboard/nix/build-observation';
import { derivationPathOf } from '@cupboard/nix-store/derivation';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const derivationTargetSchema = z.object({
	drvPath: storePathSchema.optional()
});
const evaluatedInstallableSchema = z.union([
	z.string(),
	derivationTargetSchema
]);
const evaluatedInstallablesSchema = z.array(evaluatedInstallableSchema);

export async function targetDerivations(
	installables: readonly string[],
	environment: ChildEnvironment,
	signal?: AbortSignal
): Promise<ReadonlyMap<string, readonly StorePathString[]>> {
	const roots = new Map<string, readonly StorePathString[]>();
	const unique = new Set(installables);
	for (const installable of unique) {
		signal?.throwIfAborted();
		const derivation = derivationPathOf(installable);
		if (derivation !== undefined) {
			roots.set(installable, [storePathSchema.parse(derivation)]);
			continue;
		}
		if (storePathSchema.safeParse(installable).success) {
			roots.set(installable, []);
			continue;
		}
		const { stdout } = await execFileAsync(
			'nix',
			['build', '--dry-run', '--json', '--no-link', '--', installable],
			{
				env: environment,
				maxBuffer: 1024 * 1024,
				...(signal !== undefined && { signal })
			}
		);
		const json: unknown = JSON.parse(stdout);
		const evaluated = evaluatedInstallablesSchema.parse(json);
		roots.set(
			installable,
			evaluated.flatMap((target) =>
				typeof target === 'string' || target.drvPath === undefined
					? []
					: [target.drvPath]
			)
		);
	}
	return roots;
}
