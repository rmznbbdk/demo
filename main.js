const { app, BrowserWindow } = require('electron');
const path = require('path');

// Önce Node.js sunucumuzu (server.js) arka planda çalıştırıyoruz
require('./server.js');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        title: "My MMORPG",
        autoHideMenuBar: true, // Üstteki menü çubuğunu gizler
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Sunucu açıldıktan sonra oyunun arayüzünü bu pencereye yükler
    mainWindow.loadURL('http://localhost:3000');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.stop ? app.stop() : app.quit();
});