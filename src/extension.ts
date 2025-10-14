import * as vscode from 'vscode';
import * as path from 'path';
import { codeToPseudocode, PseudocodeResult } from './claudeApi';
import * as dotenv from 'dotenv';
import { parsePythonWithAST } from './pythonAnalyzer';
import { WebViewNodeClickEventHandler, clearEditor, setWebviewPanel, handlePseudocodeLineClick, setMappings } from './WebviewEventHandler';


export let sourceDocUri: vscode.Uri | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
let nodeOrder: string[] = [];

const pseudocodeCache = new Map<string, string>();
let pseudocodeHistory: string[] = [];

// mapping relation
let lineToNodeMap: Map<number, string[]> = new Map();
let currentLineMapping: Array<{pythonLine: number, pseudocodeLine: number}> = [];
let pseudocodeToLineMap: Map<number, number> = new Map();
let fullPseudocodeGenerated = false;

export const nodeIdToLine = new Map<string, number | null>();
const nodeIdToLabel = new Map<string, string>();

export function activate(context: vscode.ExtensionContext) {
    const extensionPath = context.extensionPath;
    dotenv.config({ path: path.join(extensionPath, '.env') });

    console.log('Code2Pseudocode extension is now active!');
    console.log('Extension path:', extensionPath);
    console.log('CLAUDE_API_KEY exists:', !!process.env.CLAUDE_API_KEY);
    
    const disposable = vscode.commands.registerCommand('code2pseudocode.convertToPseudocode', async () => {
        await convertToPseudocode();
    });

    const onChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0) {
            const hasRealChanges = event.contentChanges.some(change => {
                return change.text.trim() !== '' || change.rangeLength > 0;
            });

            if (hasRealChanges) {
                pseudocodeCache.clear();
                currentLineMapping = [];
                fullPseudocodeGenerated = false;
            }
        }
    });
    
    let generateDisposable = vscode.commands.registerCommand('m5-test2.generate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active Python file');
            return;
        }

        const document = editor.document;
        
        if (document.languageId !== 'python') {
            vscode.window.showErrorMessage('Current file is not a Python file');
            return;
        }

        const code = document.getText();
        sourceDocUri = editor.document.uri;
        
        try {
            const { mermaidCode, lineMapping, nodeSequence, nodeMeta } = await parsePythonWithAST(code);
            
            console.log('Generated Mermaid code:');
            console.log(mermaidCode);
            console.log('Line mapping:', lineMapping);
            console.log('Node sequence:', nodeSequence);

            pseudocodeHistory = [];
            
            let pseudocodeText = '等待生成 Pseudocode...';
            
            lineToNodeMap = parseLineMapping(lineMapping);
            console.log('Parsed line to node map:', Array.from(lineToNodeMap.entries()));
            
            nodeOrder = await parseNodeSequence(nodeSequence, nodeMeta, code);
            console.log('Node order:', nodeOrder);
            
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
                        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
                    }
                );

                currentPanel.onDidDispose(() => {
                    currentPanel = undefined;
                    setWebviewPanel(undefined);
                    pseudocodeHistory = [];
                    currentLineMapping = [];
                    pseudocodeToLineMap.clear();
                    fullPseudocodeGenerated = false;
                });
            }

            // 設置 webview panel 引用
            setWebviewPanel(currentPanel);

            currentPanel.webview.html = await getWebviewHtmlExternal(
                currentPanel.webview,
                context,
                mermaidCode,
                nodeOrder,
                getPseudocodeHistoryText()
            );
            
            currentPanel.webview.onDidReceiveMessage(
                message => {
                    switch (message.command) {
                        case 'nodeClicked':
                            break;
                        case 'requestNodeOrder':
                            currentPanel?.webview.postMessage({
                                command: 'setNodeOrder',
                                nodeOrder: nodeOrder
                            });
                            break;
                        case 'webview.nodeClicked':
                            WebViewNodeClickEventHandler(message);
                            break;
                        case 'webview.requestClearEditor':
                            clearEditor(editor);
                            break;
                        case 'webview.clearPseudocodeHistory':
                            pseudocodeHistory = [];
                            currentLineMapping = [];
                            pseudocodeToLineMap.clear();
                            fullPseudocodeGenerated = false;
                            updateWebviewPseudocode();
                            break;
                        case 'webview.pseudocodeLineClicked':
                            handlePseudocodeLineClick(message.pseudocodeLine);
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

    const clearHistoryDisposable = vscode.commands.registerCommand('code2pseudocode.clearHistory', () => {
        pseudocodeHistory = [];
        currentLineMapping = [];
        pseudocodeToLineMap.clear();
        fullPseudocodeGenerated = false;
        updateWebviewPseudocode();
        vscode.window.showInformationMessage('Pseudocode history cleared');
    });
    
    let selectionDisposable = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!currentPanel) {
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'python') {
            return;
        }
        if (editor.document.uri !== sourceDocUri) {
            console.error('current editor is not where the flowchart come from');
            return;
        }

        const selection = e.selections[0];
        clearEditor(editor);
        
        if (!selection.isEmpty) {
            const startLine = selection.start.line + 1;
            const endLine = selection.end.line + 1;
            
            console.log(`Selection from line ${startLine} to ${endLine}`);
            
            const allNodeIds = new Set<string>();
            const pythonLines: number[] = [];
            
            for (let line = startLine; line <= endLine; line++) {
                const nodeIds = lineToNodeMap.get(line);
                if (nodeIds && nodeIds.length > 0) {
                    nodeIds.forEach(id => allNodeIds.add(id));
                }
                pythonLines.push(line);
            }
            
            if (allNodeIds.size > 0 || pythonLines.length > 0) {
                console.log('Highlighting nodes for Python lines:', Array.from(allNodeIds), pythonLines);
                
                currentPanel.webview.postMessage({
                    command: 'highlightNodesAndPseudocode',
                    nodeIds: Array.from(allNodeIds),
                    pseudocodeLines: pythonLines
                });
            } else {
                currentPanel.webview.postMessage({
                    command: 'clearHighlight'
                });
            }
        } else {
            const lineNumber = selection.active.line + 1;
            
            console.log('Cursor at line:', lineNumber);
            
            const nodeIds = lineToNodeMap.get(lineNumber);
            
            if (nodeIds && nodeIds.length > 0) {
                console.log('Found nodes for line', lineNumber, ':', nodeIds);
                
                currentPanel.webview.postMessage({
                    command: 'highlightNodesAndPseudocode',
                    nodeIds: nodeIds,
                    pseudocodeLines: [lineNumber]
                });
            } else {
                currentPanel.webview.postMessage({
                    command: 'clearHighlight'
                });
            }
        }
    });

    context.subscriptions.push(generateDisposable);
    context.subscriptions.push(selectionDisposable);
    context.subscriptions.push(disposable, onChangeDisposable, clearHistoryDisposable);
}

