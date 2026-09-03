import type { DataMigrationBudget } from '@cupboard/protocol/deployment-manifest';
import { describe, expect, it } from 'vitest';

import {
	DataMigrationBudgetExceededError,
	recordMigrationRows,
	reserveMigrationR2Operation,
	reserveMigrationStatement,
	withDataMigrationBudget
} from './database-cost-meter.ts';

const budget: DataMigrationBudget = {
	maximumStatements: 2,
	maximumRowsReturned: 3,
	maximumReportedD1RowsRead: 5,
	maximumRowsWritten: 2,
	maximumParametersPerStatement: 2,
	maximumR2Operations: 2,
	maximumR2BytesRead: 10,
	maximumR2BytesWritten: 10
};

describe('data migration budget', () => {
	it('refuses a statement before it exceeds the declared count', async () => {
		const result = withDataMigrationBudget(budget, async () => {
			await Promise.resolve();
			reserveMigrationStatement(1, 'first');
			reserveMigrationStatement(2, 'second');
			reserveMigrationStatement(0, 'third');
		});

		await expect(result).rejects.toBeInstanceOf(
			DataMigrationBudgetExceededError
		);
	});

	it('refuses a statement with too many parameters', async () => {
		const result = withDataMigrationBudget(budget, async () => {
			await Promise.resolve();
			reserveMigrationStatement(3, 'oversized');
		});

		await expect(result).rejects.toThrow(
			'The data migration used 3 statements, above its declared maximum of 2'
		);
	});

	it('audits database rows after each statement', async () => {
		const result = withDataMigrationBudget(budget, async () => {
			await Promise.resolve();
			recordMigrationRows({
				rowsReturned: 2,
				reportedRowsRead: 3,
				rowsWritten: 1
			});
			recordMigrationRows({
				rowsReturned: 2,
				reportedRowsRead: 2,
				rowsWritten: 1
			});
		});

		await expect(result).rejects.toThrow(
			'The data migration used 4 rowsReturned, above its declared maximum of 3'
		);
	});

	it('reserves R2 operations and bytes before transfer', async () => {
		const result = withDataMigrationBudget(budget, async () => {
			await Promise.resolve();
			reserveMigrationR2Operation({ bytesRead: 6 });
			reserveMigrationR2Operation({ bytesWritten: 8 });
			reserveMigrationR2Operation({ bytesRead: 1 });
		});

		await expect(result).rejects.toThrow(
			'The data migration used 3 r2Operations, above its declared maximum of 2'
		);
	});

	it('keeps concurrent invocation budgets independent', async () => {
		const first = withDataMigrationBudget(budget, async () => {
			reserveMigrationStatement(0, 'first');
			await Promise.resolve();
			reserveMigrationStatement(0, 'second');
		});
		const second = withDataMigrationBudget(budget, async () => {
			reserveMigrationStatement(0, 'first');
			await Promise.resolve();
			reserveMigrationStatement(0, 'second');
		});

		await expect(Promise.all([first, second])).resolves.toStrictEqual([
			undefined,
			undefined
		]);
	});
});
