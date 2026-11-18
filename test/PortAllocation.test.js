const assert = require('node:assert/strict');
const test = require('node:test');
const dgram = require('node:dgram');
const {once} = require('node:events');
const {pickPort} = require('pick-port');
const {RTCPeerConnection} = require('werift');
const {StreamingDelegate} = require('../dist/StreamingDelegate');
const {WebRtcNestStreamer} = require('../dist/NestStreamer');

async function bind(t, port = 0, ip = '127.0.0.1') {
    const socket = dgram.createSocket(ip.includes(':') ? 'udp6' : 'udp4');
    t.after(() => {
        try { socket.close(); } catch (error) {
            if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error;
        }
    });
    const listening = once(socket, 'listening');
    socket.bind(port, ip);
    await listening;
    return socket;
}

function reservations(t) {
    // Port selection/binding remains real. Only the 15-second in-process
    // reservation expiry uses the mock clock so tests need not wait to exit.
    t.mock.timers.enable({apis: ['setTimeout']});
}

for (const [family, ip] of [['ipv4', '127.0.0.1'], ['ipv6', '::1']]) {
    test(`compiled stream preparation selects distinct, bindable ${family} UDP ports`, {timeout: 5000}, async t => {
        // Skip only if the host genuinely has no IPv6 loopback support.
        if (family === 'ipv6') {
            try { await bind(t, 0, ip); } catch (error) {
                if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) {
                    t.skip('IPv6 loopback is unavailable on this host');
                    return;
                }
                throw error;
            }
        }
        reservations(t);
        const delegate = Object.create(StreamingDelegate.prototype);
        delegate.camera = {getCameraLiveStream: async () => ({})};
        delegate.hap = {CameraController: {generateSynchronisationSource: () => 1234}};
        delegate.getIpAddress = async () => ip;
        delegate.pendingSessions = {};
        const media = {port: 50000, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14)};
        let response;
        await delegate.prepareStream({sessionID: family, addressVersion: family, targetAddress: ip,
            audio: media, video: media}, (error, value) => {
            assert.ifError(error);
            assert.equal(response, undefined, 'callback must run once');
            response = value;
        });
        assert.ok(response);
        assert.equal(response.addressOverride, ip);
        assert.notEqual(response.video.port, response.audio.port);
        assert.equal(delegate.pendingSessions[family].videoReturnPort, response.video.port);
        const receiver = await bind(t, response.video.port, ip);
        const sender = await bind(t, response.audio.port, ip);
        const received = once(receiver, 'message');
        await new Promise((resolve, reject) => sender.send(Buffer.from('port-check'), response.video.port, ip,
            error => error ? reject(error) : resolve()));
        const [payload] = await received;
        assert.equal(payload.toString(), 'port-check');
        t.mock.timers.tick(15000);
    });
}

test('port allocation rejects an occupied UDP port instead of handing it to a stream', {timeout: 5000}, async t => {
    const occupied = await bind(t);
    const port = occupied.address().port;
    await assert.rejects(pickPort({type: 'udp', ip: '127.0.0.1', minPort: port, maxPort: port,
        reserveTimeout: 0}), /no available port/);
});

test('compiled WebRTC setup allocates bindable SDP ports before contacting a real camera', {timeout: 5000}, async t => {
    reservations(t);
    // Prevent ICE gathering and real SDP exchange. This tests our second
    // pick-port consumer, not Nest/WebRTC interoperability.
    t.mock.method(RTCPeerConnection.prototype, 'createOffer', async () => ({type: 'offer', sdp: 'test-offer'}));
    t.mock.method(RTCPeerConnection.prototype, 'setLocalDescription', async () => {});
    t.mock.method(RTCPeerConnection.prototype, 'setRemoteDescription', async () => {});
    let offers = 0;
    const camera = {
        getDisplayName: () => 'Test Camera',
        generateStream: async offer => {
            assert.equal(offer, 'test-offer');
            offers++;
            return {mediaSessionId: 'test-session', answerSdp: 'test-answer'};
        },
        stopStream: async token => assert.equal(token, 'test-session')
    };
    const log = {debug() {}, info() {}, warn() {}, error() {}};
    const streamer = new WebRtcNestStreamer(log, camera, {});
    try {
        const stream = await streamer.initialize();
        const audioPort = Number(/^m=audio (\d+) /m.exec(stream.stdin)?.[1]);
        const videoPort = Number(/^m=video (\d+) /m.exec(stream.stdin)?.[1]);
        assert.ok(audioPort > 0 && videoPort > 0);
        assert.notEqual(audioPort, videoPort);
        await bind(t, audioPort);
        await bind(t, videoPort);
        assert.equal(offers, 1);
    } finally {
        await streamer.teardown();
        t.mock.timers.tick(15000);
    }
});
