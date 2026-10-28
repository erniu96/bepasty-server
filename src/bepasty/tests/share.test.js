// Run with: node src/bepasty/tests/share.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'app', 'js', 'share.js'), 'utf8');

async function copy(options) {
    const handlers = {};
    const result = {selected: false, focused: false, shown: false, label: '复制链接', status: '',
        clipboardCalls: 0, legacyCalls: 0};
    const input = {value: options.url || 'https://paste.example.org/abc',
        focus() { result.focused = true; },
        select() { if (!options.selectNoop) result.selected = true; }};
    if (options.selectionRange) {
        input.setSelectionRange = (start, end) => {
            if (options.rangeThrows) throw new Error('selection range unsupported');
            assert.strictEqual(result.focused, true, 'focus before selecting the complete URL');
            assert.strictEqual(start, 0);
            assert.strictEqual(end, input.value.length);
            result.range = [start, end];
            result.selected = true;
        };
    }
    const status = {text(value) { result.status = value; }};
    const container = {find(selector) { return selector === 'input' ? [input] : status; },
        addClass(value) { result.containerClass = value; return this; }};
    const label = {length: options.icon ? 1 : 0, text(value) { result.label = value; }};
    const button = {closest() { return container; }, text(value) { result.label = value; },
        find() { return label; }, attr() { return this; }};
    const document = {};
    if (options.legacy !== undefined) {
        document.execCommand = command => {
            assert.strictEqual(command, 'copy');
            result.legacyCalls++;
            assert.strictEqual(result.selected, true, 'select the whole URL before legacy copy');
            if (options.legacyThrows) throw new Error('copy denied');
            return options.legacy;
        };
    }
    function $(selector) {
        if (typeof selector === 'function') { selector(); return; }
        if (selector === 'body') return {addClass() { return this; }};
        if (selector === document) {
            return {on(event, target, handler) { handlers[target] = handler; }};
        }
        if (selector === '.share-link .copy-link') {
            return {show() { result.shown = true; }};
        }
        return button;
    }
    const navigator = {};
    if (options.modern) {
        navigator.clipboard = {writeText(value) {
            result.clipboardCalls++;
            assert.strictEqual(value, input.value);
            if (options.modernThrows) throw new Error('clipboard denied');
            if (options.noThen) return undefined;
            if (options.invalidThen) return {then: true};
            return options.reject ? Promise.reject(new Error('clipboard unavailable')) : Promise.resolve();
        }};
    }
    const sandbox = {$, document, navigator};
    if (options.noPromise) sandbox.Promise = undefined;
    vm.runInNewContext(source, sandbox);
    if (options.inputClick) handlers['.share-link input'].call(input);
    else handlers['.copy-link'].call(button);
    await Promise.resolve();
    assert.strictEqual(result.shown, true);
    return result;
}

(async () => {
    for (const options of [{modern: true}, {legacy: true}, {modern: true, reject: true, legacy: true}]) {
        const result = await copy(options);
        assert.strictEqual(result.label, '已复制');
        assert.strictEqual(result.status, '链接已复制');
    }
    for (const options of [{}, {legacy: false}, {modern: true, reject: true, legacy: false}]) {
        const result = await copy(options);
        assert.strictEqual(result.selected, true);
        assert.strictEqual(result.label, '复制链接');
        assert.ok(result.status.indexOf('链接已选中') === 0);
    }
    // These synchronous API failures previously stopped the click handler before
    // selecting the link or invoking either fallback.
    for (const problem of ['modernThrows', 'noThen', 'invalidThen']) {
        const copied = await copy({modern: true, [problem]: true, legacy: true});
        assert.strictEqual(copied.clipboardCalls, 1);
        assert.strictEqual(copied.legacyCalls, 1);
        assert.strictEqual(copied.label, '已复制');
        const manual = await copy({modern: true, [problem]: true, legacy: false});
        assert.strictEqual(manual.selected, true);
        assert.ok(manual.status.indexOf('链接已选中') === 0);
    }
    const httpCopied = await copy({url: 'http://192.168.1.10:5000/abc', noPromise: true,
        legacy: true, selectionRange: true, selectNoop: true});
    assert.strictEqual(httpCopied.clipboardCalls, 0, 'HTTP fallback needs neither Clipboard API nor Promise');
    assert.strictEqual(httpCopied.label, '已复制');
    assert.deepStrictEqual(httpCopied.range, [0, 'http://192.168.1.10:5000/abc'.length]);
    const httpManual = await copy({url: 'http://192.168.1.10:5000/abc', noPromise: true,
        legacy: false, legacyThrows: true, selectionRange: true});
    assert.strictEqual(httpManual.selected, true);
    assert.ok(httpManual.status.indexOf('链接已选中') === 0);
    const oldSelection = await copy({legacy: true, selectionRange: true, rangeThrows: true});
    assert.strictEqual(oldSelection.label, '已复制', 'unsupported range preserves select() fallback');
    const iconCopy = await copy({modern: true, icon: true});
    assert.strictEqual(iconCopy.label, '已复制', 'update label without removing the icon');
    const iconManual = await copy({legacy: false, icon: true});
    assert.strictEqual(iconManual.containerClass, 'manual-copy', 'reveal URL when manual copying is needed');
    const inputClick = await copy({inputClick: true, selectionRange: true, selectNoop: true});
    assert.strictEqual(inputClick.selected, true, 'clicking a URL also selects its full text');
    assert.strictEqual(inputClick.clipboardCalls, 0);
    assert.strictEqual(inputClick.legacyCalls, 0, 'manual selection does not copy automatically');
    console.log('Share link Clipboard API, HTTP legacy/manual fallback and complete URL selection checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
