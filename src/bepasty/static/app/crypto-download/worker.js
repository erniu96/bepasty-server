/* Isolated download-only scope. Keys are ephemeral; plaintext is never cached. */
importScripts('../js/crypto.js?v=stream-v2');
var sessions = new Map();
self.addEventListener('install', function (event) { event.waitUntil(self.skipWaiting()); });
self.addEventListener('message', function (event) {
    var data = event.data, port = event.ports[0];
    if (!port || !data || data.action !== 'prepare') { return; }
    var source = new URL(data.url, self.location.href);
    if (source.origin !== self.location.origin || !data.session || !data.session.key) { return; }
    sessions.forEach(function (value, token) { if (Date.now() - value.created > 60000) { sessions.delete(token); } });
    if (sessions.size >= 16) { port.postMessage({error: '请稍后重试下载。'}); return; }
    var token = Array.from(crypto.getRandomValues(new Uint8Array(16)), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    sessions.set(token, {source: source.href, session: data.session, created: Date.now()});
    port.postMessage({url: new URL('file/' + token, self.registration.scope).href});
});
self.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url), base = new URL('file/', self.registration.scope).pathname;
    if (!url.pathname.startsWith(base)) { return; }
    var token = url.pathname.slice(base.length), job = sessions.get(token);
    sessions.delete(token);
    event.respondWith((async function () {
        if (!job || Date.now() - job.created > 60000) { return new Response('下载已失效，请回到分享页重试。', {status: 410}); }
        var reader;
        try {
            var response = await fetch(job.source, {cache: 'no-store'});
            if (!response.ok || !response.body) { throw new Error('无法读取密文。'); }
            reader = BepastyCrypto.streamReader(response.body);
            var opened = await BepastyCrypto.openRecords(reader, null, job.session);
            var name = opened.name.replace(/[\\/\x00-\x1f\x7f]/g, '_') || '解密文件';
            var stream = new ReadableStream({
                pull: async function (controller) {
                    try {
                        var bytes = await opened.next();
                        if (bytes === null) { controller.close(); }
                        else { controller.enqueue(bytes); }
                    } catch (error) { controller.error(error); await reader.cancel(); }
                },
                cancel: function () { return reader.cancel(); }
            }, {highWaterMark: 0});
            return new Response(stream, {headers: {
                'Content-Type': 'application/octet-stream', 'Content-Length': String(opened.size),
                'Content-Disposition': "attachment; filename=download; filename*=UTF-8''" + encodeURIComponent(name).replace(/['()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16); }),
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
            }});
        } catch (error) {
            if (reader) { await reader.cancel(); }
            return new Response('解密下载失败，请回到分享页重试。', {status: 400, headers: {'Cache-Control': 'no-store'}});
        }
    }()));
});
