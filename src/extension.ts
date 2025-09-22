import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { codeToPseudocode } from './claudeApi';
import { PythonCodeBlockParser, CodeBlock, CodeBlockType } from './codeBlockParser';
import * as dotenv from 'dotenv';
// import { languageChoose } from './LanguageAnalyzer';
import { parsePythonWithAST } from './pythonAnalyzer';
import { WebViewNodeClickEventHandler, clearEditor } from './WebviewEventHandler';

//儲存目前webview panel的reference
let currentPanel: vscode.WebviewPanel | undefined;

//儲存行號到節點ID的對應關係
let lineToNodeMap: Map<number, string[]> = new Map();

//儲存所有節點的順序（新增）
let nodeOrder: string[] = [];

// 全域變數來追踪面板狀態
let pseudocodePanel: vscode.WebviewPanel | undefined;

// 快取管理 - 存儲程式碼區塊與 pseudocode 的對應
const pseudocodeCache = new Map<string, string>();

// 儲存累積的 pseudocode 歷史記錄
let pseudocodeHistory: string[] = [];

// 儲存 nodeID 對應到 LineNum, Label 的關係
// parseNodeSequence: 
//      need: nodeIdToLine, nodeIdToLabel
//      do:   provide info to LLM to analyze
// parseLineMapping:
//      need: nodeIdToLine
//      do:   provide info to handle node click event (highlight corespond line of statement)
export const nodeIdToLine = new Map<string, number | null>();
const nodeIdToLabel = new Map<string, string>();

export function activate(context: vscode.ExtensionContext) {
    // 載入 .env 文件 - 使用 extension 根目錄的路徑
    const extensionPath = context.extensionPath;
    dotenv.config({ path: path.join(extensionPath, '.env') });

    console.log('Code2Pseudocode extension is now active!');
    console.log('Extension path:', extensionPath);
    console.log('CLAUDE_API_KEY exists:', !!process.env.CLAUDE_API_KEY);
    
    // 註冊轉換命令
    const disposable = vscode.commands.registerCommand('code2pseudocode.convertToPseudocode', async () => {
        await convertToPseudocode();
    });

    // 註冊檔案儲存事件監聽器
    const onSaveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
        // 只有當面板已開啟時才自動轉換
        if (!pseudocodePanel) {
            return;
        }

        // 檢查是否為 Python 檔案
        const fileExtension = document.fileName.toLowerCase();
        const isPythonFile = fileExtension.endsWith('.py');

        if (isPythonFile) {
            // 等待一小段時間確保檔案已完全儲存
            setTimeout(async () => {
                await convertToPseudocode(true); // 傳入 true 表示是自動更新
            }, 100);
        }
    });

    // 註冊檔案變更事件監聽器 - 清理快取
    const onChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        // 只有在真正有內容變更時才清理快取
        // 檢查是否有實際的內容變更（排除格式化、自動儲存等）
        if (event.contentChanges.length > 0) {
            const hasRealChanges = event.contentChanges.some(change => {
                // 排除純粹的空白字元變更（如自動格式化）
                return change.text.trim() !== '' || change.rangeLength > 0;
            });

            if (hasRealChanges) {
                pseudocodeCache.clear();
            }
        }
    });

    // 註冊 Hover Provider - 只在 hover 時生成 pseudocode 並顯示在右下角
    const hoverProvider = vscode.languages.registerHoverProvider(
        ['python'],
        {
            async provideHover(document, position, token) {
                // 如果沒有開啟 flowchart panel，不執行任何動作
                if (!currentPanel) {
                    return null;
                }

                // 獲取當前行內容，用於初步檢查
                const line = document.lineAt(position.line);
                const lineText = line.text.trim();

                // 只在有程式碼內容的行才處理（跳過 Python 註解和空行）
                if (!lineText || lineText.startsWith('#')) {
                    return null;
                }

                // 檢查 API Key
                const apiKey = process.env.CLAUDE_API_KEY;
                if (!apiKey) {
                    console.error('CLAUDE_API_KEY not found');
                    return null;
                }

                // 判斷當前行是否為區塊開始行
                const isBlockStartLine = isBlockStart(lineText);

                let codeBlock: CodeBlock;
                let cacheKey: string;

                if (isBlockStartLine) {
                    // 如果是區塊開始行，使用區塊識別
                    codeBlock = PythonCodeBlockParser.findCodeBlock(document, position);
                    cacheKey = codeBlock.code.trim();
                } else {
                    // 否則只處理單行
                    codeBlock = {
                        type: CodeBlockType.SINGLE_LINE,
                        startLine: position.line,
                        endLine: position.line,
                        code: lineText,
                        indentLevel: 0
                    };
                    cacheKey = lineText;
                }

                // 在背景生成 pseudocode
                if (!pseudocodeCache.has(cacheKey)) {
                    // 異步生成，不阻塞 hover
                    codeToPseudocode(codeBlock.code).then(pseudocode => {
                        pseudocodeCache.set(cacheKey, pseudocode);
                        const formattedPseudocode = formatPseudocodeForDisplay(
                            pseudocode,
                            codeBlock,
                            false
                        );
                        addToPseudocodeHistory(formattedPseudocode);
                        updateWebviewPseudocode();
                    }).catch(error => {
                        console.error('Failed to generate pseudocode:', error);
                    });
                } else {
                    // 從快取取得並更新顯示
                    const pseudocode = pseudocodeCache.get(cacheKey)!;
                    const formattedPseudocode = formatPseudocodeForDisplay(
                        pseudocode,
                        codeBlock,
                        true
                    );
                    addToPseudocodeHistory(formattedPseudocode);
                    updateWebviewPseudocode();
                }

                // 不返回任何 Hover 內容
                return null;
            }
        }
    );
    
    let generateDisposable = vscode.commands.registerCommand('m5-test2.generate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active Python file');
            return;
        }

        const document = editor.document;
        // languageChoose(editor);
        
        if (document.languageId !== 'python') {
            vscode.window.showErrorMessage('Current file is not a Python file');
            return;
        }

        const code = document.getText();
        
        try {
            //使用 Python AST 來解析程式碼，並獲取每一行的對應關係
            const { mermaidCode, lineMapping, nodeSequence, nodeMeta } = await parsePythonWithAST(code);
            
            
            console.log('Generated Mermaid code:');
            console.log(mermaidCode);
            console.log('Line mapping:', lineMapping);
            console.log('Node sequence:', nodeSequence);

            // 清空 pseudocode 歷史記錄
            pseudocodeHistory = [];
            
            // 不自動生成整個程式的 pseudocode，只顯示等待訊息
            let pseudocodeText = '等待生成 Pseudocode...';
            
            //解析每一行的對應關系
            lineToNodeMap = parseLineMapping(lineMapping);
            console.log('Parsed line to node map:', Array.from(lineToNodeMap.entries()));
            
            //解析節點順序（新增）
            nodeOrder = await parseNodeSequence(nodeSequence, nodeMeta, code);
            console.log('Node order:', nodeOrder);
            
            //創建或更新 Webview 面板
            if (currentPanel) {
                currentPanel.reveal(vscode.ViewColumn.Two);
            } else {
                currentPanel = vscode.window.createWebviewPanel(
                    'pythonFlowchart',
                    'Python Flowchart',
                    vscode.ViewColumn.Two,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        // Allow loading local files from your extension
                        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
                    }
                );

                currentPanel.onDidDispose(() => {
                    currentPanel = undefined;
                    // 清空歷史記錄
                    pseudocodeHistory = [];
                });
            }

            // load the webview html from templates
            currentPanel.webview.html = await getWebviewHtmlExternal(
                currentPanel.webview,
                context,
                mermaidCode,
                nodeOrder,
                getPseudocodeHistoryText()
            );
            
            //監聽來自 webview 的消息
            currentPanel.webview.onDidReceiveMessage(
                message => {
                    switch (message.command) {
                        case 'nodeClicked':
                            break;
                        case 'requestNodeOrder':
                            // 回傳節點順序給 webview（新增）
                            currentPanel?.webview.postMessage({
                                command: 'setNodeOrder',
                                nodeOrder: nodeOrder
                            });
                            break;
                        case 'webview.nodeClicked':{
                            WebViewNodeClickEventHandler(editor, message);
                            break;
                        }
                        case 'webview.requestClearEditor':{
                            clearEditor(editor);
                            break;
                        }
                        case 'webview.clearPseudocodeHistory':
                            // 清空 pseudocode 歷史記錄
                            pseudocodeHistory = [];
                            updateWebviewPseudocode();
                            break;
                    }
                },
                undefined,
                context.subscriptions
            );
            
        } catch (error) {
            vscode.window.showErrorMessage(`Error generating flowchart: ${error}`);
        }
    });

    // 註冊清空 pseudocode 歷史的命令
    const clearHistoryDisposable = vscode.commands.registerCommand('code2pseudocode.clearHistory', () => {
        pseudocodeHistory = [];
        updateWebviewPseudocode();
        vscode.window.showInformationMessage('Pseudocode history cleared');
    });
    
    //游標位置變化的資訊
    let selectionDisposable = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!currentPanel) {
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'python') {
            return;
        }

        const selection = e.selections[0];
        
        // clear editor first
        clearEditor(editor);
        
        // 檢查是否有選取範圍（多行選取）
        if (!selection.isEmpty) {
            // 有選取範圍時，獲取選取的起始行和結束行
            const startLine = selection.start.line + 1; // 轉換為1-based
            const endLine = selection.end.line + 1;
            
            console.log(`Selection from line ${startLine} to ${endLine}`);
            console.log('Line to node map:', Array.from(lineToNodeMap.entries()));
            
            // 收集所有選取行對應的節點ID
            const allNodeIds = new Set<string>();
            
            for (let line = startLine; line <= endLine; line++) {
                const nodeIds = lineToNodeMap.get(line);
                if (nodeIds && nodeIds.length > 0) {
                    nodeIds.forEach(id => allNodeIds.add(id));
                    console.log(`Line ${line} has nodes:`, nodeIds);
                }
            }
            
            if (allNodeIds.size > 0) {
                const nodeIdsArray = Array.from(allNodeIds);
                console.log('Highlighting multiple nodes:', nodeIdsArray);
                
                // 發送消息到webview，高亮所有選取行對應的節點
                currentPanel.webview.postMessage({
                    command: 'highlightNodes',
                    nodeIds: nodeIdsArray
                });
            } else {
                console.log('No nodes found for selected lines');
                // 清除高亮
                currentPanel.webview.postMessage({
                    command: 'clearHighlight'
                });
            }
        } else {
            // 沒有選取範圍時，只處理游標所在行
            const lineNumber = selection.active.line + 1;
            
            console.log('Cursor at line:', lineNumber);
            console.log('Line to node map:', Array.from(lineToNodeMap.entries()));
            
            // 查找對應的節點ID
            const nodeIds = lineToNodeMap.get(lineNumber);
            if (nodeIds && nodeIds.length > 0) {
                console.log('Found nodes for line', lineNumber, ':', nodeIds);
                // 發送消息到webview並將該節點發光
                currentPanel.webview.postMessage({
                    command: 'highlightNodes',
                    nodeIds: nodeIds
                });
            } else {
                console.log('No nodes found for line', lineNumber);
                // 清除高亮
                currentPanel.webview.postMessage({
                    command: 'clearHighlight'
                });
            }
        }
    });

    context.subscriptions.push(generateDisposable);
    context.subscriptions.push(selectionDisposable);
    context.subscriptions.push(disposable, onSaveDisposable, onChangeDisposable, hoverProvider, clearHistoryDisposable);
}

