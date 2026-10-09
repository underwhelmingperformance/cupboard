import type {
	CheckDiscrepancy,
	CheckDiscrepancyKind,
	CheckReport,
	SharedAccessReport
} from '@cupboard/protocol/reports';
import { formatCount, type Reporter } from '@cupboard/reporter';
import { type Command, Option } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { cacheLabel } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { CheckDiscrepanciesError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface CheckOptions {
	readonly deep?: boolean;
	readonly sharedAccess?: boolean;
}

export interface CheckClient {
	run(input: {
		deep: boolean;
		cursor: string;
		cursorCache: number;
	}): Promise<CheckReport>;
}

export interface SharedAccessClient {
	sharedAccess(input: {
		cursor: SharedAccessReport['cursor'];
	}): Promise<SharedAccessReport>;
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
		.option('--deep', 'recompute and compare each stored NAR file hash')
		.addOption(
			new Option(
				'--shared-access',
				'list NARs with readable references in both public and private caches'
			).conflicts('deep')
		)
		.addHelpText(
			'after',
			'\nExits 1 if any path has a discrepancy, after printing the report.'
		)
		.action(async (url: URL, options: CheckOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			if (options.sharedAccess === true) {
				await runSharedAccess(reporter, rpc.check);
				return;
			}

			await runCheck(options.deep ?? false, reporter, rpc.check);
		});
}

/**
 * Checks every committed path, one page per request. The server checks one page
 * and returns a cursor, in two parts, that points after the last row that it
 * checked. The command sends the cursor back until the server returns an empty
 * cursor: an empty string and 0. If the server reports any discrepancies, the
 * command warns about each one and then throws {@link CheckDiscrepanciesError}.
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
		title: 'Cache integrity',
		data: { narInfosChecked, narBlobsChecked, discrepancies },
		rows: [
			{
				label: 'Cache metadata checked',
				value: formatCount(narInfosChecked)
			},
			{
				label: 'Stored archives checked',
				value: formatCount(narBlobsChecked)
			},
			{
				label: 'Problems found',
				value: formatCount(discrepancies.length)
			}
		]
	});

	if (discrepancies.length === 0) {
		reporter.info('No discrepancies.', { humanMessage: 'No problems found.' });
		return;
	}

	for (const discrepancy of discrepancies) {
		reporter.warn(discrepancy.kind, describeDiscrepancy(discrepancy), {
			humanMessage: `${discrepancyLabels[discrepancy.kind]}: ${describeDiscrepancy(discrepancy)}. Ask the tenant administrator to investigate and restore the published path.`
		});
	}

	throw new CheckDiscrepanciesError(discrepancies.length);
}

export async function runSharedAccess(
	reporter: Reporter,
	client: SharedAccessClient
): Promise<void> {
	let cursor: SharedAccessReport['cursor'] = '';
	const narHashes: SharedAccessReport['narHashes'] = [];
	do {
		const page = await reporter.phase('Checking shared NAR access', () =>
			client.sharedAccess({ cursor })
		);
		narHashes.push(...page.narHashes);
		cursor = page.cursor;
	} while (cursor !== '');

	reporter.result({
		kind: 'shared-access-report',
		title: 'NARs shared by public and private caches',
		data: { narHashes },
		rows: [
			{ label: 'Shared NARs', value: formatCount(narHashes.length) },
			...narHashes.map((narHash) => ({ label: 'NAR', value: narHash }))
		]
	});
}

function describeDiscrepancy(discrepancy: CheckDiscrepancy): string {
	return `${cacheLabel(discrepancy.cache)} ${discrepancy.storePathHash}`;
}

const discrepancyLabels: Readonly<Record<CheckDiscrepancyKind, string>> = {
	'missing-nar': 'Stored archive is missing',
	'missing-narinfo-object': 'Cache metadata file is missing',
	'file-hash-mismatch': 'Stored archive checksum does not match',
	'nar-hash-mismatch': 'Unpacked archive checksum does not match',
	'nar-size-mismatch': 'Unpacked archive size does not match',
	undecodable: 'Stored archive cannot be unpacked'
};
