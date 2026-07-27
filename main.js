const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const axios = require('axios');
const path = require('path');
const Store = require('electron-store');

const store = new Store({
  name: 'funds-data',
  defaults: {
    funds: [],
    settings: {
      autoUpdate: true,
      morningStart: '09:30',
      morningEnd: '11:31',
      afternoonStart: '13:00',
      afternoonEnd: '15:01'
    }
  }
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 740,
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
}

// ---------- 存储操作 ----------
ipcMain.handle('load-funds', () => store.get('funds', []));
ipcMain.handle('save-funds', (event, funds) => { store.set('funds', funds); return true; });
ipcMain.handle('load-settings', () => store.get('settings', {}));
ipcMain.handle('save-settings', (event, settings) => { store.set('settings', settings); return true; });

// ---------- 数据源获取函数 ----------

// 1. 天天基金（JSONP）
async function fetchFromTiantian(code) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
  });
  const jsonpStr = response.data;
  const jsonStr = jsonpStr.replace(/^jsonpgz\(/, '').replace(/\);$/, '');
  const data = JSON.parse(jsonStr);
  return {
    code: data.fundcode,
    name: data.name,
    nav: parseFloat(data.nav),
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

// 3. 新浪基金（CSV）
async function fetchFromSina(code) {
  const url = `https://hq.sinajs.cn/list=f_${code}`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }
  });
  const text = response.data;
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
    nav: gsz, // 新浪无昨日净值，用估算代替（仅显示用）
    gsz: gsz,
    gszzl: gszzl,
    gztime: gztime,
    source: '新浪基金'
  };
}

// ---------- 统一获取（带容灾） ----------
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });