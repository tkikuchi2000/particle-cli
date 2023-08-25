const usbUtils = require('../cmd/usb-util');
const { delay } = require('./utilities');
const { PLATFORMS } =require('./platform');
const { moduleTypeToString, sortBinariesByDependency } = require('./dependency-walker');
const { HalModuleParser: ModuleParser, ModuleInfo } = require('binary-version-reader');
const path = require('path');
const os = require('os');
const FLASH_APPLY_DELAY = 3000;

async function flashFiles({ device, flashSteps, ui }) {
	const progress = _createFlashProgress({ flashSteps, ui });
	try {
		for (const step of flashSteps) {
			if (step.flashMode === 'normal') {
				if (device.isInDfuMode) {
					// put device in normal mode
					progress({ event: 'switch-mode', mode: 'normal' });
					device = await usbUtils.reopenInNormalMode(device, { reset: true, timeout: 10000 });
				}
				// put the device in listening mode to prevent cloud connection
				try {
					await device.enterListeningMode();
				} catch (error) {
					// ignore if the device is already in listening mode
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

function _createFlashProgress({ flashSteps, ui }) {
	const NORMAL_MULTIPLIER = 10; // flashing in normal mode is slower so count each byte more
	const { isInteractive } = ui;
	let progressBar;
	if (isInteractive) {
		progressBar = ui.createProgressBar();
		// double the size to account for the erase and programming steps
		const total = flashSteps.reduce((total, step) => total + step.data.length * 2 * (step.flashMode === 'normal' ? NORMAL_MULTIPLIER : 1), 0);
		progressBar.start(total, 0, { description: 'Preparing to flash' });
	}

	let flashMultiplier = 1;
	let eraseSize = 0;
	let step = null;
	let description;
	return (payload) => {
		switch (payload.event) {
			case 'flash-file':
				description = `Flashing ${payload.filename}`;
				if (isInteractive) {
					progressBar.update({ description });
				} else {
					ui.stdout.write(`${description}${os.EOL}`);
				}
				step = flashSteps.find(step => step.name === payload.filename);
				flashMultiplier = step.flashMode === 'normal' ? NORMAL_MULTIPLIER : 1;
				eraseSize = 0;
				break;
			case 'switch-mode':
				description = `Switching device to ${payload.mode} mode`;
				if (isInteractive) {
					progressBar.update({ description });
				} else {
					ui.stdout.write(`${description}${os.EOL}`);
				}
				break;
			case 'erased':
				if (isInteractive) {
					// In DFU, entire sectors are erased so the count of bytes can be higher than the actual size
					// of the file. Ignore the extra bytes to avoid issues with the progress bar
					if (step && eraseSize + payload.bytes > step.data.length) {
						progressBar.increment((step.data.length - eraseSize) * flashMultiplier);
						eraseSize = step.data.length;
					} else {
						progressBar.increment(payload.bytes * flashMultiplier);
						eraseSize += payload.bytes;
					}
				}
				break;
			case 'downloaded':
				if (isInteractive) {
					progressBar.increment(payload.bytes * flashMultiplier);
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

function filterModulesToFlash({ modules, platformId, allowAll = false }) {
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

async function parseModulesToFlash({ files }) {
	return Promise.all(files.map(async (file) => {
		const parser = new ModuleParser();
		const binary = await parser.parseFile(file);
		return {
			filename: file,
			...binary
		};
	}));
}

async function createFlashSteps({ modules, isInDfuMode, platformId }) {
	const platform = PLATFORMS.find(p => p.id === platformId);
	const sortedModules = await sortBinariesByDependency(modules);
	const assetModules = [], normalModules = [], dfuModules = [];
	sortedModules.forEach(module => {
		const data = module.prefixInfo.moduleFlags === ModuleInfo.Flags.DROP_MODULE_INFO ? module.fileBuffer.slice(module.prefixInfo.prefixSize) : module.fileBuffer;
		const flashStep = {
			name: path.basename(module.filename),
			moduleInfo: { crc: module.crc, prefixInfo: module.prefixInfo, suffixInfo: module.suffixInfo },
			data
		};
		const moduleType = moduleTypeToString(module.prefixInfo.moduleFunction);
		const storage = platform.firmwareModules
			.find(firmwareModule => firmwareModule.type === moduleType);
		if (moduleType === 'assets') {
			flashStep.flashMode = 'normal';
			assetModules.push(flashStep);
		} else if (moduleType === 'bootloader' || storage.storage === 'external') {
			flashStep.flashMode = 'normal';
			normalModules.push(flashStep);
		} else {
			flashStep.flashMode = 'dfu';
			dfuModules.push(flashStep);
		}
	});

	// avoid switching to normal mode if device is already in DFU so a device with broken Device OS can get fixed
	if (isInDfuMode) {
		return [...dfuModules, ...normalModules, ...assetModules];
	} else {
		return [...normalModules, ...dfuModules, ...assetModules];
	}
}

module.exports = {
	flashFiles,
	filterModulesToFlash,
	parseModulesToFlash,
	createFlashSteps
};
