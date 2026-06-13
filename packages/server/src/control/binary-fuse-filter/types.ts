export interface Geometry {
	readonly segmentLength: number;
	readonly segmentLengthMask: number;
	readonly segmentCount: number;
	readonly segmentCountLength: number;
	readonly arrayLength: number;
}

export interface SerialisedHeader {
	readonly seedHigh: number;
	readonly seedLow: number;
	readonly geometry: Geometry;
	readonly keyCount: number;
}

export interface HashedKeys {
	readonly highs: Uint32Array;
	readonly lows: Uint32Array;
	readonly length: number;
}
