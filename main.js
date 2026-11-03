const { app, BrowserWindow, ipcMain, Menu, dialog, Tray, nativeImage } = require('electron');
const axios = require('axios');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');
const iconv = require('iconv-lite');

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

// ---------- 托盘图标（纯 SVG + 备选纯色） ----------
function createTrayIcon() {
  // SVG 黑色方块 + 白色"估"字
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <rect width="18" height="18" rx="2" fill="#000000"/>
      <text x="9" y="13" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="bold" fill="white" text-anchor="middle">估</text>
    </svg>
  `;
  let image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  // 如果 SVG 无法加载（某些 macOS 版本），回退到纯黑色方块
  if (image.isEmpty()) {
    const size = 18;
    const buffer = Buffer.alloc(size * size * 4);
    for (let i = 0; i < buffer.length; i += 4) {
      buffer[i] = 0;
      buffer[i+1] = 0;
      buffer[i+2] = 0;
      buffer[i+3] = 255;
    }
    image = nativeImage.createFromBuffer(buffer, { width: size, height: size });
  }

  // 模板图像，自动适配深浅色菜单栏
  image.setTemplateImage(true);
  return image;
}

function createTray() {
  const icon = createTrayIcon();
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

// ---------- 场内 ETF IOPV（基金份额参考净值） ----------
// 腾讯行情字段（~ 分隔，0 起算）：61=产品类型(ETF)、30=时间、3=最新价、
// 77=折溢价率(%)、78=单位净值(T-1，偶发缺失，用新浪净值接口兜底)、81=IOPV 实时参考净值（盘中每15秒更新）

// ETF 代码判定：沪市 510-529/560-563/588，深市 159 开头
function getETFMarketPrefix(code) {
  if (!/^\d{6}$/.test(code)) return null;
  if (/^(51[0-9]|52[0-9]|56[0-3]|588)/.test(code)) return 'sh';
  if (/^159/.test(code)) return 'sz';
  return null;
}

function formatQuoteTime(raw) {
  // "20261102161449" -> "2026-11-02 16:14:49"
  if (!/^\d{14}$/.test(raw || '')) return raw || '';
  const s = raw;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}`;
}

// ETF 昨日净值兜底：新浪基金净值接口（腾讯 idx78 偶发为空时使用）
async function fetchETFNavFromSina(code) {
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/CaihuiFundInfoService.getNav?symbol=${code}&datefrom=&dateto=&page=1`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }
  });
  const rows = response.data?.result?.data?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('新浪净值数据缺失');
  const nav = parseFloat(rows[0].jjjz);
  if (!isFinite(nav) || nav <= 0) throw new Error('新浪净值无效');
  return { nav, navDate: (rows[0].fbrq || '').slice(0, 10) };
}

// 4. 腾讯行情 IOPV（ETF 专用，按交易所规则由成分股实时价×PCF 清单计算）
async function fetchIOPVFromTencent(code) {
  const prefix = getETFMarketPrefix(code);
  const markets = prefix ? [prefix] : ['sh', 'sz'];
  let lastError = null;
  for (const mkt of markets) {
    try {
      const url = `https://qt.gtimg.cn/q=${mkt}${code}`;
      const response = await axios.get(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'arraybuffer'
      });
      const text = iconv.decode(response.data, 'gbk');
      const match = text.match(/v_[a-z]{2}\d+="([^"]*)"/);
      if (!match) throw new Error('腾讯行情解析失败');
      const f = match[1].split('~');
      if (f.length < 82 || f[61] !== 'ETF') throw new Error('非场内 ETF 或字段缺失');
      const iopv = parseFloat(f[81]);
      let nav = parseFloat(f[78]);
      const price = parseFloat(f[3]);
      if (!isFinite(iopv) || iopv <= 0) throw new Error('IOPV 数据无效');
      let navFallback = null;
      if (!isFinite(nav) || nav <= 0) {
        try {
          navFallback = await fetchETFNavFromSina(code);
          nav = navFallback.nav;
        } catch (e) { nav = null; }
      }
      const gszzl = isFinite(nav) && nav > 0 ? (iopv - nav) / nav * 100 : null;
      const premium = isFinite(iopv) && iopv > 0 && isFinite(price) && price > 0
        ? (price - iopv) / iopv * 100
        : null;
      return {
        code: code,
        name: f[1],
        nav: isFinite(nav) && nav > 0 ? nav : iopv,
        gsz: iopv,
        gszzl: gszzl,
        gztime: formatQuoteTime(f[30]),
        iopv: iopv,
        etfPrice: isFinite(price) ? price : null,
        premium: premium,
        navSource: navFallback ? '新浪净值(' + navFallback.navDate + ')' : null,
        isETF: true,
        source: '腾讯IOPV'
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('IOPV 获取失败');
}

const SOURCES = [
  { name: 'tiantian', fetch: fetchFromTiantian },
  { name: 'tencent', fetch: fetchFromTencent },
  { name: 'sina', fetch: fetchFromSina }
];

async function fetchFundValue(code) {
  // 场内 ETF 优先走腾讯行情 IOPV（按 IOPV 规则实时计算），失败再降级场外估值源
  const sources = getETFMarketPrefix(code)
    ? [{ name: 'etf-iopv', fetch: fetchIOPVFromTencent }, ...SOURCES]
    : SOURCES;
  let lastError = null;
  for (const source of sources) {
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
