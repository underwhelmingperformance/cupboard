import type { CheckDiscrepancy, CheckReport } from '@cupboard/protocol/reports';
import { createReporter, formatCount, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';

interface CheckOptions {
	readonly token: string;
	readonly deep?: boolean;
}

/**
 * The slice of the derived client the check command consumes, in the
 * contract's input and output shapes; the real `tenantRpc(...).check`
 * satisfies it by construction.
 */
export interface CheckClient {
	run(input: { deep: boolean }): Promise<CheckReport>;
}

export function registerCheckCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('check')
		.description('Check stored objects against committed metadata.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.option('--deep', 'recompute and compare each stored NAR file hash')
		.action(async (url: string, options: CheckOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runCheck(options.deep ?? false, reporter, rpc.check);
		});
}

export async function runCheck(
	deep: boolean,
	reporter: Reporter,
	client: CheckClient
): Promise<void> {
	const report = await reporter.phase('Checking cupboard', () =>
		client.run({ deep })
	);

	reporter.result({
		kind: 'check-report',
		data: report,
		rows: [
			{
				label: 'Narinfos checked',
				value: formatCount(report.narInfosChecked)
			},
			{
				label: 'NAR blobs checked',
				value: formatCount(report.narBlobsChecked)
			},
			{ label: 'Complete', value: report.complete ? 'yes' : 'no' },
			{
				label: 'Discrepancies',
				value: formatCount(report.discrepancies.length)
			}
		]
	});

	if (report.discrepancies.length === 0) {
		reporter.info('No discrepancies.');
		return;
	}

	for (const discrepancy of report.discrepancies) {
		reporter.warn(discrepancy.kind, describeDiscrepancy(discrepancy));
	}
}

function describeDiscrepancy(discrepancy: CheckDiscrepancy): string {
	const cache = discrepancy.cache === '' ? '(default)' : discrepancy.cache;

	return `${cache} ${discrepancy.storePathHash}`;
}
