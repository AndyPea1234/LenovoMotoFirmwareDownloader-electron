// main.electron.js - HOÀN CHỈNH
import { app, BrowserWindow, protocol, shell, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import { session } from './core/index.js';

// ===== IMPORT TỪ CORE =====
import {
  attachLocalRecipeFromModel,
  attachLocalRecipeMetadata,
  getReadSupportHints, 
  getPlayStoreStatus,
  rescueLiteFirmware,
  rescueLiteFirmwareFromLocal,
  listPlayStoreDownloads,
  searchPlayStoreApps,
  getPlayStoreAppDetails,
  downloadPlayStoreApp,
  deletePlayStoreDownload,
  installPlayStoreApp,
  listBackupRestoreSnapshots,
  scanConnectedBackupPreview,
  getConnectedBackupPreviewProgress,
  cancelConnectedBackupProcess,
  backupConnectedDevice,
  restoreBackupSnapshot,
  deleteBackupSnapshot,
  listLocalDownloadedFiles,
  extractLocalFirmware,
  deleteLocalFile,
  getWindowsQdloaderDriverStatus,
  installWindowsQdloaderDriver
} from './core/index.js';

// ===== IPC PROGRESS HANDLER =====
let progressInterval = null;
let lastProgressSent = {};

// ===== QUẢN LÝ DOWNLOAD =====
let activeDownloads = new Map();
let downloadIdCounter = 0;

// ===== GHI LOG RA FILE =====
const logFile = path.join(process.cwd(), 'debug-log.txt');
function writeLog(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, logMessage, 'utf8');
  } catch (e) {
    console.log(logMessage);
  }
  console.log(message);
}

ipcMain.on('download:progress-request', (event, data) => {
  event.reply('download:progress-response', { status: 'ok' });
});

ipcMain.on('download:cancel', (event, downloadId) => {
  writeLog(`🛑 [IPC] Cancel download requested: ${downloadId}`);
  
  if (win && !win.isDestroyed()) {
    win.webContents.send('download:cancelled', { 
      downloadId: downloadId,
      message: 'Download cancelled by user'
    });
  }
  
  event.reply('download:cancel-response', { 
    ok: true, 
    message: 'Download cancelled' 
  });
});

ipcMain.handle('cancel-download', async (event, downloadId) => {
  writeLog(`🛑 [IPC] Cancel download via handle: ${downloadId}`);
  return { ok: true };
});

app.on('before-quit', () => {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
});

// ===== LƯU SESSION TOÀN CỤC =====
let globalSession = {
  jwt: '',
  guid: '',
  clientUuid: '',
  cookieJar: new Map()
};

let win = null; 
let pendingCallbackUrl = null;
let isFirstLoad = true;

// ===== API CLIENT =====
const API_URL = 'https://lsa.lenovo.com/Interface';
const BASE_URL = 'https://lsa.lenovo.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.79 Safari/537.36';
const clientVersion = '7.5.5.19';
const requestLanguage = 'en-US';
const requestWindowsInfo = 'Microsoft Windows 10 IoT Enterprise LTSC, x64-based PC';

function serializeCookies() {
  return [...globalSession.cookieJar.entries()]
    .map(([cookieName, cookieValue]) => `${cookieName}=${cookieValue}`)
    .join('; ');
}

function getSetCookieValues(headers) {
  const setCookieValue = headers.get('set-cookie');
  return setCookieValue ? [setCookieValue] : [];
}

function updateCookies(headers) {
  for (const cookieLine of getSetCookieValues(headers)) {
    const [cookiePair] = cookieLine.split(';');
    if (!cookiePair) continue;
    const splitAt = cookiePair.indexOf('=');
    if (splitAt <= 0) continue;
    const cookieName = cookiePair.slice(0, splitAt).trim();
    const cookieValue = cookiePair.slice(splitAt + 1).trim();
    if (cookieName && cookieValue) {
      globalSession.cookieJar.set(cookieName, cookieValue);
    }
  }
}

function refreshAuth(headers) {
  const authorizationHeader = headers.get('Authorization');
  const responseGuid = headers.get('Guid');
  if (!authorizationHeader) return;
  if (responseGuid && responseGuid !== globalSession.guid) return;
  globalSession.jwt = authorizationHeader.startsWith('Bearer ')
    ? authorizationHeader
    : `Bearer ${authorizationHeader}`;
}

async function bootstrapSessionCookie() {
  try {
    const response = await fetch(`${BASE_URL}/lmsa-web/index.jsp`, { redirect: 'manual' });
    updateCookies(response.headers);
    writeLog('✅ [Bootstrap] Session cookie bootstrapped');
    
    // ===== LOAD TOKEN VÀ ĐỒNG BỘ =====
    try {
      const configPath = path.join(process.cwd(), 'assets/data/config.json');
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (configData.authorizationToken) {
          globalSession.jwt = configData.authorizationToken;
          session.jwt = configData.authorizationToken;
          writeLog(`✅ [Bootstrap] Token loaded and synced to core session`);
        }
      }
    } catch (e) {
      writeLog(`⚠️ [Bootstrap] Could not load token: ${e.message}`);
    }
  } catch (e) {
    writeLog(`❌ [Bootstrap] Error: ${e.message}`);
  }
}

// main.electron.js - SỬA HÀM requestApi
async function requestApi(path, body = {}, options = {}) {
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const isGet = (options.method || 'POST').toUpperCase() === 'GET';

  const headers = new Headers({
    'Content-Type': 'application/json',
    'Request-Tag': 'lmsa',
    'User-Agent': USER_AGENT,
    'Guid': globalSession.guid || '',
    'Cookie': serializeCookies(),
    'clientVersion': clientVersion,
    'language': requestLanguage,
    'windowsInfo': Buffer.from(requestWindowsInfo).toString('base64'),
  });

  if (globalSession.clientUuid) {
    headers.set('clientUUID', globalSession.clientUuid);
  }

  if (!options.withoutAuth && globalSession.jwt) {
    headers.set('Authorization', globalSession.jwt);
  }

  const payload = {
    client: {
      version: clientVersion,
    },
    language: requestLanguage,
    windowsInfo: requestWindowsInfo,
    dparams: body,
  };

  let requestBody = null;
  if (!isGet) {
    requestBody = JSON.stringify(payload);
  }

  writeLog(`📡 [API] ${options.method || 'POST'} ${url}`);
  if (requestBody) {
    writeLog(`📦 [API] Body: ${requestBody.substring(0, 500)}`);
  }

  try {
    const response = await fetch(url, {
      method: options.method || 'POST',
      headers,
      body: requestBody,
    });

    updateCookies(response.headers);
    refreshAuth(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const responseData = await response.json();
      writeLog(`✅ [API] Response: ${JSON.stringify(responseData).substring(0, 500)}`);
      return responseData;
    } else {
      const text = await response.text();
      writeLog(`⚠️ [API] Non-JSON response: ${text.substring(0, 200)}`);
      return { 
        code: 'ERROR', 
        desc: 'Invalid response format',
        raw: text 
      };
    }
  } catch (error) {
    writeLog(`❌ [API] Error: ${error.message}`);
    throw error;
  }
}

function generateEncryptCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function mapFirmwareVariants(content, selectedParameters) {
  const variants = [];
  if (!Array.isArray(content)) {
    return variants;
  }

  for (const item of content) {
    if (item.romResource) {
      const variant = {
        name: item.romResource.name || '',
        url: item.romResource.uri || '',
        romUrl: item.romResource.uri || '',
        romName: item.romResource.name || '',
        publishDate: item.romResource.publishDate || '',
        romMatchId: item.romMatchId || '',
        romMatchIdentifier: item.romMatchId || '',
        flashFlow: item.flashFlow || '',
        parameters: selectedParameters || {},
        fileSize: item.romResource.fileSize || 0,
        fileSha1: item.romResource.fileSha1 || '',
        romVersion: item.romResource.romVersion || '',
        releaseDate: item.romResource.releaseDate || '',
        osVersion: item.romResource.osVersion || '',
        language: item.romResource.language || '',
        romResource: item.romResource,
        toolResource: item.toolResource,
        flashFlowUrl: item.flashFlow,
        modelName: item.modelName || '',
        realModelName: item.realModelName || '',
        carrier: item.carrier || '',
        marketName: item.marketName || '',
        platform: item.platform || '',
        fastboot: item.fastboot || false,
        backUpPopup: item.backUpPopup || false
      };
      
      writeLog(`📥 [DOWNLOAD URL] ROM: ${variant.name}`);
      writeLog(`📥 [DOWNLOAD URL] ROM URL: ${variant.url}`);
      if (variant.flashFlowUrl) {
        writeLog(`📥 [DOWNLOAD URL] Flash Flow: ${variant.flashFlowUrl}`);
      }
      if (variant.toolResource?.uri) {
        writeLog(`📥 [DOWNLOAD URL] Tool: ${variant.toolResource.uri}`);
      }
      writeLog(`📥 [DOWNLOAD URL] ===== END =====`);
      
      variants.push(variant);
    }
  }

  return variants;
}

