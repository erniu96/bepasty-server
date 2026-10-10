/* Optional single-image view. Native anchors retain the continuous gallery. */
$(function () {
    'use strict';
    var items = $('.gallery-item');
    if (!items.length || !('flex' in document.documentElement.style)) {
        return;
    }
    $('body').addClass('gallery-enabled');
    function showImage() {
        var hash = window.location.hash, selected = items.filter(function () {
            return '#' + this.id === hash;
        });
        if (!selected.length) {
            selected = items.first();
        }
        items.hide().attr('aria-hidden', 'true');
        selected.show().attr('aria-hidden', 'false');
    }
    function sizeGallery() {
        var height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        $('#main-content').css('height', Math.max(0, height - $('#header').outerHeight()) + 'px');
    }
    $(window).on('hashchange', showImage).on('resize orientationchange', sizeGallery);
    if (window.visualViewport && window.visualViewport.addEventListener) {
        window.visualViewport.addEventListener('resize', sizeGallery);
    }
    showImage();
    sizeGallery();
});
