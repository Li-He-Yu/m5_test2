import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

//VSCode 載入擴展時會自動調用這個函數，雖然也不知道為甚麼這個一定要放前面:0

export function activate(context: vscode.ExtensionContext) {

    //註冊在package.json所定義的命令
    //package.json所定義的註解我打在這邊，因為package.json不能打註解，會報錯，我也不知道為甚麼 爛設計:3

    // 1.右鍵點擊 Python 檔案 (只有在python檔案右擊滑鼠的時候，下拉式選單才有Generate Flowchart的選項)
    // 2.選擇 "Generate Flowchart"
    // 3.VSCode 調用這個函數
    

  const disposable = vscode.commands.registerCommand('m5-test2.generate', async (uri?: vscode.Uri) => {

    //uri? 是可以選擇的參數，包含使用者選擇檔案的路徑

    //這邊做的是驗證檔案是否真的為python檔案

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

    //執行 pyflowchart 以及報錯的部分
    
    const cmd = `python -m pyflowchart "${pyFile}"`;
    
    
    exec(cmd, (err, stdout, stderr) => {
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
        vscode.ViewColumn.Beside,                   //這個 .Beside代表會在右側顯示
        { 
          enableScripts: true,                      
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
        }
      );

      // 取得raphael.min.js和flowchart.min.js下載到我電腦的檔案路徑
      const mediaPath = path.join(context.extensionPath, 'media');
      const raphaelPath = path.join(mediaPath, 'raphael.min.js');
      const flowchartPath = path.join(mediaPath, 'flowchart.min.js');
      
      const raphaelUri = panel.webview.asWebviewUri(vscode.Uri.file(raphaelPath));
      const flowchartUri = panel.webview.asWebviewUri(vscode.Uri.file(flowchartPath));

      // 設定 Webview 內容
      panel.webview.html = getFullFlowchartHTML(code, panel.webview.cspSource, raphaelUri, flowchartUri);
    });
  });

  context.subscriptions.push(disposable);
}

function getFullFlowchartHTML(flowchartCode: string, cspSource: string, raphaelUri: vscode.Uri, flowchartUri: vscode.Uri): string {
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
        }
        .header h2 {
            margin: 0 0 20px 0;
            color: #333;
        }
        .controls {
            margin-bottom: 20px;
        }
        .button {
            background: #007acc;
            color: white;
            border: none;
            padding: 8px 16px;
            margin-right: 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .button:hover {
            background: #005a9e;
        }
        #canvas { 
            border: 1px solid #ccc; 
            padding: 20px; 
            min-height: 400px;
            background: white;
            overflow: auto;
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
            max-width: 100%;
            height: auto;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2>Python 流程圖預覽</h2>
    </div>
    
    <div id="status" class="status">
         正在載入 flowchart.js...
    </div>
    
    <div class="controls">
        <button class="button" onclick="toggleCode()">顯示/隱藏原始碼</button>
        <button class="button" onclick="downloadSVG()" id="downloadBtn" style="display: none;">下載 SVG</button>
    </div>
    
    <div id="canvas">
        <div class="loading">正在載入流程圖...</div>
    </div>
    
    <div id="code-display" class="code-display">${escapedCode}</div>
    
    <!-- 載入順序很重要：先 Raphael，再 flowchart -->

    <!-- load rahael.js 和 flowchart.js -->

    <script src="${raphaelUri}"></script>
    <script src="${flowchartUri}"></script>
    <script>
        let initAttempts = 0;
        const maxAttempts = 50;
        
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
                console.log(' Raphael 和 flowchart 都已載入');
                updateStatus(' 庫載入成功，正在渲染流程圖...');
                setTimeout(initChart, 100); // 稍微延遲確保完全載入
            } else if (initAttempts < maxAttempts) {
                let missing = [];
                if (typeof Raphael === 'undefined') missing.push('Raphael.js');
                if (typeof flowchart === 'undefined') missing.push('flowchart.js');
                updateStatus(\` 等待載入: \${missing.join(', ')}...\`);
                setTimeout(waitForLibraries, 100);
            } else {
                let errorMsg = ' 載入超時：';
                if (typeof Raphael === 'undefined') errorMsg += ' Raphael.js 未載入';
                if (typeof flowchart === 'undefined') errorMsg += ' flowchart.js 未載入';
                updateStatus(errorMsg, true);
                document.getElementById('canvas').innerHTML = 
                    '<div class="error">' + errorMsg + '</div>';
            }
        }
        
    <!-- 將 flowchart.js 轉換成 flowchart -->

        function initChart() {
            try {
                const code = \`${escapedCode}\`;
                console.log('開始解析流程圖代碼:', code);
                
                if (!code.trim()) {
                    updateStatus(' 沒有可用的流程圖代碼', true);
                    document.getElementById('canvas').innerHTML = 
                        '<div class="error">沒有可用的流程圖代碼</div>';
                    return;
                }
                
                updateStatus(' 正在解析流程圖...');
                
                // 清空容器
                document.getElementById('canvas').innerHTML = '';
                
                // 解析並渲染流程圖
                console.log('解析流程圖...');
                const diagram = flowchart.parse(code);
                console.log(' 流程圖解析成功:', diagram);
                
                updateStatus(' 正在渲染 SVG...');
                
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
                
                console.log(' 流程圖渲染完成');
                updateStatus(' 流程圖已成功生成！');
                
                // 顯示下載按鈕
                document.getElementById('downloadBtn').style.display = 'inline-block';
                
                // 3秒後隱藏狀態訊息
                setTimeout(() => {
                    document.getElementById('status').style.display = 'none';
                }, 3000);
                
            } catch (error) {
                console.error(' 渲染錯誤:', error);
                console.error('錯誤堆疊:', error.stack);
                updateStatus(' 渲染失敗: ' + error.message, true);
                document.getElementById('canvas').innerHTML = 
                    '<div class="error">渲染失敗: ' + error.message + '<br><br>詳細錯誤請查看 Console (F12)</div>';
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
        console.log(' 開始等待庫載入...');
        updateStatus(' 正在載入必要的庫...');
        waitForLibraries();
    </script>
</body>
</html>`;
}

export function deactivate() {}