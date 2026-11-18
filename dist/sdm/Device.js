"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Device = void 0;
const lodash_1 = __importDefault(require("lodash"));
const ApiError_1 = require("./ApiError");
class Device {
    constructor(smartdevicemanagement, device, log) {
        this.commandErrorsAreFatal = false;
        this.commandTimes = [];
        this.commandCooldownUntil = 0;
        this.lastRefreshAttempt = 0;
        this.smartdevicemanagement = smartdevicemanagement;
        this.device = device;
        this.lastRefresh = Date.now();
        const parent = lodash_1.default.find(device.parentRelations, relation => relation.displayName);
        this.displayName = parent === null || parent === void 0 ? void 0 : parent.displayName;
        this.log = log;
    }
    event(event) {
        if (event.resourceUpdate && event.resourceUpdate.traits) {
            const traitEvent = event;
            lodash_1.default.forEach(traitEvent.resourceUpdate.traits, (value, key) => {
                if (this.device.traits && this.device.traits[key])
                    this.device.traits[key] = value;
            });
        }
    }
    ;
    getName() {
        return this.device.name;
    }
    async refresh() {
        if (this.refreshPromise)
            return this.refreshPromise;
        // Deduplicate concurrent characteristic reads and back off failed requests.
        if (Date.now() - this.lastRefreshAttempt < 60000)
            return;
        this.lastRefreshAttempt = Date.now();
        this.refreshPromise = this.refreshDevice();
        try {
            await this.refreshPromise;
        }
        finally {
            this.refreshPromise = undefined;
        }
    }
    async refreshDevice() {
        try {
            const response = await this.smartdevicemanagement.enterprises.devices.get({ name: this.getName() });
            this.log.debug(`Request for device info for ${this.getDisplayName()} had value ${JSON.stringify(response.data)}`);
            this.device = response.data;
            this.lastRefresh = Date.now();
        }
        catch (error) {
            if ((0, ApiError_1.isRateLimited)(error)) {
                this.log.error(`Google rate-limited the GetDevice API (HTTP 429). Device state is refreshed periodically; the cached state is used until this clears — usually within a minute.`, this.getDisplayName());
            }
            else {
                this.log.error(`Could not execute device GET request: ${(0, ApiError_1.describeApiError)(error)}`, this.getDisplayName());
            }
        }
    }
    async getTrait(name) {
        var _a, _b;
        const howLongAgo = Date.now() - this.lastRefresh;
        // Reconcile on reads even if the event connection silently stops delivering.
        if (howLongAgo > 1000 * 60 * 5) {
            await this.refresh();
            this.log.debug(`Last refresh for ${this.getDisplayName()} was ${howLongAgo / 1000}s, refreshing.`);
        }
        const value = ((_a = this.device) === null || _a === void 0 ? void 0 : _a.traits) ? (_b = this.device) === null || _b === void 0 ? void 0 : _b.traits[name] : null;
        //this.log.debug(`Request for trait ${name} had value ${JSON.stringify(value)}`, this.getDisplayName());
        return value;
    }
    async executeCommand(name, params) {
        if (this.commandErrorsAreFatal) {
            const now = Date.now();
            this.commandTimes = this.commandTimes.filter(time => now - time < 3600000);
            const recent = this.commandTimes.filter(time => now - time < 60000);
            const nextAllowed = Math.max(this.commandCooldownUntil, recent.length >= 5 ? recent[recent.length - 5] + 60000 : 0, this.commandTimes.length >= 100 ? this.commandTimes[0] + 3600000 : 0);
            if (now < nextAllowed)
                throw new Error(`Thermostat command rate limit: wait ${Math.ceil((nextAllowed - now) / 1000)} seconds before retrying.`);
            this.commandTimes.push(now);
        }
        this.log.debug(`Executing command ${name} with parameters ${JSON.stringify(params)}`, this.getDisplayName());
        try {
            const response = await this.smartdevicemanagement.enterprises.devices.executeCommand({
                name: this.getName(),
                requestBody: {
                    command: name,
                    params: params
                }
            });
            this.log.debug(`Execution of command ${name} returned ${JSON.stringify(response.data.results)}`, this.getDisplayName());
            return response.data.results;
        }
        catch (error) {
            if ((0, ApiError_1.isRateLimited)(error)) {
                if (this.commandErrorsAreFatal)
                    this.commandCooldownUntil = Date.now() + 60000;
                this.log.warn(`Google rate-limited the ${name} command (HTTP 429). Pause device commands for at least a minute; an hourly quota can take longer to clear.`, this.getDisplayName());
            }
            else {
                this.log.error(`Could not execute device command: ${(0, ApiError_1.describeApiError)(error)}`, this.getDisplayName());
            }
            if (this.commandErrorsAreFatal)
                throw new Error(`Device command failed: ${(0, ApiError_1.describeApiError)(error)}`);
        }
        return undefined;
    }
}
exports.Device = Device;
//# sourceMappingURL=Device.js.map