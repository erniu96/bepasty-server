$(function () {
    'use strict';
    var root = $('#detail-workspace');
    if (!root.length || !('flex' in document.documentElement.style)) {
        return;
    }
    var currentView;
    var returnView;
    function select(view) {
        currentView = view;
        $('[data-detail-panel]').each(function () {
            $(this).toggle($(this).attr('data-detail-panel') === view);
        });
        $('[data-detail-view]').each(function () {
            var active = $(this).attr('data-detail-view') === view;
            $(this).toggleClass('btn-primary', active).toggleClass('btn-outline-secondary', !active)
                .attr('aria-pressed', active ? 'true' : 'false');
        });
    }
    function resize() {
        var height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        $('#main-content').css('height', Math.max(0, height - $('#header').outerHeight()) + 'px');
    }
    $('body').addClass('detail-enabled');
    root.find('.data > img, .data > video').closest('.file-preview').addClass('visual-preview');
    $('.detail-tabs').show();
    $('[data-detail-view]').on('click', function () {
        select($(this).attr('data-detail-view'));
    });
    select($('[data-detail-panel=preview]').length ? 'preview' : 'info');
    $(document).on('submit', '#del-frm, .delete-form', function (event) {
        if (!window.confirm('删除这个文件？分享链接会立即失效。')) {
            event.preventDefault();
        }
    });
    var storedType = $('#contenttype').val();
    var saving = false;
    $('#modify-frm').on('submit', function (event) {
        event.preventDefault();
        if (saving) {
            return;
        }
        saving = true;
        var form = $(this);
        var button = form.find('button[type=submit]');
        var status = $('#detail-save-status');
        button.prop('disabled', true).text('正在保存…');
        status.text('');
        $.ajax({url: form.attr('action'), type: 'POST', data: form.serialize(),
            dataType: 'json', headers: {Accept: 'application/json'}})
            .done(function (result) {
                if (result.contenttype !== storedType) {
                    window.location.reload();
                    return;
                }
                $('#filename').val(result.filename);
                if (result.expiry_label) {
                    $('.current-expiry').text(result.expiry_label);
                    $('#maxlife-preset').val('keep');
                }
                $('.file-title').text(result.filename).attr('title', result.filename);
                document.title = result.filename + ' · Bepasty';
                status.text('已保存，分享链接保持不变。');
            }).fail(function () {
                status.text('未能确认保存结果，请重试；填写的内容已保留。');
            }).always(function () {
                saving = false;
                button.prop('disabled', false).text('保存修改');
            });
    });
    if (typeof qrcode === 'function') {
        $('#qr-btn').on('click', function (event) {
            var target = $('#detail-qr-code');
            var text = $('.file-overview .share-link input').val();
            try {
                var qr;
                for (var size = 1; size <= 40; size++) {
                    try {
                        qr = qrcode(size, 'H');
                        qr.addData(text);
                        qr.make();
                        break;
                    } catch (overflow) {
                        if (!overflow.message || overflow.message.indexOf('code length overflow') !== 0) {
                            throw overflow;
                        }
                    }
                }
                if (size > 40) {
                    return;
                }
                target.html(qr.createSvgTag());
                var svg = target.find('svg');
                svg.attr('viewBox', '0 0 ' + parseInt(svg.attr('width'), 10) + ' ' + parseInt(svg.attr('height'), 10))
                    .attr('width', 240).attr('height', 240).attr('role', 'presentation');
            } catch (error) {
                // Keep the native QR page available if local generation fails.
                return;
            }
            event.preventDefault();
            if (currentView !== 'qr') {
                returnView = currentView;
            }
            select('qr');
            $('#detail-qr-close').focus();
        });
        $('#detail-qr-close').on('click', function () {
            select(returnView || 'preview');
            $('#qr-btn').focus();
        });
        $(document).on('keydown', function (event) {
            if (event.keyCode === 27 && currentView === 'qr') {
                $('#detail-qr-close').click();
            }
        });
    }
    $(window).on('resize orientationchange', resize);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', resize);
    }
    resize();
});
