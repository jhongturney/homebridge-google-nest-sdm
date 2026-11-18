"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Accessory = void 0;
class Accessory {
    constructor(api, log, platform, accessory, device) {
        this.platform = platform;
        this.log = log;
        this.api = api;
        this.accessory = accessory;
        this.device = device;
        new this.api.hap.Service.AccessoryInformation()
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Nest');
    }
    async convertToNullable(input) {
        const result = await input;
        if (result === undefined || result === null)
            return null;
        return result;
    }
    async writeDevice(action) {
        var _a;
        try {
            await action();
        }
        catch (error) {
            this.log.warn(`Device change rejected: ${(_a = error === null || error === void 0 ? void 0 : error.message) !== null && _a !== void 0 ? _a : 'request failed'}`, this.accessory.displayName);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}
exports.Accessory = Accessory;
//# sourceMappingURL=Accessory.js.map