import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';

import { subrequestsPerReconcileRemoval } from '../do/reconcile-queue-service.ts';

// Reserve one call per path for its NAR head and another for the remaining
// classification work. The second reserve covers fixed work in the object.
const pageSubrequests =
	workersInvocationAllowances.free.subrequests - 2 * subrequestSafetyReserve;
export const uploadPageSize = Math.floor(pageSubrequests / 2);
export const directUploadPageSize = Math.floor(
	pageSubrequests / (1 + subrequestsPerReconcileRemoval)
);

// Admission can read twice during catalogue migration, with one retry per read.
const tenantAdmissionSubrequests = 4;

export function uploadRequestSubrequestsFor(
	invocationSubrequests: number,
	availableSubrequests: number
): number {
	return Math.max(
		0,
		Math.min(
			availableSubrequests,
			invocationSubrequests -
				subrequestSafetyReserve -
				tenantAdmissionSubrequests
		)
	);
}
