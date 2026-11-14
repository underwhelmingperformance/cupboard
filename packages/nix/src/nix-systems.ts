import { z } from 'zod';

import configuredSystems from './nix-systems.json' with { type: 'json' };

/**
A Nix system supported by Cupboard's flake and generated settings.
*/
export const nixSystemSchema = z.enum([
	'x86_64-linux',
	'aarch64-linux',
	'aarch64-darwin'
]);

export type NixSystem = z.infer<typeof nixSystemSchema>;

export const nixSystemRunnerSchema = z.strictObject({
	system: nixSystemSchema,
	runner: z.string().min(1)
});

export type NixSystemRunner = z.infer<typeof nixSystemRunnerSchema>;

/**
Maps each supported Nix system to the GitHub-hosted runner used for release
publication.
*/
export const nixSystemRunners: readonly NixSystemRunner[] = z
	.array(nixSystemRunnerSchema)
	.parse(configuredSystems);

/**
Lists supported Nix systems in output-generation order.
*/
export const nixSystems: readonly NixSystem[] = z
	.array(nixSystemSchema)
	.parse(nixSystemRunners.map(({ system }) => system));
