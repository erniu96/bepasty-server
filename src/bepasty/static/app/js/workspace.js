/* A small, optional workspace. Native links and forms remain the fallback. */
$(function () {
    'use strict';
    var root = $('#workspace'), uploads = window.BepastyUploads,
        style = document.documentElement.style;
    if (!root.length || !uploads || typeof uploads.addComplete !== 'function' ||
            !('flex' in style)) {
        return;
    }
    var page = 'upload', listLoaded = false, listRequest = null, generation = 0,
        listLink = $('.primary-nav [data-workspace-page=list]'),
        queue = $('#files'), results = $('.upload-results'), batch = [],
        maxlifeKey = 'bepasty.maxlife-preset';

    function storage(key, value) {
        // Private windows and blocked site data may throw; the default still works.
        try {
            if (value === undefined) {
                return window.localStorage.getItem(key);
            }
            window.localStorage.setItem(key, value);
        } catch (error) {
            return null;
        }
        return null;
    }

    // One retention control for files, text and collections.
    function setupMaxlife() {
        var shared = $('#shared-maxlife'), source = $('#upload-maxlife-preset'),
            selects = root.find('select[name=maxlife-preset]');
        if (!shared.length || !source.length) {
            return;
        }
        shared.html(source.html());
        var saved = storage(maxlifeKey);
        if (saved && shared.find('option').filter(function () { return this.value === saved; }).length) {
            shared.val(saved);
        } else {
            shared.val(source.val());
        }
        function sync() {
            selects.val(shared.val());
        }
        shared.on('change', function () {
            sync();
            storage(maxlifeKey, shared.val());
        });
        sync();
        $('.shared-maxlife').prop('hidden', false);
    }

    function filterList() {
        var query = $('#library-search').val().toLowerCase(), matched = 0;
        var favorites = $('#library-filter').val() === 'favorites';
        $('#library-content .file-row').each(function () {
            var row = $(this);
            var match = (!favorites || row.attr('data-permanent') === 'true') &&
                row.find('.file-row-name').text().toLowerCase().indexOf(query) !== -1;
            row.toggle(match);
            matched += match ? 1 : 0;
        });
        var total = $('#library-content .file-row').length;
        $('#library-content .library-count').text(query || favorites ?
            '匹配 ' + matched + ' 项 / 共 ' + total + ' 项' :
            total + ' 项 · 最近上传的在前');
        $('#library-search-feedback').text(!matched && (query || favorites) ? '没有符合筛选条件的内容。' : '');
    }

    function loadList() {
        if (listRequest || !listLink.length) {
            return;
        }
        $('#library-refresh').prop('disabled', true);
        $('#library-feedback').text('正在载入…');
        var requestedGeneration = generation;
        listRequest = $.ajax({
            url: listLink.attr('href'), data: {fragment: '1'}, dataType: 'html', cache: false,
            success: function (html) {
                // The server returns only its escaped file cards, never a page
                // shell or scripts. Keep ongoing uploads in their original DOM.
                $('#library-content').html(html);
                $('#library-content .share-link input').each(function () {
                    var input = $(this);
                    input.val($('<a/>').prop('href', input.val()).prop('href'));
                });
                $('#library-content .copy-link').show();
                listLoaded = requestedGeneration === generation;
                filterList();
                $('#library-feedback').text('');
            },
            error: function () {
                $('#library-feedback').text('无法载入列表，点“刷新”重试。');
            },
            complete: function () {
                listRequest = null;
                $('#library-refresh').prop('disabled', false);
            }
        });
    }

    function selectPage(next) {
        page = next === 'list' && listLink.length ? 'list' : 'upload';
        document.title = (page === 'list' ? '文件列表' : '上传') + ' · Bepasty';
        $('#upload-view').toggle(page === 'upload');
        $('#library-view').toggle(page === 'list');
        $('.primary-nav [data-workspace-page]').each(function () {
            var link = $(this), active = link.attr('data-workspace-page') === page;
            link.toggleClass('btn-primary', active).toggleClass('btn-outline-secondary', !active);
            if (active) {
                link.attr('aria-current', 'page');
            } else {
                link.removeAttr('aria-current');
            }
        });
        if (page === 'list' && !listLoaded) {
            loadList();
        }
    }

    function showHash() {
        var initialList = !window.location.hash && $('body').hasClass('library-entry');
        selectPage(window.location.hash === '#list' || initialList ? 'list' : 'upload');
        if (page === 'upload' && window.location.hash === '#text') {
            $('#formupload').focus();
        }
    }

    function go(next) {
        var hash = next === 'list' ? '#list' : '#upload';
        if (window.location.hash !== hash) {
            window.location.hash = hash;
        }
        selectPage(next);
    }

    function submitForm(form, isCollection) {
        if (!isCollection && $('#encrypt-enabled').prop('checked')) {
            if (window.BepastyEncryption) { window.BepastyEncryption.submitText(form); }
            else { form.find('.form-feedback').text('加密组件未加载，请刷新页面后重试。'); }
            return;
        }
        if (form.data('submitting')) {
            return;
        }
        var button = form.find('[type=submit]'), original = button.text(),
            feedback = form.find('.form-feedback');
        form.data('submitting', true);
        button.prop('disabled', true).text('正在生成…');
        feedback.text('');
        $.ajax({
            type: 'POST', url: form.attr('action'), data: form.serialize(),
            dataType: 'json', headers: {Accept: 'application/json'},
            success: function (result) {
                if (!uploads.addComplete(result, isCollection)) {
                    feedback.text('服务器返回的分享结果异常，请查看列表确认。');
                } else if (!isCollection) {
                    // Ready for the next paste; the shared link is in the results.
                    form.find('textarea, #filename').val('');
                }
            },
            error: function (xhr) {
                feedback.text(xhr.status === 413 ? '内容超过服务器大小限制，请调整后重试。' :
                    '生成链接失败，内容已保留。请检查网络；重试前可在列表确认是否已生成。');
            },
            complete: function () {
                form.data('submitting', false);
                button.prop('disabled', false).text(original);
            }
        });
    }

    function writeClipboard(text) {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            return null;
        }
        try {
            return navigator.clipboard.writeText(text);
        } catch (error) {
            return null;
        }
    }

    // Copy a single finished share at once. Browsers that need a fresh click
    // simply refuse, and the visible "复制链接" button remains.
    function autoCopy(context) {
        var input = context.find('.share-link input'), button = context.find('.copy-link'),
            status = context.find('.share-status'), writing = writeClipboard(input.val());
        if (writing && typeof writing.then === 'function') {
            writing.then(function () {
                queue.find('.share-status').not(status).text('');
                button.text('已复制');
                status.text('链接已自动复制，可以直接粘贴。');
                window.setTimeout(function () { button.text('复制链接'); }, 2500);
            }, function () {});
        }
    }

    function enhanceResult(context) {
        var share = context.find('.share-link'), qr = share.find('.upload-qr');
        if (!share.length || share.data('enhanced')) {
            return;
        }
        share.data('enhanced', true);
        if (qr.length) {
            $('<button type="button" class="btn btn-outline-secondary qr-toggle" aria-expanded="false"/>')
                .text('二维码').appendTo(share.find('.share-link-controls'))
                .on('click', function () {
                    var open = !share.hasClass('qr-open');
                    share.toggleClass('qr-open', open);
                    $(this).attr('aria-expanded', open ? 'true' : 'false');
                });
        }
    }

    function processing() {
        return queue.children('.alert-processing').length;
    }

    window.BepastyWorkspace = {
        added: function (context) {
            // A batch is everything selected while earlier uploads still run.
            if (!queue.children('.alert-processing').not(context).length) {
                batch = [];
            }
            if (context && $.inArray(context[0], batch) === -1) {
                batch.push(context[0]);
            }
            results.removeClass('is-empty');
            // New selections, including drops while looking at the library,
            // return to the queue without destroying either view.
            go('upload');
            if (context && context[0] && context[0].scrollIntoView) {
                window.setTimeout(function () {
                    context[0].scrollIntoView({block: 'nearest', behavior: 'smooth'});
                }, 0);
            }
        },
        changed: function (context) {
            generation++;
            listLoaded = false;
            if (!context) {
                return;
            }
            enhanceResult(context);
            if (context.hasClass('alert-success') && !processing()) {
                if (batch.length === 1 && batch[0] === context[0]) {
                    autoCopy(context);
                }
                batch = [];
            }
        }
    };

    function pastedFiles(event) {
        var data = event.originalEvent && event.originalEvent.clipboardData, files = [];
        if (!data) {
            return files;
        }
        if (data.files && data.files.length) {
            files = $.makeArray(data.files);
        } else if (data.items) {
            $.each(data.items, function (index, item) {
                var file = item.kind === 'file' && item.getAsFile();
                if (file) {
                    files.push(file);
                }
            });
        }
        return $.map(files, function (file) {
            // Screenshots arrive as "image.png"; give each a distinct name.
            if (/^image\.\w+$/.test(file.name || '') && window.File) {
                var now = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; },
                    stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
                        pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
                try {
                    return new File([file], '截图-' + stamp + file.name.replace(/^image/, ''), {type: file.type});
                } catch (error) {
                    return file;
                }
            }
            return file;
        });
    }

    $(document).on('paste', function (event) {
        var data = event.originalEvent && event.originalEvent.clipboardData,
            text = data && data.getData && data.getData('text/plain'),
            inField = $(event.target).is('input, textarea, select, [contenteditable]');
        // Office apps put a picture next to copied text; text wins there.
        if (!text) {
            var files = pastedFiles(event);
            if (files.length) {
                event.preventDefault();
                $('#fileupload').fileupload('add', {files: files});
            }
            return;
        }
        // Plain text pasted outside any field goes into the text composer.
        if (page === 'upload' && !inField) {
            event.preventDefault();
            var area = $('#formupload');
            area.val(area.val() + text).focus();
            area[0].setSelectionRange(area.val().length, area.val().length);
        }
    });

    $('#formupload').on('keydown', function (event) {
        if (event.keyCode === 13 && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            $('#text-form').submit();
        }
    });

    $('#library-content').on('expiry:updated', function () {
        generation++;
        filterList();
    });

    // Library: rename in place and delete without leaving the page.
    $('#library-content').on('click', '.rename-link', function (event) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        event.preventDefault();
        var row = $(this).closest('.file-row'), heading = row.find('.file-row-name'),
            link = heading.find('a'), url = $(this).attr('href'), original = link.text();
        if (row.hasClass('renaming')) {
            heading.find('input').focus();
            return;
        }
        row.addClass('renaming');
        var input = $('<input type="text" class="form-control rename-input" autocapitalize="off" spellcheck="false"/>')
            .attr('aria-label', '新文件名').val(original);
        link.hide().after(input);
        input.focus();
        var dot = original.lastIndexOf('.');
        input[0].setSelectionRange(0, dot > 0 ? dot : original.length);
        function finish() {
            input.remove();
            link.show();
            row.removeClass('renaming');
        }
        function save() {
            var name = $.trim(input.val());
            if (!name || name === original) {
                finish();
                return;
            }
            input.prop('disabled', true);
            $.ajax({url: url, type: 'POST', data: {filename: name}, dataType: 'json',
                headers: {Accept: 'application/json'}})
                .done(function (result) {
                    link.text(result.filename).attr('title', result.filename);
                    generation++;
                }).fail(function () {
                    $('#library-feedback').text('重命名失败，请重试。');
                }).always(finish);
        }
        input.on('keydown', function (e) {
            if (e.keyCode === 13) {
                e.preventDefault();
                save();
            } else if (e.keyCode === 27) {
                finish();
            }
        }).on('blur', save);
    });
    $('#library-content').on('submit', '.delete-form', function (event) {
        event.preventDefault();
        var form = $(this), row = form.closest('.file-row'),
            name = $.trim(row.find('.file-row-name').text());
        if (!window.confirm('删除“' + name + '”？分享链接会立即失效。')) {
            return;
        }
        form.find('button').prop('disabled', true);
        $.ajax({url: form.attr('action'), type: 'POST', data: form.serialize()})
            .done(function () {
                row.remove();
                generation++;
                filterList();
            }).fail(function () {
                form.find('button').prop('disabled', false);
                $('#library-feedback').text('删除失败，请刷新后重试。');
            });
    });

    $('body').addClass('workspace-enabled');
    $('#fileupload-label').text('选择文件，或拖到这里');
    $('#fileupload-help').text('可多选 · 也能直接粘贴截图 · 选好即上传');
    setupMaxlife();
    $('.primary-nav [data-workspace-page], .site-brand').on('click', function (event) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        event.preventDefault();
        go($(this).attr('data-workspace-page') || 'upload');
    });
    $('#library-content').on('click', 'a', function (event) {
        // Keep the uploader alive when opening file details or editing a name.
        var link = $(this), href = link.attr('href');
        if (href === $('.primary-nav [data-workspace-page=upload]').attr('href')) {
            event.preventDefault();
            go('upload');
        }
    });
    $('#library-search').on('input keyup', filterList);
    $('#library-filter').on('change', filterList);
    $('#library-refresh').on('click', loadList);
    $(document).on('keydown', function (event) {
        if (event.key === '/' && page === 'list' && !$(event.target).is('input, textarea, select')) {
            event.preventDefault();
            $('#library-search').focus();
        }
    });
    $('#text-form').on('submit', function (event) {
        event.preventDefault();
        submitForm($(this), false);
    });
    $('#filelist-form').on('submit', function (event) {
        event.preventDefault();
        submitForm($(this), true);
    });
    $(window).on('hashchange', showHash);

    // The blueimp drop handler accepts files on the whole document. Highlight
    // the drop target without relying on dragleave firing for every child.
    var dragDepth = 0;
    $(document).on('dragenter', function (event) {
        var transfer = event.originalEvent && event.originalEvent.dataTransfer;
        if (transfer && transfer.types && $.inArray('Files', transfer.types) !== -1) {
            dragDepth++;
            root.addClass('drag-active');
        }
    }).on('dragleave', function () {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) {
            root.removeClass('drag-active');
        }
    }).on('drop dragend', function () {
        dragDepth = 0;
        root.removeClass('drag-active');
    });
    showHash();
});