async function lookupReadSupportByImei(payload) {
  writeLog(`🔍 [lookupReadSupportByImei] Payload: ${JSON.stringify(payload)}`);
  
  try {
    const { imei, model, imei2, sn, roCarrier, channelId } = payload;
    
    const dparams = {
      imei: imei,
      modelCode: model?.modelName || model || '',
      roCarrier: roCarrier || 'reteu',
      encryptCode: generateEncryptCode(),
      sku: model?.modelName || model || '',
      carrierSku: model?.modelName || model || '',
    };

    if (imei2) dparams.imei2 = imei2;
    if (sn) dparams.sn = sn;
    if (channelId) dparams.channelId = channelId;

    writeLog(`📦 [lookupReadSupportByImei] Dparams: ${JSON.stringify(dparams)}`);

    const response = await requestApi('/rescueDevice/getNewResourceByImei.jhtml', dparams);
    
    writeLog(`📦 [lookupReadSupportByImei] Response: ${JSON.stringify(response)}`);

    const variants = mapFirmwareVariants(response?.content, {
      imei: imei,
      modelCode: model?.modelName || model || '',
      roCarrier: roCarrier || 'reteu',
    });

    const formattedResult = {
      ok: response.code === '0000',
      data: {
        code: response.code || '',
        description: response.desc || '',
        variants: variants,
        total: variants.length,
        modelName: model?.modelName || model || '',
        imei: imei
      },
      error: response.code !== '0000' ? response.desc : null
    };

    writeLog(`✅ [lookupReadSupportByImei] Found ${variants.length} variants for IMEI: ${imei}`);
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('lookup:result', formattedResult);
      writeLog(`📨 [lookupReadSupportByImei] Đã gửi kết quả xuống renderer`);
    }
    
    return formattedResult;
  } catch (error) {
    writeLog(`❌ [lookupReadSupportByImei] Error: ${error.message}`);
    const errorResult = {
      ok: false,
      error: error.message,
      data: {
        code: 'ERROR',
        description: error.message,
        variants: [],
        total: 0,
        modelName: '',
        imei: payload?.imei || ''
      }
    };
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('lookup:error', errorResult);
      writeLog(`📨 [lookupReadSupportByImei] Đã gửi lỗi xuống renderer`);
    }
    
    return errorResult;
  }
}

async function lookupReadSupportBySn(payload) {
  writeLog(`🔍 [lookupReadSupportBySn] Payload: ${JSON.stringify(payload)}`);
  
  try {
    const { sn, model, channelId } = payload;
    
    const dparams = {
      sn: sn,
    };

    if (channelId) dparams.channelId = channelId;

    writeLog(`📦 [lookupReadSupportBySn] Dparams: ${JSON.stringify(dparams)}`);

    const response = await requestApi('/rescueDevice/getNewResourceBySN.jhtml', dparams);
    
    writeLog(`📦 [lookupReadSupportBySn] Response: ${JSON.stringify(response)}`);

    const variants = mapFirmwareVariants(response?.content, {
      sn: sn,
      modelCode: model?.modelName || '',
    });

    const formattedResult = {
      ok: response.code === '0000',
      data: {
        code: response.code || '',
        description: response.desc || '',
        variants: variants,
        total: variants.length,
        modelName: model?.modelName || '',
        sn: sn
      },
      error: response.code !== '0000' ? response.desc : null
    };

    writeLog(`✅ [lookupReadSupportBySn] Found ${variants.length} variants for SN: ${sn}`);
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('lookup:result', formattedResult);
      writeLog(`📨 [lookupReadSupportBySn] Đã gửi kết quả xuống renderer`);
    }
    
    return formattedResult;
  } catch (error) {
    writeLog(`❌ [lookupReadSupportBySn] Error: ${error.message}`);
    const errorResult = {
      ok: false,
      error: error.message,
      data: {
        code: 'ERROR',
        description: error.message,
        variants: [],
        total: 0,
        modelName: '',
        sn: payload?.sn || ''
      }
    };
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('lookup:error', errorResult);
      writeLog(`📨 [lookupReadSupportBySn] Đã gửi lỗi xuống renderer`);
    }
    
    return errorResult;
  }
}

async function lookupReadSupportByParams(payload) {
  writeLog(`🔍 [lookupReadSupportByParams] Payload: ${JSON.stringify(payload)}`);
  
  try {
    const { model, params, imei, imei2, sn, channelId } = payload;
    
    const dparams = {
      modelName: model?.modelName || '',
      params: params || {},
      matchType: 1,
    };

    if (imei) dparams.imei = imei;
    if (imei2) dparams.imei2 = imei2;
    if (sn) dparams.sn = sn;
    if (channelId) dparams.channelId = channelId;

    writeLog(`📦 [lookupReadSupportByParams] Dparams: ${JSON.stringify(dparams)}`);

    const response = await requestApi('/rescueDevice/getNewResource.jhtml', dparams);
    
    writeLog(`📦 [lookupReadSupportByParams] Response: ${JSON.stringify(response)}`);

    const variants = mapFirmwareVariants(response?.content, params || {});

    const formattedResult = {
      ok: response.code === '0000',
      data: {
        code: response.code || '',
        description: response.desc || '',
        variants: variants,
        total: variants.length,
        modelName: model?.modelName || '',
        params: params || {}
      },
      error: response.code !== '0000' ? response.desc : null
    };

    writeLog(`✅ [lookupReadSupportByParams] Found ${variants.length} variants for model: ${model?.modelName}`);
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('lookup:result', formattedResult);
      writeLog(`📨 [lookupReadSupportByParams] Đã gửi kết quả xuống renderer`);
    }
    
    return formattedResult;
  } catch (error) {
    writeLog(`❌ [lookupReadSupportByParams] Error: ${error.message}`);
    const errorResult = {
      ok: false,
      error: error.message,
      data: {
        code: 'ERROR',
        description: error.message,
        variants: [],
        total: 0,
        modelName: '',
        params: {}
      }
    };
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('lookup:error', errorResult);
      writeLog(`📨 [lookupReadSupportByParams] Đã gửi lỗi xuống renderer`);
    }
    
    return errorResult;
  }
}

async function getModelNames(refresh = false) {
  writeLog(`🔍 [getModelNames] refresh: ${refresh}`);
  
  try {
    const response = await requestApi('/rescueDevice/getModelNames.jhtml', {});
    
    let models = [];
    if (response.code === '0000') {
      if (response.content && response.content.models && Array.isArray(response.content.models)) {
        models = response.content.models;
      } else if (Array.isArray(response.content)) {
        models = response.content;
      }
      
      if (models.length > 0) {
        try {
          const modelsPath = path.join(process.cwd(), 'assets/data/models-catalog.json');
          const modelsDir = path.dirname(modelsPath);
          if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
          }
          fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2), 'utf8');
          writeLog(`💾 [getModelNames] Đã lưu ${models.length} models vào cache`);
        } catch (e) {
          writeLog(`❌ [getModelNames] Lỗi lưu cache: ${e.message}`);
        }
      }
    }

    return {
      code: response.code,
      desc: response.desc || 'Success',
      content: models
    };
  } catch (error) {
    writeLog(`❌ [getModelNames] error: ${error.message}`);
    
    try {
      const modelsPath = path.join(process.cwd(), 'assets/data/models-catalog.json');
      if (fs.existsSync(modelsPath)) {
        const cachedModels = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
        writeLog(`🔄 [getModelNames] Fallback: đọc ${cachedModels.length} models từ cache`);
        return {
          code: '0000',
          desc: 'Offline fallback',
          content: cachedModels
        };
      }
    } catch (e) {}

    return {
      code: 'ERROR',
      desc: error.message,
      content: null
    };
  }
}

