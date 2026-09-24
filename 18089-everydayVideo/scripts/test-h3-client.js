#!/usr/bin/env node
// Unit test for lib/h3/client.js
// Run: node scripts/test-h3-client.js

const assert = require('assert');
const h3 = require('../lib/h3/client');

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); console.log(`ok ${name}`); passed++; }
    catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

// 1. Module exports
t('exports createVideo, getVideo, downloadVideo, DEFAULT_BASE', () => {
    assert.strictEqual(typeof h3.createVideo, 'function');
    assert.strictEqual(typeof h3.getVideo, 'function');
    assert.strictEqual(typeof h3.downloadVideo, 'function');
    assert.strictEqual(typeof h3.DEFAULT_BASE, 'string');
});

// 2. createVideo validates task
t('createVideo rejects invalid task', async () => {
    let threw = false;
    try { await h3.createVideo({ task: 'nope', prompt: 'x' }); }
    catch (e) { threw = /Invalid task/.test(e.message); }
    assert.ok(threw, 'should have thrown Invalid task');
});

t('createVideo rejects missing prompt', async () => {
    let threw = false;
    try { await h3.createVideo({ task: 't2va' }); }
    catch (e) { threw = /prompt is required/.test(e.message); }
    assert.ok(threw);
});

t('createVideo rejects duration out of range', async () => {
    let threw = false;
    try { await h3.createVideo({ task: 't2va', prompt: 'p', target: { duration_seconds: 99 } }); }
    catch (e) { threw = /duration_seconds/.test(e.message); }
    assert.ok(threw);
});

t('createVideo rejects bad aspect ratio', async () => {
    let threw = false;
    try { await h3.createVideo({ task: 't2va', prompt: 'p', target: { aspect_ratio: '99:1' } }); }
    catch (e) { threw = /aspect_ratio/.test(e.message); }
    assert.ok(threw);
});

t('createVideo accepts all five tasks', async () => {
    // We won't actually call the network; just verify the validator passes
    // by stubbing global fetch. Since we use http.request, we check by
    // calling _internals via a fake url.
    // Easier: just ensure the validator is fine for each task by inspecting
    // that the error path doesn't fire for "Invalid task".
    for (const task of ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va']) {
        try { await h3.createVideo({ task, prompt: '' }); }
        catch (e) {
            assert.ok(!/Invalid task/.test(e.message), `${task} should be valid task`);
        }
    }
});

setTimeout(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}, 100);