// 新增：格式化 pseudocode 以供顯示
function formatPseudocodeForDisplay(pseudocode: string, codeBlock: CodeBlock, fromCache: boolean): string {
    const timestamp = new Date().toLocaleTimeString();
    const typeDisplay = getBlockTypeDisplay(codeBlock.type);
    const lineInfo = `Lines ${codeBlock.startLine + 1}-${codeBlock.endLine + 1}`;
    const cacheStatus = fromCache ? ' [Cached]' : '';
    
    return `[${timestamp}] ${typeDisplay} (${lineInfo})${cacheStatus}\n${pseudocode}`;
}

// 新增：添加到 pseudocode 歷史記錄
function addToPseudocodeHistory(pseudocode: string) {
    pseudocodeHistory.push(pseudocode);
    // 限制歷史記錄數量，避免過多
    const maxHistory = 20;
    if (pseudocodeHistory.length > maxHistory) {
        pseudocodeHistory = pseudocodeHistory.slice(-maxHistory);
    }
}

// 新增：獲取格式化的歷史記錄文本
function getPseudocodeHistoryText(): string {
    if (pseudocodeHistory.length === 0) {
        return '等待生成 Pseudocode...';
    }
    return pseudocodeHistory.join('\n' + '─'.repeat(50) + '\n');
}

// 新增：更新 webview 中的 pseudocode 顯示
function updateWebviewPseudocode() {
    if (currentPanel) {
        currentPanel.webview.postMessage({
            command: 'updatePseudocode',
            pseudocode: getPseudocodeHistoryText()
        });
    }
}

// helper
export function nodeIdStringIsStartOrEnd(nodeId: string): Boolean{
	return nodeId === "Start" || nodeId === "End";
}

