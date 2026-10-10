// Run with: node src/bepasty/tests/fileuploader.test.js
// These unit checks control metadata and transfer timing. Actual file selection,
// blueimp processing, and browser link/copy behavior are verified in the browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'app', 'js', 'fileuploader.js'), 'utf8');

function uploader(overrides = {}) {
    const handlers = {};
    const elements = {};
    const requests = [];
    const transfers = [];
    const additions = [];
    let options;
    let initialized = false;
    let confirmation;

    class Selection {
        constructor(selector, missing = false) {
            this.selector = selector;
            this.length = missing ? 0 : 1;
            this[0] = {files: []};
            this.attributes = {};
            this.properties = {};
            this.styles = {};
            this.children = [];
            this.hidden = false;
            this.value = '';
            if (selector.charAt(0) === '<') {
                const attrs = /([\w-]+)="([^"]*)"/g;
                let match;
                while ((match = attrs.exec(selector))) this.attributes[match[1]] = match[2];
                if (/\sreadonly(?:\s|\/|>)/.test(selector)) this.attributes.readonly = '';
            }
        }
        fileupload(method, data) {
            if (typeof method === 'string' && !this.widgetInitialized) {
                throw new Error('cannot call methods on fileupload prior to initialization; attempted ' + method);
            }
            if (method === 'send') {
                const callbacks = [];
                const transfer = {
                    data,
                    fail(callback) { callbacks.push(callback); return this; },
                    reject(status = 0, textStatus = 'error', errorThrown = 'failed') {
                        const xhr = {status};
                        handlers.fileuploadfail({}, Object.assign({}, data, {jqXHR: xhr, textStatus, errorThrown}));
                        callbacks.forEach(callback => callback(xhr, textStatus, errorThrown));
                    },
                    resolve(result) { handlers.fileuploaddone({}, Object.assign({}, data, {result})); },
                    progress(loaded, total = data.files[0].size) {
                        handlers.fileuploadprogress({}, Object.assign({}, data, {loaded, total}));
                    },
                    confirm(offset) {
                        handlers.fileuploadchunkdone({}, Object.assign({}, data, {uploadedBytes: offset,
                            result: {uploaded_bytes: offset}}));
                    },
                    abort() { this.aborted = true; if (!overrides.abortDelayed) this.reject(0, 'abort', 'abort'); }
                };
                transfers.push(transfer);
                return transfer;
            }
            if (method === 'add') {
                // Mirror blueimp's fresh data object for each added file and its
                // event-before-default-add ordering without mocking network success.
                data.files.forEach(file => {
                    const added = Object.assign({}, data, {files: [file]});
                    additions.push(added);
                    handlers.fileuploadadd.call(this, {}, added);
                    if (file.size > options.maxFileSize) {
                        file.error = options.messages.maxFileSize;
                        handlers.fileuploadprocessfail({}, Object.assign({}, added, {index: 0}));
                    } else {
                        handlers.fileuploadsubmit.call(this, {}, added);
                    }
                });
                return this;
            }
            options = method;
            initialized = true;
            this.widgetInitialized = true;
            return this;
        }
        on(event, callback) { handlers[event] = callback; return this; }
        prop(name, value) {
            if (value === undefined) return this.properties[name];
            this.properties[name] = name === 'href' ? new URL(value, 'http://localhost:5000/').href : value;
            return this;
        }
        attr(name, value) {
            if (typeof name === 'object') Object.assign(this.attributes, name);
            else if (value === undefined) return this.attributes[name];
            else this.attributes[name] = value;
            return this;
        }
        closest() { return $('#upload-form'); }
        find(selector) {
            if (this.selector === '#upload-form') return $(selector);
            if (this.selector === '#fileupload-progress') return $('#total-progress-bar');
            return this.descendants().filter(node => node.matches(selector))[0] || new Selection(selector, true);
        }
        matches(selector) {
            if (selector.charAt(0) === '.') return (this.attributes.class || '').split(/\s+/).includes(selector.slice(1));
            return this.selector.indexOf('<' + selector) === 0;
        }
        descendants() { return this.children.flatMap(child => child instanceof Selection ? [child, ...child.descendants()] : []); }
        hide() { this.hidden = true; return this; }
        show() { this.hidden = false; return this; }
        text(value) { if (value === undefined) return this.textValue; this.textValue = value; return this; }
        appendTo(target) { $(target).append(this); return this; }
        insertAfter() { return this; }
        append(child) { this.children.push(child); return this; }
        empty() { this.children = []; return this; }
        css(name, value) { this.styles[name] = value; return this; }
        click(callback) { this.clicked = callback; return this; }
        val(value) { if (value === undefined) return this.value; this.value = value; return this; }
    }

    function $(selector) {
        if (typeof selector === 'function') { selector(); return; }
        if (selector instanceof Selection) return selector;
        if (typeof selector === 'string' && selector.charAt(0) === '<') return new Selection(selector);
        return elements[selector] || (elements[selector] = new Selection(selector));
    }
    $.fn = {fileupload: function () {}};
    $.support = {xhrFileUpload: true, xhrFormDataFileUpload: true, blobSlice: true};
    $.each = function (items, callback) { Object.keys(items).forEach(key => callback(key, items[key])); };
    $.ajax = function (settings) {
        const request = {
            settings,
            resolve(result) { if (settings.success) settings.success(result); },
            reject(status = 0, textStatus = 'error') { if (settings.error) settings.error({status}, textStatus); }
        };
        requests.push(request);
        return request;
    };
    $('[name=maxlife-unit]').val('hours');
    $('[name=maxlife-value]').val('2');
    $('#filelist').val('');
    $('#filelist-form').hide();
    const window = {File: function () {}, JSON, confirm: function (message) {
        confirmation = message;
        return true;
    }};
    if (overrides.bootbox) window.bootbox = {confirm(dialog) { confirmation = dialog; }};
    if (overrides.plugin === false) delete $.fn.fileupload;
    if (overrides.fileApi === false) delete window.File;
    if (overrides.fileInputApi === false) delete $('#fileupload')[0].files;
    if (overrides.xhr === false) $.support.xhrFileUpload = false;
    if (overrides.formData === false) $.support.xhrFormDataFileUpload = false;
    if (overrides.blobSlice === false) $.support.blobSlice = false;
    if (overrides.json === false) delete window.JSON;
    const sandbox = {$, window, MAX_BODY_SIZE: 1040384,
        MAX_ALLOWED_FILE_SIZE: overrides.unlimited ? null : 5000000000, UPLOAD_NEW_URL: '/+upload/new'};
    if (overrides.preset) $('[name=maxlife-preset]').val(overrides.preset);
    vm.runInNewContext(source, sandbox);
    function replaceFileInput() {
        // The real blueimp _replaceFileInput clones its widget data to the new
        // input, then $.cleanData removes initialization from the old node.
        const previous = $('#fileupload');
        const current = new Selection('#fileupload');
        current.widgetInitialized = previous.widgetInitialized;
        current.properties = Object.assign({}, previous.properties);
        previous.widgetInitialized = false;
        elements['#fileupload'] = current;
        return current;
    }
    return {initialized, elements, handlers, transfers, requests, additions, sandbox,
        select(files) { replaceFileInput().fileupload('add', {files}); },
        replaceFileInput,
        confirmation() { return confirmation; },
        cards() { return $('#files').children; },
        options() { return options; }};
}

