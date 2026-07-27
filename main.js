const { app, BrowserWindow, ipcMain, Menu, dialog, Tray, nativeImage } = require('electron');
const axios = require('axios');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');
const iconv = require('iconv-lite');
const sharp = require('sharp');

const store = new Store({
  name: 'funds-data',
  defaults: {
    funds: [],
    groups: ['默认分组'],
    settings: {
      autoUpdate: true,
      morningStart: '09:30',
      morningEnd: '11:31',
      afternoonStart: '13:00',
      afternoonEnd: '15:01',
      showMenuBar: true
    }
  }
});

let mainWindow = null;
let tray = null;

// ---------- 窗口创建 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 740,
    title: '基金估值速查',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  Menu.setApplicationMenu(null);

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------- 托盘图标生成（sharp 生成带文字的 PNG） ----------
async function createTrayIcon() {
  const width = 18;
  const height = 18;
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" rx="2" fill="#000000"/>
      <text x="${width/2}" y="${height-5}" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="bold" fill="white" text-anchor="middle">估</text>
    </svg>
  `;
  try {
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    const image = nativeImage.createFromBuffer(buffer);
    image.setTemplateImage(true); // 深浅色自适应
    return image;
  } catch (error) {
    console.warn('⚠️ SVG 生成图标失败，使用纯色备选', error);
    // 备选：纯黑色方块
    const fallbackBuffer = Buffer.alloc(width * height * 4);
    for (let i = 0; i < fallbackBuffer.length; i += 4) {
      fallbackBuffer[i] = 0;
      fallbackBuffer[i+1] = 0;
      fallbackBuffer[i+2] = 0;
      fallbackBuffer[i+3] = 255;
    }
    const image = nativeImage.createFromBuffer(fallbackBuffer, { width, height });
    image.setTemplateImage(true);
    return image;
  }
}

function createTray() {
  createTrayIcon().then(icon => {
    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
          } else {
            createWindow();
            mainWindow.show();
          }
        }
      },
      {
        label: '退出',
        click: () => {
          app.exit(0);
        }
      }
    ]);
    tray.setToolTip('基金估值速查');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      } else {
        createWindow();
        mainWindow.show();
      }
    });
  }).catch(err => {
    console.error('创建托盘失败:', err);
  });
}

function applyMenuBarSetting() {
  if (process.platform === 'darwin') {
    const show = store.get('settings.showMenuBar', true);
    if (show) {
      app.dock.hide();
      if (!tray) createTray();
    } else {
      app.dock.show();
      if (tray) {
        tray.destroy();
        tray = null;
      }
    }
  }
}

// ---------- 存储操作 ----------
ipcMain.handle('load-funds', () => store.get('funds', []));
ipcMain.handle('save-funds', (event, funds) => { store.set('funds', funds); return true; });
ipcMain.handle('load-groups', () => store.get('groups', ['默认分组']));
ipcMain.handle('save-groups', (event, groups) => { store.set('groups', groups); return true; });
ipcMain.handle('load-settings', () => store.get('settings', {}));
ipcMain.handle('save-settings', (event, settings) => {
  store.set('settings', settings);
  applyMenuBarSetting();
  return true;
});

// ---------- 数据源函数 ----------

// 1. 天天基金（JSONP）
async function fetchFromTiantian(code) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    responseType: 'text'
  });
  const jsonpStr = response.data;
  const jsonStr = jsonpStr.replace(/^jsonpgz\(/, '').replace(/\);$/, '');
  const data = JSON.parse(jsonStr);
  return {
    code: data.fundcode,
    name: data.name,
    nav: parseFloat(data.dwjz || data.nav || 0),
    gsz: parseFloat(data.gsz),
    gszzl: parseFloat(data.gszzl),
    gztime: data.gztime,
    source: '天天基金'
  };
}

// 2. 腾讯证券（JSON）
async function fetchFromTencent(code) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fund/fundInfo?code=jj${code}`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const json = response.data;
  if (json.code !== 0) throw new Error('腾讯接口返回错误');
  const dataKey = `jj${code}`;
  const fundInfo = json.data?.[dataKey]?.fundinfo;
  if (!fundInfo) throw new Error('腾讯数据缺失');
  return {
    code: fundInfo.code || code,
    name: fundInfo.name,
    nav: parseFloat(fundInfo.nav || fundInfo.netvalue || 0),
    gsz: parseFloat(fundInfo.gsz || fundInfo.estimate || 0),
    gszzl: parseFloat(fundInfo.gszzl || fundInfo.estimatet || 0),
    gztime: fundInfo.gztime || fundInfo.time || new Date().toLocaleString(),
    source: '腾讯证券'
  };
}

