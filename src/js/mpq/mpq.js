/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
*/
const { pkware_dcl_explode } = require('./pkware');
const { huffman_decomp } = require('./huffman');
const { bzip2_decompress } = require('./bzip2');
const { inflateSync } = require('zlib');
const fs = require('fs');

const MPQ_FILE_IMPLODE = 0x00000100;
const MPQ_FILE_COMPRESS = 0x00000200;
const MPQ_FILE_ENCRYPTED = 0x00010000;
const MPQ_FILE_FIX_KEY = 0x00020000;
const MPQ_FILE_SINGLE_UNIT = 0x01000000;
const MPQ_FILE_DELETE_MARKER = 0x02000000;
const MPQ_FILE_SECTOR_CRC = 0x04000000;
const MPQ_FILE_EXISTS = 0x80000000;

const HASH_ENTRY_EMPTY = 0xFFFFFFFF;
const HASH_ENTRY_DELETED = 0xFFFFFFFE;

const TABLE_ENTRY_SIZE = 16;
const MAX_TABLE_ENTRIES = 0x40000;
const MAX_USER_DATA_SIZE = 16 * 1024 * 1024;
const MAX_STORED_FILE_SIZE = 256 * 1024 * 1024;
const MAX_LOGICAL_FILE_SIZE = 256 * 1024 * 1024;
const MAX_LISTFILE_SIZE = 16 * 1024 * 1024;
const MAX_LISTFILE_ENTRIES = MAX_TABLE_ENTRIES;
const MAX_SECTORS_PER_FILE = 0x10000;
const MAX_SECTOR_SIZE_SHIFT = 16;
const MAX_COMPRESSION_RATIO = 1024;

const HashType = {
	TABLE_OFFSET: 0,
	HASH_A: 1,
	HASH_B: 2,
	TABLE: 3,
};

class MPQArchive {
	constructor(filePath) {
		this.filePath = filePath;
		this.fd = null;
		let initialized = false;
		try {
			this.fd = fs.openSync(filePath, 'r');
			const stat = fs.fstatSync(this.fd);
			if (!stat.isFile() || !Number.isSafeInteger(stat.size))
				throw this.invalidArchive('archive is not a regular file with a supported size');

			this.fileSize = stat.size;
			this.encryptionTable = this.buildEncryptionTable();
			this.header = this.readHeader();
			this.hashTable = this.readHashTable();
			this.blockTable = this.readBlockTable();
			this.files = [];
			initialized = true;

			const listfile_buffer = this.extractFile('(listfile)', MAX_LISTFILE_SIZE);
			if (listfile_buffer) {
				if (listfile_buffer.byteLength > MAX_LISTFILE_SIZE)
					throw this.resourceLimit(`listfile exceeds ${MAX_LISTFILE_SIZE} bytes`);

				const decoder = new TextDecoder('utf-8');
				const listfile_text = decoder.decode(listfile_buffer);
				const trimmed_listfile = listfile_text.trim();

				if (trimmed_listfile.length > 0) {
					let entry_count = 1;
					let in_separator = false;

					for (let i = 0; i < trimmed_listfile.length; i++) {
						const is_separator = trimmed_listfile[i] === '\r' || trimmed_listfile[i] === '\n';
						if (is_separator && !in_separator) {
							entry_count++;
							if (entry_count > MAX_LISTFILE_ENTRIES)
								throw this.resourceLimit(`listfile exceeds ${MAX_LISTFILE_ENTRIES} entries`);
						}
						in_separator = is_separator;
					}

					this.files = trimmed_listfile.split(/[\r\n]+/);
				}
			}
		} catch (e) {
			if (!initialized || e.code === 'ERR_MPQ_INVALID_ARCHIVE' || e.code === 'ERR_MPQ_RESOURCE_LIMIT') {
				this.close();
				throw e;
			}

			// The listfile is optional and may use an unsupported compression method.
		}
	}

	close() {
		if (this.fd !== null) {
			fs.closeSync(this.fd);
			this.fd = null;
		}
	}

	readBytes(offset, length) {
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0)
			throw this.invalidArchive('read uses an invalid offset or length');

		if (offset > this.fileSize || length > this.fileSize - offset)
			throw this.invalidArchive('read extends beyond the physical archive');