const file = {name: 'example.bin', size: 123, type: 'application/octet-stream'};

{
    const page = uploader();
    const completed = (name, filename, size = 0) => ({name, size, complete: true, uploaded_bytes: size,
        files: [{name, filename, size, url: '/' + name}]});
    const add = page.sandbox.window.BepastyUploads.addComplete;
    assert.strictEqual(add({}), false);
    assert.strictEqual(page.cards().length, 0, 'malformed form results never create a success row');
    assert.strictEqual(add(completed('first', '中文空文件.txt')), true);
    assert.strictEqual(page.requests.length, 0, 'completed form submissions do not start another file transfer');
    assert.strictEqual(page.cards()[0].find('strong').textValue, '中文空文件.txt');
    assert.strictEqual(status(page.cards()[0]), '上传完成');
    assert.strictEqual(add(completed('first', '中文空文件.txt')), true);
    assert.strictEqual(page.cards().length, 1, 'duplicate form responses cannot duplicate a sharing row');
    assert.strictEqual(add(completed('collection', '分享合集', 12), true), true);
    assert.strictEqual(page.elements['#filelist'].value, 'first\n', 'a collection never includes itself');
    assert.strictEqual(page.elements['#filelist-form'].hidden, true, 'a collection is not another source item');
    assert.strictEqual(add(completed('second', '下一份.txt', 9)), true);
    assert.strictEqual(page.elements['#filelist'].value, 'first\nsecond\n');
    assert.strictEqual(page.elements['#filelist-form'].hidden, false);
}