async function downloadFileWithProgress(url, outputPath, onProgress, type, modelName, downloadId) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    writeLog(`📥 [Download] Starting download from: ${url}`);
    writeLog(`📥 [Download] Output: ${outputPath}`);
    writeLog(`📥 [Download] ID: ${downloadId}`);
    
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const fileStream = fs.createWriteStream(outputPath);
    let request = null;
    let isCancelled = false;
    
    const downloadEntry = {
      cancel: () => {
        writeLog(`🛑 [Download] Cancelling download ${downloadId}`);
        isCancelled = true;
        if (request) {
          request.destroy();
        }
        if (fileStream) {
          fileStream.close();
        }
        if (fs.existsSync(outputPath)) {
          fs.unlink(outputPath, () => {});
        }
        activeDownloads.delete(downloadId);
      }
    };
    activeDownloads.set(downloadId, downloadEntry);
    
    request = protocol.get(url, (response) => {
      if (isCancelled) {
        writeLog(`🛑 [Download] Download ${downloadId} was cancelled`);
        response.destroy();
        reject(new Error('Download cancelled'));
        return;
      }
      
      if (response.statusCode === 302 || response.statusCode === 301) {
        writeLog(`🔄 [Download] Redirecting to: ${response.headers.location}`);
        activeDownloads.delete(downloadId);
        downloadFileWithProgress(response.headers.location, outputPath, onProgress, type, modelName, downloadId)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status: ${response.statusCode}`));
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedSize = 0;
      let lastProgress = -1;
      let lastSendTime = 0;
      const MIN_INTERVAL_MS = 500;
      
      activeDownloads.set(downloadId, {
        ...downloadEntry,
        response: response
      });
      
      response.on('data', (chunk) => {
        if (isCancelled) {
          response.destroy();
          return;
        }
        downloadedSize += chunk.length;
        if (onProgress && totalSize > 0) {
          const progress = Math.round((downloadedSize / totalSize) * 100);
          const now = Date.now();
          
          if (progress !== lastProgress || (now - lastSendTime) >= MIN_INTERVAL_MS) {
            lastProgress = progress;
            lastSendTime = now;
            onProgress(progress, downloadedSize, totalSize);
          }
        }
      });
      
      response.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        activeDownloads.delete(downloadId);
        if (!isCancelled) {
          writeLog(`✅ [Download] Completed! Size: ${downloadedSize} bytes`);
          if (onProgress) {
            onProgress(100, downloadedSize, totalSize);
          }
          resolve({ path: outputPath, size: downloadedSize });
        }
      });
      
      fileStream.on('error', (err) => {
        writeLog(`❌ [Download] File stream error: ${err.message}`);
        activeDownloads.delete(downloadId);
        fs.unlink(outputPath, () => {});
        reject(err);
      });
      
      response.on('error', (err) => {
        writeLog(`❌ [Download] Response error: ${err.message}`);
        activeDownloads.delete(downloadId);
        fs.unlink(outputPath, () => {});
        reject(err);
      });
      
    });
    
    const entry = activeDownloads.get(downloadId);
    if (entry) {
      entry.request = request;
    }
    
    request.on('error', (err) => {
      writeLog(`❌ [Download] Request error: ${err.message}`);
      activeDownloads.delete(downloadId);
      if (!isCancelled) {
        reject(err);
      }
    });
    
    request.setTimeout(300000, () => {
      writeLog(`⏰ [Download] Timeout for ${downloadId}`);
      activeDownloads.delete(downloadId);
      request.destroy();
      reject(new Error('Download timeout after 5 minutes'));
    });
  });
}

async function downloadFirmware(firmwareData, options = {}) {
  writeLog(`📥 [downloadFirmware] Starting download for: ${options.modelName || 'unknown'}`);
  writeLog(`📥 [downloadFirmware] STARTED!`);
  writeLog(`📥 [downloadFirmware] FirmwareData: ${JSON.stringify(firmwareData)}`);
  writeLog(`📥 [downloadFirmware] Options: ${JSON.stringify(options)}`);
  
  const downloadId = options.downloadId || `download-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  writeLog(`📥 [downloadFirmware] Download ID: ${downloadId}`);
  
  let romResource = firmwareData.romResource;
  let toolResource = firmwareData.toolResource;
  let flashFlowUrl = firmwareData.flashFlowUrl;

  if (firmwareData.romUrl && !romResource) {
    romResource = {
      uri: firmwareData.romUrl,
      name: firmwareData.romName || 'rom.zip',
      fileSize: firmwareData.fileSize || 0,
      fileSha1: firmwareData.fileSha1 || '',
      romVersion: firmwareData.romVersion || '',
      releaseDate: firmwareData.releaseDate || firmwareData.publishDate || '',
      osVersion: firmwareData.osVersion || '',
      language: firmwareData.language || '',
      publishDate: firmwareData.publishDate || ''
    };
    writeLog(`📦 [downloadFirmware] Đã tạo romResource từ romUrl: ${romResource.uri}`);
  }

  if (firmwareData.flashFlowUrl && !flashFlowUrl) {
    flashFlowUrl = firmwareData.flashFlowUrl;
  }

  if (firmwareData.toolUrl && !toolResource) {
    toolResource = {
      uri: firmwareData.toolUrl,
      name: firmwareData.toolName || 'tool.zip'
    };
  }

  const romMatchId = firmwareData.romMatchIdentifier || firmwareData.romMatchId || '';
  
  if (!romResource || !romResource.uri) {
    writeLog(`❌ [downloadFirmware] KHÔNG CÓ URL DOWNLOAD!`);
    const errorResult = {
      modelName: options.modelName || 'firmware',
      directory: '',
      files: [],
      allCompleted: false,
      hasError: true,
      error: 'No download URL found'
    };
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('download:error', {
        error: 'No download URL found',
        modelName: options.modelName || 'firmware',
        downloadId: downloadId
      });
    }
    
    return errorResult;
  }

  writeLog(`✅ [downloadFirmware] ROM URL: ${romResource.uri}`);
  
  const downloadsDir = path.join(process.cwd(), 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
  
  const modelName = options.modelName || 'firmware';
  const modelDir = path.join(downloadsDir, modelName);
  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true });
  }
  
  const results = [];
  let hasError = false;

  function sendProgressViaIpc(type, name, progress, downloaded, total, status, extra = {}) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('download:progress', {
        type: type,
        name: name,
        progress: progress,
        downloaded: downloaded,
        total: total,
        status: status,
        modelName: modelName,
        downloadId: downloadId,
        ...extra
      });
    }
  }
  
  if (romResource && romResource.uri) {
    const romName = romResource.name || 'rom.zip';
    const romPath = path.join(modelDir, romName);
    writeLog(`📥 [downloadFirmware] Downloading ROM: ${romName}`);
    
    try {
      const result = await downloadFileWithProgress(
        romResource.uri,
        romPath,
        (progress, downloaded, total) => {
          sendProgressViaIpc('rom', romName, progress, downloaded, total, 'downloading');
        },
        'rom',
        modelName,
        downloadId
      );
      
      results.push({
        type: 'rom',
        name: romName,
        path: result.path,
        size: result.size,
        status: 'completed'
      });
      
      sendProgressViaIpc('rom', romName, 100, result.size, result.size, 'completed', {
        path: result.path
      });
      
    } catch (error) {
      if (error.message === 'Download cancelled') {
        writeLog(`🛑 [downloadFirmware] ROM download was cancelled`);
        results.push({
          type: 'rom',
          name: romName,
          status: 'cancelled'
        });
      } else {
        writeLog(`❌ [downloadFirmware] ROM download failed: ${error.message}`);
        hasError = true;
        results.push({
          type: 'rom',
          name: romName,
          error: error.message,
          status: 'failed'
        });
        
        sendProgressViaIpc('rom', romName, 0, 0, 0, 'failed', {
          error: error.message
        });
      }
    }
  }

  if (flashFlowUrl && !hasError) {
    const flowPath = path.join(modelDir, 'flash_flow.json');
    writeLog(`📥 [downloadFirmware] Downloading Flash Flow...`);
    
    try {
      const result = await downloadFileWithProgress(
        flashFlowUrl,
        flowPath,
        (progress, downloaded, total) => {
          sendProgressViaIpc('flashflow', 'flash_flow.json', progress, downloaded, total, 'downloading');
        },
        'flashflow',
        modelName,
        downloadId
      );
      
      results.push({
        type: 'flashflow',
        name: 'flash_flow.json',
        path: result.path,
        size: result.size,
        status: 'completed'
      });
      
      sendProgressViaIpc('flashflow', 'flash_flow.json', 100, result.size, result.size, 'completed', {
        path: result.path
      });
      
    } catch (error) {
      if (error.message === 'Download cancelled') {
        writeLog(`🛑 [downloadFirmware] Flash Flow download was cancelled`);
        results.push({
          type: 'flashflow',
          name: 'flash_flow.json',
          status: 'cancelled'
        });
      } else {
        writeLog(`❌ [downloadFirmware] Flash Flow download failed: ${error.message}`);
        hasError = true;
        results.push({
          type: 'flashflow',
          name: 'flash_flow.json',
          error: error.message,
          status: 'failed'
        });
        
        sendProgressViaIpc('flashflow', 'flash_flow.json', 0, 0, 0, 'failed', {
          error: error.message
        });
      }
    }
  }
  
  if (toolResource && toolResource.uri && !hasError) {
    const toolName = toolResource.name || 'tool.zip';
    const toolPath = path.join(modelDir, toolName);
    writeLog(`📥 [downloadFirmware] Downloading Tool: ${toolName}`);
    
    try {
      const result = await downloadFileWithProgress(
        toolResource.uri,
        toolPath,
        (progress, downloaded, total) => {
          sendProgressViaIpc('tool', toolName, progress, downloaded, total, 'downloading');
        },
        'tool',
        modelName,
        downloadId
      );
      
      results.push({
        type: 'tool',
        name: toolName,
        path: result.path,
        size: result.size,
        status: 'completed'
      });
      
      sendProgressViaIpc('tool', toolName, 100, result.size, result.size, 'completed', {
        path: result.path
      });
      
    } catch (error) {
      if (error.message === 'Download cancelled') {
        writeLog(`🛑 [downloadFirmware] Tool download was cancelled`);
        results.push({
          type: 'tool',
          name: toolName,
          status: 'cancelled'
        });
      } else {
        writeLog(`❌ [downloadFirmware] Tool download failed: ${error.message}`);
        hasError = true;
        results.push({
          type: 'tool',
          name: toolName,
          error: error.message,
          status: 'failed'
        });
        
        sendProgressViaIpc('tool', toolName, 0, 0, 0, 'failed', {
          error: error.message
        });
      }
    }
  }
  
  const allCompleted = results.every(r => r.status === 'completed');
  const isCancelled = results.some(r => r.status === 'cancelled');
  
  activeDownloads.delete(downloadId);
  
  if (win && !win.isDestroyed()) {
    if (isCancelled) {
      win.webContents.send('download:cancelled', {
        downloadId: downloadId,
        modelName: modelName,
        message: 'Download cancelled by user'
      });
    } else {
      win.webContents.send('download:completed', {
        modelName: modelName,
        directory: modelDir,
        files: results,
        allCompleted: allCompleted,
        hasError: hasError,
        downloadId: downloadId
      });
    }
  }
  
  return {
    modelName: modelName,
    directory: modelDir,
    files: results,
    allCompleted: allCompleted,
    hasError: hasError,
    isCancelled: isCancelled,
    downloadId: downloadId
  };
}

