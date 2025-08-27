import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { codeToPseudocode } from './claudeApi';
import { PythonCodeBlockParser, CodeBlock, CodeBlockType } from './codeBlockParser';
import * as dotenv from 'dotenv';

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

    // 註冊 Hover Provider
    const hoverProvider = vscode.languages.registerHoverProvider(
        ['python'],
        {
            async provideHover(document, position, token) {
                // 獲取當前行內容，用於初步檢查
                const line = document.lineAt(position.line);
                const lineText = line.text.trim();

                // 只在有程式碼內容的行才顯示（跳過 Python 註解和空行）
                if (!lineText || lineText.startsWith('#')) {
                    return null;
                }

                // 檢查 API Key
                const apiKey = process.env.CLAUDE_API_KEY;
                if (!apiKey) {
                    const errorMessage = new vscode.MarkdownString();
                    errorMessage.appendCodeblock('❌ 找不到 CLAUDE_API_KEY', 'text');
                    return new vscode.Hover(errorMessage);
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

                // 檢查快取
                if (pseudocodeCache.has(cacheKey)) {
                    const cachedPseudocode = pseudocodeCache.get(cacheKey)!;

                    // 顯示快取結果
                    const resultMessage = new vscode.MarkdownString();
                    resultMessage.appendCodeblock(`📝 Pseudocode (快取)
${getBlockTypeDisplay(codeBlock.type)} (Lines ${codeBlock.startLine + 1}-${codeBlock.endLine + 1})

${cachedPseudocode}`, 'text');

                    return new vscode.Hover(resultMessage);
                }

                try {
                    // 呼叫 API 轉換程式碼區塊
                    const pseudocode = await codeToPseudocode(codeBlock.code);

                    // 存入快取
                    pseudocodeCache.set(cacheKey, pseudocode);

                    // 顯示結果
                    const resultMessage = new vscode.MarkdownString();
                    resultMessage.appendCodeblock(`📝 Pseudocode
${getBlockTypeDisplay(codeBlock.type)} (Lines ${codeBlock.startLine + 1}-${codeBlock.endLine + 1})

${pseudocode}`, 'text');

                    return new vscode.Hover(resultMessage);

                } catch (error) {
                    // 錯誤處理
                    const errorMessage = new vscode.MarkdownString();
                    errorMessage.appendCodeblock(`❌ 轉換失敗
${getBlockTypeDisplay(codeBlock.type)} (Lines ${codeBlock.startLine + 1}-${codeBlock.endLine + 1})
錯誤: ${(error as Error).message}`, 'text');

                    return new vscode.Hover(errorMessage);
                }
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
        if (document.languageId !== 'python') {
            vscode.window.showErrorMessage('Current file is not a Python file');
            return;
        }

        const code = document.getText();
        
        try {
            //使用 Python AST 來解析程式碼，並獲取每一行的對應關係
            const { mermaidCode, lineMapping, nodeSequence } = await parsePythonWithAST(code);
            
            console.log('Generated Mermaid code:');
            console.log(mermaidCode);
            console.log('Line mapping:', lineMapping);
            console.log('Node sequence:', nodeSequence);
            
            //解析每一行的對應關系
            lineToNodeMap = parseLineMapping(lineMapping);
            console.log('Parsed line to node map:', Array.from(lineToNodeMap.entries()));
            
            //解析節點順序（新增）
            nodeOrder = parseNodeSequence(nodeSequence);
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
                        retainContextWhenHidden: true
                    }
                );

                currentPanel.onDidDispose(() => {
                    currentPanel = undefined;
                });
            }

            currentPanel.webview.html = getWebviewContent(mermaidCode, nodeOrder);
            
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
                    }
                },
                undefined,
                context.subscriptions
            );
            
        } catch (error) {
            vscode.window.showErrorMessage(`Error generating flowchart: ${error}`);
        }
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

        //取得目前所在的是哪一行的資訊（從1開始）
        const lineNumber = e.selections[0].active.line + 1;
        
        console.log('Cursor at line:', lineNumber);
        console.log('Line to node map:', Array.from(lineToNodeMap.entries()));
        
        //查找對應的節點ID
        const nodeIds = lineToNodeMap.get(lineNumber);
        if (nodeIds && nodeIds.length > 0) {
            console.log('Found nodes for line', lineNumber, ':', nodeIds);
            //發送消息到webview並將該節點發光，bling bling這樣
            currentPanel.webview.postMessage({
                command: 'highlightNodes',
                nodeIds: nodeIds
            });
        } else {
            console.log('No nodes found for line', lineNumber);
            //把亮亮的清除
            currentPanel.webview.postMessage({
                command: 'clearHighlight'
            });
        }
    });

    context.subscriptions.push(generateDisposable);
    context.subscriptions.push(selectionDisposable);
    context.subscriptions.push(disposable, onSaveDisposable, onChangeDisposable, hoverProvider);
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
        }
    } catch (e) {
        console.error('Error parsing line mapping:', e);
    }
    console.log('Final line to node map:', Array.from(map.entries()));
    return map;
}

// 解析節點順序（新增）
function parseNodeSequence(sequenceStr: string): string[] {
    try {
        const sequence = JSON.parse(sequenceStr);
        return sequence as string[];
    } catch (e) {
        console.error('Error parsing node sequence:', e);
        return [];
    }
}

