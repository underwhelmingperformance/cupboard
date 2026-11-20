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

// The most bytes of path metadata in one page that the Worker sends to the
// tenant object. Build inputs can make one path's metadata about 1.5 MB, so the
// Worker pages by size as well as by count. Each page in flight takes about
// twice this, as JSON text and as an encoded body, and six can be in flight
// beside the validated request's paths.
export const uploadPageMaxBytes = 2 * 1024 * 1024;

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
