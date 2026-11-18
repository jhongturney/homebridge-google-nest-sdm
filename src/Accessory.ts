import {API, Logger, Nullable, PlatformAccessory} from "homebridge";
import {Platform} from "./Platform";

export abstract class Accessory<T> {
    protected readonly api: API;
    protected readonly log: Logger;
    protected readonly platform: Platform;
    protected readonly accessory: PlatformAccessory;
    protected readonly device: T;

    protected constructor(
        api: API,
        log: Logger,
        platform: Platform,
        accessory: PlatformAccessory,
        device: T) {
        this.platform = platform;
        this.log = log;
        this.api = api;
        this.accessory = accessory;
        this.device = device;
        new this.api.hap.Service.AccessoryInformation()
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Nest')
    }

    protected async convertToNullable<T>(input: Promise<T | undefined | null>): Promise<Nullable<T>> {
        const result = await input;
        if (result === undefined || result === null) return null;
        return result;
    }

    protected async writeDevice(action: () => Promise<void>): Promise<void> {
        try {
            await action();
        } catch (error: any) {
            this.log.warn(`Device change rejected: ${error?.message ?? 'request failed'}`, this.accessory.displayName);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}
