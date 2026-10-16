import { type OperationCostRecord } from './operation-cost.ts';

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
