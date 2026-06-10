import type { CheckDiscrepancy, CheckReport } from '@cupboard/protocol/reports';
import { createReporter, formatCount, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client/client.ts';

interface CheckOptions {
	readonly token: string;
	readonly deep?: boolean;
}

export interface CheckClient {
	check(
		token: AccessCredential,
		options: { readonly deep: boolean }
	): Promise<CheckReport>;
}

export function registerCheckCommand(program: Command): void {
	program
		.command('check')
		.description('Check stored objects against committed metadata.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.option('--deep', 'recompute and compare each stored NAR file hash')
		.action(async (url: string, options: CheckOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider(url);

			await runCheck(options.deep ?? false, token, reporter, client);
		});
}

export async function runCheck(
	deep: boolean,
	token: AccessCredential,
	reporter: Reporter,
	client: CheckClient
): Promise<void> {
	const report = await reporter.phase('Checking cupboard', () =>
		client.check(token, { deep })
	);

	reporter.result([
		{ label: 'Narinfos checked', value: formatCount(report.narInfosChecked) },
		{ label: 'NAR blobs checked', value: formatCount(report.narBlobsChecked) },
		{ label: 'Complete', value: report.complete ? 'yes' : 'no' },
		{ label: 'Discrepancies', value: formatCount(report.discrepancies.length) }
	]);

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
