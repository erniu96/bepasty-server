'use strict';
const assert = require('node:assert/strict');
if (!globalThis.crypto) { globalThis.crypto = require('node:crypto').webcrypto; }
require('../static/app/js/crypto.js');
(async () => {
    const c = globalThis.BepastyCrypto, plain = new TextEncoder().encode('保密内容 <script>bad()</script>'),
        metadata = {name: '私人名字.txt', type: 'text/plain'}, password = 'test-only-long-password';
    const a = await c.encrypt(plain, password, metadata), b = await c.encrypt(plain, password, metadata);
    assert.notDeepEqual(a, b);
    assert(!Buffer.from(a).includes(Buffer.from('保密内容')));
    assert(!Buffer.from(a).includes(Buffer.from(metadata.name)));
    assert(!Buffer.from(a).includes(Buffer.from(password)));
    const opened = await c.decrypt(a, password);
    assert.deepEqual(opened.bytes, plain); assert.equal(opened.name, metadata.name); assert.equal(opened.type, metadata.type);
    await assert.rejects(c.decrypt(a, 'wrong'), /密码错误/);
    for (const offset of [8, 24, 36, a.length - 1]) {
        const broken = a.slice(); broken[offset] ^= 1;
        await assert.rejects(c.decrypt(broken, password), /密码错误/);
    }
    await assert.rejects(c.decrypt(a.slice(0, 20), password), /损坏/);
    const version = a.slice(); version[7] = 50;
    await assert.rejects(c.decrypt(version, password), /不支持/);
    const empty = await c.encrypt(new Uint8Array(), password, metadata);
    assert.equal((await c.decrypt(empty, password)).bytes.length, 0);
    const binary = new Uint8Array([0, 255, 1, 128, 0, 127]);
    assert.deepEqual((await c.decrypt(await c.encrypt(binary, password, metadata), password)).bytes, binary);
    await assert.rejects(c.encrypt(plain, '', metadata), /密码/);
    console.log('Crypto envelope tests passed: roundtrips, randomness, privacy, wrong password, tampering, truncation, version, empty, binary.');
})().catch(error => { console.error(error); process.exitCode = 1; });
