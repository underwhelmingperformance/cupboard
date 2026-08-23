import { acceptCapabilitiesHeader } from '@cupboard/protocol/upload';

export function hasAcceptedCapability(
	request: Request,
	capability: string
): boolean {
	const header = request.headers.get(acceptCapabilitiesHeader);

	return (
		header?.split(',').some((entry) => entry.trim() === capability) ?? false
	);
}
