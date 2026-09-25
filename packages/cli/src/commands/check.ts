import type { CheckDiscrepancy, CheckReport } from '@cupboard/protocol/reports';
import { formatCount, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { cacheLabel } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { CheckDiscrepanciesError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface CheckOptions {
	readonly deep?: boolean;
}

export interface CheckClient {
	run(input: {
		deep: boolean;
		cursor: string;
		cursorCache: number;
	}): Promise<CheckReport>;
}

export function registerCheckCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('check')
		.description(
			'Check that every store path in the tenant still has all of its stored files.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.option('--deep', 'also read every stored NAR and check its hash (slower)')
		.action(async (url: URL, options: CheckOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runCheck(options.deep ?? false, reporter, rpc.check);
		});
}

/**
 * Checks every committed path, one page per request. The server checks a page
 * and names the last row it checked, so the command passes that cursor back
 * until the report returns it empty. If there are any discrepancies, the
 * command prints them and then fails with {@link CheckDiscrepanciesError}.
 */
export async function runCheck(
	isDeep: boolean,
	reporter: Reporter,
	client: CheckClient
): Promise<void> {
	let cursor = '';
	let cursorCache = 0;
	let narInfosChecked = 0;
	let narBlobsChecked = 0;
	const discrepancies: CheckDiscrepancy[] = [];

	do {
		const page = await reporter.phase('Checking cupboard', () =>
			client.run({ deep: isDeep, cursor, cursorCache })
		);

		narInfosChecked += page.narInfosChecked;
		narBlobsChecked += page.narBlobsChecked;
		discrepancies.push(...page.discrepancies);
		cursor = page.cursor;
		cursorCache = page.cursorCache;
	} while (cursor !== '' || cursorCache !== 0);

	reporter.result({
		kind: 'check-report',
		data: { narInfosChecked, narBlobsChecked, discrepancies },
		rows: [
			{
				label: 'Narinfos checked',
				value: formatCount(narInfosChecked)
			},
			{
				label: 'NAR blobs checked',
				value: formatCount(narBlobsChecked)
			},
			{
				label: 'Discrepancies',
				value: formatCount(discrepancies.length)
			}
		]
	});

	if (discrepancies.length === 0) {
		reporter.info('No discrepancies.');
		return;
	}

	for (const discrepancy of discrepancies) {
		reporter.warn(discrepancy.kind, describeDiscrepancy(discrepancy));
	}

	// Fail after printing the report, so a CI job stops when the check finds a
	// problem.
	throw new CheckDiscrepanciesError(discrepancies.length);
}

function describeDiscrepancy(discrepancy: CheckDiscrepancy): string {
	return `${cacheLabel(discrepancy.cache)} ${discrepancy.storePathHash}`;
}
