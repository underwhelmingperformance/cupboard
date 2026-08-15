import { readFile, writeFile } from 'node:fs/promises';

import { Nix } from '@cupboard/nix';
import type { Reporter } from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import type { Command } from 'commander';

import { commandUi, type ProgramOptions } from '../cli.ts';
import { InvalidMeasureTargetsFileError } from '../errors.ts';
import { reportUnknownSettings } from '../nix/settings.ts';
import {
	measurePlanInputSchema,
	type ParsedMeasureTarget
} from '../plan/cohort-target.ts';
import { parseStoreUri } from '../store-uri.ts';

const maximumConcurrentMeasurements = 4;

export interface PlanMeasureOptions {
	readonly targetsFile: string;
	readonly store?: string;
	readonly measureFile?: string;
}

/** One target's own substitutable size, as the store's `queryMissing` prices it. */
export interface TargetMeasurement {
	readonly downloadSize: number;
	readonly narSize: number;
}

/**
 * The per-target measurements {@link runPlanMeasure} reports and writes,
 * keyed by each target's attr. A target the store could not price carries no
 * entry at all, so a consumer can tell "measured at zero" from "unmeasured".
 */
export interface PlanMeasureResult {
	readonly measurements: Readonly<Record<string, TargetMeasurement>>;
}

export interface PlanMeasureRunOptions {
	readonly targets: readonly ParsedMeasureTarget[];
	readonly measureFile: string;
}

/**
 * What {@link runPlanMeasure} needs from this run's environment: the selected
 * store's own missing-path query, injectable so a command test can drive the
 * measurement with a double.
 */
export interface PlanMeasureDependencies {
	readonly store: Pick<Nix, 'queryMissing'>;
}

export function registerPlanMeasureCommand(
	plan: Command,
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	plan
		.command('measure')
		.description(
			"Measure each target's own substitutable size against this store."
		)
		.requiredOption(
			'--targets-file <path>',
			'JSON file naming each target and the installable to price'
		)
		.option(
			'--store <uri>',
			'remote ssh-ng store to query for the target sizes (default: the local daemon)',
			parseStoreUri
		)
		.option(
			'--measure-file <path>',
			'destination for the JSON per-target size measurements'
		)
		.action(async (options: PlanMeasureOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const targets = await readMeasureTargets(options.targetsFile);
			// The store carries the run's signal, so giving up gives up on
			// the substituters it is waiting for.
			const storeSelection = {
				...(options.store !== undefined && { storeUri: options.store }),
				...(programOptions.signal !== undefined && {
					signal: programOptions.signal
				})
			};
			const nix = Nix.openForAvailability(undefined, storeSelection);

			reportUnknownSettings(reporter, nix.unknownSettings);

			await runPlanMeasure(
				{
					targets,
					measureFile: options.measureFile ?? defaultMeasureFile()
				},
				reporter,
				{ store: nix }
			);
		});
}

/**
 * Prices each target's own substitutable size against the selected store: one
 * `queryMissing` per target, so every answer is that target's own bytes
 * rather than a grouping's union. A target the store cannot price is left out
 * of the measurements with a warning, never a failure: a consumer packs only
 * what carries a measurement. The result is reported over `reporter` and the
 * same mapping written to `options.measureFile`.
 */
export async function runPlanMeasure(
	options: PlanMeasureRunOptions,
	reporter: Reporter,
	dependencies: PlanMeasureDependencies
): Promise<void> {
	const entries = await reporter.phase(
		'Measuring substitutable sizes',
		(phase) =>
			mapWithConcurrency(
				options.targets,
				maximumConcurrentMeasurements,
				async (
					target
				): Promise<readonly [string, TargetMeasurement] | undefined> => {
					try {
						const missing = await dependencies.store.queryMissing([
							target.installable
						]);

						return [
							target.attr,
							{
								downloadSize: missing.downloadSize,
								narSize: missing.narSize
							}
						];
					} catch (error) {
						phase.warn(
							`Leaving ${target.attr} unmeasured`,
							error instanceof Error ? error.message : String(error)
						);

						return undefined;
					}
				}
			)
	);
	const measured = entries.filter((entry) => entry !== undefined);
	const result: PlanMeasureResult = {
		measurements: Object.fromEntries(measured)
	};

	await writeFile(
		options.measureFile,
		`${JSON.stringify(result, undefined, 2)}\n`
	);

	reporter.result({
		kind: 'plan-measure',
		data: result,
		rows: [
			{ label: 'Measured', value: String(measured.length) },
			{
				label: 'Unmeasured',
				value: String(options.targets.length - measured.length)
			},
			{ label: 'Measure file', value: options.measureFile }
		]
	});
}

async function readMeasureTargets(
	targetsFile: string
): Promise<readonly ParsedMeasureTarget[]> {
	let json: unknown;

	try {
		json = JSON.parse(await readFile(targetsFile, 'utf8'));
	} catch (error) {
		throw new InvalidMeasureTargetsFileError(
			targetsFile,
			error instanceof Error ? error.message : 'not valid JSON'
		);
	}

	const parsed = measurePlanInputSchema.safeParse(json);

	if (!parsed.success) {
		throw new InvalidMeasureTargetsFileError(targetsFile, parsed.error.message);
	}

	return parsed.data.targets;
}

function defaultMeasureFile(): string {
	return `cupboard-plan-measure-${String(Date.now())}.json`;
}
