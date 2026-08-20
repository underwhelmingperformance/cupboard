import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { CodedError, genericExitCode } from '@cupboard/shared/errors';
import { Command } from 'commander';

import { discoverNixStoreConfig } from '../../packages/nix/src/index.ts';

import {
	BudgetBreachError,
	checkBudgets,
	defaultTolerance,
	parseBaseline,
	parseTolerance
} from './budget.ts';
import {
	createDivertedStoreDirectory,
	createDivertedStorePlanner,
	removeDivertedStore
} from './diverted-store.ts';
import { parseManifest } from './manifest.ts';
import { measureRealisation, type RealisationReport } from './measurement.ts';
import { renderBudgetResult, renderSummary } from './summary.ts';

/**
 * The public substituter configured by default on Nix installations. Unless a
 * caller supplies another substituter, measurements use this list to model a
 * runner with no additional cache configuration.
 */
export const defaultSubstituters = ['https://cache.nixos.org'] as const;

export interface MeasureRealisationOptions {
	readonly flake: string;
	readonly targetsFile: string;
	readonly substituter: readonly string[];
	readonly reportFile?: string;
	readonly baseline?: string;
	readonly tolerance: string;
	readonly workDir?: string;
	readonly keepStore: boolean;
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

export function createProgram(): Command {
	return new Command()
		.name('measure-realisation')
		.description(
			'Measure what realising a flake’s targets costs a cold runner, ' +
				'each target on its own and every declared cohort together.'
		)
		.requiredOption(
			'--targets-file <path>',
			'JSON target manifest: the publish workflow’s targets array, or that array under a "targets" key'
		)
		.option(
			'--flake <ref>',
			'flake reference the targets are attributes of',
			'.'
		)
		.option(
			'--substituter <url>',
			'substituter to measure against, repeatable; replaces the configured list rather than adding to it',
			collect,
			[]
		)
		.option(
			'--report-file <path>',
			'destination for the JSON report (use /dev/stdout to print it)'
		)
		.option('--baseline <path>', 'expected values a gate run measures against')
		.option(
			'--tolerance <fraction>',
			'share by which a measurement may exceed its budget and still pass',
			String(defaultTolerance)
		)
		.option(
			'--work-dir <path>',
			'directory the diverted store is built in (default: a fresh temporary directory)'
		)
		.option(
			'--keep-store',
			'leave the diverted store behind for inspection',
			false
		);
}

export async function main(
	commandLine: readonly string[] = argv
): Promise<void> {
	const options = createProgram()
		.parse([...commandLine])
		.opts<MeasureRealisationOptions>();
	const targets = parseManifest(await readFile(options.targetsFile, 'utf8'));
	const substituters =
		options.substituter.length > 0
			? options.substituter
			: [...defaultSubstituters];
	const workDirectoryPrefix = path.join(tmpdir(), 'cupboard-realisation-');
	const directory = await createDivertedStoreDirectory(
		options.workDir ?? (await mkdtemp(workDirectoryPrefix))
	);

	try {
		const report = await measureRealisation({
			flake: options.flake,
			substituters,
			targets,
			planner: createDivertedStorePlanner({
				flake: options.flake,
				storeDirectory: discoverNixStoreConfig().storeDirectory,
				directory,
				substituters
			})
		});

		await emit(report, options.reportFile);
		await gate(report, options);
	} finally {
		if (!options.keepStore) {
			await removeDivertedStore(directory);
		}
	}
}

async function emit(
	report: RealisationReport,
	reportFile: string | undefined
): Promise<void> {
	if (reportFile !== undefined) {
		await writeFile(reportFile, `${JSON.stringify(report, undefined, 2)}\n`);
	}

	stdout.write(`${renderSummary(report)}\n`);
}

async function gate(
	report: RealisationReport,
	options: MeasureRealisationOptions
): Promise<void> {
	if (options.baseline === undefined) {
		return;
	}

	const result = checkBudgets({
		report,
		baseline: parseBaseline(await readFile(options.baseline, 'utf8')),
		tolerance: parseTolerance(options.tolerance)
	});

	stdout.write(`\n${renderBudgetResult(result)}\n`);

	if (result.breaches.length > 0) {
		throw new BudgetBreachError(result.breaches);
	}
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
	try {
		await main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`measure-realisation failed: ${message}`);
		exit(error instanceof CodedError ? error.exitCode : genericExitCode);
	}
}
