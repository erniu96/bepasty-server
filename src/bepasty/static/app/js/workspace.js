/* A small, optional workspace. Native links and forms remain the fallback. */
$(function () {
    'use strict';
    var root = $('#workspace'), uploads = window.BepastyUploads,
        style = document.documentElement.style;
    if (!root.length || !uploads || typeof uploads.addComplete !== 'function' ||
            !('flex' in style)) {
        return;
    }
    var mode = 'file', page = 'upload', listLoaded = false, listRequest = null, generation = 0,
        listLink = $('.primary-nav [data-workspace-page=list]'),
        queue = $('#files'), empty = $('#upload-empty');

    function selectMode(next) {
        mode = next === 'text' ? 'text' : 'file';
        // Both composers stay expanded; old #text links remain compatible.
        $('#file-composer, #text-composer').show();
        empty.find('p').text(mode === 'text' ? '粘贴文字，生成分享链接' : '选择文件，或直接拖到这里');
        empty.find('small').text(mode === 'text' ? '生成后，在这里复制链接' : '上传完成后，在这里复制链接');
        $('[data-upload-mode]').each(function () {
            var button = $(this), active = button.attr('data-upload-mode') === mode;
            button.toggleClass('btn-primary', active).toggleClass('btn-outline-secondary', !active)
                .attr('aria-pressed', active ? 'true' : 'false');
        });
    }

    function filterList() {
        var query = $('#library-search').val().toLowerCase(), matched = 0;
        $('#library-content .file-row').each(function () {
            var row = $(this);
            var match = row.find('.file-row-name').text().toLowerCase().indexOf(query) !== -1;
            row.toggle(match);
            matched += match ? 1 : 0;
        });
        var total = $('#library-content .file-row').length;
        $('#library-content .library-count').text(query ?
            '匹配 ' + matched + ' 项 / 共 ' + total + ' 项' :
            total + ' 项 · 最近上传的在前');
        $('#library-search-feedback').text(query && !matched ? '没有匹配的文件，请换个关键词。' : '');
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
        if (page === 'upload') {
            selectMode(window.location.hash === '#text' ? 'text' : 'file');
        }
    }

    function go(next) {
        var hash = next === 'list' ? '#list' : mode === 'text' ? '#text' : '#upload';
        if (window.location.hash !== hash) {
            window.location.hash = hash;
        }
        selectPage(next);
    }

    function submitForm(form, isCollection) {
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

    window.BepastyWorkspace = {
        added: function () {
            empty.hide();
            // New selections, including drops while looking at the library,
            // return to the queue without destroying either view.
            go('upload');
            queue[0].scrollTop = queue[0].scrollHeight;
        },
        changed: function (context) {
            generation++;
            listLoaded = false;
            // The final link controls increase the new row's height. Position
            // after rendering them, without jumping to older completed files.
            if (page === 'upload' && context && context[0] === queue.children().last()[0]) {
                queue[0].scrollTop = queue[0].scrollHeight;
            }
        }
    };

    $('body').addClass('workspace-enabled');
    $('.upload-mode-nav').hide();
    $('[data-upload-mode]').on('click', function () {
        selectMode($(this).attr('data-upload-mode'));
        go('upload');
    });
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
    $('#library-refresh').on('click', loadList);
    $('#text-form').on('submit', function (event) {
        event.preventDefault();
        submitForm($(this), false);
    });
    $('#filelist-form').on('submit', function (event) {
        event.preventDefault();
        submitForm($(this), true);
    });
    $(window).on('hashchange', showHash);
    function sizeWorkspace() {
        // Old mobile Safari needs innerHeight; new Safari also reports the
        // visible height when its keyboard or browser chrome changes.
        var height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        $('#main-content').css('height', Math.max(0, height - $('#header').outerHeight()) + 'px');
    }
    $(window).on('resize orientationchange', sizeWorkspace);
    if (window.visualViewport && window.visualViewport.addEventListener) {
        window.visualViewport.addEventListener('resize', sizeWorkspace);
    }

    // The blueimp drop handler accepts files on the whole document. Highlight
    // the queue without relying on dragleave firing for every child element.
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
    sizeWorkspace();
});
