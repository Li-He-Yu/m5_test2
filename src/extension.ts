import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

    // 執行修改過後的 "my_pyflowchart"
    const pyflowchartPath = path.join(context.extensionPath, 'my_pyflowchart', 'pyflowchart', '__main__.py');
    const cmd = `python "${pyflowchartPath}" "${pyFile}"`;
    
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
      );

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

    // 傳送選取行數給 Webview
    vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!panel) {return;}

        const activeEditor = event.textEditor;
        if (!activeEditor) {return;}

        const activeLine = activeEditor.selection.active.line + 1;
        console.log('傳送 highlight 指令行號:', activeLine);
        panel.webview.postMessage({ type: 'highlight-line', line: activeLine });
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