{
    const page = uploader({unlimited: true, preset: 'weeks:1'});
    const large = {name: 'large.bin', size: 6 * 1024 ** 3 + 123, type: 'application/octet-stream'};
    assert.strictEqual(page.options().maxFileSize, undefined);
    page.select([large]);
    assert.strictEqual(page.requests.length, 1, 'unlimited files still start metadata upload');
    assert.deepStrictEqual(JSON.parse(page.requests[0].settings.data), {
        filename: large.name, size: large.size, type: large.type, maxlife_unit: 'weeks', maxlife_value: '1'
    });
    assert.strictEqual(large.error, undefined);
}

function begin(page, name = 'itemname') {
    page.select([file]);
    page.requests[page.requests.length - 1].resolve({url: '/+upload/' + name, name});
    return page.transfers[page.transfers.length - 1];
}
function result(name = 'itemname', size = file.size) {
    return {name, size, uploaded_bytes: size, complete: true, files: [{url: '/' + name + '#example.bin', name, size}]};
}
function saved(name, offset, size = file.size) { return {name, size, uploaded_bytes: offset, complete: false, files: []}; }
function status(card) { return card.find('.upload-status').textValue; }
function retry(card) { return card.find('.upload-retry'); }
function cancel(card) { return card.find('.fileupload-abort'); }
function pause(card) { return card.find('.upload-pause'); }
function resume(card) { return card.find('.upload-resume'); }

for (const capability of ['plugin', 'fileApi', 'fileInputApi', 'xhr', 'formData', 'blobSlice', 'json']) {
    const page = uploader({[capability]: false});
    assert.strictEqual(page.initialized, false, capability + ' must use the native form');
    assert.ok(!page.elements['#fileupload-submit'] || !page.elements['#fileupload-submit'].hidden);
    assert.strictEqual(page.elements['#fileupload'].properties.multiple, undefined);
    assert.strictEqual(page.requests.length, 0);
}

{
    const page = uploader();
    assert.strictEqual(page.initialized, true);
    assert.strictEqual(page.options().autoUpload, true);
    assert.ok(!page.options().add, 'retain blueimp default processing and auto-submit');
    assert.strictEqual(page.options().formData.length, 0, 'do not serialize pasted text into each file chunk');
    assert.strictEqual(page.elements['#fileupload-submit'].hidden, true);
    assert.strictEqual(page.elements['#fileupload'].properties.multiple, true);
    page.select([file]);
    assert.strictEqual(page.cards().length, 1, 'show the file before metadata returns');
    assert.strictEqual(status(page.cards()[0]), '准备上传…');
    assert.strictEqual(page.transfers.length, 0);
    assert.deepStrictEqual(JSON.parse(page.requests[0].settings.data), {
        filename: file.name, size: file.size, type: file.type, maxlife_unit: 'hours', maxlife_value: '2'
    });
    page.requests[0].reject(403);
    assert.match(status(page.cards()[0]), /服务器拒绝.*HTTP 403/);
    assert.strictEqual(retry(page.cards()[0]).hidden, false);
    assert.strictEqual(page.requests.length, 1, 'failed creation has no item to delete');
    retry(page.cards()[0]).clicked();
    assert.strictEqual(page.cards().length, 1, 'retry resets the existing card');
    assert.strictEqual(page.requests.length, 2, 'retry makes a new metadata request');
    page.requests[1].resolve({url: '/+upload/newname', name: 'newname'});
    assert.strictEqual(page.transfers[0].data.url, '/+upload/newname');
}

{
    const page = uploader();
    page.select([file]);
    const firstInput = page.elements['#fileupload'];
    page.select([{name: 'next.bin', size: 25, type: ''}]);
    assert.strictEqual(firstInput.widgetInitialized, false, 'selection cleans the previous input widget data');
    page.requests[0].resolve({url: '/+upload/first', name: 'first'});
    page.requests[1].resolve({url: '/+upload/next', name: 'next'});
    assert.strictEqual(page.transfers.length, 2, 'pending metadata sends through the current initialized widget');
    page.transfers[0].resolve(result('first'));
    page.transfers[1].resolve(result('next', 25));
    assert.strictEqual(status(page.cards()[0]), '上传完成');
    assert.strictEqual(status(page.cards()[1]), '上传完成');
}

for (const [code, textStatus, expected] of [[0, 'error', /无法连接服务器/],
    [0, 'timeout', /超时/], [413, 'error', /超过大小限制/],
    [503, 'error', /服务器暂时出错.*HTTP 503/], [200, 'parsererror', /响应异常/]]) {
    const page = uploader();
    page.select([file]);
    page.requests[0].reject(code, textStatus);
    assert.match(status(page.cards()[0]), expected);
}

