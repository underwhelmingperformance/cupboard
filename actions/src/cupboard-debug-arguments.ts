#!/usr/bin/env node
import process, { argv, env } from 'node:process';

import { cupboardDebugArguments } from './cupboard-run.ts';
import { MissingInputError } from './errors.ts';

const binaryPath = argv[2];

if (binaryPath === undefined || binaryPath === '') {
	throw new MissingInputError('cupboard-path');
}

const debugArguments = await cupboardDebugArguments(binaryPath, env);

for (const argument of debugArguments) {
	process.stdout.write(`${argument}\n`);
}