// 生成 Python AST 解析器類別
function generatePythonASTClass(): string {
    const imports = () => `
import ast
import json
import sys
`;

    const classDefinition = () => `
class FlowchartGenerator(ast.NodeVisitor):
    """AST 訪問器，用於生成 Mermaid 流程圖並追蹤行號"""
    
    def __init__(self):
        self.node_id = 0
        self.mermaid_lines = ['flowchart TD']
        self.current_node = 'Start'  #開始的節點
        self.function_defs = {}      #存放function def的節點資訊
        self.loop_stack = []         #存放所有使用迴圈的節點(包含while for)
        self.if_stack = []           #存放使用到if的節點資訊
        self.in_function = False     #下面以此類推
        self.current_function = None
        self.branch_ends = []  
        self.pending_no_label = None
        self.unreachable = False     #追蹤是否為不可達程式碼
        self.line_to_node = {}       # python code到flowchart區塊的對應關係
        self.node_sequence = []      # 節點執行順序
        
        self.mermaid_lines.append('    Start([Start])')
        self.mermaid_lines.append('    style Start fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px')
        self.node_sequence.append('Start')  # 記錄開始節點
`;

    const helperMethods = () => `
    def get_next_id(self):
        """生成下一個節點 ID"""
        self.node_id += 1
        return f'node{self.node_id}'
    
    def escape_text(self, text):
        """轉義 Mermaid 特殊字符"""
        return (text.replace('"', '&quot;')
                   .replace("'", '&apos;')
                   .replace('(', '&#40;')
                   .replace(')', '&#41;')
                   .replace('<', '&lt;')
                   .replace('>', '&gt;'))
    
    def add_line_mapping(self, node, node_id):
        """添加行號到節點ID的映射"""
        if hasattr(node, 'lineno'):
            line = node.lineno
            if line not in self.line_to_node:
                self.line_to_node[line] = []
            self.line_to_node[line].append(node_id)
    
    def add_node(self, node_id, label, shape='rectangle', style=None, source_node=None):
        """添加節點到 Mermaid 圖"""
        escaped_label = self.escape_text(label)
        
        # 添加行號映射
        if source_node:
            self.add_line_mapping(source_node, node_id)
        
        # 記錄節點順序（新增）
        if node_id not in self.node_sequence:
            self.node_sequence.append(node_id)
        
        if shape == 'rectangle':
            self.mermaid_lines.append(f'    {node_id}["{escaped_label}"]')
        elif shape == 'diamond':
            self.mermaid_lines.append(f'    {node_id}{{"{escaped_label}"}}')
        elif shape == 'parallelogram':
            self.mermaid_lines.append(f'    {node_id}[/"{escaped_label}"/]')
        elif shape == 'rounded':
            self.mermaid_lines.append(f'    {node_id}(["{escaped_label}"])')
        elif shape == 'double':
            self.mermaid_lines.append(f'    {node_id}[["{escaped_label}"]]')
        elif shape == 'invisible':
            self.mermaid_lines.append(f'    {node_id}[ ]')
            self.mermaid_lines.append(f'    style {node_id} fill:transparent,stroke:transparent')
            return
        
        if style:
            self.mermaid_lines.append(f'    style {node_id} {style}')
        
        # 添加點擊事件
        self.mermaid_lines.append(f'    click {node_id} nodeClick')
    
    def add_edge(self, from_node, to_node, label=None):
        """添加邊到 Mermaid 圖"""
        if label:
            self.mermaid_lines.append(f'    {from_node} -->|{label}| {to_node}')
        else:
            self.mermaid_lines.append(f'    {from_node} --> {to_node}')
    
    def add_dotted_edge(self, from_node, to_node, label='calls'):
        """添加虛線邊（用於函式呼叫）"""
        self.mermaid_lines.append(f'    {from_node} -.->|{label}| {to_node}')
`;

    const visitMethods = () => `
    def visit_Module(self, node):
        """訪問模組節點"""
        # 先處理所有函式定義
        for item in node.body:
            if isinstance(item, ast.FunctionDef) or isinstance(item, ast.ClassDef):
                self.visit(item)
        
        # 重置狀態，開始處理主程式
        self.current_node = 'Start'
        
        # 處理主程式（非函式定義的部分）
        for item in node.body:
            if not isinstance(item, ast.FunctionDef) and not isinstance(item, ast.ClassDef):
                self.visit(item)
        
        # 添加結束節點
        end_node = 'End'
        self.mermaid_lines.append('    End([End])')
        self.mermaid_lines.append('    style End fill:#ffcdd2,stroke:#b71c1c,stroke-width:2px')
        
        # 記錄結束節點（新增）
        if end_node not in self.node_sequence:
            self.node_sequence.append(end_node)
        
        # 處理可能的分支合併情況
        if self.branch_ends:
            for end_node_id in self.branch_ends:
                if end_node_id:
                    if end_node_id == self.pending_no_label:
                        self.add_edge(end_node_id, end_node, 'No')
                        self.pending_no_label = None
                    else:
                        self.add_edge(end_node_id, end_node)
            self.branch_ends = []
        elif self.current_node:
            if self.current_node == self.pending_no_label:
                self.add_edge(self.current_node, end_node, 'No')
                self.pending_no_label = None
            else:
                self.add_edge(self.current_node, end_node)
    
    def visit_Import(self, node):
        """處理 import 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        import_names = ', '.join([alias.name for alias in node.names])
        self.add_node(node_id, f'import {import_names}', 'rectangle', 'fill:#fff3e0,stroke:#e65100,stroke-width:2px', node)
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        self.current_node = node_id
    
    def visit_ImportFrom(self, node):
        """處理 from ... import ... 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        import_names = ', '.join([alias.name for alias in node.names])
        module = node.module or ''
        self.add_node(node_id, f'from {module} import {import_names}', 'rectangle','fill:#fff3e0,stroke:#e65100,stroke-width:2px', node)
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        self.current_node = node_id
    
    def visit_FunctionDef(self, node):
        """處理函式定義"""
        func_id = f'func_{node.name}'
        self.function_defs[node.name] = func_id
        
        # 創建函式節點
        self.add_node(func_id, f'Function: {node.name}()', 'double','fill:#e1f5fe,stroke:#01579b,stroke-width:3px', node)
        
        # 保存當前狀態
        old_current = self.current_node
        old_in_function = self.in_function
        old_branch_ends = self.branch_ends[:]
        old_loop_stack = self.loop_stack[:]
        
        # 設置函式內部狀態
        self.in_function = True
        self.current_node = func_id
        self.branch_ends = []
        self.loop_stack = []
        
        # 訪問函式體
        for stmt in node.body:
            self.visit(stmt)
        
        # 如果函式沒有以 return 結束，需要處理後續流程
        if self.current_node and not self.ends_with_return(node.body):
            # 函式結束後的節點會成為分支結束點
            pass
        
        # 恢復狀態
        self.current_node = old_current
        self.in_function = old_in_function
        self.branch_ends = old_branch_ends
        self.loop_stack = old_loop_stack
    
    def visit_ClassDef(self, node):
        """處理類別定義"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        self.add_node(node_id, f'Class: {node.name}', 'rectangle','fill:#f3e5f5,stroke:#4a148c,stroke-width:2px', node)
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        self.current_node = node_id
    
    def visit_If(self, node):
        """處理 if 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        if_id = self.get_next_id()
        
        condition = self.get_source_segment(node.test)
        self.add_node(if_id, f'if {condition}', 'diamond','fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px', node)
        
        # 處理分支合併的情況
        if self.branch_ends and not self.current_node:
            for end_node in self.branch_ends:
                if end_node:
                    self.add_edge(end_node, if_id)
            self.branch_ends = []
        elif self.current_node:
            self.add_edge(self.current_node, if_id)
        
        # 清空 branch_ends 準備收集新的分支
        self.branch_ends = []
        self.current_node = if_id
        
        # 處理 if body (Yes 分支)
        if node.body:
            self.visit(node.body[0])
            self.fix_last_edge_label(if_id, 'Yes')
            
            for stmt in node.body[1:]:
                self.visit(stmt)
            
            # 如果 if body 沒有以 return/break 結束，保存當前節點
            if self.current_node and not self.ends_with_return_or_break(node.body):
                self.branch_ends.append(self.current_node)
        
        # 處理 else/elif
        if node.orelse:
            self.current_node = if_id
            
            if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
                # 處理 elif
                elif_branches = self.process_elif_chain(node.orelse[0], if_id)
                self.branch_ends.extend(elif_branches)
            else:
                # 處理 else
                self.visit(node.orelse[0])
                self.fix_last_edge_label(if_id, 'No')
                
                for stmt in node.orelse[1:]:
                    self.visit(stmt)
                
                if self.current_node and not self.ends_with_return_or_break(node.orelse):
                    self.branch_ends.append(self.current_node)
        else:
            # 沒有 else 分支的情況
            # 設置 current_node 為 if_id讓後續的語句能從 No 分支連接
            self.current_node = if_id
            self.pending_no_label = if_id
            # 不要將 if_id 加入 branch_ends
            return  # 直接返回，避免設置 current_node 為 None
        
        # 只有在有多個分支需要合併時才設置 current_node 為 None
        if len(self.branch_ends) > 0:
            self.current_node = None
    
    def process_elif_chain(self, elif_node, parent_id):
        """處理 elif 鏈"""
        elif_id = self.get_next_id()
        
        condition = self.get_source_segment(elif_node.test)
        self.add_node(elif_id, f'if {condition}', 'diamond','fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px', elif_node)
        
        self.add_edge(parent_id, elif_id, 'No')
        
        branch_ends = []
        self.current_node = elif_id
        
        if elif_node.body:
            self.visit(elif_node.body[0])
            self.fix_last_edge_label(elif_id, 'Yes')
            
            for stmt in elif_node.body[1:]:
                self.visit(stmt)
            
            if self.current_node and not self.ends_with_return_or_break(elif_node.body):
                branch_ends.append(self.current_node)
        
        if elif_node.orelse:
            self.current_node = elif_id
            
            if len(elif_node.orelse) == 1 and isinstance(elif_node.orelse[0], ast.If):
                next_elif_branches = self.process_elif_chain(elif_node.orelse[0], elif_id)
                branch_ends.extend(next_elif_branches)
            else:
                self.visit(elif_node.orelse[0])
                self.fix_last_edge_label(elif_id, 'No')
                
                for stmt in elif_node.orelse[1:]:
                    self.visit(stmt)
                
                if self.current_node and not self.ends_with_return_or_break(elif_node.orelse):
                    branch_ends.append(self.current_node)
        else:
            branch_ends.append(elif_id)
            self.pending_no_edge = elif_id
        
        return branch_ends
    
    def ends_with_return(self, body):
        """檢查代碼塊是否以 return 語句結束"""
        if not body:
            return False
        last_stmt = body[-1]
        return isinstance(last_stmt, ast.Return)
    
    def ends_with_return_or_break(self, body):
        """檢查代碼塊是否以 return 或 break 語句結束"""
        if not body:
            return False
        last_stmt = body[-1]
        return isinstance(last_stmt, (ast.Return, ast.Break))
    
    def ends_with_continue(self, body):
        """檢查代碼塊是否以 continue 語句結束"""
        if not body:
            return False
        last_stmt = body[-1]
        return isinstance(last_stmt, ast.Continue)
    
    def fix_last_edge_label(self, from_node, label):
        """修正最後一條從指定節點出發的邊的標籤"""
        for i in range(len(self.mermaid_lines) - 1, -1, -1):
            if f'{from_node} -->' in self.mermaid_lines[i] and '|' not in self.mermaid_lines[i]:
                self.mermaid_lines[i] = self.mermaid_lines[i].replace(' --> ', f' -->|{label}| ')
                break
    
    def visit_For(self, node):
        """處理 for 迴圈（支援 break/continue)"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        for_id = self.get_next_id()
        
        target = self.get_source_segment(node.target)
        iter_expr = self.get_source_segment(node.iter)
        self.add_node(for_id, f'for {target} in {iter_expr}', 'rectangle','fill:#e3f2fd,stroke:#0d47a1,stroke-width:2px', node)
        
        # 處理分支合併的情況（例如從 if 語句的多個分支）
        if self.branch_ends and not self.current_node:
            for end_node in self.branch_ends:
                if end_node:
                    if end_node == self.pending_no_label:
                        self.add_edge(end_node, for_id, 'No')
                        self.pending_no_label = None
                    else:
                        self.add_edge(end_node, for_id)
            self.branch_ends = []
        elif self.current_node:
            if self.current_node == self.pending_no_label:
                self.add_edge(self.current_node, for_id, 'No')
                self.pending_no_label = None
            else:
                self.add_edge(self.current_node, for_id)
        
        # 將迴圈節點加入堆疊（用於 break/continue)
        self.loop_stack.append(for_id)
        
        # 儲存當前狀態
        old_branch_ends = self.branch_ends[:]
        self.branch_ends = []
        break_nodes = []  # 收集 break 節點
        
        self.current_node = for_id
        for stmt in node.body:
            self.visit(stmt)
            # 如果遇到 break收集 break 節點
            if self.branch_ends and not self.current_node:
                break_nodes.extend(self.branch_ends)
                self.branch_ends = []
                # 重要：設置 current_node 為 None確保後續語句被識別為可達
                self.current_node = None
        
        # 如果迴圈體正常結束（沒有 break/continue 導致 current_node 為 None)連接回迴圈開始
        if self.current_node and self.current_node != for_id:
            self.add_edge(self.current_node, for_id)
        
        # 從堆疊中移除迴圈節點
        self.loop_stack.pop()
        
        # 處理迴圈後的流程
        if break_nodes:
            # 如果有 break這些節點將繼續執行迴圈後的程式碼
            # 檢查是否在另一個迴圈內
            if self.loop_stack:
                # 在巢狀迴圈中break 後回到外層迴圈
                parent_loop = self.loop_stack[-1]
                for break_node in break_nodes:
                    self.add_edge(break_node, parent_loop)
                # 設置 current_node 為 None表示這個迴圈路徑已結束
                self.current_node = None
            else:
                # 不在其他迴圈內 break 節點會成為後續程式的起點
                self.current_node = None
                self.branch_ends = break_nodes + [for_id]
        else:
            # 沒有 break正常的 for 迴圈結束
            # 檢查是否在另一個迴圈內
            if self.loop_stack:
                # 在巢狀迴圈中，迴圈結束後回到外層迴圈
                parent_loop = self.loop_stack[-1]
                self.add_edge(for_id, parent_loop)
                self.current_node = None
            else:
                # 不在其他迴圈內for_id 成為下一個語句的起點
                self.current_node = for_id
                self.branch_ends = old_branch_ends
    
    def visit_While(self, node):
        """處理 while 迴圈（支援 break/continue)"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        while_id = self.get_next_id()
        
        condition = self.get_source_segment(node.test)
        self.add_node(while_id, f'while {condition}', 'diamond','fill:#e3f2fd,stroke:#0d47a1,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, while_id)
        
        # 將迴圈節點加入堆疊（用於 break/continue)
        self.loop_stack.append(while_id)
        
        # 儲存當前狀態
        old_branch_ends = self.branch_ends[:]
        self.branch_ends = []
        
        self.current_node = while_id
        
        first_in_body = True
        for stmt in node.body:
            if first_in_body:
                self.visit(stmt)
                self.fix_last_edge_label(while_id, 'True')
                first_in_body = False
            else:
                self.visit(stmt)
        
        # 如果迴圈體正常結束（沒有 break)連接回迴圈開始
        if self.current_node and self.current_node != while_id:
            self.add_edge(self.current_node, while_id)
        
        # 從堆疊中移除迴圈節點
        self.loop_stack.pop()
        
        # 設置 while 迴圈後的流程
        # 如果有 break這些節點會成為後續程式的起點
        if self.branch_ends:
            # break 節點會繼續執行後面的程式碼
            # 不直接連接，而是將它們保留在 branch_ends 中
            self.current_node = None
        else:
            # 沒有 break正常的 while False 出口
            self.current_node = while_id
        
        # 恢復並合併 branch_ends(但保留 break 節點）
        if not self.branch_ends:
            self.branch_ends = old_branch_ends
    
    def visit_Return(self, node):
        """處理 return 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        
        if node.value:
            value = self.get_source_segment(node.value)
            self.add_node(node_id, f'return {value}', 'rounded','fill:#ffebee,stroke:#b71c1c,stroke-width:2px', node)
        else:
            self.add_node(node_id, 'return', 'rounded','fill:#ffebee,stroke:#b71c1c,stroke-width:2px', node)
        
        if self.current_node:
            # 檢查是否需要添加 No 標籤
            if self.current_node == self.pending_no_label:
                self.add_edge(self.current_node, node_id, 'No')
                self.pending_no_label = None
            else:
                self.add_edge(self.current_node, node_id)
        
        if node.value and isinstance(node.value, ast.Call):
            if isinstance(node.value.func, ast.Name):
                func_name = node.value.func.id
                if func_name in self.function_defs:
                    self.add_dotted_edge(node_id, self.function_defs[func_name])
        
        self.current_node = None
    
    def visit_Break(self, node):
        """處理 break 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        self.add_node(node_id, 'break', 'rounded','fill:#ffccbc,stroke:#d84315,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        # 將此節點加入 branch_ends 以便迴圈處理
        # break 節點會在 visit_For 或 visit_While 中被收集
        self.branch_ends.append(node_id)
        
        # break 會跳出迴圈，所以設置 current_node 為 None
        self.current_node = None
    
    def visit_Continue(self, node):
        """處理 continue 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        self.add_node(node_id, 'continue', 'rounded','fill:#ffe0b2,stroke:#ef6c00,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        # continue 會返回迴圈開始，找到最近的迴圈節點
        if self.loop_stack:
            # 連接到最近的迴圈節點
            loop_node = self.loop_stack[-1]
            self.add_edge(node_id, loop_node, 'continue')
        
        # continue 後的程式碼不會執行
        self.current_node = None
    
    def visit_Pass(self, node):
        """處理 pass 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        self.add_node(node_id, 'pass', 'rectangle','fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px,stroke-dasharray:5,5', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        self.current_node = node_id
    
    def visit_Assert(self, node):
        """處理 assert 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        
        condition = self.get_source_segment(node.test)
        if node.msg:
            msg = self.get_source_segment(node.msg)
            label = f'assert {condition}, {msg}'
        else:
            label = f'assert {condition}'
        
        self.add_node(node_id, label, 'diamond','fill:#ffebee,stroke:#c62828,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        # assert 成功時繼續執行
        self.current_node = node_id
    
    def visit_Global(self, node):
        """處理 global 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        global_vars = ', '.join(node.names)
        self.add_node(node_id, f'global {global_vars}', 'rectangle','fill:#e8f5e9,stroke:#388e3c,stroke-width:1px,stroke-dasharray:3,3', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        self.current_node = node_id
    
    def visit_Nonlocal(self, node):
        """處理 nonlocal 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        nonlocal_vars = ', '.join(node.names)
        self.add_node(node_id, f'nonlocal {nonlocal_vars}', 'rectangle','fill:#e3f2fd,stroke:#1976d2,stroke-width:1px,stroke-dasharray:3,3', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        self.current_node = node_id
    
    def visit_Expr(self, node):
        """處理表達式語句"""
        # 檢查是否為不可達程式碼
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼，直接返回
        
        if isinstance(node.value, ast.Call):
            call_node = node.value
            node_id = self.get_next_id()
            
            if isinstance(call_node.func, ast.Name):
                func_name = call_node.func.id
                
                if func_name == 'print':
                    args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                    self.add_node(node_id, f'print({args})', 'parallelogram','fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px', node)
                    
                    for arg in call_node.args:
                        if isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name):
                            called_func = arg.func.id
                            if called_func in self.function_defs:
                                self.add_dotted_edge(node_id, self.function_defs[called_func])
                elif func_name == 'input':
                    args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                    self.add_node(node_id, f'input({args})', 'parallelogram','fill:#e8eaf6,stroke:#283593,stroke-width:2px', node)
                else:
                    args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                    self.add_node(node_id, f'Call {func_name}({args})', 'rectangle','fill:#fce4ec,stroke:#880e4f,stroke-width:3px', node)
                    
                    if func_name in self.function_defs:
                        self.add_dotted_edge(node_id, self.function_defs[func_name])
            elif isinstance(call_node.func, ast.Attribute):
                method_name = call_node.func.attr
                obj = self.get_source_segment(call_node.func.value)
                args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                self.add_node(node_id, f'{obj}.{method_name}({args})', 'rectangle','fill:#fce4ec,stroke:#880e4f,stroke-width:2px', node)
            
            # 處理連接
            if self.branch_ends and not self.current_node:
                for end_node in self.branch_ends:
                    if end_node:
                        if end_node == self.pending_no_label:
                            self.add_edge(end_node, node_id, 'No')
                            self.pending_no_label = None
                        else:
                            self.add_edge(end_node, node_id)
                self.branch_ends = []
            elif self.current_node:
                if self.pending_no_label == self.current_node:
                    self.add_edge(self.current_node, node_id, 'No')
                    self.pending_no_label = None
                else:
                    self.add_edge(self.current_node, node_id)
            
            self.current_node = node_id
    
    def visit_Assign(self, node):
        """處理賦值語句"""
        # 檢查是否為不可達程式碼
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        
        targets = ', '.join([self.get_source_segment(t) for t in node.targets])
        value = self.get_source_segment(node.value)
        
        self.add_node(node_id, f'{targets} = {value}', 'rectangle','fill:#ffffff,stroke:#424242,stroke-width:2px', node)
        
        # 處理多個分支合併的情況
        if self.branch_ends and not self.current_node:
            for end_node in self.branch_ends:
                if end_node:
                    if end_node == self.pending_no_label:
                        self.add_edge(end_node, node_id, 'No')
                        self.pending_no_label = None
                    else:
                        self.add_edge(end_node, node_id)
            self.branch_ends = []
        elif self.current_node:
            if self.pending_no_label == self.current_node:
                self.add_edge(self.current_node, node_id, 'No')
                self.pending_no_label = None
            else:
                self.add_edge(self.current_node, node_id)
        
        if isinstance(node.value, ast.Call):
            if isinstance(node.value.func, ast.Name):
                func_name = node.value.func.id
                if func_name in self.function_defs:
                    self.add_dotted_edge(node_id, self.function_defs[func_name])
                    self.mermaid_lines.append(f'    style {node_id} stroke:#e91e63,stroke-width:3px')
        
        self.current_node = node_id
    
    def visit_AugAssign(self, node):
        """處理增強賦值語句+=, -=等等"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        node_id = self.get_next_id()
        
        target = self.get_source_segment(node.target)
        op = self.get_op_symbol(node.op)
        value = self.get_source_segment(node.value)
        
        self.add_node(node_id, f'{target} {op}= {value}', 'rectangle','fill:#ffffff,stroke:#424242,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        self.current_node = node_id
    
    def visit_Try(self, node):
        """處理 try-except 語句"""
        if self.current_node is None and not self.branch_ends:
            return  # 不可達程式碼
            
        try_id = self.get_next_id()
        self.add_node(try_id, 'try-except', 'rectangle','fill:#fff9c4,stroke:#f57c00,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, try_id)
        
        self.current_node = try_id
    
    def get_source_segment(self, node):
        """獲取節點的源代碼片段"""
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Constant):
            return repr(node.value)
        elif isinstance(node, ast.BinOp):
            left = self.get_source_segment(node.left)
            right = self.get_source_segment(node.right)
            op = self.get_op_symbol(node.op)
            return f'{left} {op} {right}'
        elif isinstance(node, ast.Compare):
            left = self.get_source_segment(node.left)
            ops = [self.get_op_symbol(op) for op in node.ops]
            comparators = [self.get_source_segment(c) for c in node.comparators]
            result = left
            for op, comp in zip(ops, comparators):
                result += f' {op} {comp}'
            return result
        elif isinstance(node, ast.Call):
            func = self.get_source_segment(node.func)
            args = ', '.join([self.get_source_segment(arg) for arg in node.args])
            return f'{func}({args})'
        elif isinstance(node, ast.Attribute):
            value = self.get_source_segment(node.value)
            return f'{value}.{node.attr}'
        elif isinstance(node, ast.Subscript):
            value = self.get_source_segment(node.value)
            slice_val = self.get_source_segment(node.slice)
            return f'{value}[{slice_val}]'
        elif isinstance(node, ast.List):
            elements = ', '.join([self.get_source_segment(e) for e in node.elts])
            return f'[{elements}]'
        elif isinstance(node, ast.ListComp):
            # 處理列表推導式
            elt = self.get_source_segment(node.elt)
            comp = node.generators[0]
            target = self.get_source_segment(comp.target)
            iter_val = self.get_source_segment(comp.iter)
            if comp.ifs:
                conditions = ' '.join([f'if {self.get_source_segment(c)}' for c in comp.ifs])
                return f'[{elt} for {target} in {iter_val} {conditions}]'
            return f'[{elt} for {target} in {iter_val}]'
        elif isinstance(node, ast.Tuple):
            elements = ', '.join([self.get_source_segment(e) for e in node.elts])
            return f'({elements})'
        elif isinstance(node, ast.Dict):
            items = ', '.join([f'{self.get_source_segment(k)}: {self.get_source_segment(v)}' for k, v in zip(node.keys, node.values)])
            return f'{{{items}}}'
        else:
            return str(type(node).__name__)
    
    def get_op_symbol(self, op):
        """獲取運算符號"""
        op_map = {
            ast.Add: '+', ast.Sub: '-', ast.Mult: '*', ast.Div: '/',
            ast.Mod: '%', ast.Pow: '**', ast.FloorDiv: '//',
            ast.Eq: '==', ast.NotEq: '!=', ast.Lt: '<', ast.LtE: '<=',
            ast.Gt: '>', ast.GtE: '>=', ast.Is: 'is', ast.IsNot: 'is not',
            ast.In: 'in', ast.NotIn: 'not in',
            ast.And: 'and', ast.Or: 'or', ast.Not: 'not'
        }
        return op_map.get(type(op), '?')
    
    def generate_mermaid(self):
        """生成最終的 Mermaid 程式碼"""
        return '\\n'.join(self.mermaid_lines)
    
    def get_line_mapping(self):
        """獲取行號到節點ID的映射"""
        return json.dumps(self.line_to_node)
    
    def get_node_sequence(self):
        """獲取節點執行順序（新增）"""
        return json.dumps(self.node_sequence)
`;

    return [
        imports(),
        classDefinition(),
        helperMethods(),
        visitMethods()
    ].join('');
}