// ===== ĐĂNG KÝ CUSTOM SCHEME =====
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('softwarefix', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('softwarefix');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } }
]);

function checkStoredTokenStatus() {
  try {
    const configPath = path.join(process.cwd(), 'assets/data/config.json');
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return Boolean(configData.authorizationToken?.trim());
    }
  } catch (e) {}
  return false;
}

function getRealLenovoLoginUrl() {
  try {
    writeLog('-> [Electron] Đang nhờ Bun lấy URL đăng nhập...');
    const scriptPath = path.join(process.cwd(), 'core/features/auth/login.ts');
    const bunCommand = `bun -e "import { createLoginUrl } from '${scriptPath}'; console.log(await createLoginUrl());"`;
    const realLoginUrl = execSync(bunCommand).toString().trim();
    writeLog('-> [Electron] ĐÃ LẤY ĐƯỢC LINK CHÍNH CHỦ TỪ LENOVO: ' + realLoginUrl);
    return realLoginUrl;
  } catch (error) {
    return 'https://passport.lenovo.com/passport/remote/login.html?config=softwarefix';
  }
}

async function updateGlobalSession(token) {
  try {
    writeLog(`🔑 [Session] Đang cập nhật session với token...`);
    const response = await requestApi('/user/getSFUserInfo.jhtml', {}, { method: 'GET' });
    writeLog(`📦 [Session] Response: ${JSON.stringify(response)}`);
    if (response.code === '0000') {
      globalSession.jwt = token;
      session.jwt = token;
      if (response.guid) {
        globalSession.guid = response.guid;
        session.guid = response.guid;
      }
      if (response.clientUuid) {
        globalSession.clientUuid = response.clientUuid;
        session.clientUuid = response.clientUuid;
      }
      writeLog(`✅ [Session] Cập nhật session thành công`);
    }
  } catch (e) {
    writeLog(`❌ [Session] Lỗi: ${e.message}`);
  }
}

function openAuthPopupWindow(parentWindow, loginUrl) {
  writeLog('🚀 [openAuthPopupWindow] BẮT ĐẦU MỞ POP-UP');
  if (!win || win.webContents.isDestroyed()) {
    writeLog('❌ [openAuthPopupWindow] win không tồn tại hoặc đã bị hủy');
    return;
  }

  if (!loginUrl || loginUrl === '') {
    writeLog('❌ [openAuthPopupWindow] loginUrl rỗng!');
    return;
  }

  writeLog(`🔗 [openAuthPopupWindow] Login URL: ${loginUrl}`);

  const authWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    parent: parentWindow,
    modal: true,
    show: true,
    title: 'Lenovo Login (Software Fix Mode)',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  writeLog('✅ [openAuthPopupWindow] Đã tạo authWindow');
  authWindow.webContents.openDevTools({ mode: 'detach' });
  authWindow.loadURL(loginUrl);

  authWindow.webContents.on('did-finish-load', () => {
    writeLog('✅ [openAuthPopupWindow] Pop-up load thành công');
    authWindow.show();
  });

  authWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    writeLog(`❌ [openAuthPopupWindow] Load thất bại: ${errorCode} - ${errorDescription}`);
    writeLog(`❌ [openAuthPopupWindow] URL: ${validatedURL}`);
  });

  const handleAuthRedirect = async (redirectUrl) => {
    writeLog(`🔄 [handleAuthRedirect] Redirect đến: ${redirectUrl}`);
    
    if (redirectUrl.startsWith('softwarefix://callback') || redirectUrl.includes('api/auth/callback')) {
      writeLog(`🎉 [handleAuthRedirect] BẮT ĐƯỢC CALLBACK!`);
      
      pendingCallbackUrl = redirectUrl;
      writeLog(`📌 [handleAuthRedirect] pendingCallbackUrl = ${pendingCallbackUrl}`);
      
      if (authWindow && !authWindow.isDestroyed() && !authWindow.webContents.isDestroyed()) {
        writeLog('🔒 [handleAuthRedirect] Đóng cửa sổ pop-up');
        setTimeout(() => { 
          if (!authWindow.isDestroyed()) authWindow.close(); 
        }, 50);
      }

      try {
        const urlObj = new URL(redirectUrl.replace('softwarefix://', 'http://'));
        const rawToken = urlObj.searchParams.get('Authorization');
        writeLog(`🔑 [handleAuthRedirect] Raw token: ${rawToken}`);
        
        if (rawToken) {
          const finalToken = rawToken.startsWith('Bearer ') ? rawToken : `Bearer ${rawToken}`;
          writeLog(`💎 [handleAuthRedirect] Final token: ${finalToken}`);

          const dataDir = path.join(process.cwd(), 'assets/data');
          if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

          const configPath = path.join(dataDir, 'config.json');
          let currentConfig = {};
          if (fs.existsSync(configPath)) {
            try { currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
          }
          
          currentConfig.authorizationToken = finalToken;
          fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf8');
          writeLog(`✅ [handleAuthRedirect] Đã ghi token vào file: ${configPath}`);

          await updateGlobalSession(finalToken);

          if (win && !win.isDestroyed() && win.webContents) {
            writeLog(`📨 [handleAuthRedirect] Gửi sự kiện auth:success cho Angular`);
            win.webContents.send('auth:success', { token: finalToken });
            
            win.webContents.executeJavaScript(`
              localStorage.setItem('auth_token', '${finalToken}');
              localStorage.setItem('authorizationToken', '${finalToken}');
              console.log('💾 [Renderer] Đã lưu token vào localStorage');
            `);
          }
        }
      } catch (err) {
        writeLog(`❌ [handleAuthRedirect] Lỗi: ${err.message}`);
      }
    }
  };

  authWindow.webContents.on('will-navigate', (event, url) => {
    writeLog(`🌐 [will-navigate] ${url}`);
    handleAuthRedirect(url);
  });
  authWindow.webContents.on('will-redirect', (event, url) => {
    writeLog(`🌐 [will-redirect] ${url}`);
    handleAuthRedirect(url);
  });
  authWindow.webContents.on('did-navigate', (event, url) => {
    writeLog(`🌐 [did-navigate] ${url}`);
    handleAuthRedirect(url);
  });
  authWindow.webContents.on('did-frame-navigate', (event, url) => {
    writeLog(`🌐 [did-frame-navigate] ${url}`);
    handleAuthRedirect(url);
  });
}

ipcMain.handle('get-lookup-result', async () => {
  return { ok: true };
});