// 3. 新浪基金（CSV，GBK）
async function fetchFromSina(code) {
  const url = `https://hq.sinajs.cn/list=f_${code}`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
    responseType: 'arraybuffer'
  });
  const text = iconv.decode(response.data, 'gbk');
  const match = text.match(/var hq_str_f_\w+="([^"]+)"/);
  if (!match) throw new Error('新浪数据解析失败');
  const parts = match[1].split(',');
  if (parts.length < 4) throw new Error('新浪数据字段不足');
  const name = parts[0];
  const gsz = parseFloat(parts[1]);
  const gszzl = parseFloat(parts[2]);
  const gztime = parts[3] || new Date().toLocaleString();
  return {
    code: code,
    name: name,
    nav: gsz, // 新浪无昨日净值，用估算代替（仅用于显示）
    gsz: gsz,
    gszzl: gszzl,
    gztime: gztime,
    source: '新浪基金'
  };
}

const SOURCES = [
  { name: 'tiantian', fetch: fetchFromTiantian },
  { name: 'tencent', fetch: fetchFromTencent },
  { name: 'sina', fetch: fetchFromSina }
];

async function fetchFundValue(code) {
  let lastError = null;
  for (const source of SOURCES) {
    try {
      const result = await source.fetch(code);
      if (!result.gsz || isNaN(result.gsz)) {
        throw new Error(`数据无效: gsz=${result.gsz}`);
      }
      console.log(`✅ 基金 ${code} 使用源: ${result.source}`);
      return result;
    } catch (error) {
      console.warn(`❌ 源 ${source.name} 失败:`, error.message);
      lastError = error;
    }
  }
  throw new Error(`所有数据源均失败: ${lastError?.message || '未知错误'}`);
}

// ---------- IPC 处理 ----------
ipcMain.handle('fetch-fund', async (event, code) => {
  try {
    const data = await fetchFundValue(code);
    return { ...data, status: 'success' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
});

ipcMain.handle('fetch-multiple-funds', async (event, fundList) => {
  const promises = fundList.map(async (item) => {
    try {
      const val = await fetchFundValue(item.code);
      const currentFunds = store.get('funds', []);
      const idx = currentFunds.findIndex(f => f.code === item.code);
      if (idx !== -1 && currentFunds[idx].name !== val.name) {
        currentFunds[idx].name = val.name;
        store.set('funds', currentFunds);
      }
      return {
        ...val,
        costPrice: item.costPrice,
        shares: item.shares,
        profit: (val.gsz - item.costPrice) * item.shares,
        profitRate: ((val.gsz - item.costPrice) / item.costPrice * 100),
        status: 'success'
      };
    } catch (error) {
      return {
        code: item.code,
        status: 'error',
        message: error.message,
        costPrice: item.costPrice,
        shares: item.shares
      };
    }
  });
  return Promise.all(promises);
});

// ---------- 导入导出（含分组） ----------
ipcMain.handle('export-funds', async () => {
  const funds = store.get('funds', []);
  if (!funds.length) {
    return { success: false, message: '没有基金可导出' };
  }
  const exportData = funds.map(f => ({
    code: f.code,
    name: f.name || '',
    cyfe: f.shares,
    cbj: f.costPrice,
    group: f.group || '默认分组',
    zdfRange: 1
  }));
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出基金列表',
    defaultPath: 'funds_export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) {
    return { success: false, message: '取消导出' };
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf8');
    return { success: true, message: `导出成功: ${path.basename(filePath)}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('import-funds', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '导入基金列表',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || filePaths.length === 0) {
    return { success: false, message: '取消导入' };
  }
  try {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    const imported = JSON.parse(content);
    if (!Array.isArray(imported)) {
      return { success: false, message: '文件格式错误：应为数组' };
    }
    const currentFunds = store.get('funds', []);
    const map = new Map();
    currentFunds.forEach(f => map.set(f.code, f));
    const allGroups = new Set(store.get('groups', ['默认分组']));
    imported.forEach(item => {
      if (item.code) {
        const group = item.group || '默认分组';
        allGroups.add(group);
        map.set(item.code, {
          code: item.code,
          name: item.name || '',
          costPrice: item.cbj || item.costPrice || 0,
          shares: item.cyfe || item.shares || 0,
          group: group
        });
      }
    });
    const merged = Array.from(map.values());
    store.set('funds', merged);
    store.set('groups', Array.from(allGroups));
    return { success: true, message: `导入成功，共 ${merged.length} 条记录` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------- 应用启动 ----------
app.whenReady().then(() => {
  createWindow();
  applyMenuBarSetting();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
