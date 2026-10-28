// One-click copy of file content: text as text, images as PNG.
(function () {
    'use strict';

    function fetchBlob(src) {
        return fetch(src, {credentials: 'same-origin'}).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.blob();
        });
    }

    function toPng(blob) {
        if (blob.type === 'image/png') {
            return Promise.resolve(blob);
        }
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () {
                var canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || 1;
                canvas.height = img.naturalHeight || 1;
                canvas.getContext('2d').drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                canvas.toBlob(function (png) {
                    if (png) { resolve(png); } else { reject(new Error('PNG')); }
                }, 'image/png');
            };
            img.onerror = function () {
                URL.revokeObjectURL(url);
                reject(new Error('image'));
            };
            img.src = url;
        });
    }

    function textBlob(blob) {
        return blob.text().then(function (text) {
            return new Blob([text], {type: 'text/plain'});
        });
    }

    function copyByTextarea(text) {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, text.length);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
        document.body.removeChild(area);
        if (!ok) {
            throw new Error('execCommand');
        }
    }

    function copyContent(src, kind) {
        var blob = fetchBlob(src);
        var clip = navigator.clipboard;
        // Safari needs ClipboardItem created inside the click, with a pending blob.
        if (window.ClipboardItem && clip && typeof clip.write === 'function') {
            var data = {};
            if (kind === 'image') {
                data['image/png'] = blob.then(toPng);
            } else {
                data['text/plain'] = blob.then(textBlob);
            }
            return clip.write([new ClipboardItem(data)]).catch(function (error) {
                if (kind === 'image') { throw error; }
                return blob.then(function (b) { return b.text(); }).then(copyByTextarea);
            });
        }
        if (kind === 'image') {
            return Promise.reject(new Error('unsupported'));
        }
        return blob.then(function (b) { return b.text(); }).then(function (text) {
            if (clip && typeof clip.writeText === 'function') {
                return clip.writeText(text).catch(function () { copyByTextarea(text); });
            }
            copyByTextarea(text);
        });
    }

    document.addEventListener('click', function (event) {
        var button = event.target.closest ? event.target.closest('.copy-content') : null;
        if (!button || button.disabled) {
            return;
        }
        var label = '复制内容';
        function setLabel(text) {
            (button.querySelector('.action-label') || button).textContent = text;
            button.setAttribute('aria-label', text);
            button.setAttribute('title', text);
        }
        button.disabled = true;
        setLabel('复制中…');
        copyContent(button.getAttribute('data-copy-src'), button.getAttribute('data-copy-kind')).then(function () {
            setLabel('已复制');
        }, function () {
            setLabel(window.isSecureContext ? '复制失败' : '需 https');
        }).then(function () {
            button.disabled = false;
            setTimeout(function () { setLabel(label); }, 2000);
        });
    });
}());
