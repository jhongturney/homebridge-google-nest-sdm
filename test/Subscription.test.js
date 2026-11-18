const assert = require('node:assert/strict');
const test = require('node:test');
const {EventEmitter} = require('node:events');
const {PubSub} = require('@google-cloud/pubsub');
const {SmartDeviceManagement} = require('../dist/sdm/Api');
const {Platform} = require('../dist/Platform');

function fixture(t) {
    const subscriptions = [];
    t.mock.method(PubSub.prototype, 'subscription', () => {
        const subscription = new EventEmitter();
        subscription.close = async () => { subscription.didClose = true; };
        subscriptions.push(subscription);
        return subscription;
    });
    const log = {debug() {}, warn() {}, error() {}};
    const client = new SmartDeviceManagement({clientId: 'test', clientSecret: 'test', refreshToken: 'test', projectId: 'test', subscriptionId: 'test'}, log);
    const message = payload => ({
        data: Buffer.from(payload), acks: 0, nacks: 0,
        ack() { this.acks++; }, nack() { this.nacks++; }
    });
    return {client, subscriptions, message};
}

test('startup events are retried; ready events are acknowledged after dispatch', async t => {
    const {client, subscriptions, message} = fixture(t);
    try {
        const early = message('{}');
        subscriptions[0].emit('message', early);
        assert.equal(early.acks, 0);
        assert.equal(early.nacks, 1);
        const ready = message(JSON.stringify({resourceUpdate: {name: 'device', traits: {temperature: 20}}}));
        let handled = 0;
        client.devices = [{getName: () => 'device', event: () => { assert.equal(ready.acks, 0); handled++; }}];
        subscriptions[0].emit('message', ready);
        assert.equal(handled, 1);
        assert.equal(ready.acks, 1);
        const invalid = message('invalid JSON');
        subscriptions[0].emit('message', invalid);
        assert.equal(invalid.acks, 1);
        const relation = message(JSON.stringify({relationUpdate: {}}));
        subscriptions[0].emit('message', relation);
        assert.equal(relation.acks, 1);
    } finally { await client.close(); }
});

test('subscription errors do not disable REST device discovery', async t => {
    const {client, subscriptions} = fixture(t);
    try {
        client.smartdevicemanagement = {enterprises: {devices: {list: async () => ({data: {devices: []}})}}};
        subscriptions[0].emit('error', {code: 14});
        assert.deepEqual(await client.list_devices(), []);
    } finally { await client.close(); }
});

test('error retry closes the old connection and shutdown prevents later reopen', async t => {
    const timers = [];
    t.mock.method(global, 'setTimeout', callback => {
        const timer = {callback, unref() {}};
        timers.push(timer);
        return timer;
    });
    t.mock.method(global, 'clearTimeout', () => {});
    const {client, subscriptions} = fixture(t);
    subscriptions[0].emit('error', {code: 14});
    subscriptions[0].emit('error', {code: 14});
    assert.equal(timers.length, 1);
    await timers[0].callback();
    assert.equal(subscriptions[0].didClose, true);
    assert.equal(subscriptions.length, 2);
    subscriptions[1].emit('error', {code: 14});
    await client.close();
    await timers[1].callback();
    assert.equal(subscriptions.length, 2);
});

test('failed discovery schedules a retry and does not register accessories', async t => {
    let retry;
    t.mock.method(global, 'setTimeout', callback => { retry = callback; return {unref() {}}; });
    const platform = Object.create(Platform.prototype);
    let attempts = 0;
    platform.smartDeviceManagement = {list_devices: async () => { attempts++; return undefined; }};
    await platform.discoverDevices();
    assert.equal(typeof retry, 'function');
    await retry();
    // The retry callback starts discovery asynchronously.
    await Promise.resolve();
    assert.equal(attempts, 2);
});
