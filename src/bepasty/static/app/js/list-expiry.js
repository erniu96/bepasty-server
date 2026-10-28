$(function () {
    'use strict';
    $('body').addClass('list-expiry-enhanced');
    // Delegation also covers asynchronously loaded workspace lists.
    $(document).on('change', '.list-expiry-form select', function () {
        $(this).closest('form').trigger('submit');
    }).on('submit', '.list-expiry-form', function (event) {
        event.preventDefault();
        var form = $(this), select = form.find('select'), row = form.closest('.file-row');
        if (form.data('saving') || select.val() === 'keep') {
            return;
        }
        var data = form.serialize(), status = row.find('.expiry-status');
        form.data('saving', true);
        select.prop('disabled', true);
        form.find('button').hide();
        status.text('正在保存…');
        $.ajax({url: form.attr('action'), type: 'POST', data: data,
            dataType: 'json', headers: {Accept: 'application/json'}})
            .done(function (result) {
                row.find('.current-expiry').text(result.expiry_label);
                row.attr('data-permanent', result.expiry <= 0 ? 'true' : 'false');
                select.val('keep');
                status.text('有效期已更新');
                row.trigger('expiry:updated');
            }).fail(function () {
                status.text('未能确认保存结果，请重试或刷新核对。');
                form.find('button').show().text('重试保存');
            }).always(function () {
                form.data('saving', false);
                select.prop('disabled', false);
            });
    });
});