// 解析行號對應字符串
function parseLineMapping(mappingStr: string): Map<number, string[]> {
    const map = new Map<number, string[]>();
    try {
        console.log('Raw line mapping string:', mappingStr);
        const mapping = JSON.parse(mappingStr);
        console.log('Parsed JSON mapping:', mapping);
        
        for (const [line, nodes] of Object.entries(mapping)) {
            const lineNum = parseInt(line);
            map.set(lineNum, nodes as string[]);
            console.log(`Line ${lineNum} maps to nodes:`, nodes);

            // also record inverse mapping in 'nodeIdToLine', Global var
            const arr = nodes as string[];
            let tempNodeId : string = arr[0];
            nodeIdToLine.set(tempNodeId, lineNum);
        }
    } catch (e) {
        console.error('Error parsing line mapping:', e);
    }
    console.log('Final line to node map:', Array.from(map.entries()));
    return map;
}

// 解析節點順序（新增）
async function parseNodeSequence(sequenceStr: string, nodeMeta: string, fullCode: string): Promise<string[]> {
    let sequence : string[] = [];
    try {
        sequence = JSON.parse(sequenceStr);
    } catch (e) {
        console.error('Error parsing node sequence:', e);
        return ['Error parsing node sequence'];
    }
    return sequence;

    // ---- Build derived maps from nodeMeta ----
    // Build mapping between: nodeID, label, Lineno
    const nodeMetaObj = parseNodeMeta(nodeMeta);

    // const nodeIdToLine = new Map<string, number | null>();
    // const nodeIdToLabel = new Map<string, string>();

    for (const [id, m] of Object.entries(nodeMetaObj)) {
        nodeIdToLine.set(id, m.line ?? null);
        nodeIdToLabel.set(id, m.label);
    }

    // Ready-to-send, execution-ordered view (for LLM or whatever)
    const orderedForLLM = sequence.map((tmpNodeId) => ({
        nodeId: tmpNodeId,
        line: nodeIdToLine.get(tmpNodeId) ?? null,
        // statement: nodeIdToLabel.get(tmpNodeId) ?? (tmpNodeId === 'Start' || tmpNodeId === 'End' ? tmpNodeId : '')
        statement: nodeIdToLabel.get(tmpNodeId) ?? (nodeIdStringIsStartOrEnd(tmpNodeId) ? tmpNodeId : '')
    }));
    // console.log('orderedForLLM:', orderedForLLM);

    // interact with LLM
    let sortResult: string[] = sequence;// default to be old version, if LLM failed
    
    return sortResult;
}

type NodeMeta = Record<string, { 
    label: string;
    escaped_label: string; 
    line: number | null 
}>;

function parseNodeMeta(metaStr: string): NodeMeta {
  try { return JSON.parse(metaStr) as NodeMeta; }
  catch (e) { console.error('Error parsing node meta:', e); return {}; }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {nonce += chars.charAt(Math.floor(Math.random() * chars.length));}
  return nonce;
}

async function getWebviewHtmlExternal(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    mermaidCode: string,
    nodeOrder: string[],
    pseudocode: string = ''
): Promise<string> {
    // 1) read the template file
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'flowview.html');
    const bytes = await vscode.workspace.fs.readFile(templateUri);
    let html = new TextDecoder('utf-8').decode(bytes);

    // 2) build URIs & nonce
    const mermaidUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'mermaid.min.js')
    );
    // check mermaid log success
    console.log('Mermaid URI:', mermaidUri.toString());
    const nonce = getNonce();

    // 3) replace placeholders
    html = html
        .replace(/%%CSP_SOURCE%%/g, webview.cspSource)
        .replace(/%%NONCE%%/g, nonce)
        .replace(/%%MERMAID_JS_URI%%/g, mermaidUri.toString())
        .replace(/%%MERMAID_CODE%%/g, mermaidCode)
        .replace(/%%NODE_ORDER_JSON%%/g, JSON.stringify(nodeOrder))
        .replace(/%%PSEUDOCODE%%/g, escapeHtml(pseudocode)); 

    return html;
}

/**
 * 判斷當前行是否為程式碼區塊開始行
 */
function isBlockStart(lineText: string): boolean {
    const trimmed = lineText.trim();

    // 檢查是否以冒號結尾
    if (!trimmed.endsWith(':')) {
        return false;
    }

    // 檢查是否包含區塊關鍵字
    return trimmed.startsWith('def ') ||
        trimmed.startsWith('class ') ||
        trimmed.startsWith('if ') ||
        trimmed.startsWith('elif ') ||
        trimmed === 'else:' ||
        trimmed.startsWith('for ') ||
        trimmed.startsWith('while ') ||
        trimmed === 'try:' ||
        trimmed.startsWith('except') ||
        trimmed === 'finally:' ||
        trimmed.startsWith('with ') ||
        trimmed.startsWith('match ');
}

