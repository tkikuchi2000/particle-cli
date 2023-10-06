const ParticleCache = require('./particle-cache');

class ApiCache {
	constructor(api) {
		this.particleApi = api;
		this.cache = new ParticleCache();
	}

	async getDeviceOsVersions(platformId, version) {
		const key = this.cache._generateKey('device_os_version', { platformId, version });
		try {
			const deviceOsVersion = await this.particleApi.getDeviceOsVersions(platformId, version);
			this.cache.set(key, deviceOsVersion);
			return deviceOsVersion;
		} catch (error) {
			if (isInternetConnectionError(error)) {
				const cachedDeviceOsVersion = this.cache.get(key);
				if (cachedDeviceOsVersion) {
					return cachedDeviceOsVersion;
				}
				throw new Error(`Device OS version not found in cache for platform: ${platformId} version: ${version} and there was an internet connection error`);

			}
			throw error;
		}
	}

	async getDevice({ deviceId: id, auth }) {
		const key = this.cache._generateKey('device', { deviceIdOrName: id });
		try {
			const device = await this.particleApi.api.getDevice({ deviceId: id, auth });
			this.cache.set(key, device);
			return device;
		} catch (error) {
			if (isInternetConnectionError(error)) {
				const cachedDevice = this.cache.get(key);
				if (cachedDevice) {
					return cachedDevice;
				}
				throw new Error(`Device ${id} not found in cache and there was an internet connection error`);
			}
			throw error;
		}
	}
}

function isInternetConnectionError(error) {
	return error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND') || error.message.includes('Network error');
}

const proxyHandler = {
	get: (target, prop) => {
		if (typeof target[prop] === 'function') {
			return target[prop].bind(target);
		} else if (typeof target.particleApi[prop] === 'function') {
			return target.particleApi[prop].bind(target.particleApi);
		} else if (target.particleApi.api && typeof target.particleApi.api[prop] === 'function') {
			return target.particleApi.api[prop].bind(target.particleApi.api);
		} else {
			return target[prop];
		}
	}
};

function createApiCache(api) {
	const apiCache = new ApiCache(api);
	return new Proxy(apiCache, proxyHandler);
}


module.exports = createApiCache;