{
    const page = uploader();
    page.select([{name: 'large.bin', size: 5000000001, type: ''}]);
    assert.strictEqual(status(page.cards()[0]), '文件超过大小限制');
    assert.strictEqual(page.requests.length, 0);
    assert.strictEqual(retry(page.cards()[0]).hidden, true);
    // An independently-fired validation failure is safe even without an add.
    const data = {files: [{name: '<script>.bin', size: 10, error: '不支持这种文件类型'}], index: 0};
    page.handlers.fileuploadprocessfail({}, data);
    assert.strictEqual(status(page.cards()[1]), '不支持这种文件类型');
}

{
    const page = uploader();
    page.select([file]);
    const card = page.cards()[0];
    cancel(card).clicked();
    assert.strictEqual(status(card), '已取消');
    assert.strictEqual(page.requests.length, 1, 'do not abort creation before learning the cleanup address');
    page.requests[0].resolve({url: '/+upload/cancelled', name: 'cancelled'});
    assert.strictEqual(page.transfers.length, 0);
    assert.strictEqual(page.requests[1].settings.url, '/+upload/cancelled/abort');
    assert.strictEqual(status(card), '已取消');
}

{
    const page = uploader();
    page.select([file]);
    const card = page.cards()[0];
    cancel(card).clicked();
    retry(card).clicked();
    page.requests[1].resolve({url: '/+upload/retry', name: 'retry'});
    assert.strictEqual(status(card), '上传中…');
    page.requests[0].reject(500);
    assert.strictEqual(status(card), '上传中…', 'late metadata failure must not overwrite the retry card');
    assert.match(card.attributes.class, /alert-processing/);
}

{
    const page = uploader();
    page.select([file]);
    const card = page.cards()[0];
    cancel(card).clicked();
    retry(card).clicked();
    page.requests[1].resolve({url: '/+upload/current', name: 'current'});
    page.requests[0].resolve({url: '/+upload/old', name: 'old'});
    assert.strictEqual(page.transfers.length, 1, 'cancelled metadata never starts an old transfer');
    assert.strictEqual(page.requests[2].settings.url, '/+upload/old/abort');
    assert.strictEqual(status(card), '上传中…');
    page.transfers[0].resolve(result('current'));
    assert.strictEqual(status(card), '上传完成');
    assert.strictEqual(card.find('input').value, 'http://localhost:5000/current#example.bin');
}

{
    const page = uploader();
    const transfer = begin(page);
    cancel(page.cards()[0]).clicked();
    assert.strictEqual(transfer.aborted, true);
    assert.strictEqual(status(page.cards()[0]), '已取消');
    assert.strictEqual(page.requests.filter(request => request.settings.url.endsWith('/abort')).length, 1);
    assert.strictEqual(page.sandbox.jqXHR.itemname, undefined);
}

{
    const page = uploader();
    const transfer = begin(page, 'failed');
    transfer.reject(403);
    assert.match(status(page.cards()[0]), /HTTP 403/);
    assert.strictEqual(page.requests.length, 1, 'failure preserves server data instead of cleaning it up');
    assert.strictEqual(retry(page.cards()[0]).hidden, true);
    assert.strictEqual(resume(page.cards()[0]).hidden, false);
    resume(page.cards()[0]).clicked();
    assert.strictEqual(page.requests[1].settings.url, '/+upload/failed');
    assert.strictEqual(page.requests[1].settings.type, 'GET');
    page.requests[1].resolve(saved('failed', 0));
    assert.strictEqual(page.transfers[1].data.url, '/+upload/failed');
    page.transfers[1].resolve(result('failed'));
    transfer.reject(500);
    assert.strictEqual(status(page.cards()[0]), '上传完成', 'late transfer failure must not overwrite a successful retry');
    assert.strictEqual(page.requests.filter(request => request.settings.url.endsWith('/abort')).length, 0,
        'resuming never cleans server data');
}

{
    const page = uploader();
    const transfer = begin(page);
    page.elements['#filelist'].val('existing\n');
    page.handlers.fileuploadprogress({}, Object.assign({}, transfer.data, {loaded: 61, total: 123}));
    assert.strictEqual(page.cards()[0].find('.progress-bar').attributes['aria-valuenow'], 49);
    assert.match(page.elements['#fileupload-progress-label'].textValue, /49%/);
    transfer.resolve(result());
    const card = page.cards()[0];
    assert.strictEqual(status(card), '上传完成');
    assert.strictEqual(card.find('.progress-bar').attributes['aria-valuenow'], 100);
    assert.strictEqual(transfer.data.uploadState.progressContainer.hidden, true,
        'completed cards hide redundant bars while preserving their final progress state');
    assert.strictEqual(transfer.data.uploadState.controls.hidden, true, 'hide the completed empty action row');
    assert.strictEqual(card.find('input').value, 'http://localhost:5000/itemname#example.bin');
    assert.ok(Object.prototype.hasOwnProperty.call(card.find('input').attributes, 'readonly'));
    const links = card.descendants().filter(node => node.matches('a'));
    assert.strictEqual(links[0].properties.href, 'http://localhost:5000/itemname#example.bin');
    assert.strictEqual(links[1].properties.href, 'http://localhost:5000/itemname/+download');
    for (const link of links) assert.ok(link.matches('.btn-outline-secondary'), 'open/download use large button styling');
    assert.strictEqual(links[0].textValue, '打开');
    assert.strictEqual(links[1].textValue, '下载');
    assert.strictEqual(card.find('.copy-link').attributes.type, 'button');
    assert.strictEqual(card.find('.share-status').attributes['aria-live'], 'polite');
    assert.strictEqual(card.find('.copy-link').textValue, '复制链接');
    assert.strictEqual(page.elements['#filelist'].value, 'existing\nitemname\n');
    assert.strictEqual(page.elements['#filelist-form'].hidden, true, 'one file does not need a collection');
    transfer.reject(500);
    assert.strictEqual(page.requests.length, 1, 'a completed item is never cleaned up by a late failure');
    assert.strictEqual(status(card), '上传完成');
}

{
    const page = uploader();
    page.select([{name: 'empty.txt', size: 0, type: 'text/plain'}]);
    page.requests[0].resolve({url: '/+upload/empty', name: 'empty'});
    page.handlers.fileuploadprogress({}, Object.assign({}, page.transfers[0].data, {loaded: 0, total: 0}));
    assert.strictEqual(page.cards()[0].find('.progress-bar').attributes['aria-valuenow'], 0);
    page.transfers[0].resolve({files: [{url: '/empty#empty.txt', name: 'empty', size: 0}], complete: true});
    assert.strictEqual(page.cards()[0].find('.progress-bar').attributes['aria-valuenow'], 100);
    assert.strictEqual(page.elements['#total-progress-bar'].attributes['aria-valuenow'], 100);
}

{
    const page = uploader();
    page.select([file, {name: 'other.bin', size: 123, type: ''}]);
    assert.strictEqual(page.cards().length, 2);
    page.requests[0].resolve({url: '/+upload/first', name: 'first'});
    page.transfers[0].resolve(result('first'));
    page.requests[1].reject(0);
    assert.strictEqual(page.elements['#fileupload-progress-label'].textValue, '已上传 1 个 · 失败 1 个');
    assert.strictEqual(page.elements['#fileupload-abort'].styles.visibility, 'hidden');
}

{
    const page = uploader();
    page.select([file, {name: 'other.bin', size: 123, type: ''}]);
    page.requests[0].resolve({url: '/+upload/first', name: 'first'});
    page.transfers[0].resolve(result('first'));
    assert.strictEqual(page.elements['#filelist-form'].hidden, true);
    page.requests[1].resolve({url: '/+upload/second', name: 'second'});
    page.transfers[1].resolve(result('second'));
    assert.strictEqual(page.elements['#filelist-form'].hidden, false, 'two successful files can form a collection');
    page.transfers[1].resolve(result('second'));
    assert.strictEqual(page.elements['#filelist'].value, 'first\nsecond\n', 'duplicate done events do not duplicate IDs');
}

{
    const page = uploader();
    page.select([file, {name: 'other.bin', size: 123, type: ''}, {name: 'last.bin', size: 123, type: ''}]);
    page.requests[0].resolve({url: '/+upload/done', name: 'done'});
    page.transfers[0].resolve(result('done'));
    page.requests[1].resolve({url: '/+upload/active', name: 'active'});
    page.elements['#fileupload-abort'].clicked();
    assert.strictEqual(status(page.cards()[0]), '上传完成', 'cancel all leaves completed files alone');
    assert.strictEqual(status(page.cards()[1]), '已取消');
    assert.strictEqual(status(page.cards()[2]), '已取消');
    assert.strictEqual(page.transfers[1].aborted, true);
    page.requests[2].resolve({url: '/+upload/preparing', name: 'preparing'});
    assert.deepStrictEqual(page.requests.filter(request => request.settings.url.endsWith('/abort'))
        .map(request => request.settings.url), ['/+upload/active/abort', '/+upload/preparing/abort']);
    assert.strictEqual(page.elements['#fileupload-progress-label'].textValue, '已上传 1 个 · 取消 2 个');
}

{
    const page = uploader();
    const transfer = begin(page);
    const card = page.cards()[0];
    transfer.progress(85);
    transfer.confirm(40);
    assert.strictEqual(pause(card).hidden, false);
    pause(card).clicked();
    assert.strictEqual(transfer.aborted, true);
    assert.match(status(card), /^已暂停/);
    assert.strictEqual(card.find('.progress-bar').attributes['aria-valuenow'], 32,
        'pause rolls back optimistic network progress to acknowledged bytes');
    assert.strictEqual(page.requests.length, 1, 'pause neither deletes nor creates server data');
    assert.strictEqual(resume(card).hidden, false);
    assert.strictEqual(cancel(card).hidden, false);
    assert.strictEqual(retry(card).hidden, true);
    assert.strictEqual(page.elements['#fileupload-abort'].styles.visibility, 'visible');
    assert.match(page.elements['#fileupload-progress-label'].textValue, /暂停 1 个/);
    resume(card).clicked();
    resume(card).clicked();
    assert.strictEqual(page.requests.length, 2, 'one explicit Resume creates one status request');
    assert.strictEqual(pause(card).hidden, true, 'do not pause while checking the server');
    assert.strictEqual(status(card), '正在确认进度…');
    assert.strictEqual(page.requests[1].settings.cache, false);
    assert.strictEqual(page.requests[1].settings.dataType, 'json');
    // An in-flight server request can commit one more chunk after client pause.
    page.requests[1].resolve(saved('itemname', 80));
    assert.strictEqual(page.transfers.length, 2);
    assert.strictEqual(page.transfers[1].data.url, '/+upload/itemname');
    assert.strictEqual(page.transfers[1].data.files[0], transfer.data.files[0]);
    assert.strictEqual(page.transfers[1].data.uploadedBytes, 80);
    assert.notStrictEqual(page.transfers[1].data, transfer.data, 'fresh send options avoid stale Deferred/progress state');
    assert.notStrictEqual(page.transfers[1].data.uploadAttempt, transfer.data.uploadAttempt);
    assert.strictEqual(page.requests.filter(request => request.settings.type === 'POST').length, 1);
    page.transfers[1].resolve(result());
    assert.strictEqual(status(card), '上传完成');
    assert.strictEqual(page.elements['#filelist'].value, 'itemname\n');
}

{
    const page = uploader({abortDelayed: true});
    const old = begin(page);
    const card = page.cards()[0];
    old.confirm(40);
    pause(card).clicked();
    resume(card).clicked();
    page.requests[1].resolve(saved('itemname', 60));
    old.reject(0, 'abort', 'abort');
    old.progress(123);
    old.resolve(result());
    assert.strictEqual(status(card), '继续上传…', 'late old attempt events cannot finish/cancel the resumed transfer');
    assert.strictEqual(card.find('.progress-bar').attributes['aria-valuenow'], 48);
    assert.strictEqual(page.elements['#filelist'].value, '');
    page.transfers[1].resolve(result());
    old.reject(500);
    assert.strictEqual(status(card), '上传完成');
    assert.strictEqual(page.requests.length, 2, 'late events never trigger cleanup or extra requests');
}

{
    const page = uploader();
    const transfer = begin(page);
    const card = page.cards()[0];
    transfer.progress(file.size);
    assert.strictEqual(status(card), '正在完成…');
    transfer.reject(0);
    assert.notStrictEqual(status(card), '上传完成', 'bytes sent alone do not mean the upload is complete');
    resume(card).clicked();
    page.requests[1].resolve(result());
    assert.strictEqual(page.transfers.length, 1, 'GET complete recovers a lost final response without reposting');
    assert.strictEqual(status(card), '上传完成');
    assert.strictEqual(page.elements['#filelist'].value, 'itemname\n');
    page.requests[1].resolve(result());
    transfer.resolve(result());
    assert.strictEqual(page.elements['#filelist'].value, 'itemname\n', 'GET/done duplicates do not duplicate batch IDs');
    assert.strictEqual(card.descendants().filter(node => node.matches('.share-link')).length, 1);
}

