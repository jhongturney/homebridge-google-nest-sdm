const assert = require('node:assert/strict');
const test = require('node:test');
const {Thermostat} = require('../dist/sdm/Thermostat');
const {Device} = require('../dist/sdm/Device');
const {Accessory} = require('../dist/Accessory');
const {Platform} = require('../dist/Platform');
const {Constants: Traits} = require('../dist/sdm/Traits');
const {Constants: Commands} = require('../dist/sdm/Commands');

function fixture(mode = 'HEATCOOL', execute = async () => ({data: {}})) {
    const calls = [];
    const api = {enterprises: {devices: {
        executeCommand: async request => { calls.push(request.requestBody); return execute(request); }
    }}};
    const state = {name: 'devices/test', traits: {
        [Traits.ThermostatMode]: {mode},
        [Traits.ThermostatEco]: {mode: 'OFF'},
        [Traits.ThermostatTemperatureSetpoint]: {heatCelsius: 18, coolCelsius: 25}
    }};
    const log = {debug() {}, warn() {}, error() {}};
    return {device: new Thermostat(api, state, log), calls, api, state, log};
}

test('concurrent mixed-mode threshold changes preserve both accepted values', async () => {
    const {device, calls} = fixture();
    await Promise.all([
        device.setTargetTemperatureRange(undefined, 20),
        device.setTargetTemperatureRange(27, undefined)
    ]);
    assert.deepEqual(calls, [
        {command: Commands.ThermostatTemperatureSetpoint_SetRange, params: {heatCelsius: 20, coolCelsius: 25}},
        {command: Commands.ThermostatTemperatureSetpoint_SetRange, params: {heatCelsius: 20, coolCelsius: 27}}
    ]);
});

test('a rejected mixed-mode command leaves cache intact and does not poison the queue', async () => {
    let attempts = 0;
    const {device, calls} = fixture('HEATCOOL', async () => {
        if (++attempts === 1) throw new Error('network unavailable');
        return {data: {}};
    });
    await assert.rejects(device.setTargetTemperatureRange(undefined, 20), /Device command failed/);
    await device.setTargetTemperatureRange(27);
    assert.equal(calls[1].params.heatCelsius, 18);
});

test('single-mode thresholds use the correct command and do not fall through', async () => {
    for (const [mode, cool, heat, command] of [
        ['HEAT', undefined, 0, Commands.ThermostatTemperatureSetpoint_SetHeat],
        ['COOL', 24, undefined, Commands.ThermostatTemperatureSetpoint_SetCool]
    ]) {
        const {device, calls} = fixture(mode);
        await device.setTargetTemperatureRange(cool, heat);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, command);
    }
});

test('rejects crossed, missing and non-finite thresholds without sending commands', async () => {
    const {device, calls, state} = fixture();
    await assert.rejects(device.setTargetTemperatureRange(17, 20), /below/);
    await assert.rejects(device.setTargetTemperatureRange(NaN), /finite/);
    await assert.rejects(device.setTargetTemperatureRange(), /specified/);
    delete state.traits[Traits.ThermostatTemperatureSetpoint].heatCelsius;
    await assert.rejects(device.setTargetTemperatureRange(27), /required/);
    assert.equal(calls.length, 0);
});

test('fan defaults to 900 seconds, omits duration for OFF, and validates ON duration', async () => {
    const {device, calls} = fixture();
    await device.setFan('ON');
    await device.setFan('OFF');
    assert.deepEqual(calls.map(c => c.params), [{timerMode: 'ON', duration: '900s'}, {timerMode: 'OFF'}]);
    for (const duration of [0, -1, 43201, 1.5, NaN, Infinity])
        await assert.rejects(device.setFan('ON', duration), /duration/);
    assert.equal(calls.length, 2);
});

test('fan events never invoke HVAC callbacks', () => {
    const {device} = fixture();
    let fan = 0;
    let hvac = 0;
    device.onFanChanged = () => fan++;
    device.onHvacChanged = () => hvac++;
    device.event({resourceUpdate: {traits: {[Traits.Fan]: {timerMode: 'ON'}}}});
    assert.equal(fan, 1);
    assert.equal(hvac, 0);
});

test('thermostat command failure rejects without exposing request credentials', async () => {
    const {device, api, state, log} = fixture('HEAT', async () => {
        throw Object.assign(new Error('request failed'), {config: {headers: {Authorization: 'secret'}}});
    });
    await assert.rejects(device.setTargetTemperature(20), e => /request failed/.test(e.message) && !/secret/.test(e.message));
    // Retain the existing non-thermostat error contract for camera callers.
    const base = new Device(api, state, log);
    base.getDisplayName = () => 'test';
    assert.equal(await base.executeCommand('camera-command'), undefined);
});

test('nullable conversion preserves zero and false', async () => {
    for (const value of [0, false, 20])
        assert.equal(await Accessory.prototype.convertToNullable(Promise.resolve(value)), value);
    assert.equal(await Accessory.prototype.convertToNullable(Promise.resolve(undefined)), null);
});

test('invalid configuration logs field names but never configured credential values', () => {
    const errors = [];
    const config = {platform: 'test', clientId: 'sensitive-client', clientSecret: 'sensitive-secret', refreshToken: 'sensitive-refresh'};
    const fakeApi = {hap: {Characteristic: class {}}};
    new Platform({error: message => errors.push(message)}, config, fakeApi);
    assert.match(errors.join(' '), /projectId.*subscriptionId/);
    assert.doesNotMatch(errors.join(' '), /sensitive-/);
});

test('stale concurrent reads share one refresh and failed refreshes back off', async () => {
    const {device, api} = fixture();
    let gets = 0;
    api.enterprises.devices.get = async () => { gets++; throw new Error('offline'); };
    device.lastRefresh = 0;
    await Promise.all([device.getMode(), device.getEco(), device.getTargetTemperatureRange()]);
    await device.getMode();
    assert.equal(gets, 1);
});
