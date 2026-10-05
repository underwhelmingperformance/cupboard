import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { formatErrorWithCauses } from '@cupboard/shared/errors';
import { Command } from 'commander';
import { z } from 'zod';

import manifest from '../package.json' with { type: 'json' };
import { writeBuildInfo } from '../packages/cli/src/deploy/build-info.ts';
import { resolveBuildVersion } from '../packages/cli/src/deploy/build-version.ts';

import { executeCheck } from './check-process.ts';
import { CheckPlan, runChecks } from './check-runner.ts';

const root = path.resolve(import.meta.dirname, '..');
const optionsSchema = z.object({
	group: z.enum([
		'all',
		'tests',
		'static',
		'unit',
		'server',
		'actions',
		'scripts',
		'e2e',
		'remote-store',
		'conformance'
	]),
	concurrency: z.coerce.number().int().min(1).max(2)
});

async function main(): Promise<void> {
	const availableCpus = availableParallelism();
	const defaultConcurrency = String(Math.min(2, availableCpus));
	const program = new Command()
		.option('--group <group>', 'Run one group of source checks', 'all')
		.option(
			'--concurrency <count>',
			'Maximum simultaneous source checks',
			defaultConcurrency
		);
	program.parse();
	const options = optionsSchema.parse(program.opts());
	const concurrency = Math.min(options.concurrency, availableCpus);
	const cpuBudget = Math.floor(availableCpus / concurrency);
	const workers = Math.max(1, Math.min(4, cpuBudget));
	const tasks = CheckPlan.fromScripts(manifest.scripts, workers).select(
		options.group
	);
	const version = await resolveBuildVersion(root);
	await writeBuildInfo(
		path.join(root, 'packages/server/src/build-info.generated.ts'),
		version
	);
	const controller = new AbortController();
	const interrupt = (): void => {
		controller.abort(new Error('Source checks interrupted'));
	};
	const terminate = (): void => {
		controller.abort(new Error('Source checks terminated'));
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		const results = await runChecks(tasks, {
			concurrency,
			signal: controller.signal,
			now: () => performance.now(),
			execute: executeCheck,
			onResult(result) {
				process.stdout.write(
					`[${result.status}] ${result.id}: ${(result.durationMs / 1000).toFixed(2)}s\n`
				);
				if (result.error !== undefined) {
					process.stderr.write(`${formatErrorWithCauses(result.error)}\n`);
				}
			}
		});
		if (results.some((result) => result.status !== 'passed')) {
			process.exitCode = controller.signal.aborted ? 130 : 1;
		}
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', terminate);
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