function addToPseudocodeHistory(pseudocode: string) {
    pseudocodeHistory.push(pseudocode);
    const maxHistory = 50;
    if (pseudocodeHistory.length > maxHistory) {
        pseudocodeHistory = pseudocodeHistory.slice(-maxHistory);
    }
}

function getPseudocodeHistoryText(): string {
    if (pseudocodeHistory.length === 0) {
        return '等待生成 Pseudocode...';
    }
    return pseudocodeHistory.join('\n');
}

function updateWebviewPseudocode() {
    if (currentPanel) {
        currentPanel.webview.postMessage({
            command: 'updatePseudocode',
            pseudocode: getPseudocodeHistoryText()
        });
        
        if (currentLineMapping.length > 0) {
            currentPanel.webview.postMessage({
                command: 'setLineMapping',
                mapping: currentLineMapping
            });
        }
    }
}

// ❌ 刪除這個函數定義（第 275-295 行）
// function handlePseudocodeLineClick(pseudocodeLine: number, editor: vscode.TextEditor) {
//     ...
// }

export function nodeIdStringIsStartOrEnd(nodeId: string): Boolean {
    return nodeId === "Start" || nodeId === "End";
}

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

            const arr = nodes as string[];
            let tempNodeId: string = arr[0];
            nodeIdToLine.set(tempNodeId, lineNum);
        }
    } catch (e) {
        console.error('Error parsing line mapping:', e);
    }
    console.log('Final line to node map:', Array.from(map.entries()));
    return map;
}

