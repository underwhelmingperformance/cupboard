#!/usr/bin/env node
import { buildProgram } from './cli.ts';

try {
	await buildProgram().parseAsync();
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exit(1);
}
