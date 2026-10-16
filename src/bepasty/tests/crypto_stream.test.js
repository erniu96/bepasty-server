// node src/bepasty/tests/crypto_stream.test.js
'use strict';
const assert = require('node:assert/strict');
const {createHash, webcrypto} = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
require('../static/app/js/crypto.js');
const c = globalThis.BepastyCrypto, password = 'synthetic-stream-test', chunk = c.chunkSize;
function source(size) {
    const state = {maxRead: 0, reads: 0};
    return Object.assign(state, {name: '原始名字.txt', type: 'text/plain', size,
        slice(start, end) { return {async arrayBuffer() {
            state.maxRead = Math.max(state.maxRead, end - start); state.reads++;
            const out = new Uint8Array(end - start);
            for (let i = 0; i < out.length; i++) out[i] = (start + i) % 251;
            return out.buffer;
        }}; }
    });
}
function stream(file, mutate) {
    let offset = 0;
    return new ReadableStream({async pull(controller) {
        if (offset === file.size) { controller.close(); return; }
        const end = Math.min(file.size, offset + 100003);
        const bytes = await file.readEncrypted(offset, end);
        if (mutate) mutate(bytes, offset);
        offset = end; controller.enqueue(bytes);
    }}, {highWaterMark: 0});
}
async function verify(file, plain, mutate) {
    const reader = c.streamReader(stream(file, mutate));
    try {
        const opened = await c.openRecords(reader, password);
        assert.equal(opened.name, plain.name); assert.equal(opened.size, plain.size);
        let offset = 0, bytes; const hash = createHash('sha256');
        while ((bytes = await opened.next()) !== null) {
            assert(bytes.length <= chunk);
            for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], (offset + i) % 251);
            hash.update(bytes); offset += bytes.length;
        }
        assert.equal(offset, plain.size); return hash.digest('hex');
    } finally { await reader.cancel(); }
}
(async () => {
    for (const size of [0, 1, chunk - 1, chunk, chunk + 1, chunk * 3 + 13]) {
        const plain = source(size), file = await c.prepareFile(plain, password);
        assert.equal(plain.reads, 0, 'preparation must not read file content');
        await verify(file, plain);
        assert(plain.maxRead <= chunk);
        const a = await file.readEncrypted(33, Math.min(file.size, 7777));
        const b = await file.readEncrypted(33, Math.min(file.size, 7777));
        assert.deepEqual(a, b, 'retry ciphertext must be identical');
    }
    const plain = source(2 * chunk + 10), file = await c.prepareFile(plain, password);
    const header = await file.readEncrypted(0, 48), metaLength = new DataView(header.buffer).getUint32(44), prefix = 48 + metaLength + 16;
    for (const at of [8, 24, 44, 50, prefix + 10, file.size - 1]) {
        await assert.rejects(verify(file, plain, (bytes, start) => { if (at >= start && at < start + bytes.length) bytes[at - start] ^= 1; }));
    }
    let reader = c.streamReader(stream(file));
    await assert.rejects(c.openRecords(reader, 'wrong'), /密码/); await reader.cancel();
    const truncated = {size: file.size - 1, readEncrypted: file.readEncrypted};
    await assert.rejects(verify(truncated, plain), /不完整/);
    const extra = {size: file.size + 1, async readEncrypted(a,b) { return b <= file.size ? file.readEncrypted(a,b) : new Uint8Array([...await file.readEncrypted(a,file.size),0]); }};
    await assert.rejects(verify(extra, plain), /多余/);
    const swapped = {size:file.size, async readEncrypted(a,b) {
        const bytes = await file.readEncrypted(a,b);
        // Swap bytes at equal positions in different records: tags must reject it.
        if (a <= prefix && b > prefix) bytes[prefix-a] ^= 128;
        return bytes;
    }};
    await assert.rejects(verify(swapped, plain));
    const huge = source(130 * 1024 * 1024 + 7), encrypted = await c.prepareFile(huge,password);
    const hash = await verify(encrypted,huge);
    assert.equal(huge.maxRead,chunk);
    console.log(JSON.stringify({passed:true,largePlainBytes:huge.size,maxSourceRead:huge.maxRead,sha256:hash,
        checks:'empty/boundary/large roundtrips; bounded reads; exact retry; wrong password; header/meta/chunk corruption; truncation/trailing bytes'}));
})().catch(error => { console.error(error); process.exitCode=1; });
