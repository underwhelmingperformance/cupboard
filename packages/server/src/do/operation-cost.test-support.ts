import {
	type OperationCostRecord,
	withOperationCost
} from './operation-cost.ts';

export const noCost: OperationCostRecord = {
	rowsRead: 0,
	rowsWritten: 0,
	d1Calls: 0,
	d1RowsRead: 0,
	d1RowsWritten: 0,
	d1CallsWithoutRows: 0,
	r2Head: 0,
	r2Get: 0,
	r2Put: 0,
	r2Delete: 0,
	r2List: 0
};

/**
Runs `body` in a cost scope of its own and returns the rows that its own
statements read. The tenant object's lifetime counter also counts the
statements of an alarm handler or a maintenance reconciliation that runs while
`body` awaits, so a measurement from that counter depends on timing.
A statement in a narrower scope that `body` opens, such as a request's, is
counted in that scope and not here.
*/
export async function rowsReadBy(body: () => unknown): Promise<number> {
	let rowsRead = 0;

	await withOperationCost(
		'test-measurement',
		async () => {
			await body();
		},
		(cost) => {
			({ rowsRead } = cost);
		}
	);

	return rowsRead;
}
