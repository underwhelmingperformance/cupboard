import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import { isRpcProcedureMissingError } from './rpc-errors.ts';

const forbiddenStatus: number = StatusCodes.FORBIDDEN;

// No store path has this hash, so the probe reads one missing row.
const probeStorePathHash = '0'.repeat(32);

/**
The procedure that reads one path's build inputs in the default cache.
*/
export interface BuildInputsReadProbe {
	inDefaultCache(input: { hash: string }): Promise<unknown>;
}

// oRPC keeps the raw response of a reply without an oRPC error body in the
// error's data. A procedure's own refusal has an oRPC error body, so its data
// has no raw response.
function isProcedureRefusal(error: unknown): boolean {
	if (!(error instanceof ORPCError) || error.status !== forbiddenStatus) {
		return false;
	}

	const data: unknown = error.data;

	return !(
		typeof data === 'object' &&
		data !== null &&
		Object.hasOwn(data, 'body') &&
		Object.hasOwn(data, 'headers')
	);
}

/**
Whether the server knows the `build-inputs:record` operation, so that a trust
rule may grant it. The release that added the operation also added the
procedure that reads a path's build inputs. An earlier server has no route for
that procedure and answers it with a plain 404 before it authenticates the
request, and it refuses a trust rule that grants the operation. A procedure's
refusal of a token without `cache:content-read` therefore comes from a server
that has the procedure. Any other failure propagates, including a plain 403
from the edge.

A current server also answers a tenant that is not active with a plain 404, so
the probe reports an earlier server for it. The command that asked then fails
when it writes, with `TenantWritesStoppedError`, and changes nothing.
*/
export async function canGrantBuildInputs(
	read: BuildInputsReadProbe
): Promise<boolean> {
	try {
		await read.inDefaultCache({ hash: probeStorePathHash });

		return true;
	} catch (error) {
		if (isProcedureRefusal(error)) {
			return true;
		}

		if (isRpcProcedureMissingError(error)) {
			return false;
		}

		throw error;
	}
}
