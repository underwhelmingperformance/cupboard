declare const CUPBOARD_VERSION: string | undefined;

export const cupboardVersion =
	typeof CUPBOARD_VERSION === 'string' && CUPBOARD_VERSION.length > 0
		? CUPBOARD_VERSION
		: '0.0.0';
