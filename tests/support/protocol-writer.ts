export class ProtocolWriter {
	private readonly chunks: Buffer[] = [];

	writeInteger(value: number): void {
		const bytes = Buffer.alloc(8);
		bytes.writeBigUInt64LE(BigInt(value));
		this.chunks.push(bytes);
	}

	writeBoolean(value: boolean): void {
		this.writeInteger(value ? 1 : 0);
	}

	writeString(value: string): void {
		const bytes = Buffer.from(value, 'utf8');
		this.writeInteger(bytes.byteLength);
		this.chunks.push(bytes);

		const padding = (8 - (bytes.byteLength % 8)) % 8;

		if (padding > 0) {
			this.chunks.push(Buffer.alloc(padding));
		}
	}

	writeStringSet(values: readonly string[]): void {
		this.writeInteger(values.length);

		for (const value of values) {
			this.writeString(value);
		}
	}

	bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}
}
