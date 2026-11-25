const { describe, expect, test } = require('bun:test');
const BufferWrapper = require('../src/js/buffer');
const BLPImage = require('../src/js/casc/blp');

const BLP_HEADER_SIZE = 148;

const createBLP = ({ width, height, encoding = 3, alphaDepth = 8, mipmapData = Buffer.from([10, 20, 30, 40]), declaredOffset, declaredSize = mipmapData.length }) => {
	const dataOffset = BLP_HEADER_SIZE + (encoding === 1 ? 1024 : 0);
	const buffer = Buffer.alloc(dataOffset + mipmapData.length);

	buffer.write('BLP2', 0, 'ascii');
	buffer.writeUInt32LE(1, 4);
	buffer.writeUInt8(encoding, 8);
	buffer.writeUInt8(alphaDepth, 9);
	buffer.writeUInt8(0, 10);
	buffer.writeUInt8(0, 11);
	buffer.writeUInt32LE(width, 12);
	buffer.writeUInt32LE(height, 16);
	buffer.writeUInt32LE(declaredOffset ?? dataOffset, 20);
	buffer.writeUInt32LE(declaredSize, 84);
	if (encoding === 1)
		Buffer.from([10, 20, 30, 40]).copy(buffer, BLP_HEADER_SIZE);
	mipmapData.copy(buffer, dataOffset);

	return new BufferWrapper(buffer);
};

describe('BLP conversion resource limits', () => {
	test('rejects excessive dimensions before conversion', () => {
		const data = createBLP({ width: 16384, height: 16384 });
		expect(() => new BLPImage(data)).toThrow('BLP dimensions exceed the conversion limit');
	});

	test('rejects excessive pixel counts', () => {
		const data = createBLP({ width: 8192, height: 8192 });
		expect(() => new BLPImage(data)).toThrow('BLP pixel count exceeds the BLP conversion limit');
	});

	test('rejects zero dimensions', () => {
		const data = createBLP({ width: 0, height: 1 });
		expect(() => new BLPImage(data)).toThrow('Invalid BLP dimensions');
	});

	test('rejects undersized encoded mipmaps', () => {
		const data = createBLP({ width: 4, height: 4 });
		expect(() => new BLPImage(data)).toThrow('Invalid BLP mipmap size');
	});

	test('rejects out-of-bounds mipmaps', () => {
		const data = createBLP({ width: 1, height: 1, declaredOffset: 0xFFFFFFFF });
		expect(() => new BLPImage(data)).toThrow('Invalid BLP mipmap range');
	});

	test('preserves valid BGRA conversion', () => {
		const blp = new BLPImage(createBLP({ width: 1, height: 1 }));
		expect(blp.toUInt8Array()).toEqual(new Uint8Array([30, 20, 10, 40]));
	});

	test('preserves valid palette conversion', () => {
		const data = createBLP({ width: 1, height: 1, encoding: 1, alphaDepth: 0, mipmapData: Buffer.from([0]) });
		const blp = new BLPImage(data);
		expect(blp.toUInt8Array()).toEqual(new Uint8Array([30, 20, 10, 255]));
	});

	test('preserves valid DXT conversion', () => {
		const data = createBLP({ width: 4, height: 4, encoding: 2, alphaDepth: 0, mipmapData: Buffer.alloc(8) });
		const blp = new BLPImage(data);
		expect(blp.toUInt8Array().subarray(0, 4)).toEqual(new Uint8Array([0, 0, 0, 255]));
	});
});
