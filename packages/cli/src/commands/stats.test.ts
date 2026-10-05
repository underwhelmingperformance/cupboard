import { capturingReporter } from '@cupboard/cli-ui/testing';
import {
	statsResponseSchema,
	usageResponseSchema
} from '@cupboard/protocol/upload';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerStatsCommand } from './stats.ts';

const mocks = vi.hoisted(() => ({ reporter: vi.fn(), rpc: vi.fn() }));
vi.mock('../cli.ts', () => ({
	commandUi: () => ({ reporter: mocks.reporter })
}));
vi.mock('../client/orpc.ts', () => ({ tenantRpc: mocks.rpc }));

describe('storage accounting output', () => {
	it.each(['summary', 'details', 'debug'] as const)(
		'describes stored bundles without changing accounting data (%s)',
		async (presentation) => {
			const stats = statsResponseSchema.parse({
				storePaths: 4,
				narBlobs: 2,
				narFileSize: 1000,
				casObjects: 1,
				casFileSize: 500,
				pendingUploads: 3,
				totalFileSize: 1500
			});
			const usage = usageResponseSchema.parse({
				narBlobs: 2,
				narFileSize: 1000,
				casObjects: 1,
				casFileSize: 500,
				totalFileSize: 1500,
				quotaBytes: 1500,
				remainingQuotaBytes: 0
			});
			const rows: ResultRow[][] = [];
			const data: unknown[] = [];
			const infos: string[] = [];
			const capture = capturingReporter(rows, infos);
			const reporter: Reporter = {
				...capture,
				presentation,
				result(payload) {
					data.push(payload.data);
					capture.result(payload);
				}
			};
			mocks.reporter.mockReturnValue(reporter);
			mocks.rpc.mockReturnValue({
				stats: {
					cache: { inDefaultCache: () => Promise.resolve(stats) },
					usage: () => Promise.resolve(usage)
				}
			});
			const program = new Command();
			registerStatsCommand(program);

			await program.parseAsync(
				['stats', 'https://cupboard.example.workers.dev/t/acme'],
				{ from: 'user' }
			);
			await program.parseAsync(
				['usage', 'https://cupboard.example.workers.dev/t/acme'],
				{ from: 'user' }
			);

			expect({ rows, data, infos }).toStrictEqual({
				data: [stats, usage],
				infos: [
					'Storage shared by several store paths or caches counts once for this tenant.'
				],
				rows: [
					[
						{ label: 'Store paths', value: '4' },
						{ label: 'NAR archives', value: '2' },
						{ label: 'NAR storage', value: '1 kB' },
						{ label: 'Attestation bundles', value: '1' },
						{ label: 'Attestation storage', value: '500 B' },
						{ label: 'Pending uploads', value: '3' },
						{ label: 'Total referenced storage', value: '1.5 kB' }
					],
					[
						{ label: 'Tenant storage used', value: '1.5 kB' },
						{ label: 'Quota', value: '1.5 kB' },
						{ label: 'Remaining quota', value: '0 B' },
						...(presentation === 'summary'
							? []
							: [
									{ label: 'NAR archives', value: '2' },
									{ label: 'NAR storage', value: '1 kB' },
									{ label: 'Attestation bundles', value: '1' },
									{ label: 'Attestation storage', value: '500 B' }
								])
					]
				]
			});
		}
	);
});