		const buffer = Buffer.allocUnsafe(length);
		const bytes_read = fs.readSync(this.fd, buffer, 0, length, offset);
		if (bytes_read !== length)
			throw this.invalidArchive(`short read at offset ${offset}: expected ${length}, received ${bytes_read}`);

		return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	}

	invalidArchive(message) {
		const error = new Error(`invalid MPQ archive: ${message}`);
		error.code = 'ERR_MPQ_INVALID_ARCHIVE';
		return error;
	}

	resourceLimit(message) {
		const error = new Error(`MPQ resource limit exceeded: ${message}`);
		error.code = 'ERR_MPQ_RESOURCE_LIMIT';
		return error;
	}

	resolveArchiveOffset(offset, offset_high = 0) {
		const resolved = this.header.offset + offset + (offset_high * 0x100000000);
		if (!Number.isSafeInteger(resolved))
			throw this.invalidArchive('archive offset exceeds the supported integer range');

		return resolved;
	}

	validateArchiveRange(offset, length, label) {
		const archive_end = this.header.offset + this.header.archivedSize;
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < this.header.offset || length < 0)
			throw this.invalidArchive(`${label} uses an invalid range`);

		if (offset > archive_end || length > archive_end - offset)
			throw this.invalidArchive(`${label} extends beyond the declared archive`);

		if (offset > this.fileSize || length > this.fileSize - offset)
			throw this.invalidArchive(`${label} extends beyond the physical archive`);
	}

	buildEncryptionTable() {
		const table = new Uint32Array(0x500);
		let seed = 0x00100001;

		for (let i = 0; i < 0x100; i++) {
			let index = i;
			for (let j = 0; j < 5; j++) {
				seed = (seed * 125 + 3) % 0x2aaaab;
				const temp1 = (seed & 0xffff) << 0x10;

				seed = (seed * 125 + 3) % 0x2aaaab;
				const temp2 = seed & 0xffff;

				table[index] = (temp1 | temp2) >>> 0;
				index += 0x100;
			}
		}

		return table;
	}

	readHeader() {
		let offset = 0;

		const possible_offsets = [0, 0x200, 0x400, 0x600, 0x800, 0xa00, 0xc00, 0xe00];
		let found_offset = -1;

		for (const test_offset of possible_offsets) {
			const data = this.readBytes(test_offset, 4);

			const magic = String.fromCharCode(
				data[0],
				data[1],
				data[2],
				data[3]
			);

			if (magic === 'MPQ\x1a' || magic === 'MPQ\x1b') {
				found_offset = test_offset;
				offset = test_offset;
				break;
			}
		}

		if (found_offset === -1)
			throw new Error('invalid MPQ archive: MPQ signature not found');

		const data = this.readBytes(offset, 4);
		const magic = String.fromCharCode(
			data[0],
			data[1],
			data[2],
			data[3]
		);

		let header;

		if (magic === 'MPQ\x1b') {
			const user_data_header = this.readUserDataHeader(offset);
			offset = user_data_header.mpqHeaderOffset;
			header = this.readMPQHeader(offset);
			header.userDataHeader = user_data_header;
		} else if (magic === 'MPQ\x1a') {
			header = this.readMPQHeader(offset);
		} else {
			throw new Error('invalid MPQ archive: invalid magic signature');
		}

		return header;
	}

	readUserDataHeader(offset) {
		const data = this.readBytes(offset, 16);
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

		const magic = String.fromCharCode(
			data[0],
			data[1],
			data[2],
			data[3]
		);

		const user_data_size = view.getUint32(4, true);
		const mpq_header_offset = view.getUint32(8, true);
		const user_data_header_size = view.getUint32(12, true);

		if (user_data_header_size > MAX_USER_DATA_SIZE)
			throw this.resourceLimit(`user data header exceeds ${MAX_USER_DATA_SIZE} bytes`);

		const content = this.readBytes(offset + 16, user_data_header_size);

		return {
			magic,
			userDataSize: user_data_size,
			mpqHeaderOffset: mpq_header_offset,
			userDataHeaderSize: user_data_header_size,
			content,
		};
	}

	readMPQHeader(offset) {
		const data = this.readBytes(offset, 44);
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

		const magic = String.fromCharCode(
			data[0],
			data[1],
			data[2],
			data[3]
		);

		const header_size = view.getUint32(4, true);
		const archived_size = view.getUint32(8, true);
		const format_version = view.getUint16(12, true);
		const sector_size_shift = view.getUint16(14, true);
		const hash_table_offset = view.getUint32(16, true);
		const block_table_offset = view.getUint32(20, true);
		const hash_table_entries = view.getUint32(24, true);
		const block_table_entries = view.getUint32(28, true);
		const minimum_header_size = format_version === 1 ? 44 : 32;

		if (magic !== 'MPQ\x1a')
			throw this.invalidArchive('invalid MPQ header signature');

		if (format_version > 1)
			throw this.invalidArchive(`unsupported format version ${format_version}`);

		if (header_size < minimum_header_size)
			throw this.invalidArchive(`header is smaller than ${minimum_header_size} bytes`);

		if (archived_size < header_size || offset > this.fileSize || archived_size > this.fileSize - offset)
			throw this.invalidArchive('declared archive size exceeds the physical archive');

		if (sector_size_shift > MAX_SECTOR_SIZE_SHIFT)
			throw this.resourceLimit(`sector size shift exceeds ${MAX_SECTOR_SIZE_SHIFT}`);

		if (hash_table_entries === 0 || hash_table_entries > MAX_TABLE_ENTRIES || (hash_table_entries & (hash_table_entries - 1)) !== 0)
			throw this.resourceLimit(`hash table must contain a power-of-two entry count no greater than ${MAX_TABLE_ENTRIES}`);

		if (block_table_entries > MAX_TABLE_ENTRIES)
			throw this.resourceLimit(`block table exceeds ${MAX_TABLE_ENTRIES} entries`);

		const header = {
			magic,
			headerSize: header_size,
			archivedSize: archived_size,
			formatVersion: format_version,
			sectorSizeShift: sector_size_shift,
			hashTableOffset: hash_table_offset,
			blockTableOffset: block_table_offset,
			hashTableEntries: hash_table_entries,
			blockTableEntries: block_table_entries,
			offset,
		};

		if (format_version === 1) {
			const ext_block_table_low = view.getUint32(32, true);
			const ext_block_table_high = view.getUint32(36, true);

			header.extendedBlockTableOffset = (BigInt(ext_block_table_high) << 32n) | BigInt(ext_block_table_low);
			header.hashTableOffsetHigh = view.getUint16(40, true);
			header.blockTableOffsetHigh = view.getUint16(42, true);
		}

		return header;
	}

	hash(str, hashType) {
		let seed1 = 0x7fed7fed >>> 0;
		let seed2 = 0xeeeeeeee >>> 0;

		str = str.toUpperCase();

		for (let i = 0; i < str.length; i++) {
			const ch = str.charCodeAt(i);
			const value = this.encryptionTable[(hashType << 8) + ch];
			seed1 = (value ^ (seed1 + seed2)) >>> 0;
			seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
		}

		return seed1;
	}

	decrypt(data, key, in_place = false) {
		let seed1 = key >>> 0;
		let seed2 = 0xeeeeeeee >>> 0;

		const result = in_place ? data : new Uint8Array(data.length);
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const result_view = new DataView(result.buffer, result.byteOffset, result.byteLength);

		for (let i = 0; i < Math.floor(data.length / 4); i++) {
			const temp = (seed2 + this.encryptionTable[0x400 + (seed1 & 0xff)]) >>> 0;
			seed2 = temp;

			const value = view.getUint32(i * 4, true);
			const decrypted = (value ^ (seed1 + seed2)) >>> 0;

			seed1 = ((((~seed1) << 21) + 0x11111111) | (seed1 >>> 11)) >>> 0;
			seed2 = (decrypted + seed2 + (seed2 << 5) + 3) >>> 0;

			result_view.setUint32(i * 4, decrypted, true);
		}

		return result;
	}

	detectFileSeed(data, expected) {
		if (data.length < 8)
			return 0;

		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const encrypted0 = view.getUint32(0, true);
		const encrypted1 = view.getUint32(4, true);

		const seed_sum = (encrypted0 ^ expected) >>> 0;
		const temp = (seed_sum - 0xEEEEEEEE) >>> 0;

		for (let low_byte = 0; low_byte < 256; low_byte++) {
			const seed1 = (temp - this.encryptionTable[0x400 + low_byte]) >>> 0;

			const seed2_0 = (0xEEEEEEEE + this.encryptionTable[0x400 + (seed1 & 0xFF)]) >>> 0;
			const decrypted0 = (encrypted0 ^ (seed1 + seed2_0)) >>> 0;

			if (decrypted0 !== expected)
				continue;

			const next_seed1 = ((((~seed1) << 21) + 0x11111111) | (seed1 >>> 11)) >>> 0;
			const seed2_1 = (decrypted0 + seed2_0 + (seed2_0 << 5) + 3 + this.encryptionTable[0x400 + (next_seed1 & 0xFF)]) >>> 0;
			const decrypted1 = (encrypted1 ^ (next_seed1 + seed2_1)) >>> 0;

			if ((decrypted1 & 0xFFFF0000) === 0)
				return seed1;
		}

		return 0;
	}

	readHashTable() {
		const table_offset = this.resolveArchiveOffset(this.header.hashTableOffset, this.header.hashTableOffsetHigh);
		const table_size = this.header.hashTableEntries * TABLE_ENTRY_SIZE;
		const key = this.hash('(hash table)', HashType.TABLE);
		this.validateArchiveRange(table_offset, table_size, 'hash table');

		let table_data = this.readBytes(table_offset, table_size);
		table_data = this.decrypt(table_data, key, true);

		const entries = [];
		const table_view = new DataView(table_data.buffer, table_data.byteOffset, table_data.byteLength);

		for (let i = 0; i < this.header.hashTableEntries; i++) {
			const offset = i * 16;
			entries.push({
				hashA: table_view.getUint32(offset, true),
				hashB: table_view.getUint32(offset + 4, true),
				locale: table_view.getUint16(offset + 8, true),
				platform: table_view.getUint16(offset + 10, true),
				blockTableIndex: table_view.getUint32(offset + 12, true),
			});
		}

		return entries;
	}

	readBlockTable() {
		const table_offset = this.resolveArchiveOffset(this.header.blockTableOffset, this.header.blockTableOffsetHigh);
		const table_size = this.header.blockTableEntries * TABLE_ENTRY_SIZE;
		const key = this.hash('(block table)', HashType.TABLE);
		this.validateArchiveRange(table_offset, table_size, 'block table');

		let table_data = this.readBytes(table_offset, table_size);
		table_data = this.decrypt(table_data, key, true);

		const entries = [];
		const table_view = new DataView(table_data.buffer, table_data.byteOffset, table_data.byteLength);

		for (let i = 0; i < this.header.blockTableEntries; i++) {
			const offset = i * 16;
			const entry = {
				offset: table_view.getUint32(offset, true),
				archivedSize: table_view.getUint32(offset + 4, true),
				size: table_view.getUint32(offset + 8, true),
				flags: table_view.getUint32(offset + 12, true),
			};

			if ((entry.flags & MPQ_FILE_EXISTS) && !(entry.flags & MPQ_FILE_DELETE_MARKER))
				this.validateBlockEntry(entry);

			entries.push(entry);
		}

		return entries;
	}

	validateBlockEntry(block_entry, maximum_size = MAX_LOGICAL_FILE_SIZE) {
		if (block_entry.archivedSize > MAX_STORED_FILE_SIZE)
			throw this.resourceLimit(`stored file exceeds ${MAX_STORED_FILE_SIZE} bytes`);

		if (block_entry.size > maximum_size)
			throw this.resourceLimit(`logical file exceeds ${maximum_size} bytes`);

		if (block_entry.archivedSize === 0 && block_entry.size !== 0)
			throw this.invalidArchive('non-empty file has no stored data');

		if ((block_entry.flags & (MPQ_FILE_COMPRESS | MPQ_FILE_IMPLODE)) && block_entry.archivedSize > 0 &&
			block_entry.size > block_entry.archivedSize * MAX_COMPRESSION_RATIO)
			throw this.resourceLimit(`file compression ratio exceeds ${MAX_COMPRESSION_RATIO}:1`);

		const file_offset = this.resolveArchiveOffset(block_entry.offset);
		this.validateArchiveRange(file_offset, block_entry.archivedSize, 'file data');
		return file_offset;
	}

	getHashTableEntry(filename) {
		const hash_table_index = this.hash(filename, HashType.TABLE_OFFSET) & (this.header.hashTableEntries - 1);
		const hash_a = this.hash(filename, HashType.HASH_A);
		const hash_b = this.hash(filename, HashType.HASH_B);

		for (let i = hash_table_index; i < this.hashTable.length; i++) {
			const entry = this.hashTable[i];
			if (entry.hashA === hash_a && entry.hashB === hash_b) {
				if (entry.blockTableIndex === 0xFFFFFFFF || entry.blockTableIndex === 0xFFFFFFFE)
					return null; // empty or deleted
				return entry;
			}

			if (entry.hashA === 0xFFFFFFFF && entry.hashB === 0xFFFFFFFF)
				break; // file doesn't exist
		}

		return null;
	}

	decompress(data, expected_size) {
		// 0x01: Huffman
		// 0x02: Zlib
		// 0x08: PKWare
		// 0x10: Bzip2
		// 0x40: ADPCM Mono
		// 0x80: ADPCM Stereo

		if (!Number.isSafeInteger(expected_size) || expected_size <= 0 || expected_size > MAX_LOGICAL_FILE_SIZE)
			throw this.resourceLimit(`invalid decompression output size ${expected_size}`);

		if (data.length === 0)
			throw this.invalidArchive('compressed data is empty');

		if (expected_size > data.length * MAX_COMPRESSION_RATIO)
			throw this.resourceLimit(`compression ratio exceeds ${MAX_COMPRESSION_RATIO}:1`);

		let compression_flags = data[0];
		let result = data.slice(1);

		// order: Bzip2 (0x10) -> PKWare (0x08) -> Zlib (0x02) -> Huffman (0x01)
		if (compression_flags & 0x10) {
			result = bzip2_decompress(result, expected_size);
			compression_flags &= ~0x10;
			this.validateDecompressionOutput(result, expected_size, 'Bzip2');
		}

		if (compression_flags & 0x08) {
			result = pkware_dcl_explode(result, expected_size);
			compression_flags &= ~0x08;
			this.validateDecompressionOutput(result, expected_size, 'PKWare');
		}

		if (compression_flags & 0x02) {
			result = this.inflateData(result, expected_size);
			compression_flags &= ~0x02;
			this.validateDecompressionOutput(result, expected_size, 'Zlib');
		}

		if (compression_flags & 0x01) {
			result = huffman_decomp(result, expected_size);
			compression_flags &= ~0x01;
			this.validateDecompressionOutput(result, expected_size, 'Huffman');
		}

		if (compression_flags & 0x80)
			throw new Error('ADPCM Stereo compression (0x80) not yet supported');

		if (compression_flags & 0x40)
			throw new Error('ADPCM Mono compression (0x40) not yet supported');

		if (compression_flags !== 0)
			throw new Error(`unhandled compression flags remaining: 0x${compression_flags.toString(16)}`);

		if (result.length !== expected_size)
			throw this.invalidArchive(`decompression produced ${result.length} bytes instead of ${expected_size}`);

		return result;
	}

	validateDecompressionOutput(data, expected_size, codec) {
		if (data.length > expected_size)
			throw this.resourceLimit(`${codec} output exceeds ${expected_size} bytes`);
	}

	inflateData(data, maximum_size) {
		try {
			const result = inflateSync(Buffer.from(data), { maxOutputLength: maximum_size });
			return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
		} catch (e) {
			console.error('decompression error:', e);
			throw e;
		}
	}

	getSectorLayout(file_data, block_entry) {
		const sector_size = 512 * (2 ** this.header.sectorSizeShift);
		const data_sector_count = Math.ceil(block_entry.size / sector_size);
		if (data_sector_count > MAX_SECTORS_PER_FILE)
			throw this.resourceLimit(`file exceeds ${MAX_SECTORS_PER_FILE} sectors`);

		const has_crc = !!(block_entry.flags & MPQ_FILE_SECTOR_CRC);
		const position_count = data_sector_count + (has_crc ? 2 : 1);
		const position_table_size = position_count * 4;
		if (position_table_size > file_data.length)
			throw this.invalidArchive('sector position table exceeds stored file data');

		return {
			sectorSize: sector_size,
			dataSectorCount: data_sector_count,
			hasCRC: has_crc,
			positionCount: position_count,
			positionTableSize: position_table_size,
			positions: this.readSectorPositions(file_data, position_count),
		};
	}

	readSectorPositions(data, count) {
		const positions = new Uint32Array(count);
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let i = 0; i < count; i++)
			positions[i] = view.getUint32(i * 4, true);

		return positions;
	}

	validateSectorPositions(positions, position_table_size, stored_size) {
		if (positions[0] !== position_table_size)
			throw this.invalidArchive('sector position table has an invalid starting offset');

		for (let i = 1; i < positions.length; i++) {
			if (positions[i] < positions[i - 1] || positions[i] > stored_size)
				throw this.invalidArchive('sector position table is not monotonic or exceeds stored data');
		}
	}

	extractSectors(file_data, block_entry, layout, encryption_seed = 0, is_encrypted = false) {
		this.validateSectorPositions(layout.positions, layout.positionTableSize, file_data.length);

		const output = new Uint8Array(block_entry.size);
		let output_offset = 0;

		for (let i = 0; i < layout.dataSectorCount; i++) {
			let sector = file_data.subarray(layout.positions[i], layout.positions[i + 1]);

			if (is_encrypted && block_entry.size > 3) {
				const sector_seed = (encryption_seed + i) >>> 0;
				sector = this.decrypt(sector, sector_seed);
			}

			const expected_sector_size = Math.min(layout.sectorSize, block_entry.size - output_offset);
			if (sector.length > expected_sector_size)
				throw this.invalidArchive('stored sector exceeds its logical size');

			if ((block_entry.flags & MPQ_FILE_COMPRESS) && sector.length < expected_sector_size)
				sector = this.decompress(sector, expected_sector_size);

			if (sector.length !== expected_sector_size)
				throw this.invalidArchive(`sector produced ${sector.length} bytes instead of ${expected_sector_size}`);

			output.set(sector, output_offset);
			output_offset += sector.length;
		}

		if (output_offset !== block_entry.size)
			throw this.invalidArchive(`file produced ${output_offset} bytes instead of ${block_entry.size}`);

		return output;
	}

	toArrayBuffer(data) {
		if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
			return data.buffer;

		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	}

	extractFile(filename, maximum_size = MAX_LOGICAL_FILE_SIZE) {
		const hash_entry = this.getHashTableEntry(filename);
		if (!hash_entry)
			return null;

		const block_entry = this.blockTable[hash_entry.blockTableIndex];
		if (!block_entry)
			throw this.invalidArchive('hash table references a missing block entry');

		if (!(block_entry.flags & MPQ_FILE_EXISTS))
			return null;

		if (!Number.isSafeInteger(maximum_size) || maximum_size < 0)
			throw this.resourceLimit('invalid logical file size limit');

		maximum_size = Math.min(maximum_size, MAX_LOGICAL_FILE_SIZE);
		const file_offset = this.validateBlockEntry(block_entry, maximum_size);

		if (block_entry.archivedSize === 0)
			return new ArrayBuffer(0);

		let file_data = this.readBytes(file_offset, block_entry.archivedSize);

		let encryption_seed = 0;
		let is_encrypted = false;

		if (block_entry.flags & MPQ_FILE_ENCRYPTED) {
			is_encrypted = true;
			const path_separator_index = filename.lastIndexOf('\\');
			const file_name_only = path_separator_index >= 0 ? filename.substring(path_separator_index + 1) : filename;
			encryption_seed = this.hash(file_name_only, HashType.TABLE);

			if (block_entry.flags & MPQ_FILE_FIX_KEY)
				encryption_seed = ((encryption_seed + block_entry.offset) ^ block_entry.size) >>> 0;
		}

		// check if file is actually stored as single unit even without flag
		// this happens when archivedSize == size and no compression
		const is_single_unit = (block_entry.flags & MPQ_FILE_SINGLE_UNIT) ||
		                       (block_entry.archivedSize === block_entry.size && !(block_entry.flags & MPQ_FILE_COMPRESS));

		if (is_single_unit) {
			if (is_encrypted)
				file_data = this.decrypt(file_data, encryption_seed);

			if (block_entry.flags & MPQ_FILE_COMPRESS) {
				if (block_entry.size > block_entry.archivedSize)
					file_data = this.decompress(file_data, block_entry.size);
			}

			if (file_data.length !== block_entry.size)
				throw this.invalidArchive(`file produced ${file_data.length} bytes instead of ${block_entry.size}`);
		} else {
			const layout = this.getSectorLayout(file_data, block_entry);
			const is_position_table_encrypted = layout.positions[0] !== layout.positionTableSize;

			if (is_position_table_encrypted) {
				const position_table_data = file_data.slice(0, layout.positionTableSize);

				if (encryption_seed === 0) {
					encryption_seed = this.detectFileSeed(position_table_data, layout.positionTableSize);
					if (encryption_seed === 0) {
						// plaintext attack failed, compute from filename
						const path_separator_index = filename.lastIndexOf('\\');
						const file_name_only = path_separator_index >= 0 ? filename.substring(path_separator_index + 1) : filename;
						encryption_seed = this.hash(file_name_only, HashType.TABLE);

						if (block_entry.flags & MPQ_FILE_FIX_KEY)
							encryption_seed = ((encryption_seed + block_entry.offset) ^ block_entry.size) >>> 0;
					}
					is_encrypted = true;
				} else {
					const detected_seed = this.detectFileSeed(position_table_data, layout.positionTableSize);
					if (detected_seed !== 0)
						encryption_seed = detected_seed;
				}

				const decrypted_positions = this.decrypt(position_table_data, encryption_seed);
				layout.positions = this.readSectorPositions(decrypted_positions, layout.positionCount);

				encryption_seed = (encryption_seed + 1) >>> 0;
			}

			file_data = this.extractSectors(file_data, block_entry, layout, encryption_seed, is_encrypted);
		}

		return this.toArrayBuffer(file_data);
	}

	getInfo() {
		return {
			formatVersion: this.header.formatVersion,
			archiveSize: this.header.archivedSize,
			fileCount: this.files.length,
			hashTableEntries: this.header.hashTableEntries,
			blockTableEntries: this.header.blockTableEntries,
		};
	}

	getValidHashEntries() {
		return this.hashTable.filter(entry => {
			return entry.blockTableIndex !== HASH_ENTRY_EMPTY &&
			entry.blockTableIndex !== HASH_ENTRY_DELETED &&
			entry.blockTableIndex < this.blockTable.length &&
			entry.hashA !== HASH_ENTRY_EMPTY &&
			entry.hashB !== HASH_ENTRY_EMPTY;
		});
	}

	getValidBlockEntries() {
		return this.blockTable
		.map((entry, index) => ({index, entry}))
		.filter(({entry}) => (entry.flags & MPQ_FILE_EXISTS) !== 0);
	}

	extractFileByBlockIndex(blockIndex) {
		if (!Number.isSafeInteger(blockIndex) || blockIndex < 0 || blockIndex >= this.blockTable.length)
			return null;

		const block_entry = this.blockTable[blockIndex];

		if (!(block_entry.flags & MPQ_FILE_EXISTS))
			return null;

		const file_offset = this.validateBlockEntry(block_entry);

		if (block_entry.archivedSize === 0)
			return new ArrayBuffer(0);

		if (block_entry.flags & MPQ_FILE_ENCRYPTED)
			return null; // todo: MPQ_FILE_FIX_KEY?

		let file_data = this.readBytes(file_offset, block_entry.archivedSize);
		const is_single_unit = (block_entry.flags & MPQ_FILE_SINGLE_UNIT) ||
		                       (block_entry.archivedSize === block_entry.size && !(block_entry.flags & MPQ_FILE_COMPRESS));

		if (is_single_unit) {
			if (block_entry.flags & MPQ_FILE_COMPRESS) {
				if (block_entry.size > block_entry.archivedSize)
					file_data = this.decompress(file_data, block_entry.size);
			}

			if (file_data.length !== block_entry.size)
				throw this.invalidArchive(`file produced ${file_data.length} bytes instead of ${block_entry.size}`);
		} else {
			const layout = this.getSectorLayout(file_data, block_entry);
			file_data = this.extractSectors(file_data, block_entry, layout);
		}

		return this.toArrayBuffer(file_data);
	}
}

module.exports = { MPQArchive };
