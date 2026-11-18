import * as google from "googleapis";
import * as Events from './Events';
import {Logger} from "homebridge";
import _ from "lodash";
import {describeApiError, isRateLimited} from "./ApiError";

export abstract class Device {
    protected smartdevicemanagement: google.smartdevicemanagement_v1.Smartdevicemanagement;
    protected device: google.smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device;
    protected lastRefresh: number;
    protected displayName: string|null|undefined;
    protected log: Logger;
    protected commandErrorsAreFatal = false;
    private commandTimes: number[] = [];
    private commandCooldownUntil = 0;
    private refreshPromise?: Promise<void>;
    private lastRefreshAttempt = 0;
    constructor(smartdevicemanagement: google.smartdevicemanagement_v1.Smartdevicemanagement,
                device: google.smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device,
                log: Logger) {
        this.smartdevicemanagement = smartdevicemanagement;
        this.device = device;
        this.lastRefresh = Date.now();
        const parent = <google.smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1ParentRelation|undefined>_.find(device.parentRelations, relation => relation.displayName);
        this.displayName = parent?.displayName;
        this.log = log;
    }

    event(event: Events.Event): void {
        if ((event as any).resourceUpdate && (event as any).resourceUpdate.traits) {
            const traitEvent = event as Events.ResourceTraitEvent;
            _.forEach(traitEvent.resourceUpdate.traits, (value, key) => {
                if (this.device.traits && this.device.traits[key])
                    this.device.traits[key] = value;
            })
        }
    };

    abstract getDisplayName() : string;

    getName(): string {
        return <string>this.device.name;
    }

    async refresh(): Promise<void> {
        if (this.refreshPromise) return this.refreshPromise;
        // Deduplicate concurrent characteristic reads and back off failed requests.
        if (Date.now() - this.lastRefreshAttempt < 60000) return;
        this.lastRefreshAttempt = Date.now();
        this.refreshPromise = this.refreshDevice();
        try { await this.refreshPromise; } finally { this.refreshPromise = undefined; }
    }

    private async refreshDevice(): Promise<void> {
        try {
            const response = await this.smartdevicemanagement.enterprises.devices.get({name: this.getName()});
            this.log.debug(`Request for device info for ${this.getDisplayName()} had value ${JSON.stringify(response.data)}`);
            this.device = response.data;
            this.lastRefresh = Date.now();
        } catch (error: any) {
            if (isRateLimited(error)) {
                this.log.error(`Google rate-limited the GetDevice API (HTTP 429). Device state is refreshed periodically; the cached state is used until this clears — usually within a minute.`, this.getDisplayName());
            } else {
                this.log.error(`Could not execute device GET request: ${describeApiError(error)}`, this.getDisplayName());
            }
        }
    }

    async getTrait<T>(name: string): Promise<T | null> {
        const howLongAgo: number = Date.now() - this.lastRefresh;
        // Reconcile on reads even if the event connection silently stops delivering.
        if (howLongAgo > 1000 * 60 * 5) {
            await this.refresh();
            this.log.debug(`Last refresh for ${this.getDisplayName()} was ${howLongAgo/1000}s, refreshing.`)
        }

        const value = this.device?.traits ? this.device?.traits[name] : null;
        //this.log.debug(`Request for trait ${name} had value ${JSON.stringify(value)}`, this.getDisplayName());
        return value;
    }

    async executeCommand<T extends {[key: string]: any} | null, U>(name: string, params?: T): Promise<U | undefined> {
        if (this.commandErrorsAreFatal) {
            const now = Date.now();
            this.commandTimes = this.commandTimes.filter(time => now - time < 3600000);
            const recent = this.commandTimes.filter(time => now - time < 60000);
            const nextAllowed = Math.max(this.commandCooldownUntil,
                recent.length >= 5 ? recent[recent.length - 5] + 60000 : 0,
                this.commandTimes.length >= 100 ? this.commandTimes[0] + 3600000 : 0);
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
            return <U>response.data.results;
        } catch (error: any) {
            if (isRateLimited(error)) {
                if (this.commandErrorsAreFatal) this.commandCooldownUntil = Date.now() + 60000;
                this.log.warn(`Google rate-limited the ${name} command (HTTP 429). Pause device commands for at least a minute; an hourly quota can take longer to clear.`, this.getDisplayName());
            } else {
                this.log.error(`Could not execute device command: ${describeApiError(error)}`, this.getDisplayName());
            }
            if (this.commandErrorsAreFatal)
                throw new Error(`Device command failed: ${describeApiError(error)}`);
        }

        return undefined;
    }
}
