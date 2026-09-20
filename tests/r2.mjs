import assert from 'node:assert/strict';

export function bytesOf(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    throw new TypeError('Unsupported fake R2 value.');
}

class FakeR2Object {
    constructor(record) {
        this.key = record.key;
        this.etag = record.etag;
        this.httpEtag = `"${record.etag}"`;
        this.httpMetadata = record.httpMetadata;
        this.customMetadata = record.customMetadata;
        this.bytes = new Uint8Array(record.bytes);
        this.body = new Blob([this.bytes]).stream();
    }

    async text() {
        return new TextDecoder().decode(this.bytes);
    }

    async arrayBuffer() {
        return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
    }
}

export class FakeR2 {
    constructor() {
        this.records = new Map();
        this.sequence = 0;
        this.putCalls = [];
    }

    async get(key) {
        const record = this.records.get(key);
        return record ? new FakeR2Object(record) : null;
    }

    async put(key, value, options = {}) {
        const existing = this.records.get(key);
        const onlyIf = options.onlyIf;
        let allowed = true;
        if (onlyIf?.etagMatches !== undefined) {
            allowed = Boolean(existing && existing.etag === onlyIf.etagMatches);
        }
        if (onlyIf?.etagDoesNotMatch !== undefined) {
            allowed = allowed && (onlyIf.etagDoesNotMatch === '*' ? !existing : existing?.etag !== onlyIf.etagDoesNotMatch);
        }
        this.putCalls.push({ key, onlyIf, allowed });
        if (!allowed) return null;
        this.sequence += 1;
        const record = {
            key,
            bytes: bytesOf(value),
            etag: `etag-${this.sequence}`,
            httpMetadata: options.httpMetadata,
            customMetadata: options.customMetadata
        };
        this.records.set(key, record);
        return new FakeR2Object(record);
    }

    async delete(key) {
        this.records.delete(key);
    }

    seedJson(key, value) {
        this.sequence += 1;
        this.records.set(key, {
            key,
            bytes: bytesOf(JSON.stringify(value)),
            etag: `etag-${this.sequence}`,
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
            customMetadata: undefined
        });
    }

    seedText(key, value, httpMetadata = { contentType: 'application/json; charset=utf-8' }) {
        this.sequence += 1;
        this.records.set(key, {
            key,
            bytes: bytesOf(value),
            etag: `etag-${this.sequence}`,
            httpMetadata,
            customMetadata: undefined
        });
    }

    json(key) {
        const record = this.records.get(key);
        assert(record, `missing fake R2 JSON object: ${key}`);
        return JSON.parse(new TextDecoder().decode(record.bytes));
    }

    keys(prefix = '') {
        return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort();
    }
}
