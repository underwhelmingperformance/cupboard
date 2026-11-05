import { uploadRequestMaxPathsHeader } from '@cupboard/protocol/upload';

/**
Returns the number of paths that a response advertises in
`x-cupboard-upload-max-paths`, at most `cap`. Returns `undefined` when the
header is missing or is not a positive integer.
*/
export function advertisedMaxPaths(
	response: Response,
	cap: number
): number | undefined {
	const advertised = Number(response.headers.get(uploadRequestMaxPathsHeader));

	if (!Number.isSafeInteger(advertised) || advertised <= 0) {
		return undefined;
	}

	return Math.min(advertised, cap);
}
