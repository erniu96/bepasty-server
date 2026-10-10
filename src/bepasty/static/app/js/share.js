$(function () {
    'use strict';

    function selectLink(input) {
        input.focus();
        input.select();
        if (typeof input.setSelectionRange === 'function') {
            try {
                // Explicitly select the whole readonly URL on mobile browsers.
                input.setSelectionRange(0, input.value.length);
            } catch (error) {
                // Older browsers can still use the selection made by select().
            }
        }
    }

    $('.share-link .copy-link').show();
    $(document).on('click', '.share-link input', function () {
        selectLink(this);
    });

    $(document).on('click', '.copy-link', function () {
        var button = $(this);
        var container = button.closest('.share-link');
        var input = container.find('input')[0];
        var status = container.find('.share-status');
        if (!input) {
            return;
        }

        function copied() {
            button.text('已复制');
            status.text('链接已复制');
        }

        function selectAndCopy() {
            selectLink(input);
            try {
                if (document.execCommand && document.execCommand('copy')) {
                    copied();
                    return;
                }
            } catch (error) {
                // The selected link remains available for manual copying.
            }
            button.text('复制链接');
            status.text('链接已选中，长按后选“复制”，或使用键盘复制。');
        }

        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                var writing = navigator.clipboard.writeText(input.value);
                if (writing && typeof writing.then === 'function') {
                    writing.then(copied, selectAndCopy);
                    return;
                }
            }
        } catch (error) {
            // A restricted or partial Clipboard API must not disable fallback.
        }
        selectAndCopy();
    });
});
