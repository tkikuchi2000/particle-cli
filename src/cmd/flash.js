const fs = require('fs-extra');
const os = require('os');
const ParticleApi = require('./api');
const VError = require('verror');
const { HalModuleParser: ModuleParser, ModuleInfo } = require('binary-version-reader');
const deviceSpecs = require('../lib/device-specs');
const { ensureError, delay } = require('../lib/utilities');
const { errors: { usageError } } = require('../app/command-processor');
const dfu = require('../lib/dfu');
const usbUtils = require('./usb-util');
const CLICommandBase = require('./base');
const { platformForId, PLATFORMS } = require('../lib/platform');
const settings = require('../../settings');
const path = require('path');
const utilities = require('../lib/utilities');
const CloudCommand = require('./cloud');
const BundleCommand = require('./bundle');
const temp = require('temp').track();
const { knownAppNames, knownAppsForPlatform } = require('../lib/known-apps');
const { sourcePatterns, binaryPatterns, binaryExtensions } = require('../lib/file-types');
const deviceOsUtils = require('../lib/device-os-version-util');
const semver = require('semver');
const { moduleTypeToString, sortBinariesByDependency } = require('../lib/dependency-walker');

const FLASH_APPLY_DELAY = 3000;

module.exports = class FlashCommand extends CLICommandBase {
	constructor(...args) {
		super(...args);
	}

	async flash(device, binary, files, {
		local,
		usb,
		serial,
		factory,
		force,
		target,
		port,
		yes,
		'application-only': applicationOnly
	}) {
		if (!device && !binary && !local) {
			// if no device nor files are passed, show help
			throw usageError('You must specify a device or a file');
		}

		this.ui.logFirstTimeFlashWarning();

		if (usb) {
			await this.flashDfu({ binary, factory, force });
		} else if (serial) {
			await this.flashYModem({ binary, port, yes });
		} else if (local) {
			let allFiles = binary ? [binary, ...files] : files;
			await this.flashLocal({ files: allFiles, applicationOnly, target });
		} else {
			await this.flashCloud({ device, files, target });
		}

		this.ui.write('Flash success!');
	}

	flashCloud({ device, files, target }) {
		const CloudCommands = require('../cmd/cloud');
		const args = { target, params: { device, files } };
		return new CloudCommands().flashDevice(args);
	}

	flashYModem({ binary, port, yes }) {
		const SerialCommands = require('../cmd/serial');
		return new SerialCommands().flashDevice(binary, { port, yes });
	}

	flashDfu({ binary, factory, force, requestLeave }) {
		return Promise.resolve()
			.then(() => dfu.isDfuUtilInstalled())
			.then(() => dfu.findCompatibleDFU())
			.then(() => {
				//only match against knownApp if file is not found
				let stats;

				try {
					stats = fs.statSync(binary);
				} catch (error) {
					// file does not exist
					binary = dfu.checkKnownApp(binary);

					if (binary === undefined) {
						throw new Error(`file does not exist and no known app found. tried: \`${error.path}\``);
					}
					return;
				}

				if (!stats.isFile()) {
					throw new Error('You cannot flash a directory over USB');
				}
			})
			.then(() => {
				const parser = new ModuleParser();
				return parser.parseFile(binary)
					.catch(err => {
						throw new VError(ensureError(err), `Could not parse ${binary}`);
					});
			})
			.then(info => {
				if (info.suffixInfo.suffixSize === 65535) {
					this.ui.write('warn: unable to verify binary info');
					return;
				}

				if (!info.crc.ok && !force) {
					throw new Error('CRC is invalid, use --force to override');
				}

				const specs = deviceSpecs[dfu.dfuId];
				if (info.prefixInfo.platformID !== specs.productId && !force) {
					throw new Error(`Incorrect platform id (expected ${specs.productId}, parsed ${info.prefixInfo.platformID}), use --force to override`);
				}

				let segmentName;
				if (factory) {
					if (info.prefixInfo.moduleFunction !== ModuleInfo.FunctionType.USER_PART) {
						throw new Error('Cannot flash a non-application binary to the factory reset location');
					}
					segmentName = 'factoryReset';
					if (!specs[segmentName]) {
						throw new Error('The platform does not support a factory reset application');
					}
				}

				if (requestLeave === undefined) {
					// todo - leave on factory firmware write too?
					requestLeave = (!factory && info.prefixInfo.moduleFunction === ModuleInfo.FunctionType.USER_PART);
				}

				return dfu.writeModule(binary, { segmentName, leave: requestLeave });
			})
			.catch((err) => {
				throw new VError(ensureError(err), 'Error writing firmware');
			});
	}

	async flashLocal({ files, applicationOnly, target }) {
		const { files: parsedFiles, deviceIdOrName, knownApp } = await this._analyzeFiles(files);
		const { api, auth } = this._particleApi();
		const device = await usbUtils.getOneUsbDevice({ deviceIdOrName, api, auth, ui: this.ui });

		const platformName = platformForId(device.platformId).name;
		let { skipDeviceOSFlash, files: filesToFlash } = await this._prepareFilesToFlash({
			knownApp,
			parsedFiles,
			platformId: device.platformId,
			platformName,
			target
		});

		filesToFlash = await this._processBundle({ filesToFlash });

		this.ui.write(`Flashing ${platformName} ${deviceIdOrName || device.id}`);

		// TODO: process all the files with binary version reader
		const fileModules = await this._parseModules({ files: filesToFlash });

		// TODO: check that all the files are for the correct platform

		const deviceOsBinaries = await this._getDeviceOsBinaries({
			currentDeviceOsVersion: device.version,
			skipDeviceOSFlash,
			target,
			files: fileModules,
			platformId: device.platformId,
			applicationOnly
		});
		const deviceOsModules = await this._parseModules({ files: deviceOsBinaries });
		let modulesToFlash = [...fileModules, ...deviceOsModules];
		modulesToFlash = await this._filterModulesToFlash({ modules: modulesToFlash, platformId: device.platformId });

		const flashSteps = await this._createFlashSteps({ modules: modulesToFlash, isInDfuMode: device.isInDfuMode , platformId: device.platformId });
		console.log(flashSteps);

		//await this._flashFiles({ device, flashSteps });
		await device.close();

	}


	async _analyzeFiles(files) {
		const apps = knownAppNames();

		// assume the user wants to compile/flash the current directory if no argument is passed
		if (files.length === 0) {
			return {
				files: ['.'],
				deviceIdOrName: null,
				knownApp: null
			};
		}

		// check if the first argument is a known app
		const [knownApp] = files;
		if (apps.includes(knownApp)) {
			return {
				files: [],
				deviceIdOrName: null,
				knownApp
			};
		}

		// check if the second argument is a known app
		if (files.length > 1) {
			const [deviceIdOrName, knownApp] = files;
			if (apps.includes(knownApp)) {
				return {
					files: [],
					deviceIdOrName,
					knownApp
				};
			}
		}

		// check if the first argument exists in the filesystem, regardless if it's a file or directory
		try {
			await fs.stat(files[0]);
			return {
				files,
				deviceIdOrName: null,
				knownApp: null
			};
		} catch (error) {
			// file doesn't exist, assume the first argument is a device
			const [deviceIdOrName, ...remainingFiles] = files;
			return {
				files: remainingFiles,
				deviceIdOrName,
				knownApp: null
			};
		}
	}

	// Should be part fo CLICommandBase??
	_particleApi() {
		const auth = settings.access_token;
		const api = new ParticleApi(settings.apiUrl, { accessToken: auth } );
		return { api: api.api, auth, particleApi: api };
	}

	async _prepareFilesToFlash({ knownApp, parsedFiles, platformId, platformName, target }) {
		if (knownApp) {
			const knownAppPath = knownAppsForPlatform(platformName)[knownApp];
			if (knownAppPath) {
				return { skipDeviceOSFlash: true, files: [knownAppPath] };
			} else {
				throw new Error(`Known app ${knownApp} is not available for ${platformName}`);
			}
		}

		const [filePath] = parsedFiles;
		let stats;
		try {
			stats = await fs.stat(filePath);
		} catch (error) {
			// ignore error
		}

		// if a directory, figure out if it's a source directory that should be compiled
		// or a binary directory that should be flashed directly
		if (stats && stats.isDirectory()) {
			const binaries = utilities.globList(filePath, binaryPatterns);
			const sources = utilities.globList(filePath, sourcePatterns);

			if (binaries.length > 0 && sources.length === 0) {
				// this is a binary directory so get all the binaries from all the parsedFiles
				const binaries = this._findBinaries(parsedFiles);
				return { skipDeviceOSFlash: false, files: binaries };
			} else if (sources.length > 0) {
				// this is a source directory so compile it
				const compileResult = await this._compileCode({ parsedFiles, platformId, target });
				return { skipDeviceOSFlash: false, files: compileResult };
			} else {
				throw new Error('No files found to flash');
			}
		} else {
			// this is a file so figure out if it's a source file that should be compiled or a
			// binary that should be flashed directly
			if (binaryExtensions.includes(path.extname(filePath))) {
				const binaries = this._findBinaries(parsedFiles);
				return { skipDeviceOSFlash: false, files: binaries };
			} else {
				const compileResult = await this._compileCode({ parsedFiles, platformId, target });
				return { skipDeviceOSFlash: false, files: compileResult };
			}
		}
	}

	async _compileCode({ parsedFiles, platformId, target }) {
		const cloudCommand = new CloudCommand();
		const saveTo = temp.path({ suffix: '.zip' }); // compileCodeImpl will pick between .bin and .zip as appropriate
		const { filename } = await cloudCommand.compileCodeImpl({ target, saveTo, platformId, files: parsedFiles });
		return [filename];
	}

	_findBinaries(parsedFiles) {
		const binaries = new Set();
		for (const filePath of parsedFiles) {
			try {
				const stats = fs.statSync(filePath);
				if (stats.isDirectory()) {
					const found = utilities.globList(filePath, binaryPatterns);
					for (const binary of found) {
						binaries.add(binary);
					}
				} else {
					binaries.add(filePath);
				}
			} catch (error) {
				throw new Error(`I couldn't find that: ${filePath}`);
			}

		}
		return Array.from(binaries);
	}

	async _processBundle({ filesToFlash }) {
		const bundle = new BundleCommand();
		const processed = await Promise.all(filesToFlash.map(async (filename) => {
			if (path.extname(filename) === '.zip') {
				return bundle.extractModulesFromBundle({ bundleFilename: filename });
			} else {
				return filename;
			}
		}));

		return processed.flat();
	}

	async _getDeviceOsBinaries({ skipDeviceOSFlash, target, files, currentDeviceOsVersion, platformId, applicationOnly }) {
		const { particleApi } = this._particleApi();
		const { file: application, applicationDeviceOsVersion } = await this._pickApplicationBinary(files, particleApi);

		// no application so no need to download Device OS binaries
		if (!application) {
			return [];
		}

		// TODO: if files to flash include Device OS binaries, don't override them with the ones from the cloud

		// need to get the binary required version
		if (applicationOnly) {
			return [];
		}

		// force to flash device os binaries if target is specified
		if (target) {
			return deviceOsUtils.downloadDeviceOsVersionBinaries({
				api: particleApi,
				platformId,
				version: target,
				ui: this.ui,
				omitUserPart: true
			});
		}

		// avoid downgrading Device OS for known application like Tinker compiled against older Device OS
		if (skipDeviceOSFlash) {
			return [];
		}

		// if Device OS needs to be upgraded, or we don't know the current Device OS version, download the binaries
		if (!currentDeviceOsVersion || semver.lt(currentDeviceOsVersion, applicationDeviceOsVersion)) {
			return deviceOsUtils.downloadDeviceOsVersionBinaries({
				api: particleApi,
				platformId,
				version: applicationDeviceOsVersion,
				ui: this.ui,
			});
		} else {
			// Device OS is up to date, no need to download binaries
			return [];
		}
	}

	async _pickApplicationBinary(files, api) {
		for (const file of files) {
			// parse file and look for moduleFunction
			if (file.prefixInfo.moduleFunction === ModuleInfo.FunctionType.USER_PART) {
				const internalVersion = file.prefixInfo.depModuleVersion;
				// TODO: handle the case when the Device OS version is not available
				let applicationDeviceOsVersionData = { version: null };
				try {
					applicationDeviceOsVersionData = await api.getDeviceOsVersions(file.prefixInfo.platformID, internalVersion);
				} catch (error) {
					// ignore
				}
				return { file, applicationDeviceOsVersion: applicationDeviceOsVersionData.version };
			}
		}
		return { file: null, applicationDeviceOsVersion: null };
	}

	async _flashFiles({ device, flashSteps }) {
		const progress = this._createFlashProgress({ flashSteps });

		try {
			for (const step of flashSteps) {
				if (step.flashMode === 'normal') {
					if (device.isInDfuMode) {
						// put device in normal mode
						progress({ event: 'switch-mode', mode: 'normal' });
						device = await usbUtils.reopenInNormalMode(device);
					}

					// flash the file in normal mode
					progress({ event: 'flash-file', filename: step.name });
					await device.updateFirmware(step.data, { progress });

					// wait for the device to apply the firmware
					await delay(FLASH_APPLY_DELAY);
					device = await usbUtils.reopenInNormalMode(device, { reset: false });
				} else {
					if (!device.isInDfuMode) {
						// put device in dfu mode
						progress({ event: 'switch-mode', mode: 'DFU' });
						device = await usbUtils.reopenInDfuMode(device);
					}

					// flash the file over DFU
					progress({ event: 'flash-file', filename: step.name });
					// CLI always flashes to internal flash which is the DFU alt setting 0
					const altSetting = 0;
					await device.writeOverDfu(step.data, { altSetting, startAddr: parseInt(step.moduleInfo.prefixInfo.moduleStartAddy, 16), progress });
				}
			}
		} finally {
			progress({ event: 'finish' });
			await device.reset();
			await device.close();
		}
	}

	_createFlashProgress({ flashSteps }) {
		const { isInteractive } = this.ui;
		let progressBar;
		if (isInteractive) {
			progressBar = this.ui.createProgressBar();
			// double the size to account for the erase and programming steps
			const total = flashSteps.reduce((total, step) => total + step.data.length * 2, 0);
			progressBar.start(total, 0, { description: 'Preparing to flash' });
		}

		let eraseSize = 0;
		let currentStep = null;
		let description;
		return (payload) => {
			switch (payload.event) {
				case 'flash-file':
					description = `Flashing ${payload.filename}`;
					if (isInteractive) {
						progressBar.update({ description });
					} else {
						this.ui.stdout.write(`${description}${os.EOL}`);
					}
					currentStep = flashSteps.find(step => step.name === payload.filename);
					eraseSize = 0;
					break;
				case 'switch-mode':
					description = `Switching device to ${payload.mode} mode`;
					if (isInteractive) {
						progressBar.update({ description });
					} else {
						this.ui.stdout.write(`${description}${os.EOL}`);
					}
					break;
				case 'erased':
					if (isInteractive) {
						// In DFU, entire sectors are erased so the count of bytes can be higher than the actual size
						// of the file. Ignore the extra bytes to avoid issues with the progress bar
						if (currentStep && eraseSize + payload.bytes > currentStep.data.length) {
							progressBar.increment(currentStep.data.length - eraseSize);
							eraseSize = currentStep.data.length;
						} else {
							progressBar.increment(payload.bytes);
							eraseSize += payload.bytes;
						}
					}
					break;
				case 'downloaded':
					if (isInteractive) {
						progressBar.increment(payload.bytes);
					}
					break;
				case 'finish':
					if (isInteractive) {
						progressBar.stop();
					}
					break;
			}
		};
	}

	async _parseModules({ files }) {
		return Promise.all(files.map(async (file) => {
			const parser = new ModuleParser();
			const binary = await parser.parseFile(file);
			return {
				filename: file,
				...binary
			};
		}));

	}

	async _filterModulesToFlash({ modules, platformId, allowAll = false }) {
		const platform = PLATFORMS.find(p => p.id === platformId);
		const filteredModules = [];
		// remove encrypted files
		for (const moduleInfo of modules) {
			const moduleType = moduleTypeToString(moduleInfo.prefixInfo.moduleFunction);
			const platformModule = platform.firmwareModules.find(m => m.type === moduleType && m.index === moduleInfo.prefixInfo.moduleIndex);
			// filter encrypted modules
			const isEncrypted = platformModule && platformModule.encrypted;
			const isRadioStack = moduleInfo.prefixInfo.moduleFunction === ModuleInfo.FunctionType.RADIO_STACK;
			const isNcpFirmware = moduleInfo.prefixInfo.moduleFunction === ModuleInfo.FunctionType.NCP_FIRMWARE;
			if (!isEncrypted && (!isRadioStack || allowAll) && (!isNcpFirmware || allowAll)) {
				filteredModules.push(moduleInfo);
			}
		}
		return filteredModules;
	}

	async _createFlashSteps({ modules, isInDfuMode, platformId }) {
		const platform = PLATFORMS.find(p => p.id === platformId);
		const binaries = await sortBinariesByDependency(modules);
		const assetModules = [], normalModules = [], dfuModules = [];
		binaries.forEach(binary => {
			const data = binary.prefixInfo.moduleFlags === ModuleInfo.Flags.DROP_MODULE_INFO ? binary.fileBuffer.slice(binary.prefixInfo.prefixSize) : binary.fileBuffer;
			const module = {
				name: path.basename(binary.filename),
				moduleInfo: { crc: binary.crc, prefixInfo: binary.prefixInfo, suffixInfo: binary.suffixInfo },
				data
			};
			const moduleType = moduleTypeToString(binary.prefixInfo.moduleFunction);
			const storage = platform.firmwareModules
				.find(firmwareModule => firmwareModule.type === moduleType);
			if (moduleType === 'assets') {
				module.flashMode = 'normal';
				assetModules.push(module);
			} else if (moduleType === 'bootloader' || storage.storage === 'external') {
				module.flashMode = 'normal';
				normalModules.push(module);
			} else {
				module.flashMode = 'dfu';
				dfuModules.push(module);
			}
		});

		if (isInDfuMode) {
			return [...dfuModules, ...normalModules, ...assetModules];
		} else {
			return [...normalModules, ...dfuModules, ...assetModules];
		}
	}
};