function getBlockTypeDisplay(type: CodeBlockType): string {
    switch (type) {
        case CodeBlockType.FUNCTION:
            return ' Function';
        case CodeBlockType.CLASS:
            return ' Class';
        case CodeBlockType.IF:
            return ' If Statement';
        case CodeBlockType.FOR:
            return ' For Loop';
        case CodeBlockType.WHILE:
            return ' While Loop';
        case CodeBlockType.TRY:
            return ' Try Block';
        case CodeBlockType.SINGLE_LINE:
            return ' Single Line';
        default:
            return ' Code Block';
    }
}

/**
 * 執行程式碼轉換為 pseudocode 的核心邏輯
 */
async function convertToPseudocode(isAutoUpdate: boolean = false) {
    // 獲取當前編輯器和選中的程式碼
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        if (!isAutoUpdate) {
            vscode.window.showErrorMessage('請先打開一個程式碼文件');
        }
        return;
    }

    const selection = editor.selection;
    let selectedText = editor.document.getText(selection);

    // 如果沒有選中程式碼，則轉換整個檔案
    if (!selectedText.trim()) {
        selectedText = editor.document.getText();
        if (!selectedText.trim()) {
            if (!isAutoUpdate) {
                vscode.window.showErrorMessage('檔案內容為空');
            }
            return;
        }
    }

    // 獲取 Claude API Key
    const apiKey = process.env.CLAUDE_API_KEY;

    if (!apiKey) {
        if (!isAutoUpdate) {
            vscode.window.showErrorMessage('找不到 CLAUDE_API_KEY，請檢查 .env 檔案');
        }
        return;
    }

    // 顯示進度指示器
    const progressLocation = vscode.ProgressLocation.Notification;

    await vscode.window.withProgress({
        location: progressLocation,
        title: isAutoUpdate ? "更新 pseudocode..." : "正在轉換程式碼為 pseudocode...",
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ increment: 30, message: "正在呼叫 Claude API..." });

            // 呼叫 Claude API
            const pseudocode = await codeToPseudocode(selectedText);

            progress.report({ increment: 70, message: "正在顯示結果..." });

            // 創建分割視窗顯示結果
            await showPseudocodePanel(pseudocode);

        } catch (error) {
            console.error('轉換失敗:', error);
            if (!isAutoUpdate) {
                vscode.window.showErrorMessage(`轉換失敗: ${(error as Error).message}`);
            }
        }
    });
}

/**
 * 創建分割視窗顯示 pseudocode
 */
async function showPseudocodePanel(pseudocode: string) {
    // 如果面板已存在，只更新內容
    if (pseudocodePanel) {
        pseudocodePanel.webview.html = getPseudocodeWebviewContent(pseudocode);
        return;
    }

    // 創建新的 WebView 面板
    pseudocodePanel = vscode.window.createWebviewPanel(
        'code2pseudocode',
        'Code to Pseudocode',
        vscode.ViewColumn.Beside, // 在側邊顯示
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    // 監聽面板關閉事件
    pseudocodePanel.onDidDispose(() => {
        pseudocodePanel = undefined;
    });

    // 設置 WebView 內容
    pseudocodePanel.webview.html = getPseudocodeWebviewContent(pseudocode);
}

/**
 * 生成 Pseudocode WebView 的 HTML 內容
 */
function getPseudocodeWebviewContent(pseudocode: string): string {
    return `
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code to Pseudocode</title>
        <style>
            body {
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                margin: 0;
                padding: 20px;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
            }
            .container {
                height: 100vh;
                display: flex;
                flex-direction: column;
            }
            .container h2 {
                margin: 0 0 15px 0;
                color: var(--vscode-titleBar-activeForeground);
                border-bottom: 2px solid var(--vscode-titleBar-border);
                padding-bottom: 8px;
            }
            .code-block {
                background-color: var(--vscode-textCodeBlock-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 4px;
                padding: 15px;
                flex: 1;
                overflow: auto;
                white-space: pre-wrap;
                font-size: 14px;
                line-height: 1.5;
            }
            .pseudocode {
                background-color: var(--vscode-diffEditor-removedTextBackground);
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h2> Pseudocode</h2>
            <div class="code-block pseudocode">${escapeHtml(pseudocode)}</div>
        </div>
    </body>
    </html>
    `;
}

/**
 * 跳脫 HTML 特殊字符
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function deactivate() {
    if (currentPanel) {
        currentPanel.dispose();
    }
    if (pseudocodePanel) {
        pseudocodePanel.dispose();
    }
}