{
    const page = uploader();
    const transfer = begin(page);
    const card = page.cards()[0];
    transfer.confirm(40);
    transfer.progress(100);
    transfer.reject(409);
    assert.match(status(card), /HTTP 409/);
    assert.strictEqual(card.find('.progress-bar').attributes['aria-valuenow'], 32);
    resume(card).clicked();
    page.requests[1].reject(0);
    assert.strictEqual(resume(card).hidden, false, 'failed status GET remains resumable');
    resume(card).clicked();
    page.requests[2].resolve(saved('itemname', 80));
    assert.strictEqual(page.transfers[1].data.uploadedBytes, 80);
    page.transfers[1].reject(409);
    resume(card).clicked();
    page.requests[3].resolve(result());
    assert.strictEqual(status(card), '上传完成');
    assert.strictEqual(page.requests.filter(request => request.settings.type === 'POST').length, 1);
    assert.strictEqual(page.requests.filter(request => request.settings.url.endsWith('/abort')).length, 0);
}

{
    const page = uploader();
    const transfer = begin(page);
    const card = page.cards()[0];
    pause(card).clicked();
    cancel(card).clicked();
    assert.strictEqual(status(card), '已取消');
    assert.strictEqual(page.requests[1].settings.url, '/+upload/itemname/abort');
    assert.strictEqual(resume(card).hidden, true);
    assert.strictEqual(retry(card).hidden, false);
    retry(card).clicked();
    page.requests[2].resolve({url: '/+upload/fresh', name: 'fresh'});
    assert.strictEqual(page.transfers[1].data.url, '/+upload/fresh');
    assert.strictEqual(page.transfers[1].data.uploadedBytes, 0, 'Cancel + Retry starts a new item at byte zero');
    transfer.resolve(result());
    assert.strictEqual(status(card), '上传中…');
    page.transfers[1].resolve(result('fresh'));
    assert.strictEqual(page.elements['#filelist'].value, 'fresh\n');
}

{
    const page = uploader();
    const transfer = begin(page);
    const card = page.cards()[0];
    transfer.reject(0);
    resume(card).clicked();
    cancel(card).clicked();
    assert.strictEqual(page.requests[2].settings.url, '/+upload/itemname/abort');
    page.requests[1].resolve(saved('itemname', 80));
    page.requests[1].reject(500);
    assert.strictEqual(page.transfers.length, 1, 'cancel while GET is pending prevents any resume send');
    assert.strictEqual(status(card), '已取消');
    retry(card).clicked();
    page.requests[3].resolve({url: '/+upload/newer', name: 'newer'});
    page.requests[1].resolve(result());
    assert.strictEqual(status(card), '上传中…', 'late completed GET cannot overwrite a fresh Retry card');
    assert.strictEqual(page.elements['#filelist'].value, '');
}

for (const invalid of [saved('wrong-item', 40), saved('itemname', 40, 999),
    saved('itemname', -1), saved('itemname', 124), saved('itemname', 1.5),
    saved('itemname', '40'), saved('itemname', NaN), saved('itemname', file.size),
    {name: 'itemname', size: file.size, uploaded_bytes: 40},
    {name: 'itemname', size: file.size, uploaded_bytes: 40, complete: true, files: result().files},
    Object.assign(result(), {files: [{name: 'wrong-item', size: file.size, url: '/wrong-item'}]}),
    Object.assign(result(), {files: [{name: 'itemname', size: 999, url: '/itemname'}]}),
    Object.assign(result(), {files: []})]) {
    const page = uploader();
    const transfer = begin(page);
    transfer.reject(0);
    resume(page.cards()[0]).clicked();
    page.requests[1].resolve(invalid);
    assert.match(status(page.cards()[0]), /异常/);
    assert.strictEqual(page.transfers.length, 1, 'invalid server identity/offset must not send bytes');
    assert.strictEqual(resume(page.cards()[0]).hidden, false);
    assert.strictEqual(page.elements['#filelist'].value, '');
    assert.strictEqual(page.requests.filter(request => request.settings.url.endsWith('/abort')).length, 0);
}

for (const size of [0, 25]) {
    const page = uploader();
    page.select([{name: 'small.bin', size, type: ''}]);
    page.requests[0].resolve({url: '/+upload/small', name: 'small'});
    const transfer = page.transfers[0];
    pause(page.cards()[0]).clicked();
    resume(page.cards()[0]).clicked();
    page.requests[1].resolve(saved('small', 0, size));
    assert.strictEqual(page.transfers[1].data.uploadedBytes, 0, 'untouched zero/small files resume with a whole-file POST');
    assert.strictEqual(page.transfers[1].data.url, '/+upload/small');
    page.transfers[1].resolve(result('small', size));
    assert.strictEqual(status(page.cards()[0]), '上传完成');
    assert.strictEqual(page.cards()[0].find('.progress-bar').attributes['aria-valuenow'], 100);
    transfer.resolve(result('small', size));
    assert.strictEqual(page.elements['#filelist'].value, 'small\n');
}

