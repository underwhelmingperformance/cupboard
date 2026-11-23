import { accessKeySecretSchema } from '@cupboard/protocol/access-keys';

/**
An access key for the destination cache in the actions' tests.
*/
export const destinationAccessKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-00000000000d_${'d'.repeat(64)}`
);

/**
An access key for a reuse view or reference source in the actions' tests.
*/
export const viewAccessKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-00000000000e_${'e'.repeat(64)}`
);

/**
The Basic authorization header that presents `key` to a read route.
*/
export function accessKeyAuthorization(key: string): string {
	return `Basic ${Buffer.from(`cupboard:${key}`).toString('base64')}`;
}
