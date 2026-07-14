import { acceptCapabilitiesHeader } from '@cupboard/protocol/upload';

/** Tests whether a request declares support for an optional protocol feature. */
export function hasAcceptedCapability(
	request: Request,
	capability: string
): boolean {
	const header = request.headers.get(acceptCapabilitiesHeader);

	return (
		header?.split(',').some((entry) => entry.trim() === capability) ?? false
	);
}