async function parseNodeSequence(sequenceStr: string, nodeMeta: string, fullCode: string): Promise<string[]> {
    let sequence: string[] = [];
    try {
        sequence = JSON.parse(sequenceStr);
    } catch (e) {
        console.error('Error parsing node sequence:', e);
        return ['Error parsing node sequence'];
    }
    return sequence;
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
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

async function getWebviewHtmlExternal(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    mermaidCode: string,
    nodeOrder: string[],
    pseudocode: string = ''
): Promise<string> {
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'flowview.html');
    const bytes = await vscode.workspace.fs.readFile(templateUri);
    let html = new TextDecoder('utf-8').decode(bytes);

    const mermaidUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'mermaid.min.js')
    );
    console.log('Mermaid URI:', mermaidUri.toString());
    const nonce = getNonce();

    html = html
        .replace(/%%CSP_SOURCE%%/g, webview.cspSource)
        .replace(/%%NONCE%%/g, nonce)
        .replace(/%%MERMAID_JS_URI%%/g, mermaidUri.toString())
        .replace(/%%MERMAID_CODE%%/g, mermaidCode)
        .replace(/%%NODE_ORDER_JSON%%/g, JSON.stringify(nodeOrder))
        .replace(/%%PSEUDOCODE%%/g, escapeHtml(pseudocode)); 

    return html;
}

async function convertToPseudocode(isAutoUpdate: boolean = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        if (!isAutoUpdate) {
            vscode.window.showErrorMessage('請先打開一個程式碼文件');
        }
        return;
    }

    if (!currentPanel) {
        vscode.window.showWarningMessage('請先執行 "Generate Flowchart" 命令');
        return;
    }

    if (fullPseudocodeGenerated) {
        vscode.window.showInformationMessage('Pseudocode 已生成，使用現有映射');
        return;
    }

    const document = editor.document;
    const fullCode = document.getText();

    if (!fullCode.trim()) {
        vscode.window.showErrorMessage('檔案內容為空');
        return;
    }

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
        if (!isAutoUpdate) {
            vscode.window.showErrorMessage('找不到 CLAUDE_API_KEY，請檢查 .env 檔案');
        }
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "正在轉換完整程式碼為 pseudocode...",
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ increment: 30, message: "正在呼叫 Claude API..." });
            
            const result: PseudocodeResult = await codeToPseudocode(fullCode);
            
            progress.report({ increment: 40, message: "正在處理結果..." });
            
            console.log('Received line mapping:', result.lineMapping);
            console.log('Pseudocode lines:', result.pseudocode.split('\n').length);
            
            currentLineMapping = result.lineMapping;

            pseudocodeToLineMap.clear();
            result.lineMapping.forEach(mapping => {
                pseudocodeToLineMap.set(mapping.pseudocodeLine, mapping.pythonLine);
            });
            console.log('Pseudocode to line map created:', Array.from(pseudocodeToLineMap.entries()));
            
            // 設置映射到 WebviewEventHandler
            setMappings(pseudocodeToLineMap, lineToNodeMap);
            
            pseudocodeHistory = [];
            addToPseudocodeHistory(result.pseudocode);
            fullPseudocodeGenerated = true;
            
            updateWebviewPseudocode();
            
            progress.report({ increment: 30, message: "完成！" });
            
            console.log('Total mappings created:', currentLineMapping.length);
            vscode.window.showInformationMessage(
                `Pseudocode 生成完成！已映射 ${currentLineMapping.length} 行程式碼`
            );

        } catch (error) {
            console.error('轉換失敗:', error);
            if (!isAutoUpdate) {
                vscode.window.showErrorMessage(`轉換失敗: ${(error as Error).message}`);
            }
        }
    });
}

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
}