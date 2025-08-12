```mermaid
flowchart TB
  Start[VS Code 啟動擴展]
  A[activate(context) & registerCommand('m5-test2.generate')]
  B[用戶執行命令 "Flowchart Preview"]
  C[確定 target 文件 (py 或活動編輯器)]
  D{文件後綴是 .py 嗎?}
  E[執行: exec python my_pyflowchart ... target.py]
  F{pyflowchart 成功輸出 DSL?}
  G[createWebviewPanel 載入 view.html]
  H[Webview 載入 raphael.js & flowchart.js]
  I[parse(code) → drawSVG('canvas')]
  J[Webview → panel.postMessage({type:'ready'})]
  K[onDidChangeTextEditorSelection → postMessage({type:'highlight-line'})]
  L[Webview 收到 highlight-line → highlightByLine()]
  End[完成]

  Start --> A
  A --> B
  B --> C
  C --> D
  D -- yes --> E
  D -- no  --> End
  E --> F
  F -- yes --> G
  F -- no  --> End
  G --> H
  H --> I
  I --> J
  J --> K
  K --> L
  L --> End

