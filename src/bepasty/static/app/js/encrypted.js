/* Optional encrypted uploads and isolated, local-only decryption UI. */
(function () {
    'use strict';
    var crypto = window.BepastyCrypto, options = document.getElementById('encryption-options'),
        unlock = document.getElementById('encrypted-unlock'), objectURL = null;
    function supported(feedback) {
        if (!crypto.supported()) {
            // Web Crypto only exists in secure contexts (HTTPS or localhost).
            feedback.textContent = window.location.protocol === 'http:' ?
                '加密需要 HTTPS：请改用 https://' + window.location.host + window.location.pathname + ' 打开。' :
                '当前浏览器不支持 Web Crypto，无法加密或解密。';
            return false;
        }
        return true;
    }
    async function prepare(file, password) {
        if (!password) { throw new Error('请先输入加密密码，再点重试。'); }
        return crypto.prepareFile(file, password);
    }
    function send(file, options) {
        var xhr = null, aborted = false;
        var transfer = {abort: function () { aborted = true; if (xhr) { xhr.abort(); } }};
        (async function () {
            var offset = options.offset, result;
            try {
                while (offset < file.size) {
                    var end = Math.min(file.size, offset + Math.min(window.MAX_BODY_SIZE, 1024 * 1024)),
                        bytes = await file.readEncrypted(offset, end);
                    if (aborted) { return; }
                    var data = new FormData(); data.append('file', new Blob([bytes], {type: file.type}), file.name);
                    result = await window.jQuery.ajax({url: options.url, type: 'POST', data: data,
                        processData: false, contentType: false, dataType: 'json',
                        headers: {'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + file.size},
                        xhr: function () {
                            xhr = new XMLHttpRequest();
                            xhr.upload.onprogress = function (event) {
                                if (!aborted && event.lengthComputable) { options.progress(offset + Math.min(end - offset, event.loaded)); }
                            };
                            return xhr;
                        }});
                    if (aborted) { return; }
                    if (!result || result.uploaded_bytes !== end || result.size !== file.size) { throw new Error('服务器返回的上传进度不正确。'); }
                    offset = end; options.chunk(offset);
                }
                if (!aborted) { options.done(result); }
            } catch (error) { if (!aborted) { options.fail(error); } }
        }());
        return transfer;
    }
    window.BepastyEncryption = {
        prepare: prepare,
        send: send,
        submitText: async function (form) {
            var $ = window.jQuery, button = form.find('[type=submit]'), original = button.text(),
                feedback = form.find('.form-feedback'), password = document.getElementById('encrypt-password').value,
                text = form.find('textarea').val(), name = form.find('#filename').val() || '加密文字.txt',
                lifetime = form.find('[name=maxlife-preset]').val();
            if (form.data('submitting')) { return; }
            form.data('submitting', true);
            button.prop('disabled', true).text('正在加密…');
            feedback.text('');
            try {
                if (!text) { throw new Error('请填写要分享的文字。'); }
                var file = await prepare(new File([text], name, {type: 'text/plain'}), password);
                window.BepastyUploads.addEncrypted(file, lifetime);
                // Do not erase text the user has edited while encryption/upload ran.
                if (form.find('textarea').val() === text) { form.find('textarea').val(''); }
                if (form.find('#filename').val() === name) { form.find('#filename').val(''); }
            } catch (error) {
                feedback.text(error.message || '加密上传失败，内容已保留。请检查网络后重试。');
            } finally {
                form.data('submitting', false);
                button.prop('disabled', false).text(original);
            }
        }
    };
    if (options) {
        window.jQuery(function () {
            if (!window.BepastyUploads || !window.BepastyWorkspace) { return; }
            options.hidden = false;
            var checkbox = document.getElementById('encrypt-enabled'), password = document.getElementById('encrypt-password');
            function update() {
                document.getElementById('encryption-password').hidden = !checkbox.checked;
                document.getElementById('encryption-help').hidden = !checkbox.checked;
                if (!checkbox.checked) { password.value = ''; }
            }
            checkbox.addEventListener('change', function () { update(); if (checkbox.checked) { password.focus(); } });
            update();
        });
    }
    var downloadSession = null, workerPromise = null, downloadGeneration = 0;
    function downloadWorker() {
        if (!navigator.serviceWorker || !window.ReadableStream) { return Promise.reject(new Error('当前浏览器不支持分块保存，请使用支持 Service Worker 的 HTTPS 浏览器。')); }
        if (!workerPromise) {
            workerPromise = navigator.serviceWorker.register(unlock.dataset.worker).then(function (registration) {
                return new Promise(function (resolve, reject) {
                    var worker = registration.installing || registration.waiting || registration.active,
                        timer = setTimeout(function () { reject(new Error('下载组件启动超时，请重试。')); }, 15000);
                    function check() {
                        if (worker && worker.state === 'activated') { clearTimeout(timer); resolve(worker); }
                        else if (!worker || worker.state === 'redundant') { clearTimeout(timer); reject(new Error('下载组件无法启动。')); }
                    }
                    if (worker) { worker.addEventListener('statechange', check); } check();
                });
            }).catch(function (error) { workerPromise = null; throw error; });
        }
        return workerPromise;
    }
    async function startDownload(event) {
        if (!downloadSession) { return; }
        event.preventDefault();
        var current = downloadSession, generation = downloadGeneration, status = document.getElementById('decrypt-status');
        try {
            var worker = await downloadWorker();
            var url = await new Promise(function (resolve, reject) {
                var channel = new MessageChannel(), timer = setTimeout(function () { channel.port1.close(); reject(new Error('下载组件未响应，请重试。')); }, 10000);
                channel.port1.onmessage = function (message) {
                    clearTimeout(timer); channel.port1.close();
                    if (message.data.error) { reject(new Error(message.data.error)); }
                    else { resolve(message.data.url); }
                };
                worker.postMessage({action: 'prepare', url: new URL(unlock.dataset.url, location.href).href, session: current}, [channel.port2]);
            });
            if (generation !== downloadGeneration) { return; }
            var frame = document.createElement('iframe'); frame.hidden = true; frame.src = url; frame.title = '解密下载';
            document.body.appendChild(frame);
            // Keep the frame alive for the browser-managed streaming download.
            status.textContent = '已开始分块解密下载，请在浏览器下载列表查看进度。';
        } catch (error) { status.textContent = error.message; }
    }
    function clearPreview() {
        downloadSession = null; downloadGeneration++;
        if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
        document.getElementById('decrypted-preview').replaceChildren();
        document.getElementById('decrypted-panel').hidden = true;
        document.getElementById('decrypted-download').hidden = true;
    }
    if (unlock) {
        var status = document.getElementById('decrypt-status');
        document.getElementById('decrypted-download').addEventListener('click', startDownload);
        unlock.querySelector('[type=submit]').disabled = !supported(status);
        unlock.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (!supported(status)) { return; }
            var button = unlock.querySelector('[type=submit]');
            if (button.disabled) { return; }
            button.disabled = true; document.getElementById('decrypt-lock').disabled = true; clearPreview();
            try {
                status.textContent = '正在读取密文并本地解密…';
                var response = await fetch(unlock.dataset.url, {cache: 'no-store'});
                if (!response.ok || !response.body) { throw new Error('读取失败或浏览器不支持流式读取。'); }
                var reader = crypto.streamReader(response.body), opened;
                try {
                    var head = await reader.read(48), version = new TextDecoder().decode(head.slice(0, 8)),
                        password = document.getElementById('decrypt-password').value;
                    if (version === 'BEPAENC2') {
                        opened = await crypto.openRecords(reader, password, null, head);
                        if (opened.size > 16 * 1024 * 1024) {
                            await reader.cancel();
                            await downloadWorker();
                            downloadSession = opened.session;
                            var largeDownload = document.getElementById('decrypted-download');
                            largeDownload.href = '#download'; largeDownload.removeAttribute('download'); largeDownload.hidden = false;
                            document.getElementById('decrypt-password').value = '';
                            status.textContent = '已解锁：' + opened.name + '。点击下载，边解密边保存。';
                            return;
                        }
                        var parts = [], part;
                        while ((part = await opened.next()) !== null) { parts.push(part); }
                        opened.bytes = new Uint8Array(opened.size);
                        var at = 0; parts.forEach(function (bytes) { opened.bytes.set(bytes, at); at += bytes.length; });
                    } else {
                        // Compatibility only: v1 was limited to 128 MiB and has one authentication tag.
                        var size = Number(response.headers.get('Content-Length'));
                        if (version !== 'BEPAENC1' || !Number.isSafeInteger(size) || size < 56 || size > crypto.max + 16440) {
                            throw new Error('不支持或已损坏的加密文件。');
                        }
                        var legacy = new Uint8Array(size); legacy.set(head); legacy.set(await reader.read(size - 48), 48);
                        await reader.end(); opened = await crypto.decrypt(legacy, password);
                    }
                } finally { await reader.cancel(); }
                document.getElementById('decrypt-password').value = '';
                var preview = document.getElementById('decrypted-preview'), download = document.getElementById('decrypted-download');
                // Never render active HTML/SVG or execute decrypted scripts.
                var safeMedia = /^(image\/(png|jpeg|gif|webp|avif)|audio\/(mpeg|ogg|wav|mp4|webm)|video\/(mp4|webm|ogg)|application\/pdf)$/.test(opened.type);
                objectURL = URL.createObjectURL(new Blob([opened.bytes], {type: safeMedia ? opened.type : 'application/octet-stream'}));
                download.href = objectURL; download.download = opened.name.replace(/[\\/\x00-\x1f]/g, '_') || '解密文件'; download.hidden = false;
                if (opened.type.startsWith('text/') || /\.(txt|md|json|csv|log)$/i.test(opened.name)) {
                    if (opened.bytes.length <= 4 * 1024 * 1024) {
                        var pre = document.createElement('pre'); pre.className = 'text-content';
                        pre.textContent = new TextDecoder().decode(opened.bytes); preview.appendChild(pre);
                    } else { preview.textContent = '文字较大，请下载后打开。'; }
                } else if (safeMedia) {
                    var tag = opened.type.startsWith('image/') ? 'img' : opened.type.startsWith('audio/') ? 'audio' : opened.type.startsWith('video/') ? 'video' : 'iframe',
                        media = document.createElement(tag);
                    media.src = objectURL;
                    if (tag === 'iframe') { media.setAttribute('sandbox', ''); media.title = '解密后的 PDF'; media.style.height = '70vh'; }
                    if (tag === 'audio' || tag === 'video') { media.controls = true; }
                    media.style.maxWidth = '100%'; preview.appendChild(media);
                } else { preview.textContent = '此类型不提供在线预览，请下载解密后的文件。'; }
                document.getElementById('decrypted-panel').hidden = false;
                status.textContent = '已在当前浏览器解密：' + opened.name;
            } catch (error) { status.textContent = error.message; }
            finally { button.disabled = false; document.getElementById('decrypt-lock').disabled = false; }
        });
        document.getElementById('decrypt-lock').addEventListener('click', function () {
            clearPreview(); document.getElementById('decrypt-password').value = ''; status.textContent = '已锁定，请重新输入密码。';
        });
        window.addEventListener('pagehide', clearPreview);
    }
}());