function createWindow() {
  const configPath = path.join(process.cwd(), 'assets/data/config.json');
  if (fs.existsSync(configPath)) {
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      configData.authorizationToken = '';
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
      writeLog(`🗑️ [Main] Đã xóa token trong config.json khi mở app`);
    } catch (e) {}
  }

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      offscreen: false,
    },
    show: false,
    frame: true,
    titleBarStyle: 'default',
  });

  win.once('ready-to-show', () => {
    win.show();
    writeLog('✅ [Main] Window ready-to-show');
  });

  win.webContents.on('devtools-opened', () => {
    setTimeout(() => {
      win.webContents.executeJavaScript(`
        console.log("🚀 LENOVO FIRMWARE TOOL - QUICK COMMANDS");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("");
        console.log("📋 CODE:");
        console.log("window.desktopApi.lookupReadSupportByImei({model:{modelName:'YOUR_MODEL'},imei:'YOUR_IMEI',roCarrier:'reteu',channelId:'reteu'}).then(d=>console.log(d));");
        console.log("");
        console.log("📱 VÍ DỤ máy Razr 40 Ultra nhà mạng AT&T:");
        console.log("window.desktopApi.lookupReadSupportByImei({model:{modelName:'XT2321-1'},imei:'357354621261890',roCarrier:'att',channelId:'retus'}).then(d=>console.log(d));");
        console.log("");
        console.log("🇨🇳 MÁY NỘI ĐỊA TRUNG QUỐC (CMCC):");
        console.log("window.desktopApi.lookupReadSupportByParams({model:{modelName:'XT2537-4'},params:{fingerPrint:'motorola/mumba_cn/mumba:16/W1WAA36.48-23-10/1c41a-29619:user/release-keys','fsgVersion.qcom':'MUMBA_PVT_PRCDSDS_CUST',roCarrier:'cmcc',category:null},sn:'ZY32MMFP52',channelId:'cmcc'}).then(d=>console.log(d));");
        console.log("");
        console.log("📌 LƯU Ý: Máy Trung Quốc cần roCarrier, fingerprint và fsgVersion.qcom.");
        console.log("   Có thể lấy từ ADB:");
        console.log("   fingerPrint    → adb shell getprop ro.build.fingerprint");
        console.log("   fsgVersion.qcom → adb shell getprop vendor.ril.baseband.config.version");
        console.log("   roCarrier      → adb shell getprop ro.carrier");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("💡 Copy dòng bên trên, paste vào Console, Enter!");
      `);
    }, 500);
  });

  bootstrapSessionCookie().then(() => {
    writeLog('✅ [Main] Session cookie bootstrapped');
    
    // ===== KIỂM TRA TOKEN ĐÃ ĐỒNG BỘ CHƯA =====
    if (globalSession.jwt) {
      session.jwt = globalSession.jwt;
      writeLog(`✅ [Main] Token synced to core session on window creation`);
    }
  });

  win.webContents.on('did-finish-load', () => {
    writeLog('📝 [Main] Inject desktopApi...');
    
    if (isFirstLoad) {
      win.webContents.executeJavaScript(`
        localStorage.removeItem('auth_token');
        localStorage.removeItem('authorizationToken');
        console.log('🗑️ [Renderer] Đã xóa token trong localStorage (lần đầu)');
      `);
      isFirstLoad = false;
    }

    win.webContents.executeJavaScript(`
      window.desktopApi = {
        isDesktop: true,
        startAuth: () => {
          console.log('🔄 [Renderer] startAuth');
          return fetch('app://localhost/api/auth/start', { method: 'POST' })
            .then(res => res.json())
            .catch(err => ({ ok: false, error: err.message }));
        },
        startInAppAuth: () => Promise.resolve({ ok: true }),
        getStoredAuthState: () => {
          console.log('🔄 [Renderer] getStoredAuthState');
          const token = localStorage.getItem('auth_token');
          if (token) {
            return Promise.resolve({ ok: true, hasStoredAuthorizationToken: true, hasToken: true, token: token });
          }
          return fetch('app://localhost/api/auth/state')
            .then(res => res.json())
            .catch(err => ({ ok: false, error: err.message }));
        },
        consumePendingAuthCallback: () => {
          console.log('🔄 [Renderer] consumePendingAuthCallback');
          const token = localStorage.getItem('auth_token');
          if (token) {
            return Promise.resolve({ ok: true, callbackUrlOrToken: token, token: token });
          }
          return fetch('app://localhost/api/auth/callback')
            .then(res => res.json())
            .catch(err => ({ ok: false, error: err.message }));
        },
        completeAuth: (callbackUrlOrToken) => {
          console.log('🔄 [Renderer] completeAuth');
          return fetch('app://localhost/api/auth/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callbackUrlOrToken })
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        authWithStoredToken: () => {
          console.log('🔄 [Renderer] authWithStoredToken');
          const token = localStorage.getItem('auth_token');
          if (token) {
            return Promise.resolve({ ok: true, error: null });
          }
          return fetch('app://localhost/api/auth/state')
            .then(res => res.json())
            .catch(err => ({ ok: false, error: err.message }));
        },
        getCatalogModels: (refresh) => {
          console.log('🔥🔥🔥 [Renderer] getCatalogModels CALLED! refresh:', refresh);
          return fetch('app://localhost/api/catalog/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh: refresh || false })
          })
          .then(res => res.json())
          .then(data => {
            console.log('✅ [Renderer] Catalog response:', data);
            if (data.code === '0000' && data.content && Array.isArray(data.content)) {
              localStorage.setItem('catalog_models', JSON.stringify(data.content));
              localStorage.setItem('catalog_count', data.content.length.toString());
              console.log('💾 [Renderer] Đã lưu', data.content.length, 'models vào localStorage');
            }
            return { ok: true, ...data, data: data.content, models: data.content };
          })
          .catch(err => {
            console.error('❌ [Renderer] Catalog error:', err);
            return { ok: false, error: err.message };
          });
        },
        getReadSupportHints: (modelName) => {
      console.log('🔍 [Renderer] getReadSupportHints CALLED! Model:', modelName);
      
      return new Promise((resolve, reject) => {
        fetch('app://localhost/api/read-support/hints', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelName })
        })
        .then(res => {
          console.log('📦 [Renderer] Response status:', res.status);
          if (!res.ok) {
            throw new Error(\`HTTP \${res.status}\`);
          }
          return res.json();
        })
        .then(data => {
          console.log('✅ [Renderer] Raw response:', data);
          
          const result = {
            ok: true, 
            data: {          
              requiredParameters: data.params || [],
              platform: data.platform || '',
              modelName: modelName
              }
          };
          
          console.log('✅ [Renderer] Final data for Angular:', result);
          
          window._readSupportHintsData = result;

          resolve(result);
        })
        .catch(err => {
          console.error('❌ [Renderer] getReadSupportHints error:', err);
          const errorResult = { 
            params: [], 
            platform: '', 
            modelName: modelName,
            hints: [],
            error: err.message 
          };
          window._readSupportHintsData = errorResult;
          reject(new Error('Failed to load readSupport hints'));
        });
      });
    },
        lookupReadSupportByImei: (payload) => {
          console.log('🔍 [Renderer] lookupReadSupportByImei CALLED!');
          console.log('📦 [Renderer] Payload:', payload);
          return fetch('app://localhost/api/read-support/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .then(data => {
            console.log('✅ [Renderer] lookupReadSupportByImei response:', data);
            window._lastLookupResult = data;
            window.dispatchEvent(new CustomEvent('lookup:result', { detail: data }));
            return data;
          })
          .catch(err => {
            console.error('❌ [Renderer] lookupReadSupportByImei error:', err);
            const errorData = { code: 'ERROR', desc: err.message, content: { variants: [], total: 0 } };
            window._lastLookupResult = errorData;
            window.dispatchEvent(new CustomEvent('lookup:error', { detail: errorData }));
            return errorData;
          });
        },
        lookupReadSupportBySn: (payload) => {
          console.log('🔍 [Renderer] lookupReadSupportBySn CALLED!');
          console.log('📦 [Renderer] Payload:', payload);
          return fetch('app://localhost/api/read-support/lookup-sn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .then(data => {
            console.log('✅ [Renderer] lookupReadSupportBySn response:', data);
            window._lastLookupResult = data;
            window.dispatchEvent(new CustomEvent('lookup:result', { detail: data }));
            return data;
          })
          .catch(err => {
            console.error('❌ [Renderer] lookupReadSupportBySn error:', err);
            const errorData = { code: 'ERROR', desc: err.message, content: { variants: [], total: 0 } };
            window._lastLookupResult = errorData;
            window.dispatchEvent(new CustomEvent('lookup:error', { detail: errorData }));
            return errorData;
          });
        },
        lookupReadSupportByParams: (payload) => {
          console.log('🔍 [Renderer] lookupReadSupportByParams CALLED!');
          console.log('📦 [Renderer] Payload:', payload);
          return fetch('app://localhost/api/read-support/lookup-params', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .then(data => {
            console.log('✅ [Renderer] lookupReadSupportByParams response:', data);
            window._lastLookupResult = data;
            window.dispatchEvent(new CustomEvent('lookup:result', { detail: data }));
            return data;
          })
          .catch(err => {
            console.error('❌ [Renderer] lookupReadSupportByParams error:', err);
            const errorData = { code: 'ERROR', desc: err.message, content: { variants: [], total: 0 } };
            window._lastLookupResult = errorData;
            window.dispatchEvent(new CustomEvent('lookup:error', { detail: errorData }));
            return errorData;
          });
        },
        cancelDownload: (downloadId) => {
          console.log('🛑 [Renderer] cancelDownload called');
          const id = window._currentDownloadId;
          if (!id) {
            return Promise.resolve({ ok: false, error: 'No download in progress' });
          }
          return fetch('app://localhost/api/download/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId: id })
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        downloadFirmware: (firmwareData, modelName) => {
          console.log('📥 [Renderer] downloadFirmware CALLED!');
          const downloadId = 'download-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
          window._currentDownloadId = downloadId;
          const payload = {
            firmwareData: firmwareData,
            modelName: modelName || firmwareData.modelName || 'firmware',
            downloadId: downloadId
          };
          return fetch('app://localhost/api/download/firmware', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ code: 'ERROR', desc: err.message }));
        },
        openDownloadFolder: (path) => {
          console.log('📂 [Renderer] openDownloadFolder:', path);
          return fetch('app://localhost/api/open-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        getLastLookupResult: () => Promise.resolve(window._lastLookupResult || null),
        checkDesktopIntegration: () => Promise.resolve({ ok: true, isIntegrated: true }),
        getDesktopPromptPreference: () => Promise.resolve(true),
        checkFrameworkUpdate: () => Promise.resolve({ ok: true, hasUpdate: false }),
        getAppInfo: () => Promise.resolve({ ok: true, platform: 'darwin', version: '1.0.0' }),
        ping: () => Promise.resolve({ ok: true }),
        getPlayStoreStatus: () => {
          console.log('📦 [Renderer] getPlayStoreStatus');
          return fetch('app://localhost/api/playstore/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, available: false, error: err.message }));
        },
        listPlayStoreDownloads: () => {
          console.log('📦 [Renderer] listPlayStoreDownloads');
          return fetch('app://localhost/api/playstore/downloads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message, downloads: [] }));
        },
        searchPlayStoreApps: (payload) => {
          console.log('🔍 [Renderer] searchPlayStoreApps');
          return fetch('app://localhost/api/playstore/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message, results: [] }));
        },
        getPlayStoreAppDetails: (payload) => {
          console.log('📦 [Renderer] getPlayStoreAppDetails');
          return fetch('app://localhost/api/playstore/details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        downloadPlayStoreApp: (payload) => {
          console.log('📥 [Renderer] downloadPlayStoreApp');
          return fetch('app://localhost/api/playstore/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        deletePlayStoreDownload: (payload) => {
          console.log('🗑️ [Renderer] deletePlayStoreDownload');
          return fetch('app://localhost/api/playstore/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        installPlayStoreApp: (payload) => {
          console.log('📲 [Renderer] installPlayStoreApp');
          return fetch('app://localhost/api/playstore/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        listBackupRestoreSnapshots: () => {
          console.log('💾 [Renderer] listBackupRestoreSnapshots');
          return fetch('app://localhost/api/backup/snapshots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message, snapshots: [] }));
        },
        scanConnectedBackupPreview: () => {
          console.log('🔍 [Renderer] scanConnectedBackupPreview');
          return fetch('app://localhost/api/backup/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, connected: false, error: err.message }));
        },
        getConnectedBackupPreviewProgress: () => {
          console.log('📊 [Renderer] getConnectedBackupPreviewProgress');
          return fetch('app://localhost/api/backup/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        cancelConnectedBackupProcess: () => {
          console.log('🛑 [Renderer] cancelConnectedBackupProcess');
          return fetch('app://localhost/api/backup/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        backupConnectedDevice: (payload) => {
          console.log('💾 [Renderer] backupConnectedDevice');
          return fetch('app://localhost/api/backup/device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {})
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, connected: false, error: err.message }));
        },
        restoreBackupSnapshot: (payload) => {
          console.log('🔄 [Renderer] restoreBackupSnapshot');
          return fetch('app://localhost/api/backup/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, connected: false, error: err.message }));
        },
        deleteBackupSnapshot: (payload) => {
          console.log('🗑️ [Renderer] deleteBackupSnapshot');
          return fetch('app://localhost/api/backup/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        listLocalDownloadedFiles: () => {
          console.log('📂 [Renderer] listLocalDownloadedFiles');
          return fetch('app://localhost/api/local/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message, files: [] }));
        },
        extractLocalFirmware: (payload) => {
          console.log('📦 [Renderer] extractLocalFirmware');
          return fetch('app://localhost/api/local/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        deleteLocalFile: (payload) => {
          console.log('🗑️ [Renderer] deleteLocalFile');
          return fetch('app://localhost/api/local/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        getWindowsQdloaderDriverStatus: () => {
          return fetch('app://localhost/api/driver/qdloader/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, installed: false, error: err.message }));
        },
        attachLocalRecipeFromModel: (payload) => {
  console.log('📦 [Renderer] attachLocalRecipeFromModel');
  return fetch('app://localhost/api/local/attach-recipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .catch(err => ({ ok: false, error: err.message }));
},
attachLocalRecipeMetadata: (payload) => {
  console.log('📦 [Renderer] attachLocalRecipeMetadata');
  return fetch('app://localhost/api/local/attach-recipe-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .catch(err => ({ ok: false, error: err.message }));
},
// main.electron.js - TRONG window.desktopApi
getRecipeContent: (payload) => {
  console.log('📦 [Renderer] getRecipeContent');
  return fetch('app://localhost/api/recipe/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .catch(err => ({ ok: false, error: err.message }));
},
parseFlashfile: (payload) => {
  console.log('📦 [Renderer] parseFlashfile');
  return fetch('app://localhost/api/recipe/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .catch(err => ({ ok: false, error: err.message }));
},
// main.electron.js - TRONG window.desktopApi
attachLocalRecipeFromModel: (payload) => {
  console.log('📦 [Renderer] attachLocalRecipeFromModel');
  return fetch('app://localhost/api/local/attach-recipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .catch(err => ({ ok: false, error: err.message }));
},
attachLocalRecipeMetadata: (payload) => {
  console.log('📦 [Renderer] attachLocalRecipeMetadata');
  return fetch('app://localhost/api/local/attach-recipe-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .catch(err => ({ ok: false, error: err.message }));
},
        installWindowsQdloaderDriver: () => {
          return fetch('app://localhost/api/driver/qdloader/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          .then(res => res.json())
          .catch(err => ({ ok: false, error: err.message }));
        },
        rescueLiteFirmware: (payload) => {
  console.log('🔧 [Renderer] rescueLiteFirmware CALLED!', payload);
  return fetch('app://localhost/api/rescue/lite/firmware', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  .then(res => res.json())
  .then(data => {
    console.log('✅ [Renderer] rescueLiteFirmware response:', data);
    return data;
  })
  .catch(err => {
    console.error('❌ [Renderer] rescueLiteFirmware error:', err);
    return { ok: false, error: err.message };
  });
},
rescueLiteFirmwareFromLocal: (payload) => {
  console.log('🔧 [Renderer] rescueLiteFirmwareFromLocal CALLED!', payload);
  return fetch('app://localhost/api/rescue/lite/firmware/local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  .then(res => res.json())
  .then(data => {
    console.log('✅ [Renderer] rescueLiteFirmwareFromLocal response:', data);
    return data;
  })
  .catch(err => {
    console.error('❌ [Renderer] rescueLiteFirmwareFromLocal error:', err);
    return { ok: false, error: err.message };
  });
},
        setupIpcListener: () => {
          console.log('🔄 [Renderer] Setting up IPC listener...');
          try {
            const ipcRenderer = require('electron').ipcRenderer;
            ipcRenderer.on('read-support:hints-loaded', (event, data) => {
              console.log('📨 [Renderer] IPC event received:', data);
              window._readSupportHintsData = data;
              window.dispatchEvent(new CustomEvent('read-support:hints-loaded-ipc', { detail: data }));
            });
            console.log('✅ [Renderer] IPC listener registered for read-support:hints-loaded');
            return Promise.resolve({ ok: true });
          } catch (err) {
            console.error('❌ [Renderer] Failed to setup IPC listener:', err);
            return Promise.resolve({ ok: false, error: err.message });
          }
        }
      };
      
      // ===== GỌI SETUP IPC LISTENER =====
      window.desktopApi.setupIpcListener();
      
      console.log('✅ [Renderer] desktopApi injected with all functions from original project!');
      console.log('✅ [Renderer] Available functions:', Object.keys(window.desktopApi));
      
      window.addEventListener('lookup:result', (event) => {
        console.log('📨 [Renderer] Received lookup:result event:', event.detail);
      });
      
      window.addEventListener('lookup:error', (event) => {
        console.log('📨 [Renderer] Received lookup:error event:', event.detail);
      });
    `);
  });

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let pathname = url.pathname;
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    writeLog(`📡 [Protocol] Request: ${request.method} ${pathname}`);
    writeLog(`📡 [Protocol] Full URL: ${request.url}`);

    const corsHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    if (request.method === 'OPTIONS') {
      return new Response('', { status: 204, headers: corsHeaders });
    }

    // ===== AUTH =====
    if (pathname.includes('/api/auth/state') && !pathname.includes('complete')) {
      writeLog(`🔍 [Protocol] Angular kiểm tra state`);
      const hasToken = checkStoredTokenStatus();
      return new Response(JSON.stringify({ 
        ok: true, 
        hasStoredAuthorizationToken: hasToken, 
        hasToken: hasToken 
      }), { headers: corsHeaders });
    }

    if (pathname.includes('/api/auth/start')) {
      writeLog(`🔑 [Protocol] Angular gọi /api/auth/start`);
      setTimeout(() => { openAuthPopupWindow(win, getRealLenovoLoginUrl()); }, 0);
      return new Response(JSON.stringify({ ok: true, openedInExternalBrowser: true }), { headers: corsHeaders });
    }

    if (pathname.includes('/api/auth/callback')) {
      writeLog(`🔍 [Protocol] Angular GỌI CALLBACK!`);
      const callbackUrl = pendingCallbackUrl;
      let token = null;

      if (callbackUrl) {
        try {
          const urlObj = new URL(callbackUrl.replace('softwarefix://', 'http://'));
          token = urlObj.searchParams.get('Authorization');
          if (token && !token.startsWith('Bearer ')) {
            token = `Bearer ${token}`;
          }
          writeLog(`🔑 [Protocol] Token từ callback: ${token}`);
          pendingCallbackUrl = null;
        } catch (e) {
          writeLog(`❌ [Protocol] Lỗi parse callback: ${e.message}`);
        }
      }

      if (!token) {
        try {
          const configPath = path.join(process.cwd(), 'assets/data/config.json');
          if (fs.existsSync(configPath)) {
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            token = configData.authorizationToken;
            writeLog(`📂 [Protocol] Token từ file config: ${token}`);
          }
        } catch (e) {}
      }

      if (!token) {
        writeLog(`❌ [Protocol] KHÔNG CÓ TOKEN!`);
        return new Response(JSON.stringify({ error: 'No token' }), { 
          status: 400,
          headers: corsHeaders 
        });
      }

      globalSession.jwt = token;
      session.jwt = globalSession.jwt;
      await updateGlobalSession(token);

      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.executeJavaScript(`
          localStorage.setItem('auth_token', '${token}');
          localStorage.setItem('authorizationToken', '${token}');
          console.log('💾 [Renderer] Đã lưu token vào localStorage');
        `);
      }

      return new Response(JSON.stringify({ token: token }), { 
        headers: corsHeaders 
      });
    }

    if (pathname.includes('/api/auth/complete')) {
      return new Response(JSON.stringify({ ok: true, error: null }), { headers: corsHeaders });
    }

    // ===== READ SUPPORT HINTS =====
    if (pathname.includes('/api/read-support/hints')) {
      writeLog(`🔍 [Protocol] getReadSupportHints called`);
      
      try {
        const body = await request.json();
        const { modelName } = body;
        
        if (!modelName) {
          return new Response(JSON.stringify({ 
            params: [], 
            platform: ''
          }), { status: 400, headers: corsHeaders });
        }
        
        const result = await getReadSupportHints(modelName);
        
        const responseData = {
          params: result.requiredParameters || [],
          platform: result.platform || ''
        };
        
        // ===== GỬI EVENT QUA IPC CHO ANGULAR =====
        if (win && !win.isDestroyed()) {
          win.webContents.send('read-support:hints-loaded', {
            modelName: modelName,
            params: responseData.params || [],
            platform: responseData.platform || '',
            hints: responseData.params || []
          });
          writeLog(`📨 [Protocol] Sent read-support:hints-loaded IPC event to Angular`);
        }
        
        writeLog(`📦 [Protocol] Returning: ${JSON.stringify(responseData)}`);
        
        return new Response(JSON.stringify(responseData), { headers: corsHeaders });
      } catch (error) {
        writeLog(`❌ [Protocol] getReadSupportHints error: ${error.message}`);
        return new Response(JSON.stringify({ 
          params: [], 
          platform: ''
        }), { status: 500, headers: corsHeaders });
      }
    }

    if (pathname.includes('/api/read-support/lookup') && !pathname.includes('/api/read-support/lookup-sn') && !pathname.includes('/api/read-support/lookup-params')) {
      writeLog(`🔍 [Protocol] lookupReadSupportByImei called`);
      
      try {
        const payload = await request.json();
        writeLog(`📦 [Protocol] Payload: ${JSON.stringify(payload)}`);
        
        if (!payload.imei) {
          return new Response(JSON.stringify({ 
            code: 'ERROR', 
            desc: 'IMEI is required',
            content: { variants: [], total: 0 }
          }), { status: 400, headers: corsHeaders });
        }
        
        const result = await lookupReadSupportByImei(payload);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      } catch (error) {
        writeLog(`❌ [Protocol] lookupReadSupportByImei error: ${error.message}`);
        const errorResult = {
          code: 'ERROR',
          desc: error.message,
          content: { variants: [], total: 0 }
        };
        return new Response(JSON.stringify(errorResult), { status: 500, headers: corsHeaders });
      }
    }

    if (pathname.includes('/api/read-support/lookup-sn')) {
      writeLog(`🔍 [Protocol] lookupReadSupportBySn called`);
      
      try {
        const payload = await request.json();
        writeLog(`📦 [Protocol] Payload: ${JSON.stringify(payload)}`);
        
        if (!payload.sn) {
          return new Response(JSON.stringify({ 
            code: 'ERROR', 
            desc: 'SN is required',
            content: { variants: [], total: 0 }
          }), { status: 400, headers: corsHeaders });
        }
        
        const result = await lookupReadSupportBySn(payload);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      } catch (error) {
        writeLog(`❌ [Protocol] lookupReadSupportBySn error: ${error.message}`);
        return new Response(JSON.stringify({ 
          code: 'ERROR', 
          desc: error.message,
          content: { variants: [], total: 0 }
        }), { status: 500, headers: corsHeaders });
      }
    }

    if (pathname.includes('/api/read-support/lookup-params')) {
      writeLog(`🔍 [Protocol] lookupReadSupportByParams called`);
      
      try {
        const payload = await request.json();
        writeLog(`📦 [Protocol] Payload: ${JSON.stringify(payload)}`);
        
        if (!payload.model || !payload.params) {
          return new Response(JSON.stringify({ 
            code: 'ERROR', 
            desc: 'Model and params are required',
            content: { variants: [], total: 0 }
          }), { status: 400, headers: corsHeaders });
        }
        
        const result = await lookupReadSupportByParams(payload);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      } catch (error) {
        writeLog(`❌ [Protocol] lookupReadSupportByParams error: ${error.message}`);
        return new Response(JSON.stringify({ 
          code: 'ERROR', 
          desc: error.message,
          content: { variants: [], total: 0 }
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ===== DOWNLOAD =====
    if (pathname.includes('/api/download/firmware')) {
      writeLog(`📥 [Protocol] Download firmware called`);
      
      try {
        const body = await request.json();
        let { firmwareData, modelName, downloadId } = body;
        
        if (!downloadId) {
          downloadId = `download-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        }

        writeLog(`📦 [Protocol] Download ID: ${downloadId}`);
        writeLog(`📦 [Protocol] FirmwareData received: ${JSON.stringify(firmwareData)}`);
        
        if (firmwareData.romUrl && !firmwareData.romResource) {
          writeLog(`🔄 [Protocol] Đang chuyển đổi dữ liệu đơn giản sang format đầy đủ...`);
          
          firmwareData.romResource = {
            uri: firmwareData.romUrl,
            name: firmwareData.romName || 'rom.zip',
            fileSize: firmwareData.fileSize || 0,
            fileSha1: firmwareData.fileSha1 || '',
            romVersion: firmwareData.romVersion || '',
            releaseDate: firmwareData.releaseDate || firmwareData.publishDate || '',
            osVersion: firmwareData.osVersion || '',
            language: firmwareData.language || '',
            publishDate: firmwareData.publishDate || ''
          };
          
          if (firmwareData.flashFlowUrl) {
            firmwareData.flashFlowUrl = firmwareData.flashFlowUrl;
          }
          
          if (firmwareData.toolUrl) {
            firmwareData.toolResource = {
              uri: firmwareData.toolUrl,
              name: firmwareData.toolName || 'tool.zip'
            };
          }
          
          writeLog(`✅ [Protocol] Đã chuyển đổi thành công!`);
          writeLog(`📦 [Protocol] ROM Resource: ${JSON.stringify(firmwareData.romResource)}`);
        }
        
        const result = await downloadFirmware(firmwareData, { 
          modelName: modelName || firmwareData.modelName || 'firmware',
          downloadId: downloadId 
        });
        
        writeLog(`📥 [downloadFirmware] KẾT QUẢ: ${JSON.stringify(result)}`);
        
        if (win && !win.isDestroyed()) {
          win.webContents.send('download:completed', {
            code: result.allCompleted ? '0000' : 'PARTIAL',
            desc: result.allCompleted ? 'Download completed successfully' : 'Some files failed to download',
            content: result
          });
        }
        
        return new Response(JSON.stringify({
          code: result.allCompleted ? '0000' : 'PARTIAL',
          desc: result.allCompleted ? 'Download completed successfully' : 'Some files failed to download',
          content: result
        }), { headers: corsHeaders });
        
      } catch (error) {
        writeLog(`❌ [Protocol] Download error: ${error.message}`);
        writeLog(`❌ [Protocol] Stack: ${error.stack}`);
        
        if (win && !win.isDestroyed()) {
          win.webContents.send('download:error', {
            error: error.message,
            modelName: modelName || 'firmware'
          });
        }
        
        return new Response(JSON.stringify({ 
          code: 'ERROR', 
          desc: error.message 
        }), { status: 500, headers: corsHeaders });
      }
    }

    if (pathname.includes('/api/download/cancel')) {
      writeLog(`🛑 [Protocol] Cancel download called`);
      
      try {
        const body = await request.json();
        let downloadId = body.downloadId;
        
        writeLog(`📦 [Protocol] Cancel body: ${JSON.stringify(body)}`);
        writeLog(`📦 [Protocol] downloadId nhận được: ${downloadId}`);
        
        if (typeof downloadId === 'string' && !downloadId.startsWith('download-')) {
          const oldId = downloadId;
          downloadId = `download-${downloadId}`;
          writeLog(`🔄 [Protocol] Thêm prefix: ${oldId} -> ${downloadId}`);
        }
        
        if (typeof downloadId === 'object' && downloadId !== null) {
          downloadId = downloadId.downloadId || downloadId.id || String(downloadId);
          if (!downloadId.startsWith('download-')) {
            downloadId = `download-${downloadId}`;
          }
        }
        
        downloadId = String(downloadId);
        writeLog(`🛑 [Protocol] Cancelling download: ${downloadId}`);
        
        writeLog(`📦 [Protocol] Active downloads: ${Array.from(activeDownloads.keys()).join(', ')}`);
        
        const downloadEntry = activeDownloads.get(downloadId);
        if (downloadEntry && typeof downloadEntry.cancel === 'function') {
          writeLog(`✅ [Protocol] Found download ${downloadId}, cancelling...`);
          downloadEntry.cancel();
          activeDownloads.delete(downloadId);
          
          if (win && !win.isDestroyed()) {
            win.webContents.send('download:cancelled', { 
              downloadId: downloadId,
              message: 'Download cancelled by user'
            });
          }
          
          return new Response(JSON.stringify({ 
            ok: true,
            message: 'Download cancelled successfully'
          }), { headers: corsHeaders });
        } else {
          writeLog(`⚠️ [Protocol] Download ${downloadId} not found`);
          writeLog(`📦 [Protocol] Available IDs: ${Array.from(activeDownloads.keys()).join(', ')}`);
          return new Response(JSON.stringify({ 
            ok: false,
            error: 'Download not found or already completed'
          }), { status: 404, headers: corsHeaders });
        }
        
      } catch (error) {
        writeLog(`❌ [Protocol] Cancel error: ${error.message}`);
        return new Response(JSON.stringify({ 
          ok: false,
          error: error.message
        }), { status: 500, headers: corsHeaders });
      }
    }

// ===== RESCUE LITE FIRMWARE =====
if (pathname.includes('/api/rescue/lite/firmware')) {
  try {
    const body = await request.json();
    const result = await rescueLiteFirmware(body);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}

if (pathname.includes('/api/rescue/lite/firmware/local')) {
  try {
    const body = await request.json();
    const result = await rescueLiteFirmwareFromLocal(body);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}

// ===== ATTACH RECIPE =====
if (pathname.includes('/api/local/attach-recipe')) {
  try {
    const body = await request.json();
    const result = await attachLocalRecipeFromModel(body);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}

if (pathname.includes('/api/local/attach-recipe-metadata')) {
  try {
    const body = await request.json();
    const result = await attachLocalRecipeMetadata(body);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}

// ===== GET RECIPE CONTENT =====
if (pathname.includes('/api/recipe/content')) {
  try {
    const body = await request.json();
    const result = await getRecipeContent(body);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}

// ===== PARSE FLASHFILE =====
if (pathname.includes('/api/recipe/parse')) {
  try {
    const body = await request.json();
    const result = await parseFlashfile(body);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}

    // ===== OPEN FOLDER =====
    if (pathname.includes('/api/open-folder')) {
      writeLog(`📂 [Protocol] Open folder called`);
      
      try {
        const body = await request.json();
        const { path: folderPath } = body;
        
        if (!folderPath) {
          return new Response(JSON.stringify({ 
            ok: false, 
            error: 'Path is required' 
          }), { status: 400, headers: corsHeaders });
        }
        
        if (fs.existsSync(folderPath)) {
          shell.showItemInFolder(folderPath);
          return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({ 
            ok: false, 
            error: 'Folder does not exist' 
          }), { status: 404, headers: corsHeaders });
        }
        
      } catch (error) {
        writeLog(`❌ [Protocol] Open folder error: ${error.message}`);
        return new Response(JSON.stringify({ 
          ok: false, 
          error: error.message 
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ===== CATALOG =====
    if (pathname.includes('/api/catalog/models')) {
      writeLog(`🔍 [Protocol] Angular gọi /api/catalog/models`);
      
      try {
        let body = null;
        try {
          body = await request.json();
        } catch (e) {}
        
        writeLog(`📦 [Protocol] Body: ${JSON.stringify(body)}`);
        
        const refresh = body?.refresh || false;
        const result = await getModelNames(refresh);
        
        if (result.code === '0000' && result.content && Array.isArray(result.content) && win && !win.isDestroyed()) {
          const modelsData = JSON.stringify(result.content);
          const count = result.content.length;
          win.webContents.executeJavaScript(`
            try {
              const models = ${modelsData};
              if (models && models.length > 0) {
                localStorage.setItem('catalog_models', JSON.stringify(models));
                localStorage.setItem('catalog_count', '${count}');
                console.log('💾 [Renderer] Đã lưu ${count} models vào localStorage');
              }
            } catch(e) {
              console.error('❌ [Renderer] Lỗi lưu catalog:', e);
            }
          `);
        }
        
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      } catch (error) {
        writeLog(`❌ [Protocol] Catalog error: ${error.message}`);
        return new Response(JSON.stringify({ 
          code: 'ERROR', 
          desc: error.message 
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ===== PLAY STORE =====
    if (pathname.includes('/api/playstore/status')) {
      try { 
        const result = await getPlayStoreStatus();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, available: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/playstore/downloads')) {
      try { 
        const result = await listPlayStoreDownloads();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message, downloads: [] }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/playstore/search')) {
      try { 
        const body = await request.json(); 
        const result = await searchPlayStoreApps(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message, results: [] }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/playstore/details')) {
      try { 
        const body = await request.json(); 
        const result = await getPlayStoreAppDetails(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/playstore/download')) {
      try { 
        const body = await request.json(); 
        const result = await downloadPlayStoreApp(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/playstore/delete')) {
      try { 
        const body = await request.json(); 
        const result = await deletePlayStoreDownload(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/playstore/install')) {
      try { 
        const body = await request.json(); 
        const result = await installPlayStoreApp(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    // ===== BACKUP =====
    if (pathname.includes('/api/backup/snapshots')) {
      try { 
        const result = await listBackupRestoreSnapshots();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message, snapshots: [] }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/backup/scan')) {
      try { 
        const result = await scanConnectedBackupPreview();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, connected: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/backup/progress')) {
      try { 
        const result = await getConnectedBackupPreviewProgress();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/backup/cancel')) {
      try { 
        const result = await cancelConnectedBackupProcess();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/backup/device')) {
      try { 
        const body = await request.json(); 
        const result = await backupConnectedDevice(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, connected: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/backup/restore')) {
      try { 
        const body = await request.json(); 
        const result = await restoreBackupSnapshot(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, connected: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/backup/delete')) {
      try { 
        const body = await request.json(); 
        const result = await deleteBackupSnapshot(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    // ===== LOCAL FILES =====
    if (pathname.includes('/api/local/files')) {
      try { 
        const result = await listLocalDownloadedFiles();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message, files: [] }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/local/extract')) {
      try { 
        const body = await request.json(); 
        const result = await extractLocalFirmware(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/local/delete')) {
      try { 
        const body = await request.json(); 
        const result = await deleteLocalFile(body);
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    // ===== DRIVERS =====
    if (pathname.includes('/api/driver/qdloader/status')) {
      try { 
        const result = await getWindowsQdloaderDriverStatus();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, installed: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    if (pathname.includes('/api/driver/qdloader/install')) {
      try { 
        const result = await installWindowsQdloaderDriver();
        return new Response(JSON.stringify(result), { headers: corsHeaders }); 
      } catch (error) { 
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders }); 
      }
    }

    // ===== STATIC FILES =====
    if (pathname.includes('/models-catalog.json')) {
      writeLog(`📂 [Protocol] Phục vụ file models-catalog.json`);
      try {
        const modelsPath = path.join(process.cwd(), 'assets/data/models-catalog.json');
        if (fs.existsSync(modelsPath)) {
          const content = fs.readFileSync(modelsPath, 'utf8');
          writeLog(`✅ [Protocol] Đã đọc file models-catalog.json (${content.length} bytes)`);
          return new Response(content, {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      } catch (e) {
        writeLog(`❌ [Protocol] Lỗi đọc models-catalog.json: ${e.message}`);
      }
    }

    if (pathname.includes('config.json')) {
      try {
        const activeConfigPath = path.join(process.cwd(), 'assets/data/config.json');
        if (fs.existsSync(activeConfigPath)) {
          return new Response(fs.readFileSync(activeConfigPath), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
      } catch (e) {}
    }

    try {
      const filePath = path.join(process.cwd(), 'web/dist/web/browser', pathname);
      let mimeType = 'text/html';
      if (pathname.endsWith('.js')) mimeType = 'text/javascript';
      else if (pathname.endsWith('.css')) mimeType = 'text/css';

      return new Response(fs.readFileSync(filePath), {
        headers: { 'Content-Type': mimeType, 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response('File Not Found', { status: 404 });
    }
  });

  win.loadURL('app://localhost/');
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  writeLog('🚀 [macOS] Hệ điều hành chuyển giao link hồi hướng về app: ' + url);
  pendingCallbackUrl = url;
});

app.whenReady().then(() => { 
  writeLog('🚀 [App] App đã sẵn sàng, tạo cửa sổ...');
  createWindow(); 
});

app.on('before-quit', (event) => {
  writeLog('🛑 [App] Đang đóng app, cleanup...');
  
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  
  if (win && !win.isDestroyed()) {
    win.close();
  }
});

app.on('window-all-closed', () => { 
  if (process.platform !== 'darwin') app.quit(); 
});