/**
 * 生成 Python 主程式
 */
function generatePythonMain(code: string): string {
    const escapedCode = code
        .replace(/\\/g, '\\\\')
        .replace(/'''/g, "\\'''")
        .replace(/"""/g, '\\"""');
    
    return `
# 主程式
try:
    code = '''${escapedCode}'''
    
    # 顯示每一行的內容和行號（測試用）
    import sys
    lines = code.split('\\n')
    for i, line in enumerate(lines, 1):
        print(f"Line {i}: {repr(line)}", file=sys.stderr)
    
    # 解析 AST
    tree = ast.parse(code)
    
    # 生成流程圖
    generator = FlowchartGenerator()
    generator.visit(tree)
    
    # 輸出 Mermaid 程式碼
    print(generator.generate_mermaid())
    print("---LINE_MAPPING---")
    
    # 輸出行號映射
    line_mapping = generator.get_line_mapping()
    print(line_mapping)
    
    print("---NODE_SEQUENCE---")
    
    # 輸出節點順序（新增）
    node_sequence = generator.get_node_sequence()
    print(node_sequence)
    
    # 錯誤測試
    print(f"Line mapping details: {generator.line_to_node}", file=sys.stderr)
    print(f"Node sequence: {generator.node_sequence}", file=sys.stderr)
    
    # 檢查並顯示 AST 節點的實際行號
    for node in ast.walk(tree):
        if hasattr(node, 'lineno'):
            node_type = type(node).__name__
            print(f"AST Node {node_type} at line {node.lineno}", file=sys.stderr)
    
except SyntaxError as e:
    print(f"Syntax Error: {e}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
`;
}

// 使用 Python 的 AST 模組來解析程式碼
function parsePythonWithAST(code: string): Promise<{mermaidCode: string, lineMapping: string, nodeSequence: string}> {
    return new Promise((resolve, reject) => {
        const pythonScript = generatePythonASTClass() + generatePythonMain(code);
        
        // 創建臨時文件來避免命令行長度限制
        const tempDir = os.tmpdir();
        const tempScriptPath = path.join(tempDir, `vscode_flowchart_${Date.now()}.py`);
        
        try {
            // 寫入臨時Python文件
            fs.writeFileSync(tempScriptPath, pythonScript, 'utf8');
        } catch (writeError) {
            reject(new Error(`Failed to create temporary file: ${writeError}`));
            return;
        }
        
        // 嘗試多個可能的 Python 命令
        const pythonCommands = ['python3', 'python', 'py'];
        let currentCommandIndex = 0;
        
        function cleanupAndReject(error: Error) {
            try {
                fs.unlinkSync(tempScriptPath);
            } catch (cleanupError) {
                console.error('Failed to cleanup temp file:', cleanupError);
            }
            reject(error);
        }
        
        function cleanupAndResolve(result: {mermaidCode: string, lineMapping: string, nodeSequence: string}) {
            try {
                fs.unlinkSync(tempScriptPath);
            } catch (cleanupError) {
                console.error('Failed to cleanup temp file:', cleanupError);
            }
            resolve(result);
        }
        
        function tryNextPython() {
            if (currentCommandIndex >= pythonCommands.length) {
                cleanupAndReject(new Error('Python not found. Please install Python 3.x or add it to your PATH. Tried: ' + pythonCommands.join(', ')));
                return;
            }
            
            const pythonCmd = pythonCommands[currentCommandIndex];
            console.log(`Trying Python command: ${pythonCmd}`);
            
            // 使用臨時文件而不是 -c 參數
            const python = spawn(pythonCmd, [tempScriptPath]);
            
            let output = '';
            let error = '';
            
            python.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            python.stderr.on('data', (data) => {
                const errorStr = data.toString();
                error += errorStr;
                // 輸出所有調試信息到 console
                console.log('Python stderr:', errorStr);
            });
            
            python.on('close', (exitCode) => {
                if (exitCode !== 0) {
                    console.error(`${pythonCmd} script failed with exit code:`, exitCode);
                    console.error('Full error output:', error);
                    
                    // 如果當前Python命令失敗，嘗試下一個
                    currentCommandIndex++;
                    tryNextPython();
                } else {
                    const parts = output.trim().split('---LINE_MAPPING---');
                    const mermaidCode = parts[0].trim();
                    const afterMapping = parts[1]?.trim() || '{}';
                    
                    const secondParts = afterMapping.split('---NODE_SEQUENCE---');
                    const lineMapping = secondParts[0].trim();
                    const nodeSequence = secondParts[1]?.trim() || '[]';
                    
                    console.log('Raw Python output line mapping:', lineMapping);
                    console.log('Raw Python output node sequence:', nodeSequence);
                    
                    cleanupAndResolve({
                        mermaidCode: mermaidCode,
                        lineMapping: lineMapping,
                        nodeSequence: nodeSequence
                    });
                }
            });
            
            python.on('error', (err) => {
                console.error(`Failed to spawn ${pythonCmd}:`, err.message);
                
                // 如果spawn失敗（通常是找不到命令），嘗試下一個
                currentCommandIndex++;
                tryNextPython();
            });
        }
        
        // 開始嘗試第一個Python命令
        tryNextPython();
    });
}





















// Webview 內容（修改以包含新按鈕和動畫功能）
// Webview 內容（修正版本）
function getWebviewContent(mermaidCode: string, nodeOrder: string[]): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Python Flowchart</title>
        <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
        <style>
            body {
                font-family: Arial, sans-serif;
                padding: 20px;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
            }
            h1 {
                color: var(--vscode-editor-foreground);
                border-bottom: 2px solid var(--vscode-panel-border);
                padding-bottom: 10px;
            }
            .controls {
                margin: 20px 0;
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
            }
            button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 16px;
                cursor: pointer;
                border-radius: 4px;
            }
            button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .animation-control {
                background-color: #4CAF50;
            }
            .animation-control:hover {
                background-color: #45a049;
            }
            .stop-button {
                background-color: #f44336;
            }
            .stop-button:hover {
                background-color: #da190b;
            }
            #mermaid-container {
                background-color: white;
                border-radius: 8px;
                padding: 20px;
                margin-top: 20px;
                overflow: auto;
                max-height: 80vh;
            }
            .mermaid {
                text-align: center;
            }
            .legend {
                margin-top: 20px;
                padding: 15px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                border-radius: 4px;
            }
            .legend h3 {
                margin-top: 0;
            }
            .legend-item {
                display: inline-block;
                margin: 5px 10px;
                padding: 5px 10px;
                border-radius: 4px;
            }
            
            /* 高亮樣式 - 保留原始顏色的發光效果 */
            .highlighted rect,
            .highlighted polygon,
            .highlighted ellipse,
            .highlighted path {
                filter: drop-shadow(0 0 10px #FFC107) drop-shadow(0 0 20px #FFC107);
                animation: glow 1.5s infinite;
            }
            
            /* 動畫高亮樣式 - 不同顏色 */
            .animation-highlighted rect,
            .animation-highlighted polygon,
            .animation-highlighted ellipse,
            .animation-highlighted path {
                filter: drop-shadow(0 0 10px #00BCD4) drop-shadow(0 0 20px #00BCD4);
                animation: animationGlow 1s infinite;
            }
            
            @keyframes glow {
                0% {
                    filter: drop-shadow(0 0 5px #FFC107) drop-shadow(0 0 10px #FFC107);
                }
                50% {
                    filter: drop-shadow(0 0 15px #FFC107) drop-shadow(0 0 30px #FFC107);
                }
                100% {
                    filter: drop-shadow(0 0 5px #FFC107) drop-shadow(0 0 10px #FFC107);
                }
            }
            
            @keyframes animationGlow {
                0% {
                    filter: drop-shadow(0 0 5px #00BCD4) drop-shadow(0 0 10px #00BCD4);
                }
                50% {
                    filter: drop-shadow(0 0 20px #00BCD4) drop-shadow(0 0 35px #00BCD4);
                }
                100% {
                    filter: drop-shadow(0 0 5px #00BCD4) drop-shadow(0 0 10px #00BCD4);
                }
            }
            
            .speed-control {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-top: 10px;
            }
            
            .speed-slider {
                width: 200px;
            }
            
            .status-display {
                margin-top: 10px;
                padding: 10px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                border-radius: 4px;
                font-family: monospace;
            }
        </style>
    </head>
    <body>
        <h1> PseudoChart</h1>
        
        <div class="controls">
            <button onclick="zoomIn()"> Zoom In</button>
            <button onclick="zoomOut()"> Zoom Out</button>
            <button onclick="resetZoom()"> Reset</button>
            <button onclick="exportSVG()"> Export SVG</button>
            <button onclick="clearHighlight()"> Clear Highlight</button>
            <button id="animateBtn" class="animation-control" onclick="startAnimation()">▶ Animate Flow</button>
            <button id="stopBtn" class="stop-button" onclick="stopAnimation()" style="display: none;">⏹ Stop</button>
        </div>
        
        <div class="speed-control">
            <label for="speedSlider">Animation Speed:</label>
            <input type="range" id="speedSlider" class="speed-slider" min="100" max="2000" value="500" step="100">
            <span id="speedValue">500ms</span>
        </div>
        
        <div id="statusDisplay" class="status-display" style="display: none;">
            Current Node: <span id="currentNodeName">-</span>
        </div>
        
        <div id="mermaid-container">
            <div class="mermaid" id="flowchart">
                ${mermaidCode}
            </div>
        </div>
        
        <div class="legend">
            <h4> 功能說明：</h4>
            <ul>
                <li>虛線箭頭 (- - ->) 加上 "calls" 表示函式呼叫關係</li>
                <li>點擊左側程式碼行，右側對應的流程圖節點會發光（黃色）</li>
                <li>點擊 "Animate Flow" 按鈕，按順序展示程式執行流程（藍色發光）</li>
                <li>調整 Animation Speed 滑桿來控制動畫速度</li>
            </ul>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            let currentScale = 1;
            let currentHighlightedNodes = [];
            let animationNodes = [];
            let animationTimer = null;
            let animationIndex = 0;
            let nodeOrder = ${JSON.stringify(nodeOrder)};
            
            // 速度滑桿控制
            const speedSlider = document.getElementById('speedSlider');
            const speedValue = document.getElementById('speedValue');
            speedSlider.addEventListener('input', (e) => {
                speedValue.textContent = e.target.value + 'ms';
            });
            
            mermaid.initialize({ 
                startOnLoad: true,
                theme: 'default',
                flowchart: {
                    useMaxWidth: true,
                    htmlLabels: true,
                    curve: 'basis'
                },
                securityLevel: 'loose'
            });
            
            // 當 Mermaid 完成渲染後設置
            mermaid.init(undefined, document.querySelector('.mermaid')).then(() => {
                console.log('Mermaid initialized, node order:', nodeOrder);
            });
            
            function findNodeElement(nodeId) {
                const elements = document.querySelectorAll(\`.node\`);
                for (const el of elements) {
                    const elementId = el.id;
                    if (elementId) {
                        const idParts = elementId.split('-');
                        if (idParts.length >= 2) {
                            const extractedId = idParts[1];
                            if (extractedId === nodeId || 
                                (nodeId.startsWith('func_') && elementId.includes(nodeId)) ||
                                (nodeId === 'Start' && elementId.includes('Start')) ||
                                (nodeId === 'End' && elementId.includes('End'))) {
                                return el;
                            }
                        }
                    }
                }
                return null;
            }
            
            function highlightNodes(nodeIds) {
                //清除之前的高亮
                clearHighlight();
                
                console.log('Highlighting nodes:', nodeIds);
                
                //高亮新的節點
                nodeIds.forEach(nodeId => {
                    const element = findNodeElement(nodeId);
                    if (element) {
                        element.classList.add('highlighted');
                        currentHighlightedNodes.push(element);
                        console.log('Highlighted element:', element.id);
                    }
                });
                
                if (currentHighlightedNodes.length === 0) {
                    console.log('No nodes found to highlight');
                }
            }
            
            function clearHighlight() {
                // 移除所有高亮
                currentHighlightedNodes.forEach(el => {
                    el.classList.remove('highlighted');
                });
                currentHighlightedNodes = [];
            }
            
            function clearAnimationHighlight() {
                // 移除所有動畫高亮
                animationNodes.forEach(el => {
                    el.classList.remove('animation-highlighted');
                });
                animationNodes = [];
            }
            
            function animateNode(nodeId) {
                clearAnimationHighlight();
                
                const element = findNodeElement(nodeId);
                if (element) {
                    element.classList.add('animation-highlighted');
                    animationNodes.push(element);
                    
                    // 更新狀態顯示
                    const statusDisplay = document.getElementById('statusDisplay');
                    const currentNodeName = document.getElementById('currentNodeName');
                    statusDisplay.style.display = 'block';
                    
                    // 從節點中提取文字內容
                    const textElement = element.querySelector('text') || element.querySelector('.nodeLabel');
                    if (textElement) {
                        currentNodeName.textContent = nodeId + ': ' + textElement.textContent;
                    } else {
                        currentNodeName.textContent = nodeId;
                    }
                    
                    // 滾動到當前節點
                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
            
            function startAnimation() {
                if (animationTimer) {
                    stopAnimation();
                }
                
                animationIndex = 0;
                const animateBtn = document.getElementById('animateBtn');
                const stopBtn = document.getElementById('stopBtn');
                animateBtn.style.display = 'none';
                stopBtn.style.display = 'inline-block';
                
                const speed = parseInt(speedSlider.value);
                
                function nextNode() {
                    if (animationIndex < nodeOrder.length) {
                        animateNode(nodeOrder[animationIndex]);
                        animationIndex++;
                        animationTimer = setTimeout(nextNode, speed);
                    } else {
                        // 動畫結束
                        stopAnimation();
                    }
                }
                
                nextNode();
            }
            
            function stopAnimation() {
                if (animationTimer) {
                    clearTimeout(animationTimer);
                    animationTimer = null;
                }
                
                clearAnimationHighlight();
                
                const animateBtn = document.getElementById('animateBtn');
                const stopBtn = document.getElementById('stopBtn');
                animateBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
                
                // 隱藏狀態顯示
                const statusDisplay = document.getElementById('statusDisplay');
                statusDisplay.style.display = 'none';
            }
            
            // 監聽來自擴展的消息
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'highlightNodes':
                        // 如果正在播放動畫，先停止
                        if (animationTimer) {
                            stopAnimation();
                        }
                        highlightNodes(message.nodeIds);
                        break;
                    case 'clearHighlight':
                        clearHighlight();
                        break;
                    case 'setNodeOrder':
                        nodeOrder = message.nodeOrder;
                        console.log('Updated node order:', nodeOrder);
                        break;
                }
            });
            
            function zoomIn() {
                currentScale += 0.1;
                document.querySelector('.mermaid').style.transform = \`scale(\${currentScale})\`;
            }
            
            function zoomOut() {
                currentScale = Math.max(0.5, currentScale - 0.1);
                document.querySelector('.mermaid').style.transform = \`scale(\${currentScale})\`;
            }
            
            function resetZoom() {
                currentScale = 1;
                document.querySelector('.mermaid').style.transform = 'scale(1)';
            }
            
            function exportSVG() {
                const svg = document.querySelector('.mermaid svg');
                const svgData = new XMLSerializer().serializeToString(svg);
                const blob = new Blob([svgData], { type: 'image/svg+xml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'python-flowchart.svg';
                a.click();
            }
        </script>
    </body>
    </html>`;
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

/**
 * 取得區塊類型的顯示名稱
 */
function getBlockTypeDisplay(type: CodeBlockType): string {
    switch (type) {
        case CodeBlockType.FUNCTION:
            return '🔧 Function';
        case CodeBlockType.CLASS:
            return '🏗️ Class';
        case CodeBlockType.IF:
            return '🔀 If Statement';
        case CodeBlockType.FOR:
            return '🔄 For Loop';
        case CodeBlockType.WHILE:
            return '🔁 While Loop';
        case CodeBlockType.TRY:
            return '🛡️ Try Block';
        case CodeBlockType.SINGLE_LINE:
            return '📝 Single Line';
        default:
            return '📋 Code Block';
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
            <h2>🔄 Pseudocode</h2>
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