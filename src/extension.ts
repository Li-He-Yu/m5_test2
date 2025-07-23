import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('m5-test2.generate', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showWarningMessage('找不到檔案');
      return;
    }

    const pyFile = target.fsPath;
    if (!pyFile.endsWith('.py')) {
      vscode.window.showWarningMessage('只能處理 .py 檔案');
      return;
    }

    // 執行 pyflowchart
    // const cmd = `python -m pyflowchart "${pyFile}"`;

    // 執行修改過後的 "my_pyflowchart"
    const pyflowchartPath = path.join(context.extensionPath, 'my_pyflowchart', 'pyflowchart', '__main__.py');
    const cmd = `python "${pyflowchartPath}" "${pyFile}"`;


    // 原本：
    // exec(cmd, (err, stdout, stderr) => {
    
    // 修改後：
    exec(cmd, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) => {
      if (err) {
        vscode.window.showErrorMessage(`pyflowchart 失敗：${stderr || err.message}`);
        return;
      }
      
      const code = stdout.trim();
      if (!code) {
        vscode.window.showErrorMessage('pyflowchart 沒有輸出');
        return;
      }

      // 建立 Webview Panel
      const panel = vscode.window.createWebviewPanel(
        'flowchartPreview',
        `Flowchart - ${path.basename(pyFile)}`,
        vscode.ViewColumn.Beside,
        { 
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
        }
      );

      // 取得本地檔案路徑
      const mediaPath = path.join(context.extensionPath, 'media');
      const raphaelPath = path.join(mediaPath, 'raphael.min.js');
      const flowchartPath = path.join(mediaPath, 'flowchart.min.js');
      
      const raphaelUri = panel.webview.asWebviewUri(vscode.Uri.file(raphaelPath));
      const flowchartUri = panel.webview.asWebviewUri(vscode.Uri.file(flowchartPath));

      // 設定 Webview 內容
      panel.webview.html = getZoomableFlowchartHTML(code, panel.webview.cspSource, raphaelUri, flowchartUri);
    });

    // 傳送選取行數給 Webview
    vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor.document.uri.fsPath === pyFile) {
        const activeLine = event.selections[0].active.line + 1; // 行號從 1 開始
        panel.webview.postMessage({ type: 'highlight-line', line: activeLine });
    }
    });

  });

  context.subscriptions.push(disposable);
}

