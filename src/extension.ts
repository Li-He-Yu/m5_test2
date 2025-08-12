import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('m5-test2.generate', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const editorAtStart = vscode.window.activeTextEditor;
    if (!target) {
      vscode.window.showWarningMessage('找不到檔案');
      return;
    }

    const pyFile = target.fsPath;
    if (!pyFile.endsWith('.py')) {
      vscode.window.showWarningMessage('只能處理 .py 檔案');
      return;
    }

    // 執行修改過後的 "my_pyflowchart"
    const pyflowchartPath = path.join(context.extensionPath, 'my_pyflowchart', 'pyflowchart', '__main__.py');
    const cmd = `python "${pyflowchartPath}" "${pyFile}"`;
    // const cmd = `python "${pyflowchartPath}" --simplify "${pyFile}"`;
    // test in command-line
    // python .\my_pyflowchart\pyflowchart\__main__.py ..\test_space\test2.py
    // python .\my_pyflowchart\pyflowchart\__main__.py ..\test_space\test.py
    // python .\my_pyflowchart\pyflowchart\__main__.py "C:\Users\jeffl\Desktop\其他\vs code\coco\113_2_Machine_Learning\EX3\problem1.py"
    
    // 宣告 outter 的 panel 讓後面可以存取
    let panel: vscode.WebviewPanel | undefined = undefined;
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
      panel = vscode.window.createWebviewPanel(
        'flowchartPreview',
        `Flowchart - ${path.basename(pyFile)}`,
        vscode.ViewColumn.Beside,
        { 
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
        }
      );// end of assign panel

      // 用來分辨前端渲染完成了沒
      let webviewReady = false;

      // ✅ 接收 Webview 傳來的「準備好了」訊號
      // 1) 前端準備好時開 flag、送初次 highlight
      panel.webview.onDidReceiveMessage((message) => {
        console.log('[EXT] 收到來自 Webview 的訊息:', message);

        if (message.type === 'ready') {
          webviewReady = true;

          // 確保 panel 進到 function 的時候不是 undefined
          if (!panel) { console.log('panel 抓不到'); return; };
          if (!editorAtStart) { console.log('activeEditor 抓不到'); return; };

          const initLine = editorAtStart.selection.active.line + 1;
          panel.webview.postMessage({ type: 'highlight-line', line: initLine });
          console.log('[EXT] Webview 已準備好，送出 highlight-line:', initLine);
        }
      });
      
      // 2) 只有在 webviewReady 之後才回應後續游標移動
      const selListener = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!webviewReady) {return;}// 如果前端還沒 'ready' 就不要繼續執行
        if (!panel) { console.log('panel 抓不到'); return; };

        const activeLine = event.selections[0].active.line + 1;
        panel.webview.postMessage({ type: 'highlight-line', line: activeLine });
        console.log('[EXT] 偵測行變化，送出 highlight-line:', activeLine);
      });
      // 回傳值（Disposable）存到 context.subscriptions，
      // 這樣就能確保你的事件 listener 在 extension 被停用或重載時，自動被釋放。
      context.subscriptions.push(selListener);


      // 取得本地檔案路徑
      const mediaPath = path.join(context.extensionPath, 'media');
      const raphaelPath = path.join(mediaPath, 'raphael.min.js');
      const flowchartPath = path.join(mediaPath, 'flowchart.min.js');
      
      const raphaelUri = panel.webview.asWebviewUri(vscode.Uri.file(raphaelPath));
      const flowchartUri = panel.webview.asWebviewUri(vscode.Uri.file(flowchartPath));

      // 設定 Webview 內容
      // panel.webview.html = getZoomableFlowchartHTML(code, panel.webview.cspSource, raphaelUri, flowchartUri);

      // 改為從外部引入 html template，再調用函數，插入 script 
      const htmlTemplatePath = path.join(context.extensionPath, 'media', 'view.html');
      panel.webview.html = getZoomableFlowchartHTMLFromTemplate(
          htmlTemplatePath, code, panel.webview.cspSource, raphaelUri, flowchartUri
      );
      // console.log("✅ Webview HTML loaded");
      // console.log("HTML content:\n", panel.webview.html);
    });

  });

  context.subscriptions.push(disposable);
}

// 將 html 轉成靜態模板，另外再插入 javascripts
// 這邊用來給前面抓取 HTML template，方便維護 HTML

function getZoomableFlowchartHTMLFromTemplate(
    templatePath: string, 
    flowchartCode: string, 
    cspSource: string, 
    raphaelUri: vscode.Uri, 
    flowchartUri: vscode.Uri
): string {
  let html = fs.readFileSync(templatePath, 'utf-8');
  const escapedCode = JSON.stringify(flowchartCode);

  html = html.replace(/\${escapedCode}/g, escapedCode);
  html = html.replace(/\${cspSource}/g, cspSource);
  html = html.replace(/\${raphaelUri}/g, raphaelUri.toString());
  html = html.replace(/\${flowchartUri}/g, flowchartUri.toString());
  return html;
}