{
    const page = uploader();
    const transfer = begin(page);
    transfer.reject(0);
    resume(page.cards()[0]).clicked();
    const oldInput = page.elements['#fileupload'];
    page.select([{name: 'other.bin', size: 123, type: ''}]);
    assert.strictEqual(oldInput.widgetInitialized, false);
    page.requests[1].resolve(saved('itemname', 60));
    assert.strictEqual(page.transfers[1].data.uploadedBytes, 60, 'Resume resolves the live input after a second selection');
    page.requests[2].resolve({url: '/+upload/other', name: 'other'});
    page.transfers[1].resolve(result());
    page.transfers[2].resolve(result('other'));
    assert.strictEqual(page.elements['#filelist'].value, 'itemname\nother\n');
}

for (const size of [0, 25]) {
    const page = uploader();
    page.select([{name: 'tiny.bin', size, type: ''}]);
    page.requests[0].resolve({url: '/+upload/tiny', name: 'tiny'});
    page.transfers[0].reject(0);
    resume(page.cards()[0]).clicked();
    page.requests[1].resolve(result('tiny', size));
    assert.strictEqual(page.transfers.length, 1, 'complete zero/small files recover final response without a second POST');
    assert.strictEqual(status(page.cards()[0]), '上传完成');
    assert.strictEqual(page.elements['#filelist'].value, 'tiny\n');
}

{
    const page = uploader();
    const transfer = begin(page);
    transfer.resolve(Object.assign(result(), {name: 'stale-other-item'}));
    assert.match(status(page.cards()[0]), /异常/);
    assert.strictEqual(page.elements['#filelist'].value, '', 'a conflicting final identity cannot create a share link');
    assert.strictEqual(resume(page.cards()[0]).hidden, false);
}

{
    const page = uploader();
    page.select([file, {name: 'other.bin', size: 123, type: ''}, {name: 'done.bin', size: 123, type: ''}]);
    page.requests[0].resolve({url: '/+upload/paused', name: 'paused'});
    pause(page.cards()[0]).clicked();
    page.requests[1].resolve({url: '/+upload/failed', name: 'failed'});
    page.transfers[1].reject(0);
    page.requests[2].resolve({url: '/+upload/done', name: 'done'});
    page.transfers[2].resolve(result('done'));
    page.elements['#fileupload-abort'].clicked();
    assert.strictEqual(status(page.cards()[0]), '已取消');
    assert.strictEqual(status(page.cards()[1]), '已取消');
    assert.strictEqual(status(page.cards()[2]), '上传完成');
    assert.deepStrictEqual(page.requests.filter(request => request.settings.url.endsWith('/abort'))
        .map(request => request.settings.url), ['/+upload/paused/abort', '/+upload/failed/abort']);
    assert.strictEqual(page.elements['#filelist'].value, 'done\n');
}

{
    const page = uploader();
    page.select([file]);
    const card = page.cards()[0];
    const state = page.additions[0].uploadState;
    assert.strictEqual(card.children[0].find('strong').textValue, file.name,
        'show the filename before any action buttons');
    assert.strictEqual(card.find('.upload-status'), state.status);
    assert.strictEqual(card.find('.progress'), state.progressContainer);
    assert.strictEqual(card.find('.upload-actions'), state.controls);
    assert.deepStrictEqual(state.controls.children.map(button => button.textValue), ['暂停', '继续', '重试', '取消']);
    assert.strictEqual(state.progress.attributes['aria-label'], file.name + '的上传进度');
    assert.strictEqual(page.elements['#total-progress-bar'].attributes['aria-label'], '总上传进度');
    assert.strictEqual(page.elements['#fileupload-label'].textValue, '选择文件');
}

{
    const page = uploader({bootbox: true});
    const transfer = begin(page);
    page.elements['#fileupload-abort'].clicked();
    const dialog = page.confirmation();
    assert.strictEqual(dialog.message, '取消所有未完成的上传？');
    assert.strictEqual(dialog.buttons.cancel.label, '保留上传');
    assert.strictEqual(dialog.buttons.confirm.label, '全部取消');
    dialog.callback(false);
    assert.strictEqual(status(page.cards()[0]), '上传中…', 'rejecting the confirmation keeps uploads running');
    assert.ok(!transfer.aborted);
    page.elements['#fileupload-abort'].clicked();
    page.confirmation().callback(true);
    assert.strictEqual(transfer.aborted, true);
    assert.strictEqual(status(page.cards()[0]), '已取消');
}

console.log('Uploader fallback, feedback, pause/resume, cancellation, progress and lost-response recovery checks passed.');