function getZoomableFlowchartHTML(flowchartCode: string, cspSource: string, raphaelUri: vscode.Uri, flowchartUri: vscode.Uri): string {
  const escapedCode = flowchartCode
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-inline'; style-src ${cspSource} 'unsafe-inline';">
    <title>Flowchart Preview</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 20px; 
            background: white;
            color: #333;
            overflow: hidden; /* 防止頁面滾動條 */
        }
        .header h2 {
            margin: 0 0 20px 0;
            color: #333;
        }
        .controls {
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
        }
        .button {
            background: #007acc;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
        }
        .button:hover {
            background: #005a9e;
        }
        .button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        
        /* 縮放控制器樣式 */
        .zoom-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            background: #f0f0f0;
            padding: 5px 10px;
            border-radius: 6px;
            border: 1px solid #ddd;
        }
        .zoom-btn {
            background: #fff;
            border: 1px solid #ccc;
            width: 30px;
            height: 30px;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            color: #333;
            transition: all 0.2s;
        }
        .zoom-btn:hover {
            background: #e6f3ff;
            border-color: #007acc;
        }
        .zoom-info {
            font-size: 12px;
            color: #666;
            min-width: 45px;
            text-align: center;
        }
        
        /* 流程圖容器樣式 */
        #canvas-container { 
            border: 1px solid #ccc; 
            background: white;
            overflow: auto;
            position: relative;
            height: calc(100vh - 200px); /* 動態高度 */
        }
        
        #canvas {
            transform-origin: 0 0;
            transition: transform 0.2s ease;
            min-width: 100%;
            min-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
        }
        
        .error { 
            color: #d63384; 
            background: #f8d7da; 
            padding: 10px; 
            border-radius: 4px; 
            border: 1px solid #f5c2c7;
        }
        .loading { 
            text-align: center; 
            padding: 40px; 
            color: #666; 
        }
        .code-display {
            background: #f8f9fa;
            padding: 15px;
            margin: 10px 0;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 12px;
            border-radius: 4px;
            border: 1px solid #dee2e6;
            white-space: pre-wrap;
            display: none;
        }
        .status {
            background: #e7f3ff;
            border: 1px solid #b3d9ff;
            color: #004085;
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 15px;
            font-size: 14px;
        }
        
        /* 確保 SVG 在容器中正確顯示 */
        #canvas svg {
            max-width: none !important;
            height: auto !important;
        }
        
        /* 迷你地圖樣式 */
        .minimap {
            position: absolute;
            top: 10px;
            right: 10px;
            width: 150px;
            height: 100px;
            background: rgba(255, 255, 255, 0.9);
            border: 1px solid #ccc;
            border-radius: 4px;
            z-index: 100;
            overflow: hidden;
            display: none;
        }
        .minimap-content {
            transform-origin: 0 0;
            transform: scale(0.1);
        }
        .minimap-viewport {
            position: absolute;
            border: 2px solid #007acc;
            background: rgba(0, 122, 204, 0.1);
            pointer-events: none;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2>Python 流程圖預覽</h2>
    </div>
    
    <div id="status" class="status">
        🔄 正在載入 flowchart.js...
    </div>
    
    <div class="controls">
        <button class="button" onclick="toggleCode()">顯示/隱藏原始碼</button>
        <button class="button" onclick="downloadSVG()" id="downloadBtn" style="display: none;">下載 SVG</button>
        
        <!-- 縮放控制器 -->
        <div class="zoom-controls">
            <div class="zoom-btn" onclick="zoomOut()" title="縮小">−</div>
            <div class="zoom-info" id="zoomLevel">100%</div>
            <div class="zoom-btn" onclick="zoomIn()" title="放大">+</div>
            <div class="zoom-btn" onclick="resetZoom()" title="重設縮放">⌂</div>
            <div class="zoom-btn" onclick="fitToWindow()" title="適應視窗">⊞</div>
        </div>
        
        <button class="button" onclick="toggleMinimap()" id="minimapToggle" style="display: none;">迷你地圖</button>
    </div>
    
    <div id="canvas-container">
        <div id="canvas">
            <div class="loading">正在載入流程圖...</div>
        </div>
        
        <!-- 迷你地圖 -->
        <div class="minimap" id="minimap">
            <div class="minimap-content" id="minimap-content"></div>
            <div class="minimap-viewport" id="minimap-viewport"></div>
        </div>
    </div>
    
    <div id="code-display" class="code-display">${escapedCode}</div>
    
    <!-- 載入順序很重要：先 Raphael，再 flowchart -->
    <script src="${raphaelUri}"></script>
    <script src="${flowchartUri}"></script>
    <script>
        let initAttempts = 0;
        const maxAttempts = 50;
        let currentZoom = 1;
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        let canvasPosition = { x: 0, y: 0 };
        let minimapVisible = false;
        
        function updateStatus(message, isError = false) {
            const statusEl = document.getElementById('status');
            statusEl.textContent = message;
            statusEl.style.background = isError ? '#f8d7da' : '#e7f3ff';
            statusEl.style.color = isError ? '#721c24' : '#004085';
            statusEl.style.borderColor = isError ? '#f5c2c7' : '#b3d9ff';
        }
        
        function waitForLibraries() {
            initAttempts++;
            console.log('嘗試初始化，第', initAttempts, '次');
            console.log('Raphael 類型:', typeof Raphael);
            console.log('flowchart 類型:', typeof flowchart);
            
            if (typeof Raphael !== 'undefined' && typeof flowchart !== 'undefined') {
                console.log('✅ Raphael 和 flowchart 都已載入');
                updateStatus('✅ 庫載入成功，正在渲染流程圖...');
                setTimeout(initChart, 100);
            } else if (initAttempts < maxAttempts) {
                let missing = [];
                if (typeof Raphael === 'undefined') missing.push('Raphael.js');
                if (typeof flowchart === 'undefined') missing.push('flowchart.js');
                updateStatus(\`⏳ 等待載入: \${missing.join(', ')}...\`);
                setTimeout(waitForLibraries, 100);
            } else {
                let errorMsg = '❌ 載入超時：';
                if (typeof Raphael === 'undefined') errorMsg += ' Raphael.js 未載入';
                if (typeof flowchart === 'undefined') errorMsg += ' flowchart.js 未載入';
                updateStatus(errorMsg, true);
                document.getElementById('canvas').innerHTML = 
                    '<div class="error">' + errorMsg + '</div>';
            }
        }
        
        function initChart() {
            try {
                const code = \`${escapedCode}\`;
                console.log('開始解析流程圖代碼:', code);
                
                if (!code.trim()) {
                    updateStatus('❌ 沒有可用的流程圖代碼', true);
                    document.getElementById('canvas').innerHTML = 
                        '<div class="error">沒有可用的流程圖代碼</div>';
                    return;
                }
                
                updateStatus('🔧 正在解析流程圖...');
                
                // 清空容器
                document.getElementById('canvas').innerHTML = '';
                
                // 解析並渲染流程圖
                console.log('解析流程圖...');
                const diagram = flowchart.parse(code);
                console.log('✅ 流程圖解析成功:', diagram);
                
                updateStatus('🎨 正在渲染 SVG...');
                
                // 渲染到 canvas
                diagram.drawSVG('canvas', {
                    'line-width': 2,
                    'line-length': 50,
                    'text-margin': 10,
                    'font-size': 14,
                    'font-color': '#333',
                    'line-color': '#333',
                    'element-color': '#333',
                    'fill': 'white',
                    'yes-text': 'yes',
                    'no-text': 'no',
                    'arrow-end': 'block',
                    'scale': 1
                });
                
                console.log('✅ 流程圖渲染完成');
                updateStatus('✅ 流程圖已成功生成！');
                
                // 顯示功能按鈕
                document.getElementById('downloadBtn').style.display = 'inline-block';
                document.getElementById('minimapToggle').style.display = 'inline-block';
                
                // 初始化縮放和拖動功能
                initZoomAndPan();
                
                // 確保初始位置正確
                resetZoom();
                
                // 3秒後隱藏狀態訊息
                setTimeout(() => {
                    document.getElementById('status').style.display = 'none';
                }, 3000);
                
            } catch (error) {
                console.error('❌ 渲染錯誤:', error);
                console.error('錯誤堆疊:', error.stack);
                updateStatus('❌ 渲染失敗: ' + error.message, true);
                document.getElementById('canvas').innerHTML = 
                    '<div class="error">渲染失敗: ' + error.message + '<br><br>詳細錯誤請查看 Console (F12)</div>';
            }
        }

        // 接收從 Extension 傳來的行號
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'highlight-line') {
                const line = message.line;
                highlightNodeByLine(line);
            }
            });

            // 根據行號高亮節點（你需要自己定義對應關係）
            function highlightNodeByLine(line) {
            // 清除之前高亮
            document.querySelectorAll('g.element').forEach(g => {
                g.querySelector('rect, path')?.setAttribute('fill', 'white');
            });

            // 根據你的流程圖字串，尋找包含該行的節點 (要配合 pyflowchart 的 DSL 加工)
            const matches = [...document.querySelectorAll('g.element text')];
            for (const el of matches) {
                if (el.textContent?.includes(`line ${line}`)) { // ex: 你改寫 DSL 時加上 "line 12"
                el.parentElement?.querySelector('rect, path')?.setAttribute('fill', '#ffef9f');
                }
            }
        }

        
        // 縮放功能
        function zoomIn() {
            currentZoom = Math.min(currentZoom * 1.2, 5); // 最大 500%
            updateZoom();
        }
        
        function zoomOut() {
            currentZoom = Math.max(currentZoom / 1.2, 0.1); // 最小 10%
            updateZoom();
        }
        
        function resetZoom() {
            currentZoom = 1;
            canvasPosition = { x: 0, y: 0 };
            originalSvgWidth = 0;  // 重設原始尺寸，讓下次重新測量
            originalSvgHeight = 0;
            updateZoom();
        }
        
        function fitToWindow() {
            const container = document.getElementById('canvas-container');
            const canvas = document.getElementById('canvas');
            const svg = canvas.querySelector('svg');
            
            if (!svg) return;
            
            const containerRect = container.getBoundingClientRect();
            const svgRect = svg.getBoundingClientRect();
            
            const scaleX = (containerRect.width - 40) / svgRect.width;
            const scaleY = (containerRect.height - 40) / svgRect.height;
            
            currentZoom = Math.min(scaleX, scaleY, 1); // 不超過 100%
            canvasPosition = { x: 0, y: 0 };
            updateZoom();
        }
        
        let originalSvgWidth = 0;
        let originalSvgHeight = 0;
        
        function updateZoom() {
            const canvas = document.getElementById('canvas');
            const container = document.getElementById('canvas-container');
            const svg = canvas.querySelector('svg');
            
            if (svg) {
                // 第一次獲取原始尺寸
                if (originalSvgWidth === 0) {
                    // 暫時移除所有變換來獲取真實尺寸
                    const originalTransform = canvas.style.transform;
                    canvas.style.transform = 'none';
                    
                    const svgRect = svg.getBoundingClientRect();
                    originalSvgWidth = svgRect.width;
                    originalSvgHeight = svgRect.height;
                    
                    // 恢復變換
                    canvas.style.transform = originalTransform;
                }
                
                const containerRect = container.getBoundingClientRect();
                
                // 計算縮放後的實際尺寸
                const scaledWidth = originalSvgWidth * currentZoom;
                const scaledHeight = originalSvgHeight * currentZoom;
                
                // 重新計算邊界：確保能看到圖片的所有部分
                let maxX = 0, maxY = 0;
                
                if (scaledWidth > containerRect.width) {
                    // 水平方向：允許移動距離 = (圖片寬度 - 容器寬度) / 2 / 縮放比例
                    maxX = (scaledWidth - containerRect.width) / 2 / currentZoom;
                }
                
                if (scaledHeight > containerRect.height) {
                    // 垂直方向：允許移動距離 = (圖片高度 - 容器高度) / 2 / 縮放比例
                    maxY = (scaledHeight - containerRect.height) / 2 / currentZoom;
                }
                
                // 應用邊界限制，但給一點寬容度
                const tolerance = 10; // 10px 的寬容度
                canvasPosition.x = Math.max(-(maxX + tolerance), Math.min(maxX + tolerance, canvasPosition.x));
                canvasPosition.y = Math.max(-(maxY + tolerance), Math.min(maxY + tolerance, canvasPosition.y));
                
                // 如果圖片小於容器，居中顯示
                if (scaledWidth <= containerRect.width) {
                    canvasPosition.x = 0;
                }
                if (scaledHeight <= containerRect.height) {
                    canvasPosition.y = 0;
                }
            }
            
            canvas.style.transform = \`scale(\${currentZoom}) translate(\${canvasPosition.x}px, \${canvasPosition.y}px)\`;
            
            // 更新縮放顯示
            document.getElementById('zoomLevel').textContent = Math.round(currentZoom * 100) + '%';
            
            // 更新迷你地圖
            updateMinimap();
        }
        
        // 拖動功能
        function initZoomAndPan() {
            const container = document.getElementById('canvas-container');
            
            // 滑鼠拖動
            container.addEventListener('mousedown', startDrag);
            document.addEventListener('mousemove', drag);
            document.addEventListener('mouseup', endDrag);
            
            // 滾輪上下移動 (不縮放)
            container.addEventListener('wheel', (e) => {
                e.preventDefault();
                
                // 滾輪控制上下移動
                const scrollSpeed = 30;
                
                // 簡單直接的移動
                if (e.deltaY > 0) {
                    canvasPosition.y -= scrollSpeed; // 向下滾動，圖片向上移動
                } else {
                    canvasPosition.y += scrollSpeed; // 向上滾動，圖片向下移動
                }
                
                // 更新顯示
                updateZoom();
            });
            
            // 鍵盤快捷鍵
            document.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                
                const moveSpeed = 20; // 方向鍵移動速度
                
                switch(e.key) {
                    case '+':
                    case '=':
                        e.preventDefault();
                        zoomIn();
                        break;
                    case '-':
                        e.preventDefault();
                        zoomOut();
                        break;
                    case '0':
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            resetZoom();
                        }
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        canvasPosition.y += moveSpeed;
                        updateZoom(); // 內部會限制邊界
                        break;
                    case 'ArrowDown':
                        e.preventDefault();
                        canvasPosition.y -= moveSpeed;
                        updateZoom(); // 內部會限制邊界
                        break;
                    case 'ArrowLeft':
                        e.preventDefault();
                        canvasPosition.x += moveSpeed;
                        updateZoom(); // 內部會限制邊界
                        break;
                    case 'ArrowRight':
                        e.preventDefault();
                        canvasPosition.x -= moveSpeed;
                        updateZoom(); // 內部會限制邊界
                        break;
                }
            });
        }
        
        function startDrag(e) {
            if (e.button === 0) { // 左鍵
                isDragging = true;
                dragStart = { x: e.clientX - canvasPosition.x, y: e.clientY - canvasPosition.y };
                e.preventDefault();
            }
        }
        
        function drag(e) {
            if (isDragging) {
                const newX = e.clientX - dragStart.x;
                const newY = e.clientY - dragStart.y;
                
                canvasPosition.x = newX;
                canvasPosition.y = newY;
                
                updateZoom(); // 內部會限制邊界
                e.preventDefault();
            }
        }
        
        function endDrag() {
            isDragging = false;
        }
        
        // 迷你地圖功能
        function toggleMinimap() {
            minimapVisible = !minimapVisible;
            const minimap = document.getElementById('minimap');
            minimap.style.display = minimapVisible ? 'block' : 'none';
            updateMinimap();
        }
        
        function updateMinimap() {
            if (!minimapVisible) return;
            
            const canvas = document.getElementById('canvas');
            const svg = canvas.querySelector('svg');
            const minimapContent = document.getElementById('minimap-content');
            
            if (svg && minimapContent) {
                // 複製 SVG 到迷你地圖
                minimapContent.innerHTML = svg.outerHTML;
                
                // 更新迷你地圖中的 SVG 縮放
                const minimapSvg = minimapContent.querySelector('svg');
                if (minimapSvg) {
                    minimapSvg.style.maxWidth = 'none';
                    minimapSvg.style.height = 'auto';
                }
            }
        }
        
        function downloadSVG() {
            const svg = document.querySelector('#canvas svg');
            if (!svg) {
                alert('沒有可用的 SVG 內容');
                return;
            }
            
            // 克隆 SVG 並設置合適的屬性
            const svgClone = svg.cloneNode(true);
            svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            
            const serializer = new XMLSerializer();
            const svgStr = serializer.serializeToString(svgClone);
            const blob = new Blob([svgStr], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = 'flowchart.svg';
            a.click();
            
            URL.revokeObjectURL(url);
        }
        
        function toggleCode() {
            const codeDisplay = document.getElementById('code-display');
            codeDisplay.style.display = codeDisplay.style.display === 'none' ? 'block' : 'none';
        }
        
        // 開始載入檢測
        console.log('🚀 開始等待庫載入...');
        updateStatus('🔄 正在載入必要的庫...');
        waitForLibraries();
    </script>
</body>
</html>`;
}

export function deactivate() {}