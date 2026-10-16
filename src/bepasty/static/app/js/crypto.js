/* Bepasty encrypted envelope v1. Passwords/keys/plaintext never go to the server. */
(function (root) {
    'use strict';
    var MAGIC = new Uint8Array([66, 69, 80, 65, 69, 78, 67, 49]); // BEPAENC1
    var MAX = 128 * 1024 * 1024, TYPE = 'application/x-bepasty-encrypted';
    function supported() { return !!(root.crypto && root.crypto.subtle && root.TextEncoder && root.TextDecoder); }
    function join(parts) {
        var size = parts.reduce(function (n, p) { return n + p.length; }, 0), out = new Uint8Array(size), at = 0;
        parts.forEach(function (p) { out.set(p, at); at += p.length; });
        return out;
    }
    async function key(password, salt) {
        if (!password) { throw new Error('请输入加密密码。'); }
        var base = await root.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
        return root.crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: 600000},
            base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    }
    async function encrypt(bytes, password, metadata) {
        if (!supported()) { throw new Error('浏览器不支持安全加密，请使用 HTTPS 地址。'); }
        bytes = new Uint8Array(bytes);
        if (bytes.length > MAX) { throw new Error('加密分享目前最多 128 MiB，请缩小文件。'); }
        var salt = root.crypto.getRandomValues(new Uint8Array(16)), iv = root.crypto.getRandomValues(new Uint8Array(12));
        var head = join([MAGIC, salt, iv]), meta = new TextEncoder().encode(JSON.stringify(metadata));
        if (meta.length > 16384) { throw new Error('文件信息过长。'); }
        var length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, meta.length);
        var sealed = await root.crypto.subtle.encrypt({name: 'AES-GCM', iv: iv, additionalData: head, tagLength: 128},
            await key(password, salt), join([length, meta, bytes]));
        return join([head, new Uint8Array(sealed)]);
    }
    async function decrypt(envelope, password) {
        if (!supported()) { throw new Error('浏览器不支持安全解密，请使用 HTTPS 地址。'); }
        var bytes = new Uint8Array(envelope);
        if (bytes.length < 56 || bytes.length > MAX + 16440 || !MAGIC.every(function (v, i) { return bytes[i] === v; })) {
            throw new Error('不支持或已损坏的加密文件。');
        }
        var plain;
        try {
            plain = new Uint8Array(await root.crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(24, 36),
                additionalData: bytes.slice(0, 36), tagLength: 128}, await key(password, bytes.slice(8, 24)), bytes.slice(36)));
        } catch (error) { throw new Error('密码错误或文件已损坏，无法解密。'); }
        var n = new DataView(plain.buffer).getUint32(0);
        if (n > 16384 || n > plain.length - 4) { throw new Error('文件信息损坏。'); }
        var meta = JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + n)));
        if (!meta || typeof meta.name !== 'string' || typeof meta.type !== 'string') { throw new Error('文件信息损坏。'); }
        return {bytes: plain.slice(4 + n), name: meta.name, type: meta.type};
    }
    root.BepastyCrypto = {encrypt: encrypt, decrypt: decrypt, supported: supported, max: MAX, type: TYPE};
    // v2: authenticated fixed-size records; only the requested slices are read.
    var CHUNK = 512 * 1024, HEADER = 48;
    function integer(n) { return Number.isSafeInteger(n) && n >= 0; }
    function u32(n) { var out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, n); return out; }
    function nonce(head, index) { return join([head.slice(24, 32), u32(index)]); }
    function parameters(head, index) {
        return {name: 'AES-GCM', iv: nonce(head, index), additionalData: join([head, u32(index)]), tagLength: 128};
    }
    function parseHeader(head) {
        if (head.length !== HEADER || new TextDecoder().decode(head.slice(0, 8)) !== 'BEPAENC2') {
            throw new Error('不支持的分块加密格式。');
        }
        var view = new DataView(head.buffer, head.byteOffset, head.byteLength), chunk = view.getUint32(32),
            size = view.getUint32(36) * 4294967296 + view.getUint32(40), metaSize = view.getUint32(44);
        if (chunk !== CHUNK || !integer(size) || Math.ceil(size / CHUNK) > 4294967295 || metaSize < 2 || metaSize > 16384) {
            throw new Error('加密文件头损坏。');
        }
        return {size: size, metaSize: metaSize, count: Math.ceil(size / CHUNK),
            offset: HEADER + metaSize + 16, total: HEADER + metaSize + 16 + size + Math.ceil(size / CHUNK) * 16};
    }
    function blobBytes(blob) {
        if (blob.arrayBuffer) { return blob.arrayBuffer(); }
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(new Error('文件读取失败。')); };
            reader.readAsArrayBuffer(blob);
        });
    }
    async function prepareFile(file, password) {
        if (!supported()) { throw new Error('加密需要支持 Web Crypto 的浏览器和 HTTPS 连接。'); }
        if (!integer(file.size) || Math.ceil(file.size / CHUNK) > 4294967295) { throw new Error('文件超过格式支持的大小。'); }
        var meta = new TextEncoder().encode(JSON.stringify({name: file.name, type: file.type}));
        if (meta.length > 16384) { throw new Error('文件信息过长。'); }
        var head = new Uint8Array(HEADER), view = new DataView(head.buffer);
        head.set(new TextEncoder().encode('BEPAENC2'));
        head.set(root.crypto.getRandomValues(new Uint8Array(24)), 8);
        view.setUint32(32, CHUNK); view.setUint32(36, Math.floor(file.size / 4294967296));
        view.setUint32(40, file.size % 4294967296); view.setUint32(44, meta.length);
        var derived = await key(password, head.slice(8, 24)), info = parseHeader(head),
            prefix = join([head, new Uint8Array(await root.crypto.subtle.encrypt(parameters(head, 0), derived, meta))]);
        // One record cache supports HTTP resume at arbitrary ciphertext offsets.
        var cachedIndex = -1, cached = null;
        return {name: '加密分享.bepenc', type: TYPE, size: info.total, readEncrypted: async function (start, end) {
            if (!integer(start) || !integer(end) || start > end || end > info.total || end - start > 4 * CHUNK) {
                throw new Error('无效的加密读取范围。');
            }
            var out = new Uint8Array(end - start), position = start;
            while (position < end) {
                var block, base;
                if (position < prefix.length) { block = prefix; base = 0; }
                else {
                    var index = Math.floor((position - prefix.length) / (CHUNK + 16));
                    base = prefix.length + index * (CHUNK + 16);
                    if (cachedIndex !== index) {
                        var bytes = await blobBytes(file.slice(index * CHUNK, Math.min(file.size, (index + 1) * CHUNK)));
                        if (bytes.byteLength !== Math.min(CHUNK, file.size - index * CHUNK)) { throw new Error('源文件读取不完整。'); }
                        cached = new Uint8Array(await root.crypto.subtle.encrypt(parameters(head, index + 1), derived, bytes));
                        cachedIndex = index;
                    }
                    block = cached;
                }
                var length = Math.min(block.length - (position - base), end - position);
                out.set(block.subarray(position - base, position - base + length), position - start);
                position += length;
            }
            return out;
        }};
    }
    // Reads at most one encrypted record ahead and propagates consumer cancellation.
    function streamReader(body) {
        var reader = body.getReader(), held = null, at = 0;
        return {
            read: async function (n) {
                var out = new Uint8Array(n), filled = 0;
                while (filled < n) {
                    if (!held || at === held.length) {
                        var next = await reader.read();
                        if (next.done) { throw new Error('加密文件不完整。'); }
                        held = next.value; at = 0;
                    }
                    var length = Math.min(n - filled, held.length - at);
                    out.set(held.subarray(at, at + length), filled); at += length; filled += length;
                }
                return out;
            },
            end: async function () {
                if ((held && at < held.length) || !(await reader.read()).done) { throw new Error('加密文件有多余数据。'); }
            },
            cancel: function () { return reader.cancel(); }
        };
    }
    async function openRecords(reader, password, session, header) {
        var head = header || await reader.read(HEADER), info = parseHeader(head);
        if (session && !head.every(function (v, i) { return v === session.header[i]; })) { throw new Error('加密文件已改变，请重新解锁。'); }
        var derived = session ? session.key : await key(password, head.slice(8, 24)), meta;
        try {
            meta = JSON.parse(new TextDecoder().decode(await root.crypto.subtle.decrypt(parameters(head, 0), derived,
                await reader.read(info.metaSize + 16))));
        } catch (error) { throw new Error('密码错误或文件已损坏，无法解密。'); }
        if (!meta || typeof meta.name !== 'string' || typeof meta.type !== 'string') { throw new Error('文件信息损坏。'); }
        var index = 0;
        return {name: meta.name, type: meta.type, size: info.size, total: info.total,
            session: {header: head, key: derived},
            next: async function () {
                if (index === info.count) { await reader.end(); return null; }
                var length = Math.min(CHUNK, info.size - index * CHUNK), encrypted = await reader.read(length + 16), result;
                try { result = new Uint8Array(await root.crypto.subtle.decrypt(parameters(head, index + 1), derived, encrypted)); }
                catch (error) { throw new Error('文件内容损坏，下载已停止。'); }
                index++;
                if (index === info.count) { await reader.end(); }
                return result;
            }
        };
    }
    root.BepastyCrypto.prepareFile = prepareFile;
    root.BepastyCrypto.streamReader = streamReader;
    root.BepastyCrypto.openRecords = openRecords;
    root.BepastyCrypto.chunkSize = CHUNK;
}(globalThis));
