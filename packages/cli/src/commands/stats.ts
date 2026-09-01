import { formatBytes, formatCount } from '@cupboard/reporter';
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
		.description('Show objects referenced by a cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'named cache when the URL does not select one')
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
				data: stats,
				rows: [
					{ label: 'Store paths', value: formatCount(stats.storePaths) },
					{ label: 'Referenced NAR blobs', value: formatCount(stats.narBlobs) },
					{
						label: 'Referenced NAR size',
						value: formatBytes(stats.narFileSize)
					},
					{
						label: 'Referenced CAS objects',
						value: formatCount(stats.casObjects)
					},
					{
						label: 'Referenced CAS size',
						value: formatBytes(stats.casFileSize)
					},
					{
						label: 'Pending uploads',
						value: formatCount(stats.pendingUploads)
					},
					{
						label: 'Referenced total size',
						value: formatBytes(stats.totalFileSize)
					}
				]
			});
		});

	program
		.command('usage')
		.description('Show tenant-wide charged storage usage.')
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
				data: usage,
				rows: [
					{ label: 'Charged NAR blobs', value: formatCount(usage.narBlobs) },
					{ label: 'Charged NAR size', value: formatBytes(usage.narFileSize) },
					{
						label: 'Charged CAS objects',
						value: formatCount(usage.casObjects)
					},
					{ label: 'Charged CAS size', value: formatBytes(usage.casFileSize) },
					{
						label: 'Charged total size',
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
							])
				]
			});
		});
}
