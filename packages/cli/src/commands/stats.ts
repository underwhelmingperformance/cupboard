import {
	formatBytes,
	formatCount,
	shouldShowDetails
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { callInCache } from '../client/cache-scoped.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export function registerStatsCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('stats')
		.description(
			'Show how many store paths a cache has and how much storage they use.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'cache name, if the URL is a tenant URL')
		.action(async (url: URL, cache: string | undefined) => {
			const urlTarget = cacheTargetFromUrl(url);
			const target =
				cache === undefined ? urlTarget : cacheTargetWithName(urlTarget, cache);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(target.tenantUrl, {
				credential: cachedOwnerProvider(target.tenantUrl, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

			const stats = await reporter.phase('Querying cupboard', () =>
				callInCache(rpc.stats.cache, target.cache, {})
			);

			reporter.result({
				kind: 'cache-stats',
				title: 'Cache contents',
				data: stats,
				rows: [
					{ label: 'Store paths', value: formatCount(stats.storePaths) },
					{ label: 'NAR archives', value: formatCount(stats.narBlobs) },
					{
						label: 'NAR storage',
						value: formatBytes(stats.narFileSize)
					},
					{
						label: 'Attestation bundles',
						value: formatCount(stats.casObjects)
					},
					{
						label: 'Attestation storage',
						value: formatBytes(stats.casFileSize)
					},
					{
						label: 'Pending uploads',
						value: formatCount(stats.pendingUploads)
					},
					{
						label: 'Total referenced storage',
						value: formatBytes(stats.totalFileSize)
					}
				]
			});
		});

	program
		.command('usage')
		.description(
			"Show the tenant's storage usage and quota across all its caches."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const { tenantUrl } = cacheTargetFromUrl(url);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(tenantUrl, {
				credential: cachedOwnerProvider(tenantUrl, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

			const usage = await reporter.phase('Querying cupboard', () =>
				rpc.stats.usage()
			);

			reporter.result({
				kind: 'tenant-usage',
				title: 'Tenant storage usage',
				data: usage,
				rows: [
					{
						label: 'Tenant storage used',
						value: formatBytes(usage.totalFileSize)
					},
					...(usage.quotaBytes === undefined
						? []
						: [
								{
									label: 'Quota',
									value: formatBytes(usage.quotaBytes)
								},
								{
									label: 'Remaining quota',
									value: formatBytes(usage.remainingQuotaBytes ?? 0)
								}
							]),
					...(shouldShowDetails(reporter)
						? [
								{ label: 'NAR archives', value: formatCount(usage.narBlobs) },
								{ label: 'NAR storage', value: formatBytes(usage.narFileSize) },
								{
									label: 'Attestation bundles',
									value: formatCount(usage.casObjects)
								},
								{
									label: 'Attestation storage',
									value: formatBytes(usage.casFileSize)
								}
							]
						: [])
				]
			});
			reporter.info(
				'Storage shared by several store paths or caches counts once for this tenant.'
			);
		});
}
