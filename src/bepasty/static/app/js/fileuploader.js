jqXHR = {};
$(function () {
    'use strict';

    // Keep the ordinary HTML form usable until enhanced uploads are supported.
    // The JSON metadata endpoint needs File API data, and large files need slicing.
    var fileInput = $('#fileupload');
    if (!fileInput.length || !('files' in fileInput[0]) ||
            typeof $.fn.fileupload !== 'function' || !window.File ||
            !$.support.xhrFileUpload || !$.support.xhrFormDataFileUpload || !$.support.blobSlice ||
            !window.JSON || typeof window.JSON.stringify !== 'function') {
        return;
    }

    var uploadForm = fileInput.closest('form'),
        uploads = [],
        totalProgress = $('#fileupload-progress').find('.progress-bar'),
        totalLabel = $('#fileupload-progress-label');
    if (!totalLabel.length) {
        totalLabel = $('<p id="fileupload-progress-label" role="status" aria-live="polite"/>')
            .insertAfter('#fileupload-progress');
    }
    totalProgress.attr({'role': 'progressbar', 'aria-label': '总上传进度',
        'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0});

    function humansize(size) {
        var suffix = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], tier = 0;
        while (size >= 1024 && tier < suffix.length - 1) {
            size = size / 1024;
            tier++;
        }
        return Math.round(size * 10) / 10 + ' ' + suffix[tier];
    }

    function percentage(loaded, total) {
        return total ? Math.min(100, Math.floor(loaded / total * 100)) : 0;
    }

    function updateTotals() {
        var loaded = 0, total = 0, active = 0, complete = 0, failed = 0, cancelled = 0, paused = 0, cancellable = 0;
        $.each(uploads, function (index, state) {
            loaded += state.loaded;
            total += state.file.size;
            active += state.active ? 1 : 0;
            complete += state.completed ? 1 : 0;
            failed += state.failed ? 1 : 0;
            cancelled += state.cancelled ? 1 : 0;
            paused += state.paused ? 1 : 0;
            cancellable += canCancel(state) ? 1 : 0;
        });
        var progress = percentage(loaded, total), summary;
        if (active) {
            summary = '上传中 ' + active + ' 个 · ' + progress + '%（' + humansize(loaded) + ' / ' + humansize(total) + '）';
        } else {
            summary = '已上传 ' + complete + ' 个';
            if (failed) {
                summary += ' · 失败 ' + failed + ' 个';
            }
            if (cancelled) {
                summary += ' · 取消 ' + cancelled + ' 个';
            }
            if (paused) {
                summary += ' · 暂停 ' + paused + ' 个';
            }
            if (complete === uploads.length) {
                progress = 100;
            }
        }
        $('#fileupload-progress').css('visibility', 'visible');
        totalProgress.css('width', progress + '%').text(progress + '%')
            .attr({'aria-valuenow': progress, 'aria-valuetext': summary});
        if (totalLabel.text() !== summary) {
            totalLabel.text(summary);
        }
        $('#fileupload-abort').css('visibility', cancellable ? 'visible' : 'hidden');
    }

    function setProgress(state, loaded, total, complete) {
        state.loaded = Math.min(state.file.size, loaded);
        var progress = complete ? 100 : percentage(loaded, total);
        state.progress.css('width', progress + '%').text(progress + '%')
            .attr({'aria-valuenow': progress, 'aria-valuetext': '已上传 ' + progress + '%'});
        if (state.phase === 'uploading' && progress === 100 && state.status.text() !== '正在完成…') {
            state.status.text('正在完成…');
        }
        updateTotals();
    }

    function requestError(xhr, textStatus, phase) {
        var code = xhr && xhr.status;
        if (textStatus === 'timeout') {
            return phase + '超时，请检查网络。';
        }
        if (!code) {
            return phase + '失败，无法连接服务器，请检查网络。';
        }
        if (code === 401 || code === 403) {
            return phase + '失败，服务器拒绝了请求（HTTP ' + code + '）。';
        }
        if (code === 413) {
            return phase + '失败，文件或分块超过大小限制（HTTP 413）。';
        }
        if (code === 404) {
            return phase + '失败，上传记录不存在或已过期（HTTP 404）。';
        }
        if (code === 409) {
            return phase + '暂停，上传进度已变化（HTTP 409）。';
        }
        if (code >= 500) {
            return phase + '失败，服务器暂时出错（HTTP ' + code + '）。';
        }
        if (textStatus === 'parsererror') {
            return phase + '失败，服务器响应异常。';
        }
        return phase + '失败（HTTP ' + code + '）。';
    }

    function cleanup(state) {
        // Preserve failed/paused uploads. Only an explicit cancellation removes
        // unfinished data; the server refuses to remove an already-complete file.
        if (state.cancelled && state.url && !state.completed && !state.cleanupRequested) {
            state.cleanupRequested = true;
            $.ajax({type: 'GET', url: state.url + '/abort'});
        }
    }

    function finishFailure(state, message, retryable) {
        if (state.completed || state.superseded || state.cancelled) {
            return;
        }
        state.attempt++;
        state.active = false;
        state.failed = true;
        state.paused = false;
        state.phase = 'failed';
        state.encryptionPassword = null;
        state.transfer = null;
        state.retryable = retryable;
        state.context.attr('class', 'alert alert-danger upload-item');
        state.status.text(message + (state.url ? ' 点“继续”重试。' : ''));
        updateControls(state);
        if (state.name) {
            delete jqXHR[state.name];
        }
        setProgress(state, state.confirmed, state.file.size, false);
    }

    function current(state, attempt) {
        return !state.completed && !state.cancelled && !state.superseded && state.attempt === attempt;
    }

    function canCancel(state) {
        return !state.completed && !state.cancelled && !state.superseded && (state.active || !!state.url);
    }

    function updateControls(state) {
        state.cancel.hide();
        state.pause.hide();
        state.resume.hide();
        state.retry.hide();
        state.controls.hide();
        if (canCancel(state)) {
            state.cancel.show();
        }
        if (state.phase === 'uploading') {
            state.pause.show();
        }
        if (!state.active && state.url && !state.cancelled && !state.completed && !state.superseded) {
            state.resume.show();
        }
        if (!state.active && !state.completed && (state.cancelled || (state.retryable && !state.url))) {
            state.retry.show();
        }
        if (canCancel(state) || state.phase === 'uploading' ||
                (!state.active && !state.completed && !state.superseded &&
                    (state.url || state.cancelled || state.retryable))) {
            state.controls.show();
        }
    }

    function pause(state) {
        if (state.phase !== 'uploading' || !state.active) {
            return;
        }
        var transfer = state.transfer;
        state.attempt++;
        state.active = false;
        state.failed = false;
        state.paused = true;
        state.phase = 'paused';
        state.transfer = null;
        state.context.attr('class', 'alert alert-secondary upload-item');
        state.status.text('已暂停，点“继续”接着上传。');
        delete jqXHR[state.name];
        updateControls(state);
        setProgress(state, state.confirmed, state.file.size, false);
        if (transfer) {
            transfer.abort();
        }
    }

    function cancel(state) {
        if (!canCancel(state)) {
            return;
        }
        var transfer = state.transfer;
        state.attempt++;
        state.cancelled = true;
        state.active = false;
        state.failed = false;
        state.paused = false;
        state.phase = 'cancelled';
        state.encryptionPassword = null;
        state.transfer = null;
        state.context.attr('class', 'alert alert-secondary upload-item');
        state.status.text('已取消');
        delete jqXHR[state.name];
        updateControls(state);
        setProgress(state, state.confirmed, state.file.size, false);
        if (transfer) {
            transfer.abort();
        }
        cleanup(state);
        // Leave metadata requests running. If creation succeeds after cancelling,
        // its success callback receives the item address and can clean it up.
    }

    function validOffset(offset, size) {
        return typeof offset === 'number' && isFinite(offset) && offset >= 0 && offset <= size && Math.floor(offset) === offset;
    }

    function startTransfer(state, offset) {
        var attempt = ++state.attempt;
        state.active = true;
        state.failed = false;
        state.paused = false;
        state.phase = 'uploading';
        state.confirmed = offset;
        state.context.attr('class', 'alert alert-processing upload-item');
        state.status.text(offset ? '继续上传…' : '上传中…');
        updateControls(state);
        setProgress(state, offset, state.file.size, false);
        // Each send needs fresh blueimp progress/Deferred state. The retained File
        // and URL stay the same; never reuse an aborted request's AJAX options.
        var data = {files: [state.file], url: state.url, context: state.context,
            uploadedBytes: offset, uploadState: state, uploadAttempt: attempt};
        try {
            // File selection replaces the input, including while metadata/GET
            // requests are pending, so always resolve the currently-live widget.
            var transfer;
            if (state.file.readEncrypted) {
                transfer = window.BepastyEncryption.send(state.file, {
                    url: state.url, offset: offset,
                    progress: function (loaded) { if (current(state, attempt) && state.phase === 'uploading') { setProgress(state, loaded, state.file.size, false); } },
                    chunk: function (end) { if (current(state, attempt) && state.phase === 'uploading') { state.confirmed = end; } },
                    done: function (result) { if (current(state, attempt) && state.phase === 'uploading') { renderDone(state, result); } },
                    fail: function (error) { if (current(state, attempt) && state.phase === 'uploading') {
                        finishFailure(state, error.message || requestError(error, 'error', '上传'), false);
                    } }
                });
            } else { transfer = $('#fileupload').fileupload('send', data); }
            if (current(state, attempt) && state.active) {
                state.transfer = transfer;
                jqXHR[state.name] = transfer;
            }
        } catch (error) {
            if (current(state, attempt)) {
                finishFailure(state, '无法开始上传。', false);
            }
        }
    }

    function resume(state) {
        if (state.active || !state.url || state.completed || state.cancelled || state.superseded) {
            return;
        }
        var attempt = ++state.attempt;
        state.active = true;
        state.failed = false;
        state.paused = false;
        state.phase = 'checking';
        state.status.text('正在确认进度…');
        state.context.attr('class', 'alert alert-processing upload-item');
        updateControls(state);
        updateTotals();
        $.ajax({type: 'GET', url: state.url, dataType: 'json', cache: false,
            success: function (result) {
                if (!current(state, attempt)) {
                    return;
                }
                var offset = result && result.uploaded_bytes;
                if (!result || result.name !== state.name || result.size !== state.file.size ||
                        typeof result.complete !== 'boolean' || !validOffset(offset, state.file.size) ||
                        (result.complete && offset !== state.file.size) ||
                        (!result.complete && state.file.size > 0 && offset === state.file.size)) {
                    finishFailure(state, '服务器返回的上传进度异常。', false);
                    return;
                }
                state.confirmed = offset;
                if (result.complete) {
                    renderDone(state, result);
                } else {
                    // For an untouched empty file, 0/0 with complete=false still
                    // requires a normal zero-byte POST to finalize the item.
                    startTransfer(state, offset);
                }
            },
            error: function (xhr, textStatus) {
                if (current(state, attempt)) {
                    finishFailure(state, requestError(xhr, textStatus, '确认进度'), false);
                }
            }
        });
    }

    function renderDone(state, result) {
        var file = result && result.files && result.files[0];
        if (state.completed || state.cancelled || state.superseded) {
            return;
        }
        if (!file || typeof file.url !== 'string' || !file.url || file.name !== state.name ||
                file.size !== state.file.size || result.complete === false ||
                (result.name !== undefined && result.name !== state.name) ||
                (result.size !== undefined && result.size !== state.file.size)) {
            finishFailure(state, '服务器返回的上传结果异常。', false);
            return;
        }
        state.completed = true;
        // Finished rows retain metadata only, not the file, key or record cache.
        if (state.file.readEncrypted) { delete state.file.readEncrypted; }
        state.active = false;
        state.failed = false;
        state.paused = false;
        state.phase = 'complete';
        state.confirmed = state.file.size;
        state.transfer = null;
        state.context.attr('class', 'alert alert-success upload-item');
        state.status.text('上传完成');
        updateControls(state);
        setProgress(state, state.file.size, state.file.size, true);
        state.progressContainer.hide();
        var openLink = $('<a class="btn btn-outline-secondary" target="_blank" rel="noopener"/>')
            .prop('href', file.url).text('打开'),
            shareUrl = openLink.prop('href'),
            share = $('<div class="share-link"/>').appendTo(state.context),
            links = $('<div class="share-link-controls"/>').appendTo(share);
        $('<input type="text" class="form-control" readonly/>').val(shareUrl)
            .attr('aria-label', state.file.name + '的分享链接').appendTo(links);
        $('<button type="button" class="copy-link btn btn-primary"/>')
            .text('复制链接').appendTo(links);
        openLink.appendTo(links);
        $('<a class="btn btn-outline-secondary"/>').prop('href', shareUrl.split('#')[0].replace(/\/$/, '') + '/+download')
            .text('下载').appendTo(links);
        $('<small class="share-status" role="status" aria-live="polite"/>').appendTo(share);
        if (typeof qrcode === 'function') {
            try {
                var qr, version;
                // This bundled QR library requires an explicit version.
                for (version = 1; version <= 40; version++) {
                    try {
                        qr = qrcode(version, 'M');
                        // No filename fragment: stable after async rename.
                        qr.addData(shareUrl.split('#')[0]);
                        qr.make();
                        break;
                    } catch (overflow) {
                        if (version === 40) { throw overflow; }
                    }
                }
                var qrBox = $('<div class="upload-qr" aria-label="分享二维码"/>').appendTo(share);
                qrBox.html(qr.createSvgTag(4, 16));
                qrBox.find('svg').attr('role', 'img').attr('aria-label', '扫码打开分享');
            } catch (error) {
                $('<p class="text-muted"/>').text('二维码生成失败，仍可复制链接。').appendTo(share);
            }
        }
        if (file.title_pending && file.status_url) {
            state.status.text('上传完成 · Qwen 正在生成标题…');
            var polls = 0;
            function refreshTitle() {
                $.ajax({url: file.status_url, dataType: 'json', cache: false}).done(function (result) {
                    var updated = result.files && result.files[0];
                    if (!updated) { return; }
                    state.context.find('.upload-item-heading strong').text(updated.filename).attr('title', updated.filename);
                    if (updated.title_pending && ++polls < 90) {
                        window.setTimeout(refreshTitle, 2000);
                    } else {
                        state.status.text(updated.title_pending ? '上传完成 · 标题稍后可在列表查看' : '上传完成');
                    }
                }).fail(function () {
                    state.status.text('上传完成 · 标题稍后可在列表查看');
                });
            }
            window.setTimeout(refreshTitle, 2000);
        }
        var filelist = $('#filelist');
        if (!state.isCollection) {
            filelist.val(filelist.val() + file.name + '\n');
        }
        delete jqXHR[state.name];
        var completed = 0;
        $.each(uploads, function (index, upload) {
            completed += upload.completed && !upload.isCollection ? 1 : 0;
        });
        if (completed >= 2) {
            $('#filelist-count').text(completed + ' 项');
            $('#filelist-form').show();
        }
        if (window.BepastyWorkspace) {
            window.BepastyWorkspace.changed(state.context);
        }
    }

    function createState(data) {
        var previous = data.retryState,
            preset = uploadForm.find('[name=maxlife-preset]').val(),
            lifetime = preset ? preset.split(':') : null,
            context = previous ? previous.context.empty() : $('<div class="alert alert-processing upload-item"/>').appendTo('#files'),
            state = {context: context, file: data.files[0], active: true, loaded: 0, confirmed: 0, attempt: 0, phase: 'preparing',
                isCollection: !!data.isCollection,
                maxlife: data.maxlife || {
                    unit: lifetime ? lifetime[0] : uploadForm.find('[name=maxlife-unit]').val(),
                    value: lifetime ? lifetime[1] : uploadForm.find('[name=maxlife-value]').val()
                }};
        if (previous) {
            previous.superseded = true;
        }
        context.attr('class', 'alert alert-processing upload-item');
        var main = $('<div class="upload-main"/>').appendTo(context),
            info = $('<div class="upload-info"/>').appendTo(main);
        $('<p class="upload-item-heading"/>').append($('<strong/>').text(state.file.name).attr('title', state.file.name))
            .append($('<span class="break-word"/>').text(' · ' + humansize(state.file.size)))
            .appendTo(info);
        state.status = $('<p class="upload-status" role="status" aria-live="polite"/>')
            .text('准备上传…').appendTo(info);
        state.progressContainer = $('<div class="progress mb-2"/>').appendTo(info);
        state.progress = $('<div class="progress-bar" role="progressbar"/>')
            .attr({'aria-label': state.file.name + '的上传进度',
                'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0})
            .css('width', '0%').text('0%').appendTo(state.progressContainer);
        state.controls = $('<div class="upload-actions"/>').appendTo(main);
        state.pause = $('<button type="button" class="btn btn-outline-secondary upload-pause"/>')
            .text('暂停').hide().appendTo(state.controls).click(function () { pause(state); });
        state.resume = $('<button type="button" class="btn btn-primary upload-resume" title="从已保存的进度继续上传"/>')
            .text('继续').hide().appendTo(state.controls).click(function () { resume(state); });
        state.retry = $('<button type="button" class="btn btn-primary upload-retry" title="重新上传这个文件"/>')
            .text('重试').hide().appendTo(state.controls).click(function () {
                if (!state.active && !state.completed && (state.cancelled || (state.retryable && !state.url))) {
                    // A fresh add creates fresh blueimp process/Deferred state and
                    // a new server item; never reuse a failed or completed URL.
                    // blueimp replaces the file input after each selection and
                    // removes the old node's widget data. Resolve the live input.
                    $('#fileupload').fileupload('add', {files: [state.file], maxlife: state.maxlife, retryState: state});
                }
            });
        state.cancel = $('<button type="button" class="fileupload-abort btn btn-danger"/>')
            .text('取消').appendTo(state.controls).click(function () { cancel(state); });
        if (previous) {
            $.each(uploads, function (index, existing) {
                if (existing === previous) {
                    uploads[index] = state;
                }
            });
        } else {
            uploads.push(state);
        }
        data.context = context;
        data.uploadState = state;
        updateTotals();
        if (window.BepastyWorkspace) {
            window.BepastyWorkspace.added(context);
        }
        return state;
    }

    // Text and collection forms use the same aligned result rows. A collection
    // never includes its own ID in the next collection's source list.
    window.BepastyUploads = {
        addEncrypted: function (file, preset) {
            var parts = preset.split(':');
            $('#fileupload').fileupload('add', {files: [file], encryptionPrepared: true,
                maxlife: {unit: parts[0], value: parts[1]}});
        },
        addComplete: function (result, isCollection) {
            var file = result && result.files && result.files[0];
            if (!file || typeof file.filename !== 'string' || typeof file.name !== 'string' ||
                    typeof file.url !== 'string' || !file.url || !validOffset(file.size, file.size) ||
                    result.complete !== true || file.name !== result.name || file.size !== result.size) {
                return false;
            }
            var exists = false;
            $.each(uploads, function (index, upload) {
                exists = exists || (upload.name === file.name && upload.completed);
            });
            if (exists) {
                return true;
            }
            var state = createState({files: [{name: file.filename, size: file.size}], isCollection: isCollection});
            state.name = file.name;
            renderDone(state, result);
            return state.completed;
        }
    };

    fileInput.fileupload({
        dataType: 'json',
        autoUpload: true,
        singleFileUploads: true,
        // Metadata is sent separately; do not resend pasted text with each chunk.
        formData: [],
        maxChunkSize: MAX_BODY_SIZE,
        maxFileSize: MAX_ALLOWED_FILE_SIZE === null ? undefined : MAX_ALLOWED_FILE_SIZE,
        messages: {
            maxNumberOfFiles: '文件数量超过限制',
            acceptFileTypes: '不支持这种文件类型',
            maxFileSize: '文件超过大小限制',
            minFileSize: '文件太小',
            uploadedBytes: '续传位置超过文件大小'
        }
    })
        .on('fileuploadadd', function (e, data) {
            // This runs before the plugin's default validation and auto-submit.
            var state = createState(data);
            state.encryptionEnabled = data.retryState ? data.retryState.encryptionEnabled : !!$('#encrypt-enabled').prop('checked');
            state.encrypted = !!data.encryptionPrepared || !!(data.retryState && data.retryState.encrypted);
            state.encryptionPassword = state.encryptionEnabled && !state.encrypted ? $('#encrypt-password').val() : null;
        })
        .on('fileuploadsubmit', function (e, data) {
            var state = data.uploadState || createState(data), file = state.file;
            if (state.cancelled) {
                return false;
            }
            function uploadPrepared() {
                file = state.file;
                $.ajax({
                    type: 'POST',
                    url: UPLOAD_NEW_URL,
                    data: JSON.stringify({filename: file.name, size: file.size, type: file.type,
                        maxlife_unit: state.maxlife.unit, maxlife_value: state.maxlife.value}),
                    contentType: 'application/json',
                    success: function (result) {
                        if (!result || !result.url || !result.name) {
                            finishFailure(state, '服务器未返回上传地址，请重试。', true);
                            return;
                        }
                        state.url = data.url = result.url;
                        state.name = result.name;
                        if (state.cancelled) {
                            cleanup(state);
                            return;
                        }
                        if (!state.superseded) {
                            startTransfer(state, 0);
                        }
                    },
                    error: function (xhr, textStatus) {
                        finishFailure(state, requestError(xhr, textStatus, '准备上传'), true);
                    }
                });
            }
            if (state.encryptionEnabled && !state.encrypted) {
                if (!window.BepastyEncryption) {
                    finishFailure(state, '加密组件未加载，请刷新页面后重试。', true);
                    return false;
                }
                state.status.text('正在本地加密…');
                window.BepastyEncryption.prepare(file, state.encryptionPassword).then(function (sealed) {
                    state.encryptionPassword = null;
                    if (state.cancelled || state.superseded) { return; }
                    state.file = data.files[0] = sealed;
                    state.encrypted = true;
                    state.status.text('正在上传密文…');
                    uploadPrepared();
                }, function (error) {
                    state.encryptionPassword = null;
                    finishFailure(state, error.message || '加密失败，请重试。', true);
                });
            } else { uploadPrepared(); }
            return false;
        })
        .on('fileuploaddone', function (e, data) {
            var state = data.uploadState;
            if (state && current(state, data.uploadAttempt) && state.phase === 'uploading') {
                renderDone(state, data.result);
            }
        })
        .on('fileuploadfail', function (e, data) {
            var state = data.uploadState;
            if (!state || !current(state, data.uploadAttempt) || state.phase !== 'uploading') {
                return;
            }
            finishFailure(state, requestError(data.jqXHR, data.textStatus, '上传'), false);
        })
        .on('fileuploadprogress', function (e, data) {
            var state = data.uploadState;
            if (state && current(state, data.uploadAttempt) && state.phase === 'uploading') {
                setProgress(state, data.loaded, data.total, false);
            }
        })
        .on('fileuploadchunkdone', function (e, data) {
            var state = data.uploadState,
                offset = data.result && data.result.uploaded_bytes;
            if (!state || !current(state, data.uploadAttempt) || state.phase !== 'uploading') {
                return;
            }
            if (data.result && ((data.result.name !== undefined && data.result.name !== state.name) ||
                    (data.result.size !== undefined && data.result.size !== state.file.size))) {
                return;
            }
            if (offset === undefined) {
                offset = data.uploadedBytes;
            }
            if (validOffset(offset, state.file.size)) {
                state.confirmed = Math.max(state.confirmed, offset);
            }
        })
        .on('fileuploadprocessfail', function (e, data) {
            var state = data.uploadState || createState(data), file = data.files[data.index || 0];
            finishFailure(state, file.error || '无法准备这个文件。', false);
        });

    fileInput.prop('multiple', true);
    $('#fileupload-label').text('选择文件');
    $('#fileupload-help').text('支持拖拽 · 选好即上传 · 可暂停和继续');
    $('#fileupload-submit').hide();
    $('#fileupload-abort').text('全部取消').click(function () {
        var cancelAll = function (confirmed) {
            if (confirmed) {
                $.each(uploads, function (index, state) { cancel(state); });
            }
        };
        if (window.bootbox && typeof window.bootbox.confirm === 'function') {
            window.bootbox.confirm({
                message: '取消所有未完成的上传？',
                buttons: {
                    cancel: {label: '保留上传', className: 'btn-outline-secondary'},
                    confirm: {label: '全部取消', className: 'btn-danger'}
                },
                callback: cancelAll
            });
        } else {
            cancelAll(window.confirm('取消所有未完成的上传？'));
        }
    });
});
