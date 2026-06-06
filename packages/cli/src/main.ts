#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
import { buildProgram } from './cli.ts';

try {
	await buildProgram().parseAsync();
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exit(1